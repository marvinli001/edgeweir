import "reflect-metadata";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CHALLENGE_V2_FEATURE,
  decodeNodeConfig,
  RULES_BODY_FEATURE,
  WAF_V2_FEATURE,
} from "@edgeweir/config-compiler";
import type { RuleInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { ingestLogs, queryLogs } from "../../src/server/services/access-logs";
import { banChanges, listBans, reportAutoBans } from "../../src/server/services/bans";
import { updateSiteProtection } from "../../src/server/services/protection";
import { latestRevision } from "../../src/server/services/revisions";
import { saveRules } from "../../src/server/services/rules";
import { updateSite } from "../../src/server/services/sites";
import { updateSiteWaf } from "../../src/server/services/waf";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const service = {
  actor: { type: "service_account" as const, id: "service-account-g14", name: "integration" },
};
const FULL = ["tls-v1", "rules-v1", "rules-v2", "challenge-v1", "modsecurity-v1"];
const G14 = [WAF_V2_FEATURE, RULES_BODY_FEATURE, CHALLENGE_V2_FEATURE];

describe("WAF actions, request body, CRS by path, crawlers and challenges (G14)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return { row, ir: decodeNodeConfig(row.ir) };
  };
  const siteIr = async (id = siteId) => (await config()).ir.sites.find((s) => s.id === id);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const rule = (name: string, phase: RuleInput["phase"], expression: string, action: unknown) =>
    ({ name, phase, expression, enabled: true, action }) as RuleInput;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    for (const name of ["shop", "blog"]) {
      const id = (
        await admin.sites.create({
          name,
          domains: [`${name}.g14.test`],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      if (name === "shop") siteId = id;
      else otherSiteId = id;
    }
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g14",
        lastSeenAt: new Date(),
        supportedFeatures: [...FULL, ...G14],
      })
      .returning();
    nodeId = node?.id ?? "";
  });

  afterAll(() => pglite.close());

  describe("rule actions (8.1)", () => {
    it("saves every new action, compiles it with waf-v2 and keeps defaults compact", async () => {
      const saved = await admin.rules.save({
        id: siteId,
        rules: [
          rule("ban", "waf-custom", 'http.request.uri.path eq "/wp-login.php"', {
            kind: "ban",
            banSeconds: 3600,
            banPrefixV4: 24,
          }),
          rule("teapot", "waf-custom", 'http.request.uri.path eq "/teapot"', {
            kind: "respond",
            statusCode: 418,
            errorPage: true,
          }),
          rule("json", "waf-custom", 'http.request.uri.path eq "/api/ping"', {
            kind: "respond",
            statusCode: 200,
            contentType: "application/json",
            body: '{"ok":true}',
          }),
          rule("drop", "waf-custom", 'http.request.uri.path eq "/drop"', { kind: "close" }),
          rule("trusted", "waf-custom", "ip.src in {192.0.2.0/24}", {
            kind: "skip",
            skip: ["rules", "crs", "challenges"],
          }),
          rule("trace", "waf-custom", 'http.request.uri.path eq "/trace"', {
            kind: "log",
            accessLog: true,
          }),
          rule("login", "ratelimit", 'http.request.uri.path eq "/login"', {
            kind: "rate_limit",
            limit: 5,
            windowSeconds: 60,
            banSeconds: 600,
          }),
          rule("upload", "config", 'starts_with(http.request.uri.path, "/upload/")', {
            kind: "config",
            crs: "detect",
          }),
        ],
      });
      expect(saved.map((r) => r.action.kind)).toEqual([
        "ban",
        "respond",
        "respond",
        "close",
        "skip",
        "log",
        "rate_limit",
        "config",
      ]);
      expect(saved[0]?.action).toMatchObject({
        banSeconds: 3600,
        banScope: "site",
        banPrefixV4: 24,
        banPrefixV6: 64,
      });
      const ir = await siteIr();
      const actions = Object.fromEntries(
        (ir?.rules ?? []).map((r) => [
          r.action?.kind === "respond" ? `respond-${r.action.statusCode}` : r.action?.kind,
          r.action,
        ]),
      );
      expect(actions.ban).toMatchObject({
        banSeconds: 3600,
        banScope: "",
        banPrefixV4: 24,
        banPrefixV6: 0,
      });
      expect(actions["respond-418"]).toMatchObject({ errorPage: true, contentType: "", body: "" });
      expect(actions["respond-200"]).toMatchObject({
        contentType: "application/json",
        body: '{"ok":true}',
      });
      expect(actions.skip?.skip).toEqual(["challenges", "crs", "rules"]);
      expect(actions.log?.accessLog).toBe(true);
      expect(actions.rate_limit?.banSeconds).toBe(600);
      expect(actions.config?.crs).toBe("detect");
      expect((await config()).ir.requiredFeatures).toContain(WAF_V2_FEATURE);
      expect((await config()).ir.requiredFeatures).not.toContain(RULES_BODY_FEATURE);
    });

    it("refuses actions nodes could not run", async () => {
      const refused = async (action: unknown, phase: RuleInput["phase"] = "waf-custom") =>
        (
          await rpcError(
            admin.rules.save({ id: siteId, rules: [rule("x", phase, "true", action)] }),
          )
        ).code;
      for (const action of [
        { kind: "ban", banSeconds: 59 },
        { kind: "ban", banSeconds: 604801 },
        { kind: "ban", banSeconds: 600, banPrefixV4: 15 },
        { kind: "ban", banSeconds: 600, banPrefixV6: 65 },
        { kind: "ban", banSeconds: 600, banScope: "platform" },
        { kind: "respond", statusCode: 302 },
        { kind: "respond", statusCode: 200, errorPage: true },
        { kind: "respond", statusCode: 403, errorPage: true, body: "x" },
        { kind: "respond", statusCode: 204, body: "x" },
        { kind: "respond", statusCode: 200, contentType: "text/xml" },
        { kind: "respond", statusCode: 200, body: "x".repeat(8193) },
        { kind: "respond", statusCode: 200, body: "a\u0000b" },
        { kind: "skip", skip: [] },
        { kind: "skip", skip: ["crs", "crs"] },
        { kind: "skip", skip: ["cache"] },
      ])
        expect(await refused(action), JSON.stringify(action)).toBe("BAD_REQUEST");
      expect(await refused({ kind: "close" }, "config")).toBe("BAD_REQUEST");
      expect(
        await refused(
          { kind: "rate_limit", limit: 5, windowSeconds: 60, banSeconds: 30 },
          "ratelimit",
        ),
      ).toBe("BAD_REQUEST");
      expect(await refused({ kind: "config", crs: "off" }, "cache")).toBe("BAD_REQUEST");
      // The service refuses a platform-scope ban for a site as well.
      expect(
        await rpcError(
          saveRules(
            ctx,
            siteId,
            [
              rule("p", "waf-custom", "true", {
                kind: "ban",
                banSeconds: 600,
                banScope: "platform",
                banPrefixV4: 32,
                banPrefixV6: 64,
              }),
            ],
            { actor: service.actor },
          ),
        ),
      ).toMatchObject({ code: "RULE_INVALID" });
    });

    it("lets platform rules ban at platform scope", async () => {
      const saved = await admin.platformRules.save({
        rules: [
          rule("scanners", "waf-custom", 'starts_with(http.request.uri.path, "/.env")', {
            kind: "ban",
            banSeconds: 86400,
            banScope: "platform",
            banPrefixV6: 48,
          }),
        ],
      });
      expect(saved[0]?.action).toMatchObject({ banScope: "platform", banPrefixV6: 48 });
      expect((await config()).ir.platformRules[0]?.action).toMatchObject({
        kind: "ban",
        banScope: "platform",
        banPrefixV4: 0,
        banPrefixV6: 48,
      });
      await admin.platformRules.save({ rules: [] });
    });
  });

  describe("request body fields (8.2)", () => {
    it("compiles the rules body limit only for sites whose rules read the body", async () => {
      expect((await admin.sites.get({ id: siteId })).contentSettings.rulesBodyLimit).toBe(65536);
      expect((await siteIr())?.rulesBodyLimit).toBe(0);
      const current = (await admin.sites.get({ id: siteId })).contentSettings;
      await admin.sites.update({
        id: siteId,
        contentSettings: { ...current, rulesBodyLimit: 131072 },
      });
      // Not read by any rule yet: nothing changes on the nodes.
      expect((await siteIr())?.rulesBodyLimit).toBe(0);
      const rules = await admin.rules.get({ id: siteId });
      await admin.rules.save({
        id: siteId,
        rules: [
          ...rules,
          rule("admin form", "waf-custom", 'form_value("user") eq "admin"', {
            kind: "block",
            statusCode: 403,
          }),
          rule("tenant", "origin", "true", {
            kind: "request_header",
            header: "x-tenant",
            expression: 'json_value("tenant")',
          }),
        ],
      });
      expect((await siteIr())?.rulesBodyLimit).toBe(131072);
      expect((await siteIr(otherSiteId))?.rulesBodyLimit).toBe(0);
      expect((await config()).ir.requiredFeatures).toContain(RULES_BODY_FEATURE);
      // Omitting the limit keeps it; the bounds are 1 KiB and 1 MiB.
      const { rulesBodyLimit: _, ...withoutLimit } = current;
      await admin.sites.update({ id: siteId, contentSettings: withoutLimit });
      expect((await admin.sites.get({ id: siteId })).contentSettings.rulesBodyLimit).toBe(131072);
      for (const rulesBodyLimit of [1023, 1_048_577])
        expect(
          (
            await rpcError(
              admin.sites.update({ id: siteId, contentSettings: { ...current, rulesBodyLimit } }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
      // Body fields are request fields: not in the cache phase nor the response phases.
      for (const [phase, expression] of [
        ["cache", 'form_value("q") eq "1"'],
        ["response-transform", 'http.request.body.raw contains "x"'],
        ["compression", "http.request.bot.verified eq true"],
      ] as const) {
        const action =
          phase === "cache"
            ? { kind: "config", cacheBypass: true }
            : phase === "compression"
              ? { kind: "compression", algorithms: [] }
              : { kind: "response_header", header: "x-a", value: "1" };
        expect(
          (
            await rpcError(
              admin.rules.save({ id: siteId, rules: [rule("x", phase, expression, action)] }),
            )
          ).code,
          phase,
        ).toBe("BAD_REQUEST");
      }
      expect(
        await admin.rules.validate({
          expression: 'json_value("a..b") eq "x"',
          phase: "waf-custom",
        }),
      ).toMatchObject({ valid: false, code: "json_path" });
      expect(
        await admin.rules.validate({ expression: 'form_value("q") eq "x"', phase: "cache" }),
      ).toMatchObject({ valid: false, code: "request_field" });
    });
  });

  describe("CRS by path (8.3)", () => {
    it("saves exclusion entries, splits them for the nodes and refuses evaluation rules", async () => {
      const saved = await admin.waf.update({
        id: siteId,
        mode: "block",
        exclusions: [
          { ruleIds: [942100, 920350] },
          { path: "/api/", ruleIds: [942100, 941100] },
          { path: "/login", exact: true, ruleIds: [942100], targets: ["ARGS:password"] },
          { ruleIds: [932100], targets: ["REQUEST_COOKIES:session"] },
        ],
      });
      expect(saved.exclusions).toEqual([
        { path: "", exact: false, ruleIds: [920350, 942100], targets: [] },
        { path: "/api/", exact: false, ruleIds: [941100, 942100], targets: [] },
        { path: "/login", exact: true, ruleIds: [942100], targets: ["ARGS:password"] },
        { path: "", exact: false, ruleIds: [932100], targets: ["REQUEST_COOKIES:session"] },
      ]);
      const waf = (await siteIr())?.waf;
      expect(waf?.excludedRuleIds).toEqual([920350, 942100]);
      expect(waf?.exclusions.map((e) => [e.path, e.exact, e.ruleIds, e.targets])).toEqual([
        ["/api/", false, [941100, 942100], []],
        ["/login", true, [942100], ["ARGS:password"]],
        ["", false, [932100], ["REQUEST_COOKIES:session"]],
      ]);
      expect((await config()).ir.requiredFeatures).toEqual(
        expect.arrayContaining([WAF_V2_FEATURE, "modsecurity-v1"]),
      );
      expect(
        await rpcError(
          admin.waf.update({ id: siteId, exclusions: [{ path: "/a", ruleIds: [949110] }] }),
        ),
      ).toMatchObject({ code: "WAF_RULE_NOT_EXCLUDABLE", data: { ids: "949110" } });
      for (const exclusion of [
        { path: "a", ruleIds: [942100] },
        { path: "/a b", ruleIds: [942100] },
        { ruleIds: [942100], targets: ["ARGS:/x/"] },
        { ruleIds: [942100], targets: ["REQUEST_BODY:x"] },
      ])
        expect(
          (await rpcError(admin.waf.update({ id: siteId, exclusions: [exclusion] }))).code,
          JSON.stringify(exclusion),
        ).toBe("BAD_REQUEST");
      const [audit] = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "site.waf_update"));
      expect(audit?.metadata).toMatchObject({ to: { exclusions: saved.exclusions } });
    });
  });

  describe("crawlers and challenges (8.4)", () => {
    it("saves the crawler, text and failure settings and compiles them with challenge-v2", async () => {
      const read = await admin.protection.get({ id: siteId });
      expect(read).toMatchObject({
        allowVerifiedBots: false,
        challengeText: { titleZh: "", hintZh: "", titleEn: "", hintEn: "" },
        failureBan: { enabled: false, threshold: 10, banSeconds: 600 },
      });
      const saved = await admin.protection.update({
        id: siteId,
        underAttack: true,
        allowVerifiedBots: true,
        challengeText: { titleZh: " 访问验证 ", hintZh: "请稍候", titleEn: "Checking", hintEn: "" },
        failureBan: { enabled: true, threshold: 5, banSeconds: 900 },
      });
      expect(saved.challengeText).toEqual({
        titleZh: "访问验证",
        hintZh: "请稍候",
        titleEn: "Checking",
        hintEn: "",
      });
      expect((await siteIr())?.protection).toMatchObject({
        underAttack: true,
        allowVerifiedBots: true,
        failureThreshold: 5,
        failureBanSeconds: 900,
        challengeText: { titleZh: "访问验证", hintZh: "请稍候", titleEn: "Checking", hintEn: "" },
      });
      expect((await config()).ir.requiredFeatures).toContain(CHALLENGE_V2_FEATURE);
      for (const input of [
        { failureBan: { enabled: true, threshold: 2, banSeconds: 600 } },
        { failureBan: { enabled: true, threshold: 101, banSeconds: 600 } },
        { failureBan: { enabled: true, threshold: 5, banSeconds: 59 } },
        { challengeText: { titleZh: "长".repeat(201) } },
        { challengeText: { hintEn: "a\nb" } },
      ])
        expect(
          (await rpcError(admin.protection.update({ id: siteId, ...input } as never))).code,
          JSON.stringify(input),
        ).toBe("BAD_REQUEST");
      // Off again: the fields leave the configuration.
      const off = await admin.protection.update({
        id: siteId,
        allowVerifiedBots: false,
        challengeText: { titleZh: "", hintZh: "", titleEn: "", hintEn: "" },
        failureBan: { enabled: false, threshold: 5, banSeconds: 900 },
      });
      expect(off.failureBan).toEqual({ enabled: false, threshold: 5, banSeconds: 900 });
      const protection = (await siteIr())?.protection;
      expect(protection?.challengeText).toBeUndefined();
      expect(protection?.failureThreshold).toBe(0);
      expect(protection?.allowVerifiedBots).toBe(false);
    });
  });

  describe("bans made by rules and challenge failures", () => {
    it("stores rule bans with their rule, apart from automatic bans, and lists their source", async () => {
      const rules = await admin.rules.get({ id: siteId });
      const banRule = rules.find((r) => r.action.kind === "ban");
      const limitRule = rules.find((r) => r.action.kind === "rate_limit");
      const platform = await admin.platformRules.save({
        rules: [
          rule("platform ban", "waf-custom", 'http.request.uri.path eq "/.env"', {
            kind: "ban",
            banSeconds: 3600,
            banScope: "platform",
          }),
        ],
      });
      const platformRule = platform[0]?.id ?? "";
      const node = { id: nodeId, clusterId };
      const base = {
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        metric: "",
        observed: 0,
        threshold: 0,
        windowSeconds: 0,
      };
      const accepted = await reportAutoBans(ctx.db, node, [
        // The ban action at site scope, a /24.
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "198.51.100.0/24",
          reason: "waf_rule",
          ruleId: banRule?.id ?? "",
        },
        // A rate limit's ban and a CC ban of the same address: two entries.
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "203.0.113.7/32",
          reason: "rate_limit",
          metric: "rate_limit",
          observed: 6,
          threshold: 5,
          windowSeconds: 60,
          ruleId: limitRule?.id ?? "",
        },
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "203.0.113.7/32",
          reason: "cc_ip_rate",
          metric: "ip_qps",
        },
        // Challenge failures: automatic.
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "203.0.113.8/32",
          reason: "challenge_failures",
          metric: "challenge_failures",
          observed: 5,
          threshold: 5,
          windowSeconds: 600,
        },
        // A platform rule's ban at platform scope.
        {
          ...base,
          scope: "platform",
          siteId: "",
          cidr: "192.0.2.200/32",
          reason: "waf_rule",
          ruleId: platformRule,
        },
      ]);
      expect(accepted).toBe(5);
      // Refused: a site rule's ban at platform scope, a rule of another site, no rule, unknown
      // rule, prefixes rules may not ban, an automatic reason with a rule prefix.
      const refused = await reportAutoBans(ctx.db, node, [
        {
          ...base,
          scope: "platform",
          siteId: "",
          cidr: "192.0.2.201/32",
          reason: "waf_rule",
          ruleId: banRule?.id ?? "",
        },
        {
          ...base,
          scope: "site",
          siteId: otherSiteId,
          cidr: "192.0.2.202/32",
          reason: "waf_rule",
          ruleId: banRule?.id ?? "",
        },
        { ...base, scope: "site", siteId, cidr: "192.0.2.203/32", reason: "waf_rule" },
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "192.0.2.204/32",
          reason: "waf_rule",
          ruleId: crypto.randomUUID(),
        },
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "10.0.0.0/15",
          reason: "waf_rule",
          ruleId: banRule?.id ?? "",
        },
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "2001:db8::/96",
          reason: "waf_rule",
          ruleId: banRule?.id ?? "",
        },
        { ...base, scope: "site", siteId, cidr: "198.51.100.0/24", reason: "cc_ip_rate" },
        {
          ...base,
          scope: "site",
          siteId,
          cidr: "192.0.2.205/32",
          reason: "cc_ip_rate",
          ruleId: banRule?.id ?? "",
        },
      ]);
      expect(refused).toBe(0);
      const rows = await listBans(ctx.db, { page: 1, pageSize: 50 });
      const by = (cidr: string, source: string) =>
        rows.items.find((b) => b.cidr === cidr && b.source === source);
      expect(by("198.51.100.0/24", "rule")).toMatchObject({
        reason: "waf_rule",
        scope: "site",
        rule: { id: banRule?.id, name: "ban", platform: false },
        trigger: { ruleId: banRule?.id },
      });
      expect(by("203.0.113.7/32", "rule")).toMatchObject({
        reason: "rate_limit",
        rule: { name: "login" },
        trigger: { metric: "rate_limit", observed: 6, threshold: 5, windowSeconds: 60 },
      });
      expect(by("203.0.113.7/32", "auto")).toMatchObject({ reason: "cc_ip_rate", rule: null });
      expect(by("203.0.113.8/32", "auto")).toMatchObject({ reason: "challenge_failures" });
      expect(by("192.0.2.200/32", "rule")).toMatchObject({
        scope: "platform",
        rule: { id: platformRule, platform: true },
      });
      const filtered = await listBans(ctx.db, { source: "rule", page: 1, pageSize: 50 });
      expect(filtered.items.every((b) => b.source === "rule")).toBe(true);
      expect(filtered.total).toBe(3);
      // A repeated report only extends; nodes get rule bans as automatic ones.
      expect(
        await reportAutoBans(ctx.db, node, [
          {
            ...base,
            scope: "site",
            siteId,
            cidr: "198.51.100.0/24",
            reason: "waf_rule",
            ruleId: banRule?.id ?? "",
          },
        ]),
      ).toBe(1);
      expect((await listBans(ctx.db, { source: "rule", page: 1, pageSize: 50 })).total).toBe(3);
      const page = await banChanges(ctx.db, node, 0n, 1000);
      expect(page.bans.some((b) => b.cidr === "198.51.100.0/24" && b.source === "rule")).toBe(true);
      // The rule's name follows renames; a deleted rule leaves the ban with its id only.
      await admin.platformRules.save({ rules: [] });
      expect(
        (await listBans(ctx.db, { scope: "platform", page: 1, pageSize: 50 })).items.find(
          (b) => b.cidr === "192.0.2.200/32",
        )?.rule,
      ).toEqual({ id: platformRule, name: null, platform: true });
      // Lifting a rule ban the node holds as its own sends the release.
      const own = by("198.51.100.0/24", "rule");
      await admin.bans.delete({ id: own?.id ?? "" });
      const after = await banChanges(ctx.db, node, page.sequence, 1000);
      expect(after.removedIds).toContain(own?.id);
    });
  });

  describe("access log lines from log rules", () => {
    it("keeps lines of sites that do not sample when a log rule writes them, with the rule ids", async () => {
      const trace = (await admin.rules.get({ id: siteId })).find((r) => r.action.kind === "log");
      expect((await admin.sites.get({ id: siteId })).id).toBe(siteId);
      const now = Date.now();
      const entry = (ruleIds: string[]) =>
        create(AccessLogSchema, {
          siteId,
          time: timestampFromDate(new Date(now)),
          clientIp: "192.0.2.10",
          method: "POST",
          host: "shop.g14.test",
          path: "/trace",
          status: 200,
          bytesSent: 10n,
          durationMs: 1,
          sampleRate: 10000,
          cacheStatus: "",
          ruleIds,
        });
      const ids = [trace?.id ?? "", "not-a-uuid", (trace?.id ?? "").toUpperCase()];
      expect(await ingestLogs(ctx, { id: nodeId, clusterId }, 1n, [entry(ids)], now)).toBe(1);
      const found = await queryLogs(ctx, {
        siteId,
        from: new Date(now - 60_000).toISOString(),
        to: new Date(now + 60_000).toISOString(),
        ip: "",
        path: "",
        limit: 10,
      });
      expect(found.entries[0]?.ruleIds).toEqual([trace?.id]);
      // Without such a rule a site that does not sample keeps nothing.
      expect(
        await ingestLogs(
          ctx,
          { id: nodeId, clusterId },
          2n,
          [create(AccessLogSchema, { ...entry([]), siteId: otherSiteId })],
          now,
        ),
      ).toBe(0);
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "g14-ro", scope: "read" })).key;
    const account = await admin.serviceAccounts.create({
      name: "g14-integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    for (const path of [
      `/sites/${siteId}/rules`,
      `/sites/${siteId}/waf`,
      `/sites/${siteId}/protection`,
      "/bans?source=rule",
      `/sites/${siteId}/logs?from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`,
    ]) {
      expect((await api(reader, "GET", path)).status, path).toBe(200);
      const refusedKey = await api(key, "GET", path);
      expect([refusedKey.status, refusedKey.json.code], path).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    for (const [method, path, body] of [
      ["PUT", `/sites/${siteId}/rules`, { rules: [] }],
      ["PATCH", `/sites/${siteId}/waf`, { exclusions: [] }],
      ["PATCH", `/sites/${siteId}/protection`, { allowVerifiedBots: true }],
      ["PUT", "/platform-rules", { rules: [] }],
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
    expect((await admin.rules.get({ id: siteId })).length).toBeGreaterThan(0);
    expect((await admin.waf.get({ id: siteId })).exclusions.length).toBe(4);
  });
  describe("nodes (0.4)", () => {
    it("holds G14 settings for changes without the operator while a node lacks the feature", async () => {
      // Only requirements a change adds are held: the operator clears every G14 setting first.
      await admin.rules.save({ id: siteId, rules: [] });
      await admin.waf.update({ id: siteId, mode: "off", exclusions: [] });
      await admin.protection.update({ id: siteId, underAttack: false });
      expect((await config()).ir.requiredFeatures).not.toEqual(
        expect.arrayContaining([WAF_V2_FEATURE]),
      );
      for (const feature of G14)
        expect((await config()).ir.requiredFeatures).not.toContain(feature);
      await setNodeFeatures(FULL);
      try {
        const features = await admin.sites.features({ id: siteId });
        expect([features.wafV2, features.rulesBody, features.challengeV2]).toEqual([
          { available: false, reason: "nodes" },
          { available: false, reason: "nodes" },
          { available: false, reason: "nodes" },
        ]);
        const before = (await config()).row.revision;
        const holds = [
          () =>
            updateSiteWaf(
              ctx.db,
              {
                id: otherSiteId,
                mode: "detect",
                exclusions: [{ path: "/x", exact: false, ruleIds: [942100], targets: [] }],
              },
              service,
            ),
          () =>
            saveRules(
              ctx,
              otherSiteId,
              [
                rule("body", "waf-custom", 'form_value("q") eq "1"', {
                  kind: "block",
                  statusCode: 403,
                }),
              ],
              service,
            ),
          () =>
            updateSiteProtection(
              ctx.db,
              { id: otherSiteId, underAttack: true, allowVerifiedBots: true },
              service,
            ),
        ];
        for (const [i, call] of holds.entries())
          expect(await rpcError(call()), String(i)).toMatchObject({
            code: "NODE_CAPABILITY_REQUIRED",
          });
        expect((await config()).row.revision).toBe(before);
        // The operator's saves still publish (nodes keep their last good configuration).
        await updateSite(
          ctx.db,
          { id: otherSiteId, name: "blog" },
          { actor: { type: "user", id: "user_admin", name: "admin" }, masterKey: ctx.masterKey },
        );
      } finally {
        await setNodeFeatures([...FULL, ...G14]);
      }
    });
  });
});
