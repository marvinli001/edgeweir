import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adapterOf } from "../../src/server/services/probe-sources";
import type {
  Http,
  HttpRequest,
  ProbeSourceAdapter,
  PullContext,
} from "../../src/server/services/probe-sources/types";
import { acs3Sign, tc3Sign } from "../../src/server/services/sms";

// Per-adapter tests (ADR-0069): request shape (URL, auth headers, body) and
// parsing of recorded response bodies (test/server/fixtures/probe-sources/,
// in the shape of the providers' API references), plus webhook signatures.

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/probe-sources/${name}`, import.meta.url), "utf8");

/** A fake API: the first route whose test matches answers; requests are kept. */
function fakeHttp(routes: [RegExp, number, string][]) {
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    const route = routes.find(([re]) => re.test(`${request.method} ${request.url}`));
    if (!route) return { status: 404, body: Buffer.from("{}") };
    return { status: route[1], body: Buffer.from(route[2]) };
  };
  return { http, requests };
}

const ctx = (
  http: Http,
  credentials: Record<string, string>,
  monitorIds: string[] = [],
  options: Record<string, string> = {},
): PullContext => ({
  credentials,
  options,
  http,
  now: new Date("2026-10-30T08:00:00Z"),
  monitorIds,
});

const adapter = (id: string) => adapterOf(id) as ProbeSourceAdapter;

describe("UptimeRobot", () => {
  it("follows nextLink with a bearer token and maps v3 statuses", async () => {
    const { http, requests } = fakeHttp([
      [
        /^GET https:\/\/api\.uptimerobot\.com\/v3\/monitors\?limit=200&cursor=778$/,
        200,
        fixture("uptimerobot-monitors-2.json"),
      ],
      [
        /^GET https:\/\/api\.uptimerobot\.com\/v3\/monitors\?limit=200$/,
        200,
        fixture("uptimerobot-monitors-1.json"),
      ],
    ]);
    const list = await adapter("uptimerobot").listMonitors?.(ctx(http, { api_key: "ur123-key" }));
    expect(requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer ur123-key",
      "Bearer ur123-key",
    ]);
    expect(list).toEqual([
      { id: "777", name: "edge-1 https", target: "https://203.0.113.10/" },
      { id: "778", name: "edge-2", target: "203.0.113.11" },
      { id: "779", name: "paused", target: "203.0.113.12" },
      { id: "780", name: "edge-4", target: "203.0.113.13" },
    ]);
    const results = await adapter("uptimerobot").poll?.(
      ctx(http, { api_key: "ur123-key" }, ["777", "778", "779", "780"]),
    );
    const at = { location: "", rttMs: null, lossPercent: null, checkedAt: null };
    expect(results).toEqual([
      { monitorId: "777", up: true, error: "", ...at },
      { monitorId: "778", up: false, error: "down", ...at },
      { monitorId: "780", up: false, error: "looks_down", ...at },
    ]);
  });
  it("never follows a nextLink to another host; 401 is auth_failed, 429 rate_limited", async () => {
    const { http, requests } = fakeHttp([
      [/monitors/, 200, JSON.stringify({ nextLink: "https://evil.example/v3/monitors", data: [] })],
    ]);
    await adapter("uptimerobot").listMonitors?.(ctx(http, { api_key: "x" }));
    expect(requests).toHaveLength(1);
    const bad = fakeHttp([[/monitors/, 401, "{}"]]);
    await expect(
      adapter("uptimerobot").listMonitors?.(ctx(bad.http, { api_key: "x" })),
    ).rejects.toMatchObject({ code: "auth_failed" });
    const limited = fakeHttp([[/monitors/, 429, "{}"]]);
    await expect(
      adapter("uptimerobot").listMonitors?.(ctx(limited.http, { api_key: "x" })),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("Better Stack", () => {
  it("polls status and per-region response times with a bearer token", async () => {
    const { http, requests } = fakeHttp([
      [
        /^GET https:\/\/incidents\.betterstack\.com\/api\/v2\/monitors\?/,
        200,
        fixture("betterstack-monitors.json"),
      ],
      [/\/monitors\/2001\/response-times$/, 200, fixture("betterstack-response-times.json")],
    ]);
    const results = await adapter("betterstack").poll?.(
      ctx(http, { api_token: "bs-token" }, ["2001", "2002"]),
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer bs-token");
    expect(results).toEqual([
      {
        monitorId: "2001",
        location: "us",
        up: true,
        rttMs: 120,
        lossPercent: null,
        error: "",
        checkedAt: new Date("2026-10-30T07:59:30.000Z"),
      },
      {
        monitorId: "2001",
        location: "eu",
        up: true,
        rttMs: 45,
        lossPercent: null,
        error: "",
        checkedAt: new Date("2026-10-30T07:59:30.000Z"),
      },
      {
        monitorId: "2002",
        location: "",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "down",
        checkedAt: new Date("2026-10-30T07:59:10.000Z"),
      },
    ]);
    expect(
      await adapter("betterstack").listMonitors?.(ctx(http, { api_token: "bs-token" })),
    ).toEqual([
      { id: "2001", name: "Edge 1", target: "https://203.0.113.20" },
      { id: "2002", name: "Edge 2", target: "https://203.0.113.21" },
      { id: "2003", name: "Paused", target: "https://203.0.113.22" },
    ]);
  });
});

describe("Pingdom", () => {
  it("reads checks with status and the last response time", async () => {
    const { http, requests } = fakeHttp([
      [/^GET https:\/\/api\.pingdom\.com\/api\/3\.1\/checks/, 200, fixture("pingdom-checks.json")],
    ]);
    const results = await adapter("pingdom").poll?.(
      ctx(http, { api_token: "pd-token" }, ["85975", "161748", "999"]),
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer pd-token");
    expect(results).toEqual([
      {
        monitorId: "85975",
        location: "",
        up: true,
        rttMs: 355,
        lossPercent: null,
        error: "",
        checkedAt: new Date(1793347150 * 1000),
      },
      {
        monitorId: "161748",
        location: "",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "down",
        checkedAt: new Date(1793347100 * 1000),
      },
    ]);
  });
});

describe("Checkly", () => {
  const check = "a1b2c3d4-0000-4000-8000-000000000001";
  it("takes the newest v2 result per run location with the account header", async () => {
    const { http, requests } = fakeHttp([
      [
        new RegExp(`^GET https://api\\.checklyhq\\.com/v2/check-results/${check}\\?`),
        200,
        fixture("checkly-check-results.json"),
      ],
    ]);
    const results = await adapter("checkly").poll?.(
      ctx(http, { api_key: "cu_key" }, [check], { account_id: "acc-1" }),
    );
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer cu_key",
      "x-checkly-account": "acc-1",
    });
    expect(results).toEqual([
      {
        monitorId: check,
        location: "eu-central-1",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "failed",
        checkedAt: new Date("2026-10-30T07:59:00.000Z"),
      },
      {
        monitorId: check,
        location: "us-east-1",
        up: true,
        rttMs: 210,
        lossPercent: null,
        error: "",
        checkedAt: new Date("2026-10-30T07:58:00.000Z"),
      },
    ]);
  });
  describe("webhook", () => {
    const secret = "ewh_checkly-secret-0123456789";
    const body = Buffer.from(fixture("checkly-webhook.json"));
    const now = new Date("2026-10-30T07:59:30Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const verify = (h: Record<string, string>, b = body) =>
      adapter("checkly").verifyWebhook?.({ headers: new Headers(h), body: b, now }, secret);
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    it("verifies x-checkly-signature (hex HMAC of the body) and the timestamp", () => {
      expect(verify({ "x-checkly-signature": sig, "x-checkly-timestamp": ts })).toBe("ok");
      expect(
        verify({ "x-checkly-signature": sig.replace(/^./, "0"), "x-checkly-timestamp": ts }),
      ).toBe("signature_invalid");
      expect(
        verify({ "x-checkly-signature": sig, "x-checkly-timestamp": ts }, Buffer.from(`${body} `)),
      ).toBe("signature_invalid");
      expect(
        verify({ "x-checkly-signature": sig, "x-checkly-timestamp": String(Number(ts) - 301) }),
      ).toBe("timestamp_invalid");
    });
    it("maps alert types and refuses an old run", () => {
      const parse = (o: unknown) => adapter("checkly").parseWebhook?.(o, now);
      const failure = JSON.parse(body.toString());
      expect(parse(failure)).toEqual([
        {
          monitorId: check,
          location: "eu-central-1",
          up: false,
          rttMs: null,
          lossPercent: null,
          error: "failure",
          checkedAt: new Date("2026-10-30T07:59:00.000Z"),
        },
      ]);
      expect(
        parse({ ...failure, alertType: "ALERT_RECOVERY", responseTime: "120" })?.[0],
      ).toMatchObject({ up: true, rttMs: 120 });
      expect(parse({ ...failure, alertType: "ALERT_SSL" })).toEqual([]);
      expect(parse({ ...failure, startedAt: "2026-10-30T05:00:00.000Z" })).toBeNull();
      expect(parse({ alertType: "ALERT_FAILURE" })).toBeNull();
    });
  });
});

