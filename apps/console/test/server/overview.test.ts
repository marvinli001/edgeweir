import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("overview, whole-site purge and site deletion", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterB: string;
  let shopSiteId: string;
  let blogSiteId: string;

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
    shopSiteId = (
      await admin.sites.create({
        name: "shop",
        clusterId: clusterB,
        domains: ["shop.example.test"],
        origins,
      })
    ).site.id;
    blogSiteId = (
      await admin.sites.create({
        name: "blog",
        clusterId: clusterB,
        domains: ["blog.example.test"],
        origins,
      })
    ).site.id;
    await admin.sites.create({ name: "platform", domains: ["www.platform.test"], origins });
  });
  afterAll(() => pglite.close());

  it("overview.get counts clusters, nodes, online nodes, sites and the latest revisions", async () => {
    const [defaultCluster] = await admin.clusters.list();
    await ctx.db.insert(schema.node).values([
      { clusterId: clusterB, name: "online", lastSeenAt: new Date() },
      { clusterId: defaultCluster?.id ?? "", name: "offline", lastSeenAt: new Date(0) },
      { clusterId: clusterB, name: "never-seen" },
    ]);

    const overview = await admin.overview.get();
    expect(overview).toMatchObject({ clusters: 2, nodes: 3, onlineNodes: 1, sites: 3 });
    expect(overview.revisions.length).toBeGreaterThan(0);
    expect(overview.revisions.length).toBeLessThanOrEqual(10);
    const times = overview.revisions.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(overview.revisions[0]).toMatchObject({
      reasonCode: "site_created",
      reasonParams: { site: "platform" },
    });
  });

  it("sites.purgeAll bumps the cache generation, publishes a revision and audits it", async () => {
    const before = await admin.sites.get({ id: shopSiteId });
    const revisionsBefore = await revisionCount(clusterB);

    const { site, revision } = await admin.sites.purgeAll({ id: shopSiteId });
    expect(site.cacheGeneration).toBe(before.cacheGeneration + 1);
    expect(revision).toMatchObject({
      clusterId: clusterB,
      reasonCode: "site_purged",
      reasonParams: { site: "shop" },
      reason: "site shop purged",
    });
    expect(await revisionCount(clusterB)).toBe(revisionsBefore + 1);
    const ir = decodeNodeConfig((await latestRevision(ctx.db, clusterB))?.ir ?? new Uint8Array());
    expect(ir.revision).toBe(BigInt(revision.revision));
    expect(ir.sites.find((s) => s.id === shopSiteId)?.cacheGeneration).toBe(
      BigInt(before.cacheGeneration + 1),
    );
    const [entry] = (await admin.auditLogs.list({ action: "site.purge_all" })).items;
    expect(entry).toMatchObject({
      actorName: "Platform Admin",
      targetType: "site",
      targetId: shopSiteId,
      targetName: "shop",
      metadata: { cacheGeneration: before.cacheGeneration + 1, revision: revision.revision },
    });

    // Purging again bumps again: every purge is a new generation.
    const again = await admin.sites.purgeAll({ id: shopSiteId });
    expect(again.site.cacheGeneration).toBe(before.cacheGeneration + 2);
    expect(again.revision.revision).toBe(revision.revision + 1);
  });

  it("deletes a site with a new revision and refuses to delete or purge it again", async () => {
    const deleted = await admin.sites.delete({ id: blogSiteId });
    expect(deleted.revision.reasonCode).toBe("site_deleted");
    expect((await rpcError(admin.sites.get({ id: blogSiteId }))).code).toBe("SITE_NOT_FOUND");

    const revisions = await revisionCount(clusterB);
    const deletes = await auditCount("site.delete");
    const purges = await auditCount("site.purge_all");
    const again = await rpcError(admin.sites.delete({ id: blogSiteId }));
    expect(again).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    const purged = await rpcError(admin.sites.purgeAll({ id: blogSiteId }));
    expect(purged).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    // Nothing was published or audited.
    expect(await revisionCount(clusterB)).toBe(revisions);
    expect(await auditCount("site.delete")).toBe(deletes);
    expect(await auditCount("site.purge_all")).toBe(purges);
  });

  it("refuses cache tasks on a deleted site and never creates a partial task", async () => {
    const tasks = await taskCount();
    const purges = await auditCount("cache.purge");

    const whole = await rpcError(admin.cacheTasks.create({ type: "site", siteIds: [blogSiteId] }));
    expect(whole).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    // Mixing a live site with a deleted one fails as a whole.
    const mixed = await rpcError(
      admin.cacheTasks.create({ type: "site", siteIds: [shopSiteId, blogSiteId] }),
    );
    expect(mixed.code).toBe("SITE_NOT_FOUND");
    for (const type of ["url", "prefix", "prefetch"] as const) {
      const byUrl = await rpcError(
        admin.cacheTasks.create({ type, urls: ["http://blog.example.test/app/"] }),
      );
      expect(byUrl, type).toMatchObject({ code: "CACHE_TASK_HOST_UNKNOWN" });
    }
    expect(await taskCount()).toBe(tasks);
    expect(await auditCount("cache.purge")).toBe(purges);

    const task = await admin.cacheTasks.create({ type: "site", siteIds: [shopSiteId] });
    expect((await admin.cacheTasks.get({ id: task.id })).sites).toEqual([
      { id: shopSiteId, name: "shop" },
    ]);
  });
});
