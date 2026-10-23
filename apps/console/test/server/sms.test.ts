import { createHash } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { sweepAlerts } from "../../src/server/services/alerts";
import {
  acs3Sign,
  reserveSmsSend,
  SmsRateLimitedError,
  smsParam,
  tc3Sign,
} from "../../src/server/services/sms";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

/** A recorded provider: every request, and the reply the next one gets. */
const provider = vi.hoisted(() => ({
  calls: [] as { url: string; headers: Record<string, string>; body: string }[],
  replies: [] as { status: number; body: unknown }[],
}));
vi.mock("../../src/server/lib/outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/lib/outbound")>()),
  outboundPost: async (
    _app: unknown,
    url: string,
    body: Buffer,
    headers: Record<string, string>,
  ) => {
    provider.calls.push({ url, headers, body: body.toString() });
    const reply = provider.replies.shift() ?? { status: 200, body: { Code: "OK" } };
    return { status: reply.status, body: Buffer.from(JSON.stringify(reply.body)) };
  },
}));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("SMS request signing", () => {
  it("matches the worked example of Alibaba Cloud signature V3", () => {
    // help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
    const signed = acs3Sign({
      method: "POST",
      query: {
        RegionId: "cn-shanghai",
        ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
      },
      headers: {
        host: "ecs.cn-shanghai.aliyuncs.com",
        "x-acs-action": "RunInstances",
        "x-acs-version": "2014-05-26",
        "x-acs-date": "2023-10-26T10:22:32Z",
        "x-acs-signature-nonce": "3156853299f313e23d1673dc12e1703d",
        "x-acs-content-sha256": sha256(""),
      },
      accessKeyId: "YourAccessKeyId",
      accessKeySecret: "YourAccessKeySecret",
    });
    expect(signed.query).toBe(
      "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
    );
    expect(sha256(signed.canonical)).toBe(
      "7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259",
    );
    expect(signed.authorization).toBe(
      "ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    );
  });
  it("percent-encodes the canonical query as RFC 3986 wants", () => {
    const { query } = acs3Sign({
      method: "POST",
      query: { TemplateParam: '{"site":"a b*(c)!~"}', SignName: "签名" },
      headers: { host: "h", "x-acs-content-sha256": sha256("") },
      accessKeyId: "id",
      accessKeySecret: "secret",
    });
    expect(query).toBe(
      "SignName=%E7%AD%BE%E5%90%8D&TemplateParam=%7B%22site%22%3A%22a%20b%2A%28c%29%21~%22%7D",
    );
  });
  it("builds the canonical request of the Tencent Cloud TC3 example", () => {
    // cloud.tencent.com/document/api/382/52072 (its keys are masked)
    const signed = tc3Sign({
      secretId: "AKID",
      secretKey: "key",
      service: "cvm",
      timestamp: 1551113065,
      headers: {
        "content-type": "application/json; charset=utf-8",
        host: "cvm.tencentcloudapi.com",
        "x-tc-action": "DescribeInstances",
      },
      payload:
        '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    });
    expect(sha256(signed.canonical)).toBe(
      "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
    );
    expect(signed.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKID\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    );
  });
  it("signs like the official Tencent Cloud Node.js SDK", () => {
    // tencentcloud-sdk-nodejs-common 4.1.220 Sign.sign3 with the same input.
    const signed = tc3Sign({
      secretId: "AKIDEXAMPLE",
      secretKey: "EXAMPLEKEY",
      service: "sms",
      timestamp: 1761200000,
      headers: {
        "content-type": "application/json; charset=utf-8",
        host: "sms.tencentcloudapi.com",
      },
      payload:
        '{"SmsSdkAppId":"1400006666","SignName":"Edgeweir","TemplateId":"1110","TemplateParamSet":["example.com","节点离线","告警中"],"PhoneNumberSet":["+8613800000000"]}',
    });
    expect(signed.authorization).toBe(
      "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2025-10-23/sms/tc3_request, SignedHeaders=content-type;host, Signature=b0bca401daeda6db0aa46639552d554bb318fda4b3199ea328eea31dda9f2974",
    );
  });
});

describe("SMS template variables", () => {
  it("truncates by characters and drops what providers refuse", () => {
    expect(smsParam("用量达到上限：流量", 6)).toBe("用量达到上限");
    expect(smsParam("https://shop.example/a【x】\n🔥 ok", 35)).toBe("shop.example/a x ok");
    expect(smsParam("${x}", 10)).toBe("x");
    expect(smsParam(" \u200b ", 10)).toBe("-");
    expect(smsParam("a😀b", 2)).toBe("a");
  });
});

describe("SMS channels", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient, siteId: string;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    siteId = (
      await admin.sites.create({
        name: "shop.example",
        domains: ["shop.example"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
  });
  afterAll(() => db.close());
  const aliyun = {
    kind: "aliyun_sms" as const,
    accessKeyId: "LTAIfixture",
    accessKeySecret: "fixture-secret",
    signName: "Edgeweir",
    templateCode: "SMS_100000001",
    phoneNumbers: ["+8613800000000", "13900000000"],
  };
  const tencent = {
    kind: "tencent_sms" as const,
    secretId: "AKIDfixture",
    secretKey: "fixture-key",
    sdkAppId: "1400006666",
    region: "ap-beijing" as const,
    signName: "Edgeweir",
    templateId: "1110",
    phoneNumbers: ["+8613800000000"],
  };

  it("seals the keys and never returns them", async () => {
    const channel = await admin.alerts.createChannel({ name: "Aliyun", config: aliyun });
    const [row] = await ctx.db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, channel.id));
    expect(row?.configEnvelope).not.toContain("fixture-secret");
    expect(JSON.stringify(await admin.alerts.channels())).not.toContain("fixture-secret");
    await admin.alerts.deleteChannel({ id: channel.id });
  });

  it("tests an Aliyun channel with a signed SendSms and the three variables", async () => {
    const channel = await admin.alerts.createChannel({ name: "Aliyun", config: aliyun });
    provider.calls.length = 0;
    await admin.alerts.testChannel({ id: channel.id });
    const call = provider.calls[0];
    if (!call) throw new Error("no request");
    const url = new URL(call.url);
    expect(url.host).toBe("dysmsapi.aliyuncs.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      PhoneNumbers: "+8613800000000,13900000000",
      SignName: "Edgeweir",
      TemplateCode: "SMS_100000001",
      TemplateParam: JSON.stringify({ site: "Edgeweir", alert: "测试通知", status: "告警中" }),
    });
    expect(call.headers).toMatchObject({
      "x-acs-action": "SendSms",
      "x-acs-version": "2017-05-25",
      "x-acs-content-sha256": sha256(""),
    });
    expect(call.headers["x-acs-date"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const { authorization: _, ...headers } = call.headers;
    const expected = acs3Sign({
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      headers,
      accessKeyId: aliyun.accessKeyId,
      accessKeySecret: aliyun.accessKeySecret,
    });
    expect(url.search.slice(1)).toBe(expected.query);
    expect(call.headers.authorization).toBe(expected.authorization);
    await admin.alerts.deleteChannel({ id: channel.id });
  });

  it("maps Aliyun refusals to the provider code and retries a link refusal without dots", async () => {
    const channel = await admin.alerts.createChannel({ name: "Aliyun", config: aliyun });
    provider.replies.push({
      status: 400,
      body: { Code: "isv.SMS_TEMPLATE_ILLEGAL", Message: "x", RequestId: "r" },
    });
    const error = await rpcError(admin.alerts.testChannel({ id: channel.id }));
    expect(error.code).toBe("ALERT_SMS_REJECTED");
    expect(error.data).toMatchObject({ code: "isv.SMS_TEMPLATE_ILLEGAL" });
    // A provider body that is not JSON keeps the HTTP status.
    provider.replies.push({ status: 503, body: "<html>" });
    expect((await rpcError(admin.alerts.testChannel({ id: channel.id }))).data).toMatchObject({
      code: "http_503",
    });
    provider.calls.length = 0;
    provider.replies.push({ status: 200, body: { Code: "isv.PARAM_NOT_SUPPORT_URL" } });
    await ctx.db.insert(schema.nodeMinuteStats).values({
      minute: new Date(Math.floor(Date.now() / 60_000) * 60_000),
      nodeId: crypto.randomUUID(),
      siteId,
      requests: 200,
      statusCodes: { "502": 200 },
    });
    const sub = await admin.alerts.subscribe({
      channelId: channel.id,
      kinds: ["high_5xx"],
      siteIds: [siteId],
    });
    await sweepAlerts(ctx);
    const sites = provider.calls.map(
      (c) => JSON.parse(new URL(c.url).searchParams.get("TemplateParam") ?? "{}").site,
    );
    expect(sites).toEqual(["shop.example", "shop example"]);
    const [delivery] = await ctx.db
      .select()
      .from(schema.alertDelivery)
      .where(eq(schema.alertDelivery.channelId, channel.id));
    expect(delivery).toMatchObject({ status: "sent", attempts: 1 });
    await admin.alerts.unsubscribe({ id: sub.id });
    await admin.alerts.deleteChannel({ id: channel.id });
    await ctx.db.delete(schema.nodeMinuteStats);
    await ctx.db.delete(schema.alertState);
  });

  it("sends Tencent SendSms with TC3 headers and accepts a partial success", async () => {
    const channel = await admin.alerts.createChannel({ name: "Tencent", config: tencent });
    provider.calls.length = 0;
    provider.replies.push({
      status: 200,
      body: { Response: { SendStatusSet: [{ Code: "Ok" }], RequestId: "r" } },
    });
    await admin.alerts.testChannel({ id: channel.id });
    const call = provider.calls[0];
    if (!call) throw new Error("no request");
    expect(call.url).toBe("https://sms.tencentcloudapi.com/");
    expect(JSON.parse(call.body)).toEqual({
      PhoneNumberSet: ["+8613800000000"],
      SmsSdkAppId: "1400006666",
      SignName: "Edgeweir",
      TemplateId: "1110",
      // Six characters per variable by default.
      TemplateParamSet: ["Edgewe", "测试通知", "告警中"],
    });
    expect(call.headers).toMatchObject({
      "x-tc-action": "SendSms",
      "x-tc-version": "2021-01-11",
      "x-tc-region": "ap-beijing",
    });
    const expected = tc3Sign({
      secretId: tencent.secretId,
      secretKey: tencent.secretKey,
      service: "sms",
      timestamp: Number(call.headers["x-tc-timestamp"]),
      headers: {
        "content-type": "application/json; charset=utf-8",
        host: "sms.tencentcloudapi.com",
        "x-tc-action": "SendSms",
      },
      payload: call.body,
    });
    expect(call.headers.authorization).toBe(expected.authorization);
    // Some numbers received it: no error, nothing sent again.
    provider.replies.push({
      status: 200,
      body: {
        Response: {
          SendStatusSet: [{ Code: "LimitExceeded.PhoneNumberDailyLimit" }, { Code: "Ok" }],
        },
      },
    });
    await admin.alerts.testChannel({ id: channel.id });
    provider.replies.push({
      status: 200,
      body: { Response: { Error: { Code: "AuthFailure.SignatureFailure" }, RequestId: "r" } },
    });
    expect((await rpcError(admin.alerts.testChannel({ id: channel.id }))).data).toMatchObject({
      code: "AuthFailure.SignatureFailure",
    });
    provider.replies.push({
      status: 200,
      body: {
        Response: { SendStatusSet: [{ Code: "InvalidParameterValue.IncorrectPhoneNumber" }] },
      },
    });
    expect((await rpcError(admin.alerts.testChannel({ id: channel.id }))).data).toMatchObject({
      code: "InvalidParameterValue.IncorrectPhoneNumber",
    });
    await admin.alerts.deleteChannel({ id: channel.id });
  });

  it("limits sends per sliding hour and day, test sends included", async () => {
    const channel = await admin.alerts.createChannel({
      name: "Limited",
      config: { ...aliyun, hourlyLimit: 2, dailyLimit: 3 },
    });
    await admin.alerts.testChannel({ id: channel.id });
    await admin.alerts.testChannel({ id: channel.id });
    const limited = await rpcError(admin.alerts.testChannel({ id: channel.id }));
    expect(limited.code).toBe("ALERT_RATE_LIMITED");
    const [row] = await ctx.db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, channel.id));
    const first = row?.sendTimes[0]?.getTime() ?? 0;
    expect(new Date(String((limited.data as { retryAt: string }).retryAt)).getTime()).toBe(
      first + 3600_000,
    );
    // After the hour the daily limit still holds: 2 of 3 used.
    const later = first + 3600_001;
    await reserveSmsSend(ctx, channel.id, { hourlyLimit: 2, dailyLimit: 3 }, later);
    await expect(
      reserveSmsSend(ctx, channel.id, { hourlyLimit: 2, dailyLimit: 3 }, later + 1),
    ).rejects.toThrow(SmsRateLimitedError);
    // A day later the old sends no longer count and are dropped.
    await reserveSmsSend(ctx, channel.id, { hourlyLimit: 2, dailyLimit: 3 }, later + 86_400_000);
    const [after] = await ctx.db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, channel.id));
    expect(after?.sendTimes).toHaveLength(1);
    await admin.alerts.deleteChannel({ id: channel.id });
  });

  it("defers a limited delivery without counting it as an attempt", async () => {
    const channel = await admin.alerts.createChannel({
      name: "Deferred",
      config: { ...aliyun, hourlyLimit: 1 },
    });
    await admin.alerts.testChannel({ id: channel.id });
    const sub = await admin.alerts.subscribe({
      channelId: channel.id,
      kinds: ["high_5xx"],
      siteIds: [siteId],
    });
    await ctx.db.insert(schema.nodeMinuteStats).values({
      minute: new Date(Math.floor(Date.now() / 60_000) * 60_000),
      nodeId: crypto.randomUUID(),
      siteId,
      requests: 200,
      statusCodes: { "502": 200 },
    });
    provider.calls.length = 0;
    await sweepAlerts(ctx);
    expect(provider.calls).toHaveLength(0);
    const [delivery] = await ctx.db
      .select()
      .from(schema.alertDelivery)
      .where(eq(schema.alertDelivery.channelId, channel.id));
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: "alert_rate_limited",
    });
    expect(delivery?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    expect((await admin.alerts.channels()).find((c) => c.id === channel.id)?.lastError).toBe(
      "alert_rate_limited",
    );
    await admin.alerts.unsubscribe({ id: sub.id });
    await admin.alerts.deleteChannel({ id: channel.id });
    await ctx.db.delete(schema.nodeMinuteStats);
    await ctx.db.delete(schema.alertState);
  });

  it("waits an hour after a provider frequency control", async () => {
    const channel = await admin.alerts.createChannel({ name: "Provider limit", config: aliyun });
    const sub = await admin.alerts.subscribe({
      channelId: channel.id,
      kinds: ["high_5xx"],
      siteIds: [siteId],
    });
    await ctx.db.insert(schema.nodeMinuteStats).values({
      minute: new Date(Math.floor(Date.now() / 60_000) * 60_000),
      nodeId: crypto.randomUUID(),
      siteId,
      requests: 200,
      statusCodes: { "502": 200 },
    });
    provider.replies.push({ status: 200, body: { Code: "isv.BUSINESS_LIMIT_CONTROL" } });
    await sweepAlerts(ctx);
    const [delivery] = await ctx.db
      .select()
      .from(schema.alertDelivery)
      .where(eq(schema.alertDelivery.channelId, channel.id));
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "alert_sms_rejected:isv.BUSINESS_LIMIT_CONTROL",
    });
    expect(delivery?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    await admin.alerts.unsubscribe({ id: sub.id });
    await admin.alerts.deleteChannel({ id: channel.id });
    await ctx.db.delete(schema.nodeMinuteStats);
    await ctx.db.delete(schema.alertState);
  });
});
