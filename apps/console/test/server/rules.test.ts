import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { ruleInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
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

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-rules", name: "integration" },
};

describe("M4 rules and IP list boundaries", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient, siteId: string, otherSiteId: string, clusterId: string, listId: string;
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
    otherSiteId = (
      await admin.sites.create({
        name: "own",
        domains: ["own-rules.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
  });
  afterAll(() => db.close());
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  it("checks syntax with a character position and rejects invalid actions before publishing", async () => {
    expect(
      await admin.rules.validate({ expression: "http.host gt 5", phase: "waf-custom" }),
    ).toEqual({
      valid: false,
      position: 10,
      message: "ordered comparison needs integers",
      code: "ordered_comparison",
      params: {},
    });
    expect(
      await admin.rules.validate({ expression: "(ssl eq true", phase: "waf-custom" }),
    ).toMatchObject({ valid: false, code: "unexpected_end", position: 12 });
    expect(
      await admin.rules.validate({
        expression: 'http.host eq "own-rules.test"',
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
  it("lets the rules of any site use any list and refuses missing references and lists in use", async () => {
    await admin.rules.save({
      id: otherSiteId,
      rules: [
        {
          name: "foreign",
          phase: "waf-custom",
          expression: "ip.src in $blocked",
          action: { kind: "block" },
        },
      ],
    });
    const compiled = (await config()).sites.find((s) => s.id === otherSiteId)?.rules;
    expect(compiled?.[0]?.expression?.value).toBe(listId);
    expect(
      await rpcError(
        admin.rules.save({
          id: otherSiteId,
          rules: [
            {
              name: "missing",
              phase: "waf-custom",
              expression: "ip.src in $missing",
              action: { kind: "block" },
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "IP_LIST_REFERENCE_UNKNOWN", data: { lists: "missing" } });
    // The rules that use the list, with their sites.
    expect(await rpcError(admin.ipLists.delete({ id: listId }))).toMatchObject({
      code: "IP_LIST_IN_USE",
      data: { users: "foreign (own), block (rules)" },
    });
    await admin.rules.save({ id: otherSiteId, rules: [] });
  });
  it("applies lists to every site and prevents rollback from restoring old security policy", async () => {
    const target = Number((await config()).revision);
    const global = await admin.ipLists.create({
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
    expect((await admin.ipLists.list()).map((l) => l.name)).toEqual(["blocked", "global_block"]);
    await admin.ipLists.update({ id: listId, entries: ["198.51.100.0/24"], kind: "collection" });
    await admin.clusters.rollback({ id: clusterId, revision: target });
    const restored = await config();
    expect(restored.platformRules).toHaveLength(1);
    expect(restored.ipLists.find((l) => l.id === listId)?.entries).toEqual(["198.51.100.0/24"]);
    // Every list applies to every site, whichever site's rules use it.
    expect(restored.ipLists.find((l) => l.id === global.id)?.platform).toBe(true);
    expect(restored.ipLists.find((l) => l.id === listId)?.platform).toBe(true);
    await admin.ipLists.update({ id: global.id, entries: [], kind: "collection" });
    await admin.platformRules.save({ rules: [] });
    await admin.ipLists.delete({ id: global.id });
  });
  it("refuses rollback whose named list was removed and deletes unreferenced lists", async () => {
    const target = Number((await config()).revision);
    await admin.rules.save({ id: siteId, rules: [] });
    await admin.ipLists.delete({ id: listId });
    expect(
      (await rpcError(admin.clusters.rollback({ id: clusterId, revision: target }))).code,
    ).toBe("ROLLBACK_RESOURCE_UNAVAILABLE");
  });
  it("admits capabilities without the operator only after all active nodes support them; the operator may require them", async () => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "capability-admission",
        supportedFeatures: ["rules-v1"],
      })
      .returning();
    if (!node) throw new Error("missing node");
    const rules = [
      ruleInput.parse({
        name: "country",
        phase: "waf-custom",
        expression: 'ip.geoip.country eq "NZ"',
        action: { kind: "log" },
      }),
    ];
    const before = (await config()).revision;
    await expect(saveRules(ctx, otherSiteId, rules, service)).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
    });
    expect(await admin.rules.get({ id: otherSiteId })).toEqual([]);
    expect((await config()).revision).toBe(before);
    await admin.rules.save({
      id: siteId,
      rules: [
        { name: "ordinary", phase: "waf-custom", expression: "true", action: { kind: "log" } },
      ],
    });
    expect((await config()).revision).toBeGreaterThan(before);
    // IPinfo Lite answers country (reported as geoip-city-v1) and ASN, not subdivisions.
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1", "geoip-country-v1", "geoip-city-v1", "geoip-asn-v1"] })
      .where(eq(schema.node.id, node.id));
    await saveRules(ctx, otherSiteId, rules, service);
    expect((await config()).requiredFeatures).toContain("geoip-city-v1");
    const subdivision = [
      ruleInput.parse({
        name: "subdivision",
        phase: "waf-custom",
        expression: 'ip.geoip.subdivision eq "AUK"',
        action: { kind: "log" },
      }),
    ];
    await expect(saveRules(ctx, otherSiteId, subdivision, service)).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
    });
    // Subdivisions never enter requiredFeatures, so older nodes keep accepting the
    // configuration; for them geoip-city-v1 always meant a City MMDB.
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1", "geoip-city-v1"] })
      .where(eq(schema.node.id, node.id));
    await saveRules(ctx, otherSiteId, subdivision, service);
    expect((await config()).requiredFeatures).not.toContain("geoip-subdivision-v1");
    // The operator may deliberately require an upgrade the nodes lack.
    await admin.rules.save({ id: otherSiteId, rules: [] });
    expect((await config()).requiredFeatures).not.toContain("geoip-city-v1");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1"] })
      .where(eq(schema.node.id, node.id));
    await admin.rules.save({ id: otherSiteId, rules });
    expect((await config()).requiredFeatures).toContain("geoip-city-v1");
    await admin.rules.save({ id: otherSiteId, rules: [] });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node.id));
  });
  it("copies rules read from one site to another, keeping ids only within a scope", async () => {
    const saved = await admin.rules.save({
      id: siteId,
      rules: [
        {
          name: "a",
          phase: "waf-custom",
          expression: 'http.request.uri.path eq "/a"',
          action: { kind: "block" },
        },
        {
          name: "b",
          phase: "waf-custom",
          expression: 'http.request.uri.path eq "/b"',
          action: { kind: "block" },
        },
      ],
    });
    const read = await admin.rules.get({ id: siteId });
    expect(read.map((r) => r.id)).toEqual(saved.map((r) => r.id));
    // The same rules, ids included, saved to another site and to the platform.
    const copied = await admin.rules.save({ id: otherSiteId, rules: read });
    expect(copied.map((r) => r.name)).toEqual(["a", "b"]);
    expect(copied.some((r) => read.some((o) => o.id === r.id))).toBe(false);
    const platform = await admin.platformRules.save({ rules: read });
    expect(platform.some((r) => read.some((o) => o.id === r.id))).toBe(false);
    // Saving a site's own rules again keeps their ids.
    expect((await admin.rules.save({ id: siteId, rules: read })).map((r) => r.id)).toEqual(
      read.map((r) => r.id),
    );
    expect((await admin.rules.get({ id: otherSiteId })).map((r) => r.id)).toEqual(
      copied.map((r) => r.id),
    );
    const duplicate = [read[0], read[0]].map((r) => ({ ...r, name: "dup" })) as typeof read;
    expect((await rpcError(admin.rules.save({ id: otherSiteId, rules: duplicate }))).code).toBe(
      "RULE_INVALID",
    );
    await admin.rules.save({ id: siteId, rules: [] });
    await admin.rules.save({ id: otherSiteId, rules: [] });
    await admin.platformRules.save({ rules: [] });
  });
});
