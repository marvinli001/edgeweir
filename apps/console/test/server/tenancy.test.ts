import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("overview, whole-site purge and tenant isolation", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let other: ApiClient;
  let clusterB: string;
  let tenantSiteId: string;
  let otherSiteId: string;

  const origins = [{ address: "origin.test", port: 8080 }];
  const revisionCount = async (clusterId: string) =>
    (await admin.clusters.revisions({ id: clusterId })).length;
  const auditCount = async (action: string) =>
    (await admin.auditLogs.list({ action, limit: 200 })).total;
  const taskCount = async () =>
    (await ctx.db.select({ n: count() }).from(schema.cacheTask))[0]?.n ?? 0;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterB = (await admin.clusters.create({ name: "edge-b" })).id;
    for (const [org, email] of [
      ["Tenant", "tina@tenant.test"],
      ["Other", "otto@other.test"],
    ] as const) {
      const created = await admin.organizations.create({ name: org, defaultClusterId: clusterB });
      await admin.users.create({
        name: org,
        email,
        password: PASSWORD,
        organizationId: created.id,
      });
    }
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    other = rpcClient(app, origin, await signIn(app, origin, "otto@other.test"));
    tenantSiteId = (
      await tenant.sites.create({ name: "tenant-shop", domains: ["shop.tenant.test"], origins })
    ).site.id;
    otherSiteId = (
      await other.sites.create({ name: "other-blog", domains: ["blog.other.test"], origins })
    ).site.id;
    await admin.sites.create({ name: "platform", domains: ["www.platform.test"], origins });
  });
  afterAll(() => pglite.close());

  it("overview.get counts the platform for administrators and only the organization's sites for tenants", async () => {
    const [defaultCluster] = await admin.clusters.list();
    await ctx.db.insert(schema.node).values([
      { clusterId: clusterB, name: "online", lastSeenAt: new Date() },
      { clusterId: defaultCluster?.id ?? "", name: "offline", lastSeenAt: new Date(0) },
      { clusterId: clusterB, name: "never-seen" },
    ]);

    const platform = await admin.overview.get();
    expect(platform).toMatchObject({ clusters: 2, nodes: 3, onlineNodes: 1, sites: 3 });
    expect(platform.revisions.length).toBeGreaterThan(0);
    expect(platform.revisions.length).toBeLessThanOrEqual(10);
    const times = platform.revisions.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(platform.revisions[0]).toMatchObject({
      reasonCode: "site_created",
      reasonParams: { site: "platform" },
    });

    // Tenants only learn about their own sites: no infrastructure, no revisions.
    expect(await tenant.overview.get()).toEqual({
      clusters: 0,
      nodes: 0,
      onlineNodes: 0,
      sites: 1,
      revisions: [],
    });
    expect((await other.overview.get()).sites).toBe(1);
  });

  it("sites.purgeAll bumps the cache generation, publishes a revision and audits it", async () => {
    const before = await tenant.sites.get({ id: tenantSiteId });
    const revisionsBefore = await revisionCount(clusterB);

    const { site, revision } = await tenant.sites.purgeAll({ id: tenantSiteId });
    expect(site.cacheGeneration).toBe(before.cacheGeneration + 1);
    expect(revision).toMatchObject({
      clusterId: clusterB,
      reasonCode: "site_purged",
      reasonParams: { site: "tenant-shop" },
      reason: "site tenant-shop purged",
    });
    expect(await revisionCount(clusterB)).toBe(revisionsBefore + 1);
    const ir = decodeNodeConfig((await latestRevision(ctx.db, clusterB))?.ir ?? new Uint8Array());
    expect(ir.revision).toBe(BigInt(revision.revision));
    expect(ir.sites.find((s) => s.id === tenantSiteId)?.cacheGeneration).toBe(
      BigInt(before.cacheGeneration + 1),
    );
    const [entry] = (await admin.auditLogs.list({ action: "site.purge_all" })).items;
    expect(entry).toMatchObject({
      actorName: "Tenant",
      targetType: "site",
      targetId: tenantSiteId,
      targetName: "tenant-shop",
      metadata: { cacheGeneration: before.cacheGeneration + 1, revision: revision.revision },
    });

    // Purging again bumps again: every purge is a new generation.
    const again = await tenant.sites.purgeAll({ id: tenantSiteId });
    expect(again.site.cacheGeneration).toBe(before.cacheGeneration + 2);
    expect(again.revision.revision).toBe(revision.revision + 1);
  });

  it("refuses to delete or purge another organization's site and changes nothing", async () => {
    const site = await admin.sites.get({ id: tenantSiteId });
    const revisions = await revisionCount(clusterB);
    const deletes = await auditCount("site.delete");
    const purges = await auditCount("site.purge_all");

    const deleted = await rpcError(other.sites.delete({ id: tenantSiteId }));
    expect(deleted).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    const purged = await rpcError(other.sites.purgeAll({ id: tenantSiteId }));
    expect(purged).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });

    // The site is untouched, nothing was published or audited.
    expect(await admin.sites.get({ id: tenantSiteId })).toEqual(site);
    expect(await revisionCount(clusterB)).toBe(revisions);
    expect(await auditCount("site.delete")).toBe(deletes);
    expect(await auditCount("site.purge_all")).toBe(purges);
    const [row] = await ctx.db.select().from(schema.site).where(eq(schema.site.id, tenantSiteId));
    expect(row?.cacheGeneration).toBe(site.cacheGeneration);

    // A tenant may delete its own site.
    const own = await other.sites.delete({ id: otherSiteId });
    expect(own.revision.reasonCode).toBe("site_deleted");
    expect((await rpcError(admin.sites.get({ id: otherSiteId }))).code).toBe("SITE_NOT_FOUND");
  });

  it("refuses cache tasks on another organization's site and never creates a partial task", async () => {
    const tasks = await taskCount();
    const purges = await auditCount("cache.purge");
    const ownSiteId = (
      await other.sites.create({ name: "other-own", domains: ["own.other.test"], origins })
    ).site.id;

    const whole = await rpcError(
      other.cacheTasks.create({ type: "site", siteIds: [tenantSiteId] }),
    );
    expect(whole).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    // Mixing an own site with a foreign one fails as a whole.
    const mixed = await rpcError(
      other.cacheTasks.create({ type: "site", siteIds: [ownSiteId, tenantSiteId] }),
    );
    expect(mixed.code).toBe("SITE_NOT_FOUND");
    for (const type of ["url", "prefix", "prefetch"] as const) {
      const byUrl = await rpcError(
        other.cacheTasks.create({ type, urls: ["http://shop.tenant.test/app/"] }),
      );
      expect(byUrl, type).toMatchObject({ code: "CACHE_TASK_HOST_UNKNOWN" });
    }
    expect(await taskCount()).toBe(tasks);
    expect(await auditCount("cache.purge")).toBe(purges);

    // The tenant's own task stays invisible to the other organization.
    const task = await tenant.cacheTasks.create({ type: "site", siteIds: [tenantSiteId] });
    expect((await rpcError(other.cacheTasks.get({ id: task.id }))).code).toBe(
      "CACHE_TASK_NOT_FOUND",
    );
    expect((await other.cacheTasks.list({ siteId: tenantSiteId })).total).toBe(0);
    expect((await other.cacheTasks.list({})).items.map((t) => t.id)).not.toContain(task.id);
    expect((await tenant.cacheTasks.get({ id: task.id })).sites).toEqual([
      { id: tenantSiteId, name: "tenant-shop" },
    ]);
  });
});
