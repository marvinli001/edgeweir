import {
  DELETED_RULE_LIMIT,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  RULE_VERSION_LIMIT,
  type RuleInput,
  ruleInput,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import { saveRules } from "../../src/server/services/rules";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const rule = (name: string, extra: Record<string, unknown> = {}): RuleInput =>
  ruleInput.parse({
    name,
    phase: "waf-custom",
    expression: `http.host eq "${name}.test"`,
    enabled: true,
    action: { kind: "block" },
    ...extra,
  });
const service = {
  actor: { type: "service_account" as const, id: "service-account-versions", name: "versions" },
};

describe("rule versions and restore", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient, siteId: string, otherSiteId: string, clusterId: string;
  const createSite = async (name: string) =>
    (
      await admin.sites.create({
        name,
        domains: [`${name}.versions.test`],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = await createSite("versions");
    otherSiteId = await createSite("other");
  });
  afterAll(() => db.close());
  const revision = async () => (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("records a version per created, changed or deleted rule, not per move", async () => {
    const [a, b] = await admin.rules.save({ id: siteId, rules: [rule("a"), rule("b")] });
    if (!a || !b) throw new Error("rules missing");
    expect(await admin.rules.versions({ id: siteId, ruleId: a.id })).toEqual([
      expect.objectContaining({
        ruleId: a.id,
        version: 1,
        change: "created",
        source: "ui",
        restoredFrom: null,
        rule: {
          name: "a",
          phase: "waf-custom",
          expression: a.expression,
          enabled: true,
          action: a.action,
        },
        actor: expect.objectContaining({ type: "user", name: expect.any(String) }),
      }),
    ]);
    // Moving rules only, or saving them unchanged, keeps their history.
    await admin.rules.save({ id: siteId, rules: [b, a] });
    await admin.rules.save({ id: siteId, rules: [b, a] });
    expect(await admin.rules.versions({ id: siteId, ruleId: a.id })).toHaveLength(1);
    await admin.rules.save({ id: siteId, rules: [b, { ...a, enabled: false }] });
    const versions = await admin.rules.versions({ id: siteId, ruleId: a.id });
    expect(versions.map((v) => [v.version, v.change, v.rule.enabled])).toEqual([
      [2, "updated", false],
      [1, "created", true],
    ]);
    expect(await admin.rules.versions({ id: siteId, ruleId: b.id })).toHaveLength(1);
    // The API is its own source.
    const key = await admin.accessKeys.create({ name: "versions", scope: "write" });
    const res = await api(key.key, "PUT", `/sites/${siteId}/rules`, { rules: [b] });
    expect(res.status).toBe(200);
    const listed = await api(key.key, "GET", `/sites/${siteId}/rules/${a.id}/versions`);
    expect(((await listed.json()) as { change: string; source: string }[])[0]).toMatchObject({
      change: "deleted",
      source: "api",
    });
    // Another site does not see the rule's versions.
    expect(await admin.rules.versions({ id: otherSiteId, ruleId: a.id })).toEqual([]);
  });

  it("restores a version in place as a new save: version, revision and audit", async () => {
    const [current] = await admin.rules.save({
      id: siteId,
      rules: [rule("restore", { expression: 'http.host eq "one.test"' })],
    });
    if (!current) throw new Error("rule missing");
    await admin.rules.save({
      id: siteId,
      rules: [{ ...current, expression: 'http.host eq "two.test"', name: "renamed" }],
    });
    const before = await revision();
    const rules = await admin.rules.restore({ id: siteId, ruleId: current.id, version: 1 });
    expect(rules).toEqual([{ ...current, expression: 'http.host eq "one.test"' }]);
    expect(await revision()).toBeGreaterThan(before);
    const [latest] = await admin.rules.versions({ id: siteId, ruleId: current.id });
    expect(latest).toMatchObject({
      version: 3,
      change: "updated",
      source: "restore",
      restoredFrom: 1,
      rule: { name: "restore", expression: 'http.host eq "one.test"' },
    });
    const audit = (await admin.auditLogs.list({ action: "site.rule_restore" })).items[0];
    expect(audit).toMatchObject({
      targetId: siteId,
      metadata: { rule: { id: current.id, name: "restore" }, version: 1, count: 1 },
    });
    expect(
      (await rpcError(admin.rules.restore({ id: siteId, ruleId: current.id, version: 9 }))).code,
    ).toBe("RULE_VERSION_NOT_FOUND");
    // Versions belong to their site.
    expect(
      (await rpcError(admin.rules.restore({ id: otherSiteId, ruleId: current.id, version: 1 })))
        .code,
    ).toBe("RULE_VERSION_NOT_FOUND");
  });

  it("lists deleted rules and restores one under its id after the last rule of its phase", async () => {
    const saved = await admin.rules.save({
      id: siteId,
      rules: [
        rule("keep-1"),
        rule("gone", { expression: 'http.host eq "gone.test"' }),
        rule("keep-2"),
        rule("late", {
          phase: "redirect",
          action: { kind: "redirect", value: "/late", statusCode: 302 },
        }),
      ],
    });
    const gone = saved.find((r) => r.name === "gone");
    if (!gone) throw new Error("rule missing");
    await admin.rules.save({ id: siteId, rules: saved.filter((r) => r.id !== gone.id) });
    const deleted = await admin.rules.deleted({ id: siteId });
    expect(deleted.find((v) => v.ruleId === gone.id)).toMatchObject({
      change: "deleted",
      version: 2,
      rule: { name: "gone" },
    });
    const restored = await admin.rules.restore({ id: siteId, ruleId: gone.id, version: 2 });
    expect(restored.map((r) => r.name)).toEqual(["keep-1", "keep-2", "gone", "late"]);
    expect(restored[2]?.id).toBe(gone.id);
    expect((await admin.rules.deleted({ id: siteId })).some((v) => v.ruleId === gone.id)).toBe(
      false,
    );
    expect((await admin.rules.versions({ id: siteId, ruleId: gone.id }))[0]).toMatchObject({
      version: 3,
      change: "created",
      source: "restore",
      restoredFrom: 2,
    });
  });

  it("refuses a restore past the rule limit and a version today's checks reject", async () => {
    const site = await createSite("limits");
    const [first] = await admin.rules.save({ id: site, rules: [rule("first")] });
    if (!first) throw new Error("rule missing");
    await admin.rules.save({ id: site, rules: [] });
    await admin.rules.save({
      id: site,
      rules: Array.from({ length: 64 }, (_, i) => rule(`r${i}`)),
    });
    expect(
      (await rpcError(admin.rules.restore({ id: site, ruleId: first.id, version: 2 }))).code,
    ).toBe("RULE_LIMIT_REACHED");
    await admin.rules.save({ id: site, rules: [] });
    // A version whose action no longer passes (stored before a check tightened).
    await ctx.db
      .update(schema.edgeRuleVersion)
      .set({
        rule: sql`jsonb_set(${schema.edgeRuleVersion.rule}, '{action}', '{"kind":"nonsense"}')`,
      })
      .where(eq(schema.edgeRuleVersion.ruleId, first.id));
    expect(
      (await rpcError(admin.rules.restore({ id: site, ruleId: first.id, version: 1 }))).code,
    ).toBe("RULE_INVALID");
    expect(await admin.rules.get({ id: site })).toEqual([]);
  });

  it("keeps the last versions of each rule and the most recently deleted rules", async () => {
    const site = await createSite("prune");
    let [current] = await saveRules(ctx, site, [rule("p0")], service);
    for (let i = 1; i <= RULE_VERSION_LIMIT + 4; i++) {
      if (!current) throw new Error("rule missing");
      [current] = await saveRules(ctx, site, [{ ...current, name: `p${i}` }], service);
    }
    if (!current) throw new Error("rule missing");
    const versions = await admin.rules.versions({ id: site, ruleId: current.id });
    expect(versions).toHaveLength(RULE_VERSION_LIMIT);
    expect(versions[0]?.version).toBe(RULE_VERSION_LIMIT + 5);
    expect(versions.at(-1)?.version).toBe(6);
    expect(versions[0]?.source).toBe("api");

    const batch = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => rule(`${prefix}${i}`));
    await saveRules(ctx, site, batch(64, "old"), service);
    await saveRules(ctx, site, [], service);
    await saveRules(ctx, site, batch(40, "new"), service);
    await saveRules(ctx, site, [], service);
    const deleted = await admin.rules.deleted({ id: site });
    expect(deleted).toHaveLength(DELETED_RULE_LIMIT);
    // The newest deletions first: the 40 new rules, then 60 of the old ones; the 4 others and
    // the renamed rule (deleted first) lost every version.
    expect(deleted.map((v) => v.rule.name.replace(/\d+$/, ""))).toEqual([
      ...Array(40).fill("new"),
      ...Array(60).fill("old"),
    ]);
    const counted = await ctx.db
      .selectDistinct({ ruleId: schema.edgeRuleVersion.ruleId })
      .from(schema.edgeRuleVersion)
      .where(eq(schema.edgeRuleVersion.siteId, site));
    expect(counted).toHaveLength(DELETED_RULE_LIMIT);
  });

  it("keeps platform rule history and restores a deleted platform rule", async () => {
    const [platform] = await admin.platformRules.save({ rules: [rule("platform")] });
    if (!platform) throw new Error("rule missing");
    await admin.platformRules.save({ rules: [] });
    expect((await admin.platformRules.deleted()).map((v) => v.ruleId)).toContain(platform.id);
    // Site and platform histories are apart.
    expect(await admin.rules.versions({ id: siteId, ruleId: platform.id })).toEqual([]);
    expect(await admin.platformRules.restore({ ruleId: platform.id, version: 2 })).toEqual([
      platform,
    ]);
    expect(
      (await admin.platformRules.versions({ ruleId: platform.id })).map((v) => v.change),
    ).toEqual(["created", "deleted", "created"]);
    expect((await admin.auditLogs.list({ action: "platform.rule_restore" })).items).toHaveLength(1);
  });

  it("records copied rules as copies on the target", async () => {
    const source = await createSite("copy-source");
    const target = await createSite("copy-target");
    await admin.rules.save({ id: source, rules: [rule("copied")] });
    const [old] = await admin.rules.save({ id: target, rules: [rule("replaced")] });
    if (!old) throw new Error("rule missing");
    await admin.sites.copySettings({ id: source, targetIds: [target], parts: ["rules"] });
    const [copied] = await admin.rules.get({ id: target });
    if (!copied) throw new Error("rule missing");
    expect((await admin.rules.versions({ id: target, ruleId: copied.id }))[0]).toMatchObject({
      change: "created",
      source: "copy",
    });
    expect((await admin.rules.deleted({ id: target }))[0]).toMatchObject({
      ruleId: old.id,
      source: "copy",
    });
  });

  it("lets the demo account read the history but not restore", async () => {
    await admin.settings.setDemo({ enabled: true });
    const demo = rpcClient(app, origin, await signIn(app, origin, DEMO_EMAIL, DEMO_PASSWORD));
    const deleted = await demo.rules.deleted({ id: siteId });
    const target = deleted[0];
    if (!target) throw new Error("no deleted rule");
    expect(await demo.rules.versions({ id: siteId, ruleId: target.ruleId })).not.toEqual([]);
    expect(await demo.platformRules.deleted()).toEqual(expect.any(Array));
    const before = await admin.rules.get({ id: siteId });
    expect(
      (
        await rpcError(
          demo.rules.restore({ id: siteId, ruleId: target.ruleId, version: target.version }),
        )
      ).code,
    ).toBe("DEMO_READ_ONLY");
    expect(
      (await rpcError(demo.platformRules.restore({ ruleId: target.ruleId, version: 1 }))).code,
    ).toBe("DEMO_READ_ONLY");
    expect(await admin.rules.get({ id: siteId })).toEqual(before);
  });
});