describe("Datadog", () => {
  it("uses the chosen site and both keys, newest result per location", async () => {
    const { http, requests } = fakeHttp([
      [
        /^GET https:\/\/api\.datadoghq\.eu\/api\/v1\/synthetics\/tests\/abc-def-ghi\/results$/,
        200,
        fixture("datadog-results.json"),
      ],
    ]);
    const results = await adapter("datadog").poll?.(
      ctx(http, { api_key: "a".repeat(32), application_key: "b".repeat(40) }, ["abc-def-ghi"], {
        site: "datadoghq.eu",
      }),
    );
    expect(requests[0]?.headers).toMatchObject({
      "dd-api-key": "a".repeat(32),
      "dd-application-key": "b".repeat(40),
    });
    expect(results).toEqual([
      {
        monitorId: "abc-def-ghi",
        location: "aws:eu-central-1",
        up: true,
        rttMs: 87,
        lossPercent: null,
        error: "",
        checkedAt: new Date(1793347100000),
      },
      {
        monitorId: "abc-def-ghi",
        location: "aws:ap-northeast-1",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "failed",
        checkedAt: new Date(1793347050000),
      },
    ]);
  });
  it("refuses a site outside the list", async () => {
    const { http } = fakeHttp([]);
    await expect(
      adapter("datadog").listMonitors?.(
        ctx(http, { api_key: "x", application_key: "y" }, [], { site: "evil.example" }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });
});

describe("Alibaba Cloud site monitoring", () => {
  const keys = { access_key_secret: "aliyun-secret" };
  const options = { access_key_id: "LTAI5tExample", region: "cn-shanghai" };
  it("signs ACS3 RPC calls to the region's endpoint and keeps the newest log per city/ISP", async () => {
    const { http, requests } = fakeHttp([
      [
        /^POST https:\/\/metrics\.cn-shanghai\.aliyuncs\.com\/\?.*MetricName=ProbeLog/,
        200,
        fixture("aliyun-site-monitor-log.json"),
      ],
      [
        /^POST https:\/\/metrics\.cn-shanghai\.aliyuncs\.com\/\?/,
        200,
        fixture("aliyun-site-monitor-list.json"),
      ],
    ]);
    expect(
      await adapter("aliyun_site_monitor").listMonitors?.(ctx(http, keys, [], options)),
    ).toEqual([
      { id: "t-1", name: "edge-1", target: "https://203.0.113.30" },
      { id: "t-2", name: "edge-2 ping", target: "203.0.113.31" },
    ]);
    const list = requests[0];
    expect(list?.headers).toMatchObject({
      host: "metrics.cn-shanghai.aliyuncs.com",
      "x-acs-action": "DescribeSiteMonitorList",
      "x-acs-version": "2019-01-01",
      "x-acs-date": "2026-10-30T08:00:00Z",
    });
    // The signature is over the request as sent (same query, same headers).
    const sent = new URL(list?.url ?? "");
    const { authorization, ...headers } = list?.headers ?? {};
    expect(authorization).toBe(
      acs3Sign({
        method: "POST",
        query: Object.fromEntries(sent.searchParams),
        headers,
        accessKeyId: "LTAI5tExample",
        accessKeySecret: "aliyun-secret",
      }).authorization,
    );
    expect(authorization).toMatch(
      /^ACS3-HMAC-SHA256 Credential=LTAI5tExample,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[0-9a-f]{64}$/,
    );
    const results = await adapter("aliyun_site_monitor").poll?.(
      ctx(http, keys, ["t-1", "t-2"], options),
    );
    const log = new URL(requests[1]?.url ?? "").searchParams;
    expect(Object.fromEntries(log)).toMatchObject({
      TaskIds: "t-1,t-2",
      MetricName: "ProbeLog",
      EndTime: "1793347200000",
      StartTime: "1793346600000",
    });
    expect(results).toEqual([
      {
        monitorId: "t-1",
        location: "Hangzhou/China Telecom",
        up: true,
        rttMs: 41,
        lossPercent: null,
        error: "",
        checkedAt: new Date(1793347140000),
      },
      {
        monitorId: "t-1",
        location: "Beijing/China Unicom",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "610",
        checkedAt: new Date(1793347140000),
      },
      {
        monitorId: "t-2",
        location: "Shanghai/China Mobile",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "http_503",
        checkedAt: new Date(1793347150000),
      },
    ]);
  });
  it("maps error codes and refuses an unknown region", async () => {
    const bad = fakeHttp([[/aliyuncs/, 404, fixture("aliyun-error.json")]]);
    await expect(
      adapter("aliyun_site_monitor").listMonitors?.(ctx(bad.http, keys, [], options)),
    ).rejects.toMatchObject({ code: "auth_failed" });
    const limited = fakeHttp([[/aliyuncs/, 400, JSON.stringify({ Code: "Throttling.User" })]]);
    await expect(
      adapter("aliyun_site_monitor").listMonitors?.(ctx(limited.http, keys, [], options)),
    ).rejects.toMatchObject({ code: "rate_limited" });
    await expect(
      adapter("aliyun_site_monitor").listMonitors?.(
        ctx(bad.http, keys, [], { ...options, region: "evil.example" }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });
});

describe("Tencent Cloud CAT", () => {
  const keys = { secret_key: "tencent-secret" };
  const options = { secret_id: "AKIDexample" };
  it("signs TC3 calls for service cat and reads per city/operator records", async () => {
    const { http, requests } = fakeHttp([
      [/^POST https:\/\/cat\.tencentcloudapi\.com\/$/, 200, fixture("tencent-probe-tasks.json")],
    ]);
    expect(await adapter("tencent_cat").listMonitors?.(ctx(http, keys, [], options))).toEqual([
      { id: "task-abc123", name: "edge-1 ping", target: "203.0.113.40" },
    ]);
    const list = requests[0];
    expect(list?.headers).toMatchObject({
      "x-tc-action": "DescribeProbeTasks",
      "x-tc-version": "2018-04-09",
      "x-tc-timestamp": "1793347200",
    });
    expect(JSON.parse(list?.body?.toString() ?? "")).toEqual({ Offset: 0, Limit: 100 });
    expect(list?.headers.authorization).toBe(
      tc3Sign({
        secretId: "AKIDexample",
        secretKey: "tencent-secret",
        service: "cat",
        timestamp: 1793347200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          host: "cat.tencentcloudapi.com",
          "x-tc-action": "DescribeProbeTasks",
        },
        payload: list?.body?.toString() ?? "",
      }).authorization,
    );
    expect(list?.headers.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDexample\/2026-10-30\/cat\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    );
    const data = fakeHttp([[/cat\.tencentcloudapi/, 200, fixture("tencent-probe-data.json")]]);
    const results = await adapter("tencent_cat").poll?.(
      ctx(data.http, keys, ["task-abc123"], options),
    );
    expect(JSON.parse(data.requests[0]?.body?.toString() ?? "")).toMatchObject({
      BeginTime: 1793346600000,
      EndTime: 1793347200000,
      TaskType: "AnalyzeTaskType_Network",
      TaskID: ["task-abc123"],
    });
    expect(results).toEqual([
      {
        monitorId: "task-abc123",
        location: "Guangzhou/China Telecom",
        up: true,
        rttMs: 23,
        lossPercent: 0,
        error: "",
        checkedAt: new Date(1793347140000),
      },
      {
        monitorId: "task-abc123",
        location: "Chengdu/China Mobile",
        up: false,
        rttMs: null,
        lossPercent: 100,
        error: "error_7",
        checkedAt: new Date(1793347140000),
      },
    ]);
  });
  it("maps Response.Error codes", async () => {
    const bad = fakeHttp([[/cat/, 200, fixture("tencent-error.json")]]);
    await expect(
      adapter("tencent_cat").listMonitors?.(ctx(bad.http, keys, [], options)),
    ).rejects.toMatchObject({ code: "auth_failed" });
    const limited = fakeHttp([
      [/cat/, 200, JSON.stringify({ Response: { Error: { Code: "RequestLimitExceeded" } } })],
    ]);
    await expect(
      adapter("tencent_cat").listMonitors?.(ctx(limited.http, keys, [], options)),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("generic webhook", () => {
  const secret = "ewh_example-secret-0123456789";
  const body = Buffer.from(fixture("generic-delivery.body"));
  const now = new Date(1793347200 * 1000);
  const sign = (ts: number, payload: Buffer) =>
    `v1=${createHmac("sha256", secret).update(`${ts}.`).update(payload).digest("hex")}`;
  it("verifies the documented example signature", () => {
    // docs/guide/scheduling.md: secret, timestamp 1793347200 and this body.
    expect(sign(1793347200, body)).toBe(fixture("generic-delivery.sig").trim());
    const headers = new Headers({
      "x-edgeweir-timestamp": "1793347200",
      "x-edgeweir-signature": sign(1793347200, body),
    });
    expect(adapter("generic_webhook").verifyWebhook?.({ headers, body, now }, secret)).toBe("ok");
  });
  it("refuses a wrong signature, a modified body and a timestamp outside 300 s", () => {
    const ok = sign(1793347200, body);
    const verify = (h: Record<string, string>, b = body) =>
      adapter("generic_webhook").verifyWebhook?.({ headers: new Headers(h), body: b, now }, secret);
    expect(
      verify({
        "x-edgeweir-timestamp": "1793347200",
        "x-edgeweir-signature": ok.replace(/.$/, "0"),
      }),
    ).toBe("signature_invalid");
    expect(
      verify(
        { "x-edgeweir-timestamp": "1793347200", "x-edgeweir-signature": ok },
        Buffer.from(`${body} `),
      ),
    ).toBe("signature_invalid");
    expect(
      verify({
        "x-edgeweir-timestamp": "1793346899",
        "x-edgeweir-signature": sign(1793346899, body),
      }),
    ).toBe("timestamp_invalid");
    expect(verify({ "x-edgeweir-signature": ok })).toBe("timestamp_invalid");
  });
  it("parses results and rejects malformed deliveries", () => {
    const parsed = adapter("generic_webhook").parseWebhook?.(JSON.parse(body.toString()), now);
    expect(parsed).toEqual([
      {
        monitorId: "edge-1",
        location: "fra",
        up: true,
        rttMs: 31,
        lossPercent: 0,
        error: "",
        checkedAt: new Date("2026-10-30T07:59:50Z"),
      },
      {
        monitorId: "edge-1",
        location: "sin",
        up: false,
        rttMs: null,
        lossPercent: null,
        error: "timeout",
        checkedAt: null,
      },
    ]);
    expect(
      adapter("generic_webhook").parseWebhook?.({ results: [{ monitor: "", up: true }] }, now),
    ).toBeNull();
    expect(
      adapter("generic_webhook").parseWebhook?.({ results: [{ monitor: "x", up: "yes" }] }, now),
    ).toBeNull();
    expect(adapter("generic_webhook").parseWebhook?.([], now)).toBeNull();
  });
});
