import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { dnsFixture } from "./dns-fixture";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// CNAME prefixes against the provider zone of the cluster's automatic DNS:
// the zone check when a custom prefix is saved, the 24 hours a replaced
// prefix keeps while a provider switch is not applied, and which UUIDs an
// object may take.

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

describe("CNAME prefixes and the DNS zone", async () => {
  const { ctx, client: pglite } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let groupId = "";
  let zoneProvider = "";
  let otherProvider = "";
  const createSite = async (name: string) =>
    (
      await admin.sites.create({
        name,
        domains: [`${name}.customer.test`],
        origins: [{ address: "origin.test" }],
        clusterId,
      })
    ).site;
  const bind = (providerId: string, domain: string, lineAliases = false) =>
    admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "auto",
        providerId,
        domain,
        ttl: 60,
        lines: [{ name: "east", nodeGroupId: groupId }],
        lineAliases,
      },
    });
  const prefixOf = async (id: string) => (await admin.sites.get({ id })).cnamePrefix;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-z", { zones: ["z.test"] });
    dnsFixture.accounts.set("token-y", { zones: ["y.test"] });
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    groupId = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    zoneProvider = (
      await admin.dns.createProvider({
        name: "Zone",
        provider: "test",
        zone: "z.test",
        credentials: { api_token: "token-z" },
      })
    ).id;
    otherProvider = (
      await admin.dns.createProvider({
        name: "Other",
        provider: "test",
        zone: "y.test",
        credentials: { api_token: "token-y" },
      })
    ).id;
  });
  afterAll(() => pglite.close());

  it("refuses a custom prefix whose name holds a record of the zone the cluster does not manage", async () => {
    dnsFixture.set("token-z", "z.test", [
      { name: "www.edge", type: "A", data: "192.0.2.1", ttl: 600 },
      { name: "east.shop.edge", type: "TXT", data: "manual", ttl: 600 },
    ]);
    await bind(zoneProvider, "edge.z.test");
    const site = await createSite("zone");
    const www = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix: "www" }));
    expect([www.code, www.data]).toEqual(["CNAME_PREFIX_CONFLICT", { prefix: "www" }]);
    expect(await prefixOf(site.id)).toBe(site.cnamePrefix);
    expect((await admin.auditLogs.list({ action: "site.cname_update" })).items).toEqual([]);
    // Line targets count only with line aliases.
    expect((await admin.sites.setCnamePrefix({ id: site.id, prefix: "shop" })).prefix).toBe("shop");
    await bind(zoneProvider, "edge.z.test", true);
    await admin.sites.setCnamePrefix({ id: site.id });
    const alias = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix: "shop" }));
    expect(alias.code).toBe("CNAME_PREFIX_CONFLICT");
    await bind(zoneProvider, "edge.z.test");
    // A name another cluster manages at the provider is taken too.
    const other = (await admin.clusters.create({ name: "zone-other" })).id;
    await ctx.db.insert(schema.dnsManagedName).values({
      providerId: zoneProvider,
      clusterId: other,
      name: "theirs.edge",
      type: "CNAME",
    });
    const theirs = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix: "theirs" }));
    expect(theirs.code).toBe("CNAME_PREFIX_CONFLICT");
    // A name the cluster manages itself is its own record.
    await ctx.db.insert(schema.dnsManagedName).values({
      providerId: zoneProvider,
      clusterId,
      name: "mine.edge",
      type: "CNAME",
    });
    dnsFixture.set("token-z", "z.test", [
      ...dnsFixture.records("token-z", "z.test"),
      { name: "mine.edge", type: "CNAME", data: "all.edge.z.test", ttl: 60 },
    ]);
    expect((await admin.sites.setCnamePrefix({ id: site.id, prefix: "mine" })).prefix).toBe("mine");
    // Best effort: a provider that cannot be read does not block the save.
    dnsFixture.down.add("token-z");
    expect((await admin.sites.setCnamePrefix({ id: site.id, prefix: "www" })).prefix).toBe("www");
    dnsFixture.down.delete("token-z");
    // Regenerated prefixes and other bindings are not checked.
    await admin.sites.setCnamePrefix({ id: site.id });
    await admin.dns.saveBinding({
      clusterId,
      binding: { mode: "manual", providerId: null, domain: "edge.z.test", ttl: 60, lines: [] },
    });
    const calls = dnsFixture.calls.length;
    expect((await admin.sites.setCnamePrefix({ id: site.id, prefix: "www" })).prefix).toBe("www");
    expect(dnsFixture.calls.length).toBe(calls);
    await admin.sites.delete({ id: site.id });
    await ctx.db.delete(schema.dnsManagedName);
    await ctx.db.delete(schema.cnameRetired);
  });

  it("keeps a replaced prefix for 24 hours while a provider switch is not applied", async () => {
    dnsFixture.set("token-z", "z.test", []);
    await bind(zoneProvider, "edge.z.test");
    const site = await createSite("switch");
    await admin.dns.reconcile({ clusterId });
    const claimed = await ctx.db
      .select({ name: schema.dnsManagedName.name, providerId: schema.dnsManagedName.providerId })
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.clusterId, clusterId));
    expect(claimed).toContainEqual({ name: `${site.cnamePrefix}.edge`, providerId: zoneProvider });
    // Switched to another account (and domain); its first write has not happened yet.
    await bind(otherProvider, "edge.y.test");
    const replaced = await admin.sites.setCnamePrefix({ id: site.id });
    expect(replaced.retired.map((r) => r.prefix)).toEqual([site.cnamePrefix]);
    // A prefix no provider ever got is not kept.
    const again = await admin.sites.setCnamePrefix({ id: site.id });
    expect(again.retired.map((r) => r.prefix)).toEqual([site.cnamePrefix]);
    await admin.sites.delete({ id: site.id });
    await ctx.db.delete(schema.cnameRetired);
  });

  it("takes a UUID only as the object's own prefix from before CNAME prefixes while it resolves", async () => {
    await admin.dns.saveBinding({ clusterId, binding: { mode: "off" } });
    const site = await createSite("fresh");
    // A site created with a random prefix never had its id as prefix.
    const own = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix: site.id }));
    expect([own.code, own.data]).toEqual(["CNAME_PREFIX_INVALID", { prefix: site.id }]);
    expect(await prefixOf(site.id)).toBe(site.cnamePrefix);
    // An older site: its id is its prefix (no change), and taken back while it resolves.
    const legacy = await createSite("older");
    await ctx.db
      .update(schema.site)
      .set({ cnamePrefix: legacy.id })
      .where(eq(schema.site.id, legacy.id));
    expect((await admin.sites.setCnamePrefix({ id: legacy.id, prefix: legacy.id })).prefix).toBe(
      legacy.id,
    );
    await admin.sites.setCnamePrefix({ id: legacy.id });
    expect((await admin.sites.setCnamePrefix({ id: legacy.id, prefix: legacy.id })).prefix).toBe(
      legacy.id,
    );
    // Once its transition is over the id is gone for good.
    await admin.sites.setCnamePrefix({ id: legacy.id });
    await ctx.db
      .update(schema.cnameRetired)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.cnameRetired.siteId, legacy.id));
    const expired = await rpcError(
      admin.sites.setCnamePrefix({ id: legacy.id, prefix: legacy.id }),
    );
    expect([expired.code, expired.data]).toEqual(["CNAME_PREFIX_INVALID", { prefix: legacy.id }]);
  });
});
