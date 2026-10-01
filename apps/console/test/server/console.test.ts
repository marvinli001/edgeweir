import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
  totp,
} from "./helpers";

describe("console procedures", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterB: string;

  const origins = [{ address: "origin.internal", port: 8080 }];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterB = (await admin.clusters.create({ name: "edge-b" })).id;
  });
  afterAll(() => pglite.close());

  it("lands sites on the chosen cluster, or the oldest one, and routes their domains at once", async () => {
    const created = await admin.sites.create({
      name: "shop",
      clusterId: clusterB,
      domains: ["shop.test", "*.shop.test"],
      origins,
    });
    expect(created.site).toMatchObject({
      clusterId: clusterB,
      clusterName: "edge-b",
      domains: ["shop.test", "*.shop.test"],
    });
    // The domains route at once: the site's revision already ships it.
    expect(created.revision).toMatchObject({
      clusterId: clusterB,
      reasonCode: "site_created",
      siteCount: 1,
    });

    // Without a cluster the site lands on the oldest one.
    const [defaultCluster] = await admin.clusters.list();
    const blog = await admin.sites.create({ name: "blog", domains: ["blog.test"], origins });
    expect(blog.site).toMatchObject({ clusterId: defaultCluster?.id, clusterName: "default" });
    expect((await admin.sites.list({})).items.map((s) => s.name)).toEqual(["shop", "blog"]);
  });

  it("edits a site's name, domains, origins and cache rules with a new revision each save", async () => {
    const [site] = (await admin.sites.list({ search: "shop" })).items;
    if (!site) throw new Error("no site");
    const before = site.domains;

    const renamed = await admin.sites.update({ id: site.id, name: "shop-cn" });
    expect(renamed.site.name).toBe("shop-cn");
    expect(renamed.revision).toMatchObject({
      reasonCode: "site_updated",
      reasonParams: { site: "shop-cn" },
    });

    const domains = await admin.sites.update({
      id: site.id,
      domains: ["shop.test", "www.shop.test", "*.cdn.shop.test"],
    });
    expect(domains.site.domains).toEqual(["shop.test", "www.shop.test", "*.cdn.shop.test"]);
    expect(domains.revision.revision).toBe(renamed.revision.revision + 1);
    expect(before).not.toEqual(domains.site.domains);

    const conflict = await rpcError(admin.sites.update({ id: site.id, domains: ["blog.test"] }));
    expect(conflict).toMatchObject({
      code: "DOMAIN_IN_USE",
      status: 409,
      data: { domains: "blog.test" },
    });

    const originUpdate = await admin.sites.update({
      id: site.id,
      origins: [
        {
          address: "origin-a.internal",
          port: 443,
          scheme: "https",
          weight: 3,
          hostHeader: "shop.test",
        },
        { address: "origin-b.internal", port: 443, scheme: "https", backup: true },
      ],
    });
    expect(originUpdate.site.origins.map((o) => [o.address, o.weight, o.backup])).toEqual([
      ["origin-a.internal", 3, false],
      ["origin-b.internal", 1, true],
    ]);
    expect(originUpdate.revision.revision).toBe(domains.revision.revision + 1);

    const cache = await admin.sites.update({
      id: site.id,
      cacheRules: [
        { priority: 10, pathPrefixes: ["/static/"], edgeTtlSeconds: 86400 },
        { priority: 20, extensions: ["php"], action: "bypass" },
      ],
    });
    expect(cache.site.cacheRules.map((r) => r.action)).toEqual(["cache", "bypass"]);
    expect(cache.revision.revision).toBe(originUpdate.revision.revision + 1);

    const revisions = await admin.clusters.revisions({ id: clusterB });
    expect(revisions[0]).toMatchObject({
      reasonCode: "site_updated",
      reason: "site shop-cn updated",
    });
    const audit = await admin.auditLogs.list({ action: "site.update" });
    expect(audit.total).toBe(4);
    expect(audit.items[0]).toMatchObject({ actorName: "Platform Admin", targetName: "shop-cn" });
  });

  it("searches, filters by cluster and pages the site list", async () => {
    for (let i = 1; i <= 5; i++) {
      await admin.sites.create({ name: `bulk-${i}`, domains: [`bulk-${i}.example.org`], origins });
    }
    const page1 = await admin.sites.list({ search: "example.org", page: 1, pageSize: 2 });
    const page3 = await admin.sites.list({ search: "example.org", page: 3, pageSize: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items.map((s) => s.name)).toEqual(["bulk-1", "bulk-2"]);
    expect(page3.items.map((s) => s.name)).toEqual(["bulk-5"]);
    expect((await admin.sites.list({ search: "*.cdn.shop" })).items.map((s) => s.name)).toEqual([
      "shop-cn",
    ]);
    expect((await admin.sites.list({ clusterId: clusterB })).items.map((s) => s.name)).toEqual([
      "shop-cn",
    ]);
  });

  it("turns on TOTP through better-auth and asks for it at the next sign-in", async () => {
    expect((await admin.account.me()).user.twoFactorEnabled).toBe(false);
    let cookie = await signIn(app, origin, "admin@example.com");

    // Enable TOTP through better-auth, as the security page does.
    const auth = (path: string, body: unknown) =>
      app.request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const enabled = await auth("/two-factor/enable", { password: PASSWORD });
    expect(enabled.status).toBe(200);
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    const verified = await auth("/two-factor/verify-totp", { code: totp(secret) });
    expect(verified.status).toBe(200);
    cookie = (verified.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const operator = rpcClient(app, origin, cookie);
    const me = await operator.account.me();
    expect(me.user.twoFactorEnabled).toBe(true);
    expect((await operator.sites.list({})).total).toBe(7);

    // Signing in again now asks for the second factor.
    const signInRes = await app.request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
    });
    expect(await signInRes.json()).toMatchObject({ twoFactorRedirect: true });
  });
});
