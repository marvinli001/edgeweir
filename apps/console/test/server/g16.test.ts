import "reflect-metadata";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ACCESS_LOGS_V2_FEATURE, decodeNodeConfig } from "@edgeweir/config-compiler";
import { STATS_DIMS_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import {
  configureLogs,
  ingestLogs,
  logCutoff,
  logsCsv,
  maintainLogs,
} from "../../src/server/services/access-logs";
import { latestRevision } from "../../src/server/services/revisions";
import { ingestStatsBatch, type ReportedMinuteStats } from "../../src/server/services/stats";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const service = {
  type: "service_account" as const,
  id: "service-account-g16",
  name: "integration",
};
const FULL = ["tls-v1", "rules-v1", "access-logs-v1"];
const G16 = [ACCESS_LOGS_V2_FEATURE, STATS_DIMS_FEATURE];
const DAY = 86_400_000;
const MINUTE = 60_000;

describe("access logs and statistics dimensions (G16)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";
  let node: { id: string; clusterId: string };
  let sequence = 0n;
  const now = Date.now();

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const siteIr = async (id = siteId) => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    const ir = decodeNodeConfig(row.ir);
    return { ir, site: ir.sites.find((s) => s.id === id) };
  };
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const line = (extra: MessageInitShape<typeof AccessLogSchema> = {}) =>
    create(AccessLogSchema, {
      siteId,
      time: timestampFromDate(new Date(now)),
      clientIp: "203.0.113.7",
      method: "GET",
      host: "shop.g16.test",
      path: "/item",
      status: 200,
      bytesSent: 512n,
      durationMs: 20,
      sampleRate: 10000,
      cacheStatus: "MISS",
      ...extra,
    });
  const ingest = (lines: ReturnType<typeof line>[]) => {
    sequence += 1n;
    return ingestLogs(ctx, node, sequence, lines, now);
  };
  const window = () => ({
    from: new Date(now - 10 * MINUTE).toISOString(),
    to: new Date(now + MINUTE).toISOString(),
  });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    for (const name of ["shop", "blog"]) {
      const id = (
        await admin.sites.create({
          name,
          domains: [`${name}.g16.test`],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      if (name === "shop") siteId = id;
      else otherSiteId = id;
    }
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g16",
        lastSeenAt: new Date(),
        supportedFeatures: [...FULL, ...G16],
      })
      .returning();
    if (!row) throw new Error("node missing");
    nodeId = row.id;
    node = { id: row.id, clusterId };
  });
  afterAll(() => pglite.close());

  describe("site log options (10.1.2, 10.1.3)", () => {
    it("reads the defaults, saves what changes, publishes and compiles with access-logs-v2", async () => {
      expect(await admin.logs.settings({ siteId })).toEqual({
        sampleRate: 0,
        storage: "lite",
        retentionDays: 7,
        logBlocked: false,
        logQuery: false,
        logHeaders: [],
        logPeer: false,
      });
      expect((await siteIr()).ir.requiredFeatures).not.toContain(ACCESS_LOGS_V2_FEATURE);
      const before = (await siteIr()).ir.revision;
      await admin.logs.configure({
        siteId,
        logBlocked: true,
        logHeaders: ["X-Trace-Id", "accept-language", "x-trace-id"],
      });
      expect(await admin.logs.settings({ siteId })).toMatchObject({
        sampleRate: 0,
        logBlocked: true,
        logQuery: false,
        logHeaders: ["x-trace-id", "accept-language"],
        logPeer: false,
      });
      const { ir, site } = await siteIr();
      expect(ir.revision).toBeGreaterThan(before);
      expect(ir.requiredFeatures).toContain(ACCESS_LOGS_V2_FEATURE);
      expect(site).toMatchObject({
        logBlocked: true,
        logQuery: false,
        logHeaders: ["accept-language", "x-trace-id"],
        logPeer: false,
      });
      const [audit] = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "site.logs_configure"))
        .orderBy(desc(schema.auditLog.occurredAt))
        .limit(1);
      expect(audit?.metadata).toEqual({
        logBlocked: true,
        logHeaders: ["x-trace-id", "accept-language"],
      });
      // Only the sample rate: the options stay.
      await admin.logs.configure({ siteId, sampleRate: 1000, logQuery: true, logPeer: true });
      expect(await admin.logs.settings({ siteId })).toMatchObject({
        sampleRate: 1000,
        logBlocked: true,
        logQuery: true,
        logHeaders: ["x-trace-id", "accept-language"],
        logPeer: true,
      });
    });

    it("refuses sensitive, malformed and too many request headers", async () => {
      for (const logHeaders of [
        ["Cookie"],
        ["authorization"],
        ["proxy-authorization"],
        ["x trace"],
        ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      ]) {
        const error = await rpcError(admin.logs.configure({ siteId, logHeaders }));
        expect(error.status, logHeaders.join()).toBe(400);
      }
      expect((await admin.logs.settings({ siteId })).logHeaders).toEqual([
        "x-trace-id",
        "accept-language",
      ]);
    });
  });

  describe("log fields (10.1.1–10.1.3)", () => {
    it("stores the new fields, cleaned, and the optional ones only while the site records them", async () => {
      expect(
        await ingest([
          line({
            userAgent: `Mozilla/5.0 (X11; Linux x86_64)\u0007 ${"x".repeat(600)}`,
            referer: "https://ref.example/page?token=secret#frag",
            httpVersion: "2",
            scheme: "https",
            country: "DE",
            asn: 3320,
            asName: "Deutsche Telekom AG",
            upstreamAddr: "192.0.2.10:443",
            upstreamStatus: 200,
            upstreamMs: 87,
            requestBytes: 734n,
            contentType: "text/html",
            tlsVersion: "1.3",
            blockReason: "",
            query: "q=shoes&page=2",
            headers: { "x-trace-id": "abc-1", "user-agent": "dropped", "accept-language": "de" },
            peerIp: "198.51.100.2",
            requestId: "req-fields",
          }),
          line({
            requestId: "req-cleaned",
            country: "de",
            httpVersion: "HTTP/2.0",
            scheme: "gopher",
            contentType: "text/html; charset=utf-8",
            tlsVersion: "TLSv1.3",
            upstreamAddr: "192.0.2.10:443",
            upstreamStatus: 0,
            upstreamMs: 5,
            blockReason: "not-a-reason",
            blockRuleId: "00000000-0000-4000-8000-000000000001",
            peerIp: "203.0.113.7",
          }),
        ]),
      ).toBe(2);
      const { entries } = await admin.logs.query({ siteId, ...window(), requestId: "req-fields" });
      expect(entries[0]).toMatchObject({
        referer: "https://ref.example/page",
        httpVersion: "2",
        scheme: "https",
        country: "DE",
        asn: 3320,
        asName: "Deutsche Telekom AG",
        upstreamAddr: "192.0.2.10:443",
        upstreamStatus: 200,
        upstreamMs: 87,
        requestBytes: 734,
        contentType: "text/html",
        tlsVersion: "1.3",
        blockReason: "",
        query: "q=shoes&page=2",
        headers: { "x-trace-id": "abc-1", "accept-language": "de" },
        peerIp: "198.51.100.2",
      });
      expect(entries[0]?.userAgent).toHaveLength(512);
      expect(entries[0]?.userAgent).not.toContain("\u0007");
      expect(JSON.stringify(entries)).not.toContain("secret");
      const cleaned = (await admin.logs.query({ siteId, ...window(), requestId: "req-cleaned" }))
        .entries[0];
      expect(cleaned).toMatchObject({
        country: "",
        httpVersion: "",
        scheme: "",
        contentType: "",
        tlsVersion: "",
        upstreamAddr: "",
        upstreamStatus: 0,
        upstreamMs: 0,
        blockReason: "",
        blockRuleId: "",
        peerIp: "",
      });
      // Turned off: later lines drop the query string, headers and peer.
      await admin.logs.configure({
        siteId,
        logQuery: false,
        logHeaders: [],
        logPeer: false,
      });
      await ingest([
        line({
          requestId: "req-off",
          query: "q=1",
          headers: { "x-trace-id": "t" },
          peerIp: "198.51.100.2",
        }),
      ]);
      expect(
        (await admin.logs.query({ siteId, ...window(), requestId: "req-off" })).entries[0],
      ).toMatchObject({
        query: "",
        headers: {},
        peerIp: "",
      });
      await admin.logs.configure({
        siteId,
        logQuery: true,
        logHeaders: ["x-trace-id"],
        logPeer: true,
      });
    });

    it("keeps blocked lines of a site that samples nothing only while it logs blocked requests", async () => {
      const blocked = (requestId: string) =>
        line({
          siteId: otherSiteId,
          host: "blog.g16.test",
          status: 403,
          blockReason: "rule",
          blockRuleId: "00000000-0000-4000-8000-0000000000AA",
          requestId,
        });
      expect(await ingest([blocked("blog-1")])).toBe(0);
      await admin.logs.configure({ siteId: otherSiteId, logBlocked: true });
      expect(await ingest([blocked("blog-2")])).toBe(1);
      const { entries } = await admin.logs.query({ siteId: otherSiteId, ...window() });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        requestId: "blog-2",
        blockReason: "rule",
        blockRuleId: "00000000-0000-4000-8000-0000000000aa",
      });
    });
  });

  describe("filters (10.1.4)", () => {
    it("matches every new condition, and all of them together", async () => {
      const rows = [
        line({
          requestId: "f-1",
          host: "Shop.G16.test",
          method: "POST",
          status: 201,
          cacheStatus: "BYPASS",
          country: "US",
          asn: 15169,
          userAgent: "curl/8.4.0",
          referer: "https://search.example/",
          durationMs: 900,
          clientIp: "198.51.100.25",
        }),
        line({
          requestId: "f-2",
          status: 404,
          cacheStatus: "HIT",
          country: "CN",
          asn: 4134,
          userAgent: "Mozilla/5.0 Chrome/129",
          referer: "https://other.example/x",
          durationMs: 5,
          clientIp: "2001:db8::25",
        }),
        line({
          requestId: "f-3",
          status: 403,
          blockReason: "region",
          country: "RU",
          userAgent: "Mozilla/5.0 Firefox/131",
          durationMs: 1,
          clientIp: "198.51.100.200",
        }),
        line({
          requestId: "f-4",
          status: 429,
          blockReason: "rate_limit",
          country: "US",
          userAgent: "python-requests/2.32",
          durationMs: 2,
          clientIp: "192.0.2.77",
        }),
      ];
      expect(await ingest(rows)).toBe(4);
      const ids = async (filter: Record<string, unknown>) =>
        (await admin.logs.query({ siteId, ...window(), ...filter } as never)).entries
          .map((e) => e.requestId)
          .filter((id) => id.startsWith("f-"))
          .sort();
      expect(await ids({ host: "shop.g16.TEST" })).toEqual(["f-1", "f-2", "f-3", "f-4"]);
      expect(await ids({ method: "post" })).toEqual(["f-1"]);
      expect(await ids({ statusClass: "4xx" })).toEqual(["f-2", "f-3", "f-4"]);
      expect(await ids({ statusClass: "4xx", status: 404 })).toEqual(["f-2"]);
      expect(await ids({ cacheStatus: "HIT" })).toEqual(["f-2"]);
      expect(await ids({ blockReason: "any" })).toEqual(["f-3", "f-4"]);
      expect(await ids({ blockReason: "region" })).toEqual(["f-3"]);
      expect(await ids({ country: "us" })).toEqual(["f-1", "f-4"]);
      expect(await ids({ asn: 4134 })).toEqual(["f-2"]);
      expect(await ids({ ua: "CHROME" })).toEqual(["f-2"]);
      expect(await ids({ referer: "search.EXAMPLE" })).toEqual(["f-1"]);
      expect(await ids({ minDuration: 5 })).toEqual(["f-1", "f-2"]);
      expect(await ids({ cidr: "198.51.100.0/25" })).toEqual(["f-1"]);
      expect(await ids({ cidr: "198.51.100.77/24" })).toEqual(["f-1", "f-3"]);
      expect(await ids({ cidr: "2001:db8::/32" })).toEqual(["f-2"]);
      expect(await ids({ cidr: "192.0.2.77" })).toEqual(["f-4"]);
      expect(
        await ids({
          statusClass: "4xx",
          country: "US",
          blockReason: "any",
          ua: "python",
          cidr: "192.0.2.0/24",
        }),
      ).toEqual(["f-4"]);
      // The same filters through /api/v1 query parameters.
      const reader = (await admin.accessKeys.create({ name: "g16-filters", scope: "read" })).key;
      const w = window();
      const res = await api(
        reader,
        "GET",
        `/sites/${siteId}/logs?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&statusClass=4xx&asn=4134&minDuration=1&cidr=${encodeURIComponent("2001:db8::/32")}`,
      );
      expect(res.status).toBe(200);
      expect((res.json.entries as { requestId: string }[]).map((e) => e.requestId)).toEqual([
        "f-2",
      ]);
      for (const bad of [
        "cidr=10.0.0.0/33",
        "cidr=nope",
        "statusClass=6xx",
        "blockReason=bogus",
        "country=USA",
      ]) {
        const refused = await api(
          reader,
          "GET",
          `/sites/${siteId}/logs?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&${bad}`,
        );
        expect(refused.status, bad).toBe(400);
      }
    });

    it("exports the new fields as CSV columns", async () => {
      const { csv } = await admin.logs.export({ siteId, ...window(), requestId: "req-fields" });
      const [header, row] = csv.split("\r\n");
      const columns = header?.split(",") ?? [];
      expect(columns.slice(16)).toEqual([
        "userAgent",
        "referer",
        "httpVersion",
        "scheme",
        "country",
        "asn",
        "asName",
        "upstreamAddr",
        "upstreamStatus",
        "upstreamMs",
        "requestBytes",
        "contentType",
        "tlsVersion",
        "blockReason",
        "blockRuleId",
        "query",
        "headers",
        "peerIp",
      ]);
      const cells = row?.slice(1, -1).split('","') ?? [];
      expect(cells[columns.indexOf("headers")]).toBe("x-trace-id: abc-1; accept-language: de");
      expect(cells[columns.indexOf("country")]).toBe("DE");
      expect(logsCsv([])).toBe(columns.join(","));
    });
  });

  describe("retention (10.1.5)", () => {
    const partitions = async () =>
      (
        await ctx.db.execute<{ relname: string }>(
          sql`select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='access_log'::regclass order by 1`,
        )
      ).rows.map((r) => r.relname);
    const day = (offset: number) =>
      `access_log_${new Date(Math.floor(now / DAY) * DAY + offset * DAY).toISOString().slice(0, 10).replaceAll("-", "")}`;

    it("reads and validates the setting, and records it", async () => {
      expect(await admin.settings.logRetention()).toEqual({
        postgresDays: 7,
        clickhouseDays: 7,
        storage: "lite",
      });
      for (const input of [
        { postgresDays: 0, clickhouseDays: 7 },
        { postgresDays: 31, clickhouseDays: 7 },
        { postgresDays: 7, clickhouseDays: 0 },
        { postgresDays: 7, clickhouseDays: 91 },
      ])
        expect((await rpcError(admin.settings.setLogRetention(input))).status).toBe(400);
      expect(
        await admin.settings.setLogRetention({ postgresDays: 30, clickhouseDays: 90 }),
      ).toEqual({
        postgresDays: 30,
        clickhouseDays: 90,
        storage: "lite",
      });
      const [audit] = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "system.log_retention_update"));
      expect(audit).toMatchObject({ targetType: "system_setting", targetId: "log_retention" });
      expect(audit?.metadata).toMatchObject({ to: { postgresDays: 30, clickhouseDays: 90 } });
      expect((await admin.logs.settings({ siteId })).retentionDays).toBe(30);
    });

    it("follows the setting in partition maintenance, ingestion and queries", async () => {
      await maintainLogs(ctx.db, now);
      expect(await partitions()).toContain(day(-29));
      expect(await partitions()).toContain(day(1));
      // A line from 20 days ago fits 30 days.
      expect(
        await ingest([
          line({ time: timestampFromDate(new Date(now - 20 * DAY)), requestId: "old-20" }),
        ]),
      ).toBe(1);
      await admin.settings.setLogRetention({ postgresDays: 2, clickhouseDays: 90 });
      await maintainLogs(ctx.db, now);
      const kept = await partitions();
      expect(kept).toEqual([day(-1), day(0), day(1)]);
      expect(logCutoff(now, 2)).toBe(Math.floor(now / DAY) * DAY - DAY);
      expect(
        await ingest([
          line({ time: timestampFromDate(new Date(now - 3 * DAY)), requestId: "old-3" }),
        ]),
      ).toBe(0);
      const { entries } = await admin.logs.query({
        siteId,
        from: new Date(now - 25 * DAY).toISOString(),
        to: new Date(now + MINUTE).toISOString(),
        limit: 1000,
      });
      expect(entries.map((e) => e.requestId)).not.toContain("old-20");
      expect(Date.parse(entries.at(-1)?.time ?? "")).toBeGreaterThanOrEqual(logCutoff(now, 2));
      await admin.settings.setLogRetention({ postgresDays: 7, clickhouseDays: 7 });
      await maintainLogs(ctx.db, now);
      expect(await partitions()).toContain(day(-6));
    });

    it("changes the ClickHouse TTL once per value with ClickHouse storage", async () => {
      const bodies: string[] = [];
      const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetch);
      try {
        const env = { ...ctx.env, EDGEWEIR_ANALYTICS: "clickhouse" as const };
        await admin.settings.setLogRetention({ postgresDays: 7, clickhouseDays: 45 });
        await maintainLogs(ctx.db, now, env);
        await maintainLogs(ctx.db, now, env);
        const ttl = bodies.filter((b) => b.includes("MODIFY TTL"));
        expect(ttl).toEqual([
          "ALTER TABLE access_log MODIFY TTL toDateTime(time) + INTERVAL 45 DAY",
        ]);
        await admin.settings.setLogRetention({ postgresDays: 7, clickhouseDays: 7 });
        await maintainLogs(ctx.db, now, env);
        expect(bodies.filter((b) => b.includes("MODIFY TTL")).at(-1)).toBe(
          "ALTER TABLE access_log MODIFY TTL toDateTime(time) + INTERVAL 7 DAY",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("statistics dimensions (10.2)", () => {
    let statsSequence = 0n;
    const minute = new Date(Math.floor(now / MINUTE) * MINUTE - 2 * MINUTE);
    const bucket = (extra: Partial<ReportedMinuteStats> = {}): ReportedMinuteStats => ({
      minute,
      siteId,
      requests: 10,
      bytesSent: 1000,
      bytesReceived: 100,
      cacheHits: 5,
      cacheMisses: 5,
      statusCodes: { "200": 8, "403": 2 },
      ...extra,
    });
    const report = (buckets: ReportedMinuteStats[]) => {
      statsSequence += 1n;
      return ingestStatsBatch(ctx.db, node, statsSequence, buckets, now);
    };

    it("keeps valid keys and bounded maps, sums buckets and names networks", async () => {
      const countries = Array.from({ length: 300 }, (_, i) => ({
        country: String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)),
        requests: 300 - i,
        bytesSent: (300 - i) * 10,
      }));
      await report([
        bucket({
          dimensions: {
            countries: [
              ...countries,
              { country: "", requests: 500, bytesSent: 70 },
              { country: "de", requests: 9, bytesSent: 1 },
            ],
            asns: [
              ...Array.from({ length: 60 }, (_, i) => ({
                asn: 64500 + i,
                name: `AS-${i}`,
                requests: 100 - i,
              })),
              { asn: 0, name: "none", requests: 1000 },
            ],
            referers: { "search.example": 4, "Bad Host": 9, "a..b": 3 },
            browsers: { chrome: 6, crawler: 2, netscape: 9 },
            oses: { android: 6, other: 2 },
            devices: { mobile: 6, crawler: 2 },
            httpVersions: { "2": 7, "1.1": 3, "0.9": 1 },
            tlsVersions: { "1.3": 9, none: 1 },
            blockReasons: { region: 1, rule: 1, nonsense: 5 },
            challengesIssued: 4,
            challengesPassed: 3,
          },
        }),
        // The same minute and site again in one report: summed.
        bucket({
          dimensions: {
            countries: [{ country: "AA", requests: 1, bytesSent: 5 }],
            asns: [{ asn: 64500, name: "AS-renamed", requests: 1 }],
            browsers: { chrome: 1 },
            challengesIssued: 1,
          },
        }),
      ]);
      const [row] = await ctx.db
        .select()
        .from(schema.nodeMinuteStats)
        .where(
          and(eq(schema.nodeMinuteStats.siteId, siteId), eq(schema.nodeMinuteStats.minute, minute)),
        );
      expect(Object.keys(row?.countryRequests ?? {})).toHaveLength(250);
      expect(row?.countryRequests.AA).toBe(301);
      // Bytes for the same countries as requests.
      expect(Object.keys(row?.countryBytes ?? {}).sort()).toEqual(
        Object.keys(row?.countryRequests ?? {}).sort(),
      );
      expect(row?.countryBytes[""]).toBe(70);
      expect(row?.countryBytes.AA).toBe(3005);
      expect(row?.countryRequests).not.toHaveProperty("de");
      expect(Object.keys(row?.asns ?? {})).toHaveLength(50);
      expect(row?.asns).not.toHaveProperty("0");
      expect(row?.referers).toEqual({ "search.example": 4 });
      expect(row?.browsers).toEqual({ chrome: 7, crawler: 2 });
      expect(row?.httpVersions).toEqual({ "2": 7, "1.1": 3 });
      expect(row?.blockReasons).toEqual({ region: 1, rule: 1 });
      expect([row?.challengesIssued, row?.challengesPassed]).toEqual([5, 3]);
      const [name] = await ctx.db
        .select()
        .from(schema.asnName)
        .where(eq(schema.asnName.asn, 64500));
      expect(name?.name).toBe("AS-renamed");
      // A later report for the same minute adds to the stored row.
      await report([bucket({ dimensions: { browsers: { chrome: 3 }, challengesPassed: 1 } })]);
      const [again] = await ctx.db
        .select()
        .from(schema.nodeMinuteStats)
        .where(
          and(eq(schema.nodeMinuteStats.siteId, siteId), eq(schema.nodeMinuteStats.minute, minute)),
        );
      expect(again?.browsers.chrome).toBe(10);
      expect(again?.challengesPassed).toBe(4);
    });

    it("answers analytics.dimensions per site and for every site, through the rollups too", async () => {
      await report([
        bucket({
          siteId: otherSiteId,
          dimensions: {
            countries: [{ country: "JP", requests: 5000, bytesSent: 9_000_000 }],
            blockReasons: { cc: 2 },
          },
        }),
      ]);
      const site = await admin.analytics.dimensions({ siteId, range: "1h" });
      expect(site.countries.slice(0, 2)).toEqual([
        { country: "", requests: 500, bytesSent: 70 },
        { country: "AA", requests: 301, bytesSent: 3005 },
      ]);
      expect(site.countries).toHaveLength(250);
      expect(site.asns).toHaveLength(50);
      expect(site.asns[0]).toEqual({ asn: 64500, name: "AS-renamed", requests: 101 });
      expect(site.referers).toEqual([{ host: "search.example", requests: 4 }]);
      expect(site.browsers).toEqual([
        { key: "chrome", requests: 10 },
        { key: "crawler", requests: 2 },
      ]);
      expect(site.httpVersions).toEqual([
        { key: "2", requests: 7 },
        { key: "1.1", requests: 3 },
      ]);
      expect(site.blockReasons.map((r) => r.key).sort()).toEqual(["region", "rule"]);
      expect(site.challenges).toEqual({ issued: 5, passed: 4 });
      expect(site.unsupportedNodes).toBe(0);
      const all = await admin.analytics.dimensions({ range: "1h" });
      expect(all.countries.find((c) => c.country === "JP")?.bytesSent).toBe(9_000_000);
      expect(all.blockReasons.find((r) => r.key === "cc")?.requests).toBe(2);
      // The hourly rollups give the same answer for 7 days.
      await rollupTraffic(ctx.db, new Date(now + 2 * 3_600_000));
      const week = await admin.analytics.dimensions({ siteId, range: "7d" });
      expect(week.countries[0]).toEqual(site.countries[0]);
      expect(week.challenges).toEqual(site.challenges);
      expect(week.asns[0]).toEqual(site.asns[0]);
      const [hour] = await ctx.db
        .select()
        .from(schema.nodeHourStats)
        .where(eq(schema.nodeHourStats.siteId, siteId));
      expect(hour?.challengesIssued).toBe(5);
      expect(Object.keys(hour?.asns ?? {})).toHaveLength(50);
      // A node without stats-dims-v1: partial.
      await setNodeFeatures(FULL);
      expect((await admin.analytics.dimensions({ siteId, range: "1h" })).unsupportedNodes).toBe(1);
      await setNodeFeatures([...FULL, ...G16]);
    });
  });

  describe("nodes (0.4)", () => {
    it("holds the log options for changes without the operator while a node lacks access-logs-v2", async () => {
      await admin.logs.configure({
        siteId,
        logBlocked: false,
        logQuery: false,
        logHeaders: [],
        logPeer: false,
      });
      await admin.logs.configure({ siteId: otherSiteId, logBlocked: false });
      await setNodeFeatures(FULL);
      const available = { available: true, reason: null };
      expect((await admin.sites.features({ id: siteId })).accessLogsV2).toEqual({
        available: false,
        reason: "nodes",
      });
      const before = (await siteIr()).ir.revision;
      const error = await configureLogs(ctx, service, { siteId, logBlocked: true }).catch((e) => e);
      expect(error?.code ?? error?.data?.code ?? String(error)).toContain(
        "NODE_CAPABILITY_REQUIRED",
      );
      expect((await siteIr()).ir.revision).toBe(before);
      expect((await admin.logs.settings({ siteId })).logBlocked).toBe(false);
      // A change without the options is not held; the operator may require them.
      await configureLogs(ctx, service, { siteId, sampleRate: 100 });
      await admin.logs.configure({ siteId, logBlocked: true });
      expect((await siteIr()).site?.logBlocked).toBe(true);
      await setNodeFeatures([...FULL, ...G16]);
      expect((await admin.sites.features({ id: siteId })).accessLogsV2).toEqual(available);
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "g16-ro", scope: "read" })).key;
    const account = await admin.serviceAccounts.create({
      name: "g16-integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const w = window();
    for (const path of [
      `/sites/${siteId}/logs/settings`,
      `/sites/${siteId}/logs?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&blockReason=any`,
      `/sites/${siteId}/logs/export?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`,
      `/analytics/dimensions?range=1h&siteId=${siteId}`,
      "/analytics/dimensions?range=24h",
      "/settings/log-retention",
    ]) {
      expect((await api(reader, "GET", path)).status, path).toBe(200);
      const refusedKey = await api(key, "GET", path);
      expect([refusedKey.status, refusedKey.json.code], path).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    for (const [method, path, body] of [
      ["PUT", `/sites/${siteId}/logs/settings`, { logQuery: true }],
      ["PUT", "/settings/log-retention", { postgresDays: 3, clickhouseDays: 3 }],
    ] as const) {
      const readOnly = await api(reader, method, path, body);
      expect([readOnly.status, readOnly.json.code], path).toEqual([403, "ACCESS_KEY_READ_ONLY"]);
      const refusedKey = await api(key, method, path, body);
      expect([refusedKey.status, refusedKey.json.code], path).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    // Nothing changed.
    expect((await admin.logs.settings({ siteId })).logQuery).toBe(false);
    expect(await admin.settings.logRetention()).toMatchObject({
      postgresDays: 7,
      clickhouseDays: 7,
    });
  });
});
