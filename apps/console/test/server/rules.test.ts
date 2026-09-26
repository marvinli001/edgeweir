import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  approveSiteDomains,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("M4 rules and IP list boundaries", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient,
    tenant: ApiClient,
    siteId: string,
    otherSiteId: string,
    clusterId: string,
    listId: string;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "rules",
        domains: ["rules.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const org = await admin.organizations.create({ name: "Other", defaultClusterId: clusterId });
    await admin.users.create({
      name: "Other",
      email: "other@rules.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "other@rules.test"));
    otherSiteId = (
      await tenant.sites.create({
        name: "own",
        domains: ["own-tenant-rules.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    await approveSiteDomains(admin, otherSiteId);
  });
  afterAll(() => db.close());
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  it("checks syntax with a character position and rejects invalid actions before publishing", async () => {
    expect(
      await tenant.rules.validate({ expression: "http.host gt 5", phase: "waf-custom" }),
    ).toMatchObject({ valid: false, position: 10 });
    expect(
      await tenant.rules.validate({
        expression: 'http.host eq "own-tenant-rules.test"',
        phase: "waf-custom",
      }),
    ).toMatchObject({ valid: true });
    const before = (await config()).revision;
    expect(
      (
        await rpcError(
          admin.rules.save({
            id: siteId,
            rules: [
              {
                name: "invalid",
                phase: "waf-custom",
                expression: "true",
                action: { kind: "request_header", header: "host", value: "other.test" },
              },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    expect((await config()).revision).toBe(before);
  });
  it("normalizes IP lists, binds names to IDs, and publishes typed rules in phase order", async () => {
    const list = await admin.ipLists.create({
      name: "blocked",
      entries: ["192.0.2.123/24", "::ffff:192.0.2.5/120"],
    });
    listId = list.id;
    expect(list.entries).toEqual(["192.0.2.0/24"]);
    expect((await admin.ipLists.list()).some((l) => l.id === listId)).toBe(true);
    const saved = await admin.rules.save({
      id: siteId,
      rules: [
        {
          name: "response",
          phase: "response-transform",
          expression: "http.response.code ge 200",
          action: { kind: "response_header", header: "x-test", value: "yes" },
        },
        {
          name: "block",
          phase: "waf-custom",
          expression: "ip.src in $blocked",
          action: { kind: "block" },
        },
      ],
    });
    expect(await admin.rules.get({ id: siteId })).toEqual(saved);
    const compiled = (await config()).sites.find((s) => s.id === siteId)?.rules;
    expect(compiled?.map((r) => r.phase)).toEqual(["waf-custom", "response-transform"]);
    expect(compiled?.[0]?.expression?.value).toBe(listId);
    expect((await config()).requiredFeatures).toContain("rules-v1");
    expect(
      (
        await ctx.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, "site.rules_update"))
      ).length,
    ).toBeGreaterThan(0);
  });
  it("isolates tenant site rules and named lists, including update/delete and missing references", async () => {
    expect((await rpcError(tenant.rules.get({ id: siteId }))).status).toBe(404);
    expect((await rpcError(tenant.rules.save({ id: siteId, rules: [] }))).status).toBe(404);
    expect(await tenant.ipLists.list()).toEqual([]);
    expect(
      (await rpcError(tenant.ipLists.update({ id: listId, entries: [], kind: "collection" }))).code,
    ).toBe("IP_LIST_NOT_FOUND");
    expect((await rpcError(tenant.ipLists.delete({ id: listId }))).code).toBe("IP_LIST_NOT_FOUND");
    expect(
      (
        await rpcError(
          tenant.rules.save({
            id: otherSiteId,
            rules: [
              {
                name: "foreign",
                phase: "waf-custom",
                expression: "ip.src in $blocked",
                action: { kind: "block" },
              },
            ],
          }),
        )
      ).code,
    ).toBe("IP_LIST_NOT_FOUND");
    expect((await rpcError(admin.ipLists.delete({ id: listId }))).code).toBe("IP_LIST_IN_USE");
  });
  it("applies platform lists to every site and prevents rollback from restoring old security policy", async () => {
    const target = Number((await config()).revision);
    const platform = await admin.platformIpLists.create({
      name: "global_block",
      entries: ["203.0.113.0/24"],
      kind: "block",
    });
    await admin.platformRules.save({
      rules: [
        {
          name: "global",
          phase: "waf-custom",
          expression: "ip.src in $global_block",
          action: { kind: "block" },
        },
      ],
    });
    expect(await admin.platformRules.get()).toHaveLength(1);
    expect(await admin.platformIpLists.list()).toHaveLength(1);
    await admin.ipLists.update({ id: listId, entries: ["198.51.100.0/24"], kind: "collection" });
    await admin.clusters.rollback({ id: clusterId, revision: target });
    const restored = await config();
    expect(restored.platformRules).toHaveLength(1);
    expect(restored.ipLists.find((l) => l.id === listId)?.entries).toEqual(["198.51.100.0/24"]);
    expect(restored.ipLists.find((l) => l.id === platform.id)?.platform).toBe(true);
    await admin.platformIpLists.update({ id: platform.id, entries: [], kind: "collection" });
    await admin.platformRules.save({ rules: [] });
    await admin.platformIpLists.delete({ id: platform.id });
  });
  it("refuses rollback whose named list was removed and deletes unreferenced lists", async () => {
    const target = Number((await config()).revision);
    await admin.rules.save({ id: siteId, rules: [] });
    await admin.ipLists.delete({ id: listId });
    expect(
      (await rpcError(admin.clusters.rollback({ id: clusterId, revision: target }))).code,
    ).toBe("ROLLBACK_RESOURCE_UNAVAILABLE");
  });
});
