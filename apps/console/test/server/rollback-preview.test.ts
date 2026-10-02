import { schema } from "@edgeweir/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("rollback preview", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let shop: string;
  let blog: string;
  /** Revisions: 1 cluster, 2 shop created, 3 blog created, 4 shop updated. */
  const REV_SHOP = 2;
  const REV_BLOG = 3;
  const REV_UPDATED = 4;

  const rows = async () => {
    const [revisions] = await ctx.db.select({ n: count() }).from(schema.configRevision);
    const [audits] = await ctx.db.select({ n: count() }).from(schema.auditLog);
    const [keys] = await ctx.db
      .select({ n: count() })
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.clusterId, clusterId));
    return { revisions: revisions?.n, audits: audits?.n, keys: keys?.n };
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const origins = [{ address: "origin.test" }];
    const created = await admin.sites.create({ name: "shop", domains: ["shop.test"], origins });
    shop = created.site.id;
    expect(created.revision.revision).toBe(REV_SHOP);
    const second = await admin.sites.create({ name: "blog", domains: ["blog.test"], origins });
    blog = second.site.id;
    expect(second.revision.revision).toBe(REV_BLOG);
    const updated = await admin.sites.update({
      id: shop,
      cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 60 }],
    });
    expect(updated.revision.revision).toBe(REV_UPDATED);
  });
  afterAll(() => pglite.close());

  it("lists the sites a rollback adds, changes and removes against the latest revision", async () => {
    expect(await admin.clusters.rollbackPreview({ id: clusterId, revision: REV_SHOP })).toEqual({
      revision: REV_SHOP,
      currentRevision: REV_UPDATED,
      unchanged: false,
      sites: {
        added: [],
        changed: [{ id: shop, name: "shop" }],
        removed: [{ id: blog, name: "blog" }],
      },
    });
    expect(await admin.clusters.rollbackPreview({ id: clusterId, revision: REV_BLOG })).toEqual({
      revision: REV_BLOG,
      currentRevision: REV_UPDATED,
      unchanged: false,
      sites: { added: [], changed: [{ id: shop, name: "shop" }], removed: [] },
    });
    // The cluster's first revision had no site at all.
    expect(
      (await admin.clusters.rollbackPreview({ id: clusterId, revision: 1 })).sites.removed,
    ).toEqual([
      { id: blog, name: "blog" },
      { id: shop, name: "shop" },
    ]);
    expect(await admin.clusters.rollbackPreview({ id: clusterId, revision: REV_UPDATED })).toEqual({
      revision: REV_UPDATED,
      currentRevision: REV_UPDATED,
      unchanged: true,
      sites: { added: [], changed: [], removed: [] },
    });
  });

  it("refuses like the rollback would", async () => {
    expect(
      (await rpcError(admin.clusters.rollbackPreview({ id: clusterId, revision: 999 }))).code,
    ).toBe("REVISION_NOT_FOUND");
    // A domain the site no longer has cannot come back.
    await admin.sites.update({ id: blog, domains: ["news.test"] });
    const refused = await rpcError(
      admin.clusters.rollbackPreview({ id: clusterId, revision: REV_BLOG }),
    );
    expect(refused.code).toBe("ROLLBACK_RESOURCE_UNAVAILABLE");
    expect(
      (await rpcError(admin.clusters.rollback({ id: clusterId, revision: REV_BLOG }))).code,
    ).toBe("ROLLBACK_RESOURCE_UNAVAILABLE");
  });

  it("writes nothing that persists", async () => {
    // A revision whose site is under attack needs challenge keys.
    await admin.protection.update({ id: shop, underAttack: true });
    const attacked = (await admin.clusters.revisions({ id: clusterId }))[0]?.revision ?? 0;
    await admin.protection.update({ id: shop, underAttack: false });
    // Building the rollback content creates them again when they are gone.
    await ctx.db.delete(schema.challengeKey).where(eq(schema.challengeKey.clusterId, clusterId));
    const before = await rows();
    expect(before.keys).toBe(0);
    const preview = await admin.clusters.rollbackPreview({ id: clusterId, revision: attacked });
    expect(preview.unchanged).toBe(false);
    expect(preview.sites.changed).toContainEqual({ id: shop, name: "shop" });
    expect(await rows()).toEqual(before);
    // The rollback itself does write them.
    await admin.clusters.rollback({ id: clusterId, revision: attacked });
    const after = await rows();
    expect(after.keys).toBeGreaterThan(0);
    expect(after.revisions).toBe((before.revisions ?? 0) + 1);
  });
});
