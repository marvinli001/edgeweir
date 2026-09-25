import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandingSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { desc, eq } from "drizzle-orm";
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
} from "./helpers";

const shell = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta name="robots" content="noindex" />
    <title>Edgeweir</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("landing page", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const webDist = mkdtempSync(join(tmpdir(), "edgeweir-web-"));
  writeFileSync(join(webDist, "index.html"), shell);
  const app = createApp(ctx, { webDist });
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const anonymous = rpcClient(app, origin);
  let admin: ApiClient;
  let member: ApiClient;

  const settings = (patch: Partial<LandingSettings> = {}): LandingSettings => ({
    template: "horizon",
    brandName: "Acme CDN",
    headline: "",
    description: "",
    contactEmail: "",
    signupUrl: "",
    icp: "",
    showStats: false,
    ...patch,
  });

  beforeAll(async () => {
    const { organizationId } = await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    await admin.users.create({
      name: "Tenant Member",
      email: "member@example.com",
      password: PASSWORD,
      organizationId,
      role: "member",
    });
    member = rpcClient(app, origin, await signIn(app, origin, "member@example.com"));
  });
  afterAll(async () => {
    rmSync(webDist, { recursive: true, force: true });
    await pglite.close();
  });

  it("is off by default and public to read", async () => {
    expect(await anonymous.landing.get()).toEqual({
      settings: {
        template: "none",
        brandName: "Edgeweir",
        headline: "",
        description: "",
        contactEmail: "",
        signupUrl: "",
        icp: "",
        showStats: false,
      },
      stats: null,
    });
    const html = await (await app.request(`${origin}/`)).text();
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain("<title>Edgeweir</title>");
  });

  it("is changed by platform administrators only, with an audit entry", async () => {
    expect((await rpcError(anonymous.landing.update(settings()))).status).toBe(401);
    expect((await rpcError(member.landing.update(settings()))).status).toBe(403);

    const saved = await admin.landing.update(
      settings({
        template: "orbit",
        contactEmail: " Hello@Acme.test ",
        signupUrl: "https://acme.test/apply",
        icp: "ICP 12345678",
      }),
    );
    expect(saved).toMatchObject({
      template: "orbit",
      contactEmail: "hello@acme.test",
      signupUrl: "https://acme.test/apply",
    });
    expect((await anonymous.landing.get()).settings).toEqual(saved);

    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.landing_update"))
      .orderBy(desc(schema.auditLog.id));
    expect(entry).toMatchObject({ targetType: "system_setting", targetName: "Acme CDN" });
    expect(entry?.metadata).toMatchObject({
      template: "orbit",
      changed: expect.arrayContaining(["template", "brandName", "contactEmail", "signupUrl"]),
    });
  });

  it("rejects invalid links and addresses", async () => {
    for (const bad of [
      settings({ contactEmail: "not-an-email" }),
      settings({ signupUrl: "javascript:alert(1)" }),
      settings({ signupUrl: "ftp://acme.test" }),
      settings({ brandName: "  " }),
    ]) {
      expect((await rpcError(admin.landing.update(bad))).status).toBe(400);
    }
  });

  it("shares platform-wide numbers only when asked to", async () => {
    await admin.landing.update(settings({ showStats: false }));
    expect((await anonymous.landing.get()).stats).toBeNull();

    await admin.regions.create({ name: "East", code: "east" });
    await admin.regions.create({ name: "Asia Pacific", code: "apac" });
    await admin.sites.create({
      name: "shop",
      domains: ["shop.acme.test", "www.acme.test"],
      origins: [{ address: "origin.internal" }],
    });
    const [cluster] = await admin.clusters.list();
    await ctx.db.insert(schema.node).values([
      { clusterId: cluster?.id ?? "", name: "online", lastSeenAt: new Date() },
      {
        clusterId: cluster?.id ?? "",
        name: "stale",
        lastSeenAt: new Date(Date.now() - 3_600_000),
      },
      {
        clusterId: cluster?.id ?? "",
        name: "disabled",
        status: "disabled",
        lastSeenAt: new Date(),
      },
    ]);

    await admin.landing.update(settings({ showStats: true }));
    expect((await anonymous.landing.get()).stats).toEqual({
      regions: [
        { name: "Asia Pacific", code: "apac" },
        { name: "East", code: "east" },
      ],
      onlineNodes: 1,
      sites: 1,
      domains: 2,
    });

    // Switched off, the page shares nothing even with the flag left on.
    await admin.landing.update(settings({ template: "none", showStats: true }));
    expect((await anonymous.landing.get()).stats).toBeNull();
  });

  it("makes the shell at / indexable with the brand and an escaped description", async () => {
    await admin.landing.update(
      settings({ headline: "Fast & safe", description: 'Edge "network" <for> you' }),
    );
    const html = await (await app.request(`${origin}/`)).text();
    expect(html).not.toContain("noindex");
    expect(html).toContain("<title>Fast &amp; safe | Acme CDN</title>");
    expect(html).toContain(
      '<meta name="description" content="Edge &quot;network&quot; &lt;for&gt; you" />',
    );
    // Every other path keeps the console shell.
    expect(await (await app.request(`${origin}/overview`)).text()).toContain("noindex");
  });
});
