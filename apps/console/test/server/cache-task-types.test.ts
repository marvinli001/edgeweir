import type { CacheTaskCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { type CacheTaskItem, pullCacheTasks } from "../../src/server/services/cache-tasks";
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

const TASK_FEATURES = ["purge-tag-v1", "prefetch-v2"];

describe("purges by host and Cache-Tag, variant and sitemap prefetches", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let outsider: ApiClient;
  let clusterId: string;
  let orgId: string;
  let shopId: string;
  let blogId: string;
  let rivalId: string;
  let nodeId: string;
  const origins = [{ address: "origin.test" }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const payload = async (taskId: string) => {
    const [row] = await ctx.db
      .select({ payload: schema.cacheTask.payload })
      .from(schema.cacheTask)
      .where(eq(schema.cacheTask.id, taskId));
    return (row?.payload ?? []) as unknown as CacheTaskItem[];
  };
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  /** Forgets the organization's recent tasks so that the purge quota starts over. */
  const resetQuota = (organizationId: string) =>
    ctx.db
      .update(schema.cacheTask)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(schema.cacheTask.organizationId, organizationId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    orgId = (await admin.organizations.create({ name: "Shop", defaultClusterId: clusterId })).id;
    const rivalOrgId = (
      await admin.organizations.create({ name: "Rival", defaultClusterId: clusterId })
    ).id;
    const users: [string, string, "owner" | "member"][] = [
      ["owner@shop.test", orgId, "owner"],
      ["member@shop.test", orgId, "member"],
      ["owner@rival.test", rivalOrgId, "owner"],
    ];
    for (const [email, organizationId, role] of users)
      await admin.users.create({ name: email, email, password: PASSWORD, organizationId, role });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@shop.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@shop.test"));
    outsider = rpcClient(app, origin, await signIn(app, origin, "owner@rival.test"));
    shopId = (
      await owner.sites.create({
        name: "shop",
        domains: ["www.shop.test", "*.img.shop.test"],
        origins,
      })
    ).site.id;
    blogId = (await owner.sites.create({ name: "blog", domains: ["blog.shop.test"], origins })).site
      .id;
    rivalId = (await outsider.sites.create({ name: "rival", domains: ["www.rival.test"], origins }))
      .site.id;
    for (const id of [shopId, blogId, rivalId]) await approveSiteDomains(admin, id);
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-tasks", supportedFeatures: TASK_FEATURES })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("purges every URL of a host through /api/v1, resolving wildcard domains", async () => {
    const writer = await owner.accessKeys.create({ name: "purge-write", scope: "write" });
    const res = await api(writer.key, "POST", "/cache-tasks", {
      type: "host",
      hosts: ["WWW.Shop.test.", "a.img.shop.test", "www.shop.test"],
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as { id: string };
    expect(task).toMatchObject({
      type: "host",
      targets: ["www.shop.test", "a.img.shop.test"],
      sites: [{ id: shopId, name: "shop" }],
      variants: [],
      maxUrls: null,
      state: "pending",
    });
    expect(await payload(task.id)).toEqual([
      expect.objectContaining({ siteId: shopId, clusterId, type: "host", host: "www.shop.test" }),
      expect.objectContaining({ siteId: shopId, type: "host", host: "a.img.shop.test", path: "" }),
    ]);
    const [audit] = (await admin.auditLogs.list({ action: "cache.purge" })).items;
    expect(audit).toMatchObject({
      targetId: task.id,
      actorType: "api_key",
      metadata: { type: "host", count: 2, sites: ["shop"] },
    });
    // Read-only AccessKeys cannot create tasks.
    const reader = await owner.accessKeys.create({ name: "purge-read", scope: "read" });
    const refused = await api(reader.key, "POST", "/cache-tasks", {
      type: "host",
      hosts: ["www.shop.test"],
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
  });

  it("purges Cache-Tags on every chosen site with normalized, de-duplicated tags", async () => {
    // Members purge as they always could.
    const task = await member.cacheTasks.create({
      type: "tag",
      siteIds: [shopId, blogId],
      tags: [" Product-42 ", "product-42", "Category: Shoes"],
    });
    expect(task).toMatchObject({
      type: "tag",
      targets: ["product-42", "category: shoes"],
      variants: [],
      maxUrls: null,
    });
    expect(task.sites.map((s) => s.name).sort()).toEqual(["blog", "shop"]);
    const items = await payload(task.id);
    expect(items.map((i) => [i.siteId === shopId ? "shop" : "blog", i.type, i.tag]).sort()).toEqual(
      [
        ["blog", "tag", "category: shoes"],
        ["blog", "tag", "product-42"],
        ["shop", "tag", "category: shoes"],
        ["shop", "tag", "product-42"],
      ],
    );
    expect(items.every((i) => i.host === "" && i.path === "")).toBe(true);
    const invalid = await rpcError(
      member.cacheTasks.create({
        type: "tag",
        siteIds: [shopId],
        tags: ["fine", "a,b", "x".repeat(129), "café", "   "],
      }),
    );
    expect(invalid).toMatchObject({ code: "CACHE_TASK_TAG_INVALID", status: 400 });
    expect((invalid.data as { tags: string }).tags).toBe(`a,b, ${"x".repeat(129)}, café,    `);
    // At most 500 tags per task; 128 bytes per tag are fine.
    await resetQuota(orgId);
    const many = Array.from({ length: 500 }, (_, i) => `t${i}-${"y".repeat(100)}`);
    expect(
      (await owner.cacheTasks.create({ type: "tag", siteIds: [shopId], tags: many })).targets,
    ).toHaveLength(500);
    expect(
      (
        await rpcError(
          owner.cacheTasks.create({ type: "tag", siteIds: [shopId], tags: [...many, "one-more"] }),
        )
      ).status,
    ).toBe(400);
    await resetQuota(orgId);
  });

  it("refuses invalid and unknown hosts, other organizations' sites and sites nodes do not serve", async () => {
    for (const hosts of [["*.shop.test"], ["www.shop.test:8080"], ["https://www.shop.test/"]])
      expect(await rpcError(owner.cacheTasks.create({ type: "host", hosts }))).toMatchObject({
        code: "CACHE_TASK_HOST_INVALID",
        status: 400,
        data: { hosts: hosts[0] },
      });
    for (const hosts of [["nobody.test"], ["www.rival.test"], ["img.shop.test"]])
      expect(await rpcError(owner.cacheTasks.create({ type: "host", hosts }))).toMatchObject({
        code: "CACHE_TASK_HOST_UNKNOWN",
        data: { hosts: hosts[0] },
      });
    expect(
      await rpcError(owner.cacheTasks.create({ type: "tag", siteIds: [rivalId], tags: ["x"] })),
    ).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    await owner.sites.setEnabled({ id: blogId, enabled: false });
    expect(
      await rpcError(owner.cacheTasks.create({ type: "host", hosts: ["blog.shop.test"] })),
    ).toMatchObject({ code: "SITE_DISABLED" });
    expect(
      await rpcError(owner.cacheTasks.create({ type: "tag", siteIds: [blogId], tags: ["x"] })),
    ).toMatchObject({ code: "SITE_DISABLED" });
    await owner.sites.setEnabled({ id: blogId, enabled: true });
    await admin.admin.sites.suspend({ id: blogId, reason: "abuse" });
    expect(
      await rpcError(
        owner.cacheTasks.create({ type: "sitemap", urls: ["https://blog.shop.test/sitemap.xml"] }),
      ),
    ).toMatchObject({ code: "SITE_SUSPENDED" });
    await admin.admin.sites.resume({ id: blogId });
    // Each type needs its own targets.
    const missing: CacheTaskCreateInput[] = [
      { type: "host", urls: ["http://www.shop.test/"] },
      { type: "tag", tags: ["x"] },
      { type: "tag", siteIds: [shopId] },
      { type: "sitemap", urls: [] },
      { type: "sitemap", urls: ["http://www.shop.test/a.xml", "http://www.shop.test/b.xml"] },
    ];
    for (const input of missing)
      expect((await rpcError(owner.cacheTasks.create(input))).status, input.type).toBe(400);
  });

  it("counts hosts, (site, tag) pairs and whole sitemaps against the purge quota shared with URL purges", async () => {
    await resetQuota(orgId);
    await admin.admin.organizations.setLimits({ id: orgId, limits: { purgeUrlsPerHour: 10 } });
    // 2 sites x 3 tags: 6.
    await owner.cacheTasks.create({
      type: "tag",
      siteIds: [shopId, blogId],
      tags: ["a", "b", "c"],
    });
    // 2 hosts: 8.
    await owner.cacheTasks.create({ type: "host", hosts: ["www.shop.test", "blog.shop.test"] });
    // A sitemap counts once however many URLs it lists: 9.
    await owner.cacheTasks.create({
      type: "sitemap",
      urls: ["https://www.shop.test/sitemap.xml"],
      maxUrls: 10_000,
    });
    // A prefetched URL counts once in every variant: 10.
    await owner.cacheTasks.create({
      type: "prefetch",
      urls: ["https://www.shop.test/"],
      variants: ["desktop", "mobile"],
    });
    expect((await owner.organization.limits()).usage.purgeUrlsPerHour).toBe(10);
    expect(
      await rpcError(owner.cacheTasks.create({ type: "url", urls: ["https://www.shop.test/x"] })),
    ).toMatchObject({
      code: "ORG_LIMIT_EXCEEDED",
      data: { resource: "purgeUrlsPerHour", limit: 10, current: 10 },
    });
    expect(
      await rpcError(owner.cacheTasks.create({ type: "tag", siteIds: [shopId], tags: ["d"] })),
    ).toMatchObject({ code: "ORG_LIMIT_EXCEEDED" });
    // Platform administrators are exempt.
    await admin.cacheTasks.create({ type: "tag", siteIds: [shopId, blogId], tags: ["d"] });
    await admin.admin.organizations.setLimits({ id: orgId, limits: {} });
    // Without an organization limit the default budget applies (2000 an hour).
    await resetQuota(orgId);
    const tags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);
    for (let i = 0; i < 2; i++)
      await owner.cacheTasks.create({ type: "tag", siteIds: [shopId, blogId], tags });
    expect(
      await rpcError(owner.cacheTasks.create({ type: "tag", siteIds: [shopId], tags: ["one"] })),
    ).toMatchObject({ code: "CACHE_TASK_RATE_LIMITED", status: 429 });
    await resetQuota(orgId);
  });

  it("refuses host, tag, sitemap and mobile prefetch tasks with NODE_CAPABILITY_REQUIRED while an active node lacks the feature, administrators too", async () => {
    await setNodeFeatures([]);
    const cases: [CacheTaskCreateInput, string][] = [
      [{ type: "host", hosts: ["www.shop.test"] }, "purge-tag-v1"],
      [{ type: "tag", siteIds: [shopId], tags: ["x"] }, "purge-tag-v1"],
      [{ type: "sitemap", urls: ["https://www.shop.test/sitemap.xml"] }, "prefetch-v2"],
      [{ type: "prefetch", urls: ["https://www.shop.test/"], variants: ["mobile"] }, "prefetch-v2"],
    ];
    for (const client of [owner, admin]) {
      for (const [input, features] of cases)
        expect(await rpcError(client.cacheTasks.create(input))).toMatchObject({
          code: "NODE_CAPABILITY_REQUIRED",
          status: 409,
          data: { features },
        });
    }
    // Desktop prefetches and URL purges run on every node.
    await owner.cacheTasks.create({ type: "prefetch", urls: ["https://www.shop.test/"] });
    await owner.cacheTasks.create({ type: "url", urls: ["https://www.shop.test/"] });
    // A disabled node does not count.
    await ctx.db.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
    await owner.cacheTasks.create({ type: "host", hosts: ["www.shop.test"] });
    await ctx.db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, nodeId));
    await setNodeFeatures(TASK_FEATURES);
    await resetQuota(orgId);
  });

  it("creates a sitemap task for one sitemap URL of a served site with its URL limit and variants", async () => {
    const task = await owner.cacheTasks.create({
      type: "sitemap",
      urls: ["https://www.shop.test/sitemap.xml?page=1#top"],
      maxUrls: 50,
      variants: ["mobile", "desktop"],
    });
    expect(task).toMatchObject({
      type: "sitemap",
      targets: ["https://www.shop.test/sitemap.xml?page=1"],
      sites: [{ id: shopId, name: "shop" }],
      variants: ["desktop", "mobile"],
      maxUrls: 50,
    });
    expect(await payload(task.id)).toEqual([
      expect.objectContaining({
        siteId: shopId,
        type: "sitemap",
        host: "www.shop.test",
        url: "https://www.shop.test/sitemap.xml?page=1",
        maxUrls: 50,
        variants: ["desktop", "mobile"],
      }),
    ]);
    const audit = (await admin.auditLogs.list({ action: "cache.prefetch" })).items.find(
      (entry) => entry.targetId === task.id,
    );
    expect(audit?.metadata).toMatchObject({
      type: "sitemap",
      variants: ["desktop", "mobile"],
      maxUrls: 50,
    });
    expect(
      await rpcError(
        owner.cacheTasks.create({ type: "sitemap", urls: ["ftp://www.shop.test/sitemap.xml"] }),
      ),
    ).toMatchObject({ code: "CACHE_TASK_URL_INVALID" });
    expect(
      await rpcError(
        owner.cacheTasks.create({ type: "sitemap", urls: ["https://www.rival.test/sitemap.xml"] }),
      ),
    ).toMatchObject({ code: "CACHE_TASK_HOST_UNKNOWN" });
    // Prefetches default to the desktop variant; tasks from before variants read as desktop.
    const prefetch = await owner.cacheTasks.create({
      type: "prefetch",
      urls: ["https://www.shop.test/a"],
    });
    expect(prefetch).toMatchObject({ variants: ["desktop"], maxUrls: null });
    const [legacy] = await ctx.db
      .insert(schema.cacheTask)
      .values({
        organizationId: orgId,
        type: "prefetch",
        targets: ["https://www.shop.test/old"],
        siteIds: [shopId],
        payload: [
          {
            siteId: shopId,
            clusterId,
            type: "prefetch",
            host: "www.shop.test",
            path: "/old",
            query: "",
            url: "https://www.shop.test/old",
          },
        ],
      })
      .returning();
    expect((await owner.cacheTasks.get({ id: legacy?.id ?? "" })).variants).toEqual(["desktop"]);
    await resetQuota(orgId);
  });

  it("makes up missed host and tag purges with a whole-site purge", async () => {
    const host = await owner.cacheTasks.create({ type: "host", hosts: ["blog.shop.test"] });
    const tag = await owner.cacheTasks.create({ type: "tag", siteIds: [shopId], tags: ["x"] });
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    await ctx.db
      .update(schema.cacheTask)
      .set({ createdAt: old })
      .where(inArray(schema.cacheTask.id, [host.id, tag.id]));
    // The node ran everything else.
    await ctx.db
      .update(schema.cacheTaskNode)
      .set({ state: "succeeded" })
      .where(
        and(
          eq(schema.cacheTaskNode.nodeId, nodeId),
          notInArray(schema.cacheTaskNode.taskId, [host.id, tag.id]),
        ),
      );
    const [node] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, nodeId));
    if (!node) throw new Error("node missing");
    const pulled = await pullCacheTasks(ctx.db, node, 10);
    expect(pulled.map((task) => task.type)).toEqual(["site"]);
    expect(pulled[0]?.items.map((item) => item.siteId).sort()).toEqual([blogId, shopId].sort());
    const recovery = await owner.cacheTasks.get({ id: pulled[0]?.id ?? "" });
    expect(recovery).toMatchObject({ type: "site", source: "recovery" });
  });
});
