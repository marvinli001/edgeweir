import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision, publishRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Accepted by the validator of earlier versions; \s now reads differently per engine.
const LEGACY = 'http.request.uri.path matches "^/a\\\\s"';

describe("stored rules the validator no longer accepts", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let otherId: string;

  const create = async (name: string) => {
    const id = (
      await admin.sites.create({
        name,
        domains: [`${name}.test`],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    return id;
  };
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const ruleAlert = async (ruleId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.alertState)
        .where(eq(schema.alertState.key, `config_rule_invalid/platform/${ruleId}`))
    )[0]?.active ?? false;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    siteId = await create("legacy");
    otherId = await create("other");
    clusterId = (await admin.sites.get({ id: siteId })).clusterId;
  });
  afterAll(() => pglite.close());

  it("refuses to publish with RULE_INVALID instead of failing with a server error", async () => {
    await ctx.db.insert(schema.edgeRule).values({
      siteId,
      name: "legacy-space",
      phase: "waf-custom",
      expression: LEGACY,
      priority: 1,
      action: { kind: "block", statusCode: 403 },
    });
    const error = await rpcError(admin.sites.update({ id: siteId, name: "legacy-2" }));
    expect(error.code).toBe("RULE_INVALID");
    expect(error.status).toBe(400);
    expect(error.message).toContain("legacy-space");
  });

  it("keeps the last compiled form of a refused rule when the change is about another site", async () => {
    // Compiled while it was valid; the validator of a later version refuses it.
    await admin.rules.save({
      id: siteId,
      rules: [
        {
          name: "admin",
          phase: "waf-custom",
          expression: 'http.request.uri.path eq "/admin"',
          action: { kind: "block" },
        },
      ],
    });
    const [rule] = await ctx.db
      .select()
      .from(schema.edgeRule)
      .where(eq(schema.edgeRule.siteId, siteId));
    if (!rule) throw new Error("rule missing");
    const compiled = (await config()).sites.find((s) => s.id === siteId)?.rules;
    await ctx.db
      .update(schema.edgeRule)
      .set({ expression: LEGACY })
      .where(eq(schema.edgeRule.id, rule.id));
    // Another site's change, an ACME challenge publication and the platform rules publish.
    const { revision } = await admin.sites.update({ id: otherId, name: "other-2" });
    const published = await config();
    expect(published.revision).toBe(BigInt(revision.revision));
    expect(published.sites.find((s) => s.id === otherId)?.name).toBe("other-2");
    expect(published.sites.find((s) => s.id === siteId)?.rules).toEqual(compiled);
    await ctx.db.transaction((tx) =>
      publishRevision(tx, { clusterId, reason: { code: "acme_challenge_updated", params: {} } }),
    );
    await admin.platformRules.save({ rules: [] });
    expect(await ruleAlert(rule.id)).toBe(true);
    const events = await admin.alerts.events({});
    expect(events.filter((e) => e.kind === "config_rule_invalid")).toEqual([
      expect.objectContaining({ siteId: null, status: "firing", siteName: "admin" }),
    ]);
    // A change about the rule's own site still refuses it.
    expect((await rpcError(admin.sites.update({ id: siteId, name: "legacy-3" }))).code).toBe(
      "RULE_INVALID",
    );
    // Rewriting the rule resolves the alert.
    await admin.rules.save({ id: siteId, rules: [] });
    expect(await ruleAlert(rule.id)).toBe(false);
  });

  it("compiles no rules of sites that are not served", async () => {
    await ctx.db.insert(schema.edgeRule).values({
      siteId: otherId,
      name: "other-space",
      phase: "waf-custom",
      expression: LEGACY,
      priority: 1,
      action: { kind: "block", statusCode: 403 },
    });
    await ctx.db.update(schema.site).set({ enabled: false }).where(eq(schema.site.id, otherId));
    await admin.sites.update({ id: siteId, name: "legacy-4" });
    expect((await config()).sites.map((s) => s.id)).toEqual([siteId]);
    const [rule] = await ctx.db
      .select()
      .from(schema.edgeRule)
      .where(and(eq(schema.edgeRule.siteId, otherId), eq(schema.edgeRule.name, "other-space")));
    expect(await ruleAlert(rule?.id ?? "")).toBe(false);
  });

  it("leaves out a served site whose refused rule was never compiled, with an alert", async () => {
    await ctx.db.update(schema.site).set({ enabled: true }).where(eq(schema.site.id, otherId));
    await admin.sites.update({ id: siteId, name: "legacy-5" });
    expect((await config()).sites.map((s) => s.id)).toEqual([siteId]);
    const [rule] = await ctx.db
      .select()
      .from(schema.edgeRule)
      .where(eq(schema.edgeRule.siteId, otherId));
    expect(await ruleAlert(rule?.id ?? "")).toBe(true);
  });

  it("keeps the last compiled condition of another site's refused cache rule", async () => {
    await ctx.db.delete(schema.edgeRule).where(eq(schema.edgeRule.siteId, otherId));
    await admin.sites.update({
      id: otherId,
      cacheRules: [{ expression: 'http.host eq "other.test"', edgeTtlSeconds: 60 }],
    });
    const compiled = (await config()).sites.find((s) => s.id === otherId)?.cacheRules;
    expect(compiled?.[0]?.match?.condition).toBeDefined();
    const [row] = await ctx.db
      .select()
      .from(schema.cacheRule)
      .where(eq(schema.cacheRule.siteId, otherId));
    if (!row) throw new Error("cache rule missing");
    await ctx.db
      .update(schema.cacheRule)
      .set({ expression: LEGACY })
      .where(eq(schema.cacheRule.id, row.id));
    await admin.sites.update({ id: siteId, name: "legacy-6" });
    expect((await config()).sites.find((s) => s.id === otherId)?.cacheRules).toEqual(compiled);
    expect(await ruleAlert(row.id)).toBe(true);
    expect((await rpcError(admin.sites.update({ id: otherId, name: "other-3" }))).code).toBe(
      "RULE_INVALID",
    );
  });
});
