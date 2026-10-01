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
  let defaultOrgId: string;
  let tenantOrgId: string;
  let clusterB: string;

  const origins = [{ address: "origin.internal", port: 8080 }];

  beforeAll(async () => {
    ({ organizationId: defaultOrgId } = await setupPlatform(ctx));
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterB = (await admin.clusters.create({ name: "edge-b" })).id;
    tenantOrgId = (await admin.organizations.create({ name: "Tenant", defaultClusterId: clusterB }))
      .id;
    await admin.users.create({
      name: "Olivia Owner",
      email: "owner@tenant.test",
      password: PASSWORD,
      organizationId: tenantOrgId,
      role: "owner",
    });
  });
  afterAll(() => pglite.close());

  const as = async (email: string) => rpcClient(app, origin, await signIn(app, origin, email));

  it("switches the active organization only between the caller's memberships", async () => {
    const owner = await as("owner@tenant.test");
    let me = await owner.account.me();
    expect(me.organizations.map((o) => o.name)).toEqual(["Tenant"]);
    expect(me.activeOrganization).toMatchObject({ id: tenantOrgId, role: "owner" });

    const notMine = await rpcError(
      owner.account.setActiveOrganization({ organizationId: defaultOrgId }),
    );
    expect(notMine.code).toBe("NOT_A_MEMBER");

    const [ownerUser] = (await admin.users.list({ search: "owner@tenant.test" })) ?? [];
    await admin.organizations.addMember({
      organizationId: defaultOrgId,
      userId: ownerUser?.id ?? "",
      role: "member",
    });
    me = await owner.account.setActiveOrganization({ organizationId: defaultOrgId });
    expect(me.activeOrganization).toMatchObject({ id: defaultOrgId, role: "member" });
    // The choice sticks to the session.
    expect((await owner.account.me()).activeOrganization?.id).toBe(defaultOrgId);
    // Members cannot manage their organization.
    expect((await rpcError(owner.members.list())).code).toBe("ORG_ADMIN_REQUIRED");
    me = await owner.account.setActiveOrganization({ organizationId: tenantOrgId });
    expect(me.activeOrganization?.id).toBe(tenantOrgId);
  });

  it("lands tenant sites on the organization's default cluster and scopes them", async () => {
    const owner = await as("owner@tenant.test");
    const created = await owner.sites.create({
      name: "shop",
      domains: ["shop.test", "*.shop.test"],
      origins,
    });
    expect(created.site).toMatchObject({
      clusterId: clusterB,
      clusterName: "edge-b",
      organizationName: "Tenant",
      domains: ["shop.test", "*.shop.test"],
    });
    // The domains route at once: the site's revision already ships it.
    expect(created.revision).toMatchObject({
      clusterId: clusterB,
      reasonCode: "site_created",
      siteCount: 1,
    });
    const forbidden = await rpcError(
      owner.sites.create({ name: "x", clusterId: clusterB, domains: ["x.test"], origins }),
    );
    expect(forbidden.code).toBe("CLUSTER_SELECTION_FORBIDDEN");

    await admin.sites.create({ name: "blog", domains: ["blog.test"], origins });
    // Tenants only see their organization; admins see every organization.
    expect((await owner.sites.list({})).items.map((s) => s.name)).toEqual(["shop"]);
    expect((await admin.sites.list({})).items.map((s) => s.name)).toEqual(["shop", "blog"]);
    const blog = (await admin.sites.list({ search: "blog" })).items[0];
    expect((await rpcError(owner.sites.get({ id: blog?.id ?? "" }))).code).toBe("SITE_NOT_FOUND");
    expect((await rpcError(owner.sites.update({ id: blog?.id ?? "", name: "mine" }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });

  it("edits a site's name, domains, origins and cache rules with a new revision each save", async () => {
    const owner = await as("owner@tenant.test");
    const [site] = (await owner.sites.list({ search: "shop" })).items;
    if (!site) throw new Error("no site");
    const before = site.domains;

    const renamed = await owner.sites.update({ id: site.id, name: "shop-cn" });
    expect(renamed.site.name).toBe("shop-cn");
    expect(renamed.revision).toMatchObject({
      reasonCode: "site_updated",
      reasonParams: { site: "shop-cn" },
    });

    const domains = await owner.sites.update({
      id: site.id,
      domains: ["shop.test", "www.shop.test", "*.cdn.shop.test"],
    });
    expect(domains.site.domains).toEqual(["shop.test", "www.shop.test", "*.cdn.shop.test"]);
    expect(domains.revision.revision).toBe(renamed.revision.revision + 1);
    expect(before).not.toEqual(domains.site.domains);

    const conflict = await rpcError(owner.sites.update({ id: site.id, domains: ["blog.test"] }));
    expect(conflict).toMatchObject({
      code: "DOMAIN_IN_USE",
      status: 409,
      data: { domains: "blog.test" },
    });

    const originUpdate = await owner.sites.update({
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

    const cache = await owner.sites.update({
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
    expect(audit.items[0]).toMatchObject({ actorName: "Olivia Owner", targetName: "shop-cn" });
  });

  it("searches, filters by cluster (admins only) and pages the site list", async () => {
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
    // Tenants cannot use the cluster filter to probe other clusters.
    const owner = await as("owner@tenant.test");
    const [defaultCluster] = await admin.clusters.list();
    expect((await owner.sites.list({ clusterId: defaultCluster?.id })).total).toBe(1);
  });

  it("asks a new invitee for a name and password with a stable error code", async () => {
    const owner = await as("owner@tenant.test");
    const { invitation } = await owner.members.invite({ email: "later@tenant.test" });
    const anonymous = rpcClient(app, origin);
    const error = await rpcError(anonymous.invitations.accept({ id: invitation.id }));
    expect(error).toMatchObject({ code: "INVITATION_ACCOUNT_REQUIRED", status: 400 });
    const nameOnly = await rpcError(
      anonymous.invitations.accept({ id: invitation.id, name: "Later" }),
    );
    expect(nameOnly.code).toBe("INVITATION_ACCOUNT_REQUIRED");
    // Nothing was created; the invitation is still open.
    expect(await anonymous.invitations.get({ id: invitation.id })).toMatchObject({
      userExists: false,
    });
  });

  it("lets organization owners invite, re-role and remove members", async () => {
    const owner = await as("owner@tenant.test");
    const invited = await owner.members.invite({ email: "New.Person@tenant.test", role: "admin" });
    expect(invited.invitation).toMatchObject({
      email: "new.person@tenant.test",
      role: "admin",
      inviterName: "Olivia Owner",
    });

    // The invitee opens the link, creates an account and joins.
    const anonymous = rpcClient(app, origin);
    const info = await anonymous.invitations.get({ id: invited.invitation.id });
    expect(info).toMatchObject({ organizationName: "Tenant", userExists: false, role: "admin" });
    const joined = await anonymous.invitations.accept({
      id: invited.invitation.id,
      name: "New Person",
      password: PASSWORD,
    });
    expect(joined.organizationId).toBe(tenantOrgId);
    expect((await rpcError(anonymous.invitations.get({ id: invited.invitation.id }))).code).toBe(
      "INVITATION_NOT_FOUND",
    );
    const newcomer = await as("new.person@tenant.test");
    expect((await newcomer.account.me()).activeOrganization).toMatchObject({
      id: tenantOrgId,
      role: "admin",
    });

    // Org admins manage members but not owners.
    const members = await newcomer.members.list();
    expect(members.members.map((m) => [m.name, m.role])).toEqual([
      ["Olivia Owner", "owner"],
      ["New Person", "admin"],
    ]);
    const ownerRow = members.members.find((m) => m.role === "owner");
    const newRow = members.members.find((m) => m.role === "admin");
    expect(
      (await rpcError(newcomer.members.updateRole({ id: ownerRow?.id ?? "", role: "member" })))
        .code,
    ).toBe("OWNER_REQUIRED");
    expect(
      (await rpcError(newcomer.members.invite({ email: "boss@tenant.test", role: "owner" }))).code,
    ).toBe("OWNER_REQUIRED");
    const ownerInvite = await owner.members.invite({
      email: "future-owner@tenant.test",
      role: "owner",
    });
    expect((await owner.members.list()).invitations.map((i) => i.id)).toContain(
      ownerInvite.invitation.id,
    );
    expect((await newcomer.members.list()).invitations.map((i) => i.id)).not.toContain(
      ownerInvite.invitation.id,
    );
    await owner.members.cancelInvitation({ id: ownerInvite.invitation.id });
    expect((await rpcError(owner.members.remove({ id: ownerRow?.id ?? "" }))).code).toBe(
      "LAST_OWNER",
    );

    // Existing accounts must sign in as the invited address.
    const existing = await owner.members.invite({ email: "admin@example.com" });
    expect(
      (await rpcError(anonymous.invitations.accept({ id: existing.invitation.id }))).code,
    ).toBe("INVITATION_EMAIL_MISMATCH");
    expect(await admin.invitations.accept({ id: existing.invitation.id })).toMatchObject({
      organizationId: tenantOrgId,
    });
    expect((await rpcError(owner.members.invite({ email: "admin@example.com" }))).code).toBe(
      "ALREADY_MEMBER",
    );

    const pending = await owner.members.invite({ email: "later@tenant.test" });
    expect(await owner.members.cancelInvitation({ id: pending.invitation.id })).toEqual({
      ok: true,
    });
    expect((await owner.members.list()).invitations).toEqual([]);

    const demoted = await owner.members.updateRole({ id: newRow?.id ?? "", role: "member" });
    expect(demoted.role).toBe("member");
    expect((await rpcError(newcomer.members.list())).code).toBe("ORG_ADMIN_REQUIRED");
    expect(await owner.members.remove({ id: newRow?.id ?? "" })).toEqual({ ok: true });
    expect((await newcomer.account.me()).organizations).toEqual([]);
    expect(
      (await rpcError(newcomer.sites.create({ name: "x", domains: ["n.test"], origins }))).code,
    ).toBe("NOT_A_MEMBER");
  });

  it("enforces an organization's two-factor requirement until the member enables TOTP", async () => {
    await admin.users.create({
      name: "Mia Member",
      email: "mia@tenant.test",
      password: PASSWORD,
      organizationId: tenantOrgId,
      role: "member",
    });
    const owner = await as("owner@tenant.test");
    const policy = await owner.organization.update({ requireTwoFactor: true });
    expect(policy.activeOrganization?.requireTwoFactor).toBe(true);
    // The owner has no 2FA either, so the owner is now held back too.
    expect(policy.twoFactorRequired).toBe(true);

    let cookie = await signIn(app, origin, "mia@tenant.test");
    let mia = rpcClient(app, origin, cookie);
    expect((await mia.account.me()).twoFactorRequired).toBe(true);
    const blocked = await rpcError(mia.sites.list({}));
    expect(blocked).toMatchObject({ code: "TWO_FACTOR_REQUIRED", status: 403 });

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
    mia = rpcClient(app, origin, cookie);
    const me = await mia.account.me();
    expect(me.user.twoFactorEnabled).toBe(true);
    expect(me.twoFactorRequired).toBe(false);
    expect((await mia.sites.list({})).total).toBe(1);

    // Signing in again now asks for the second factor.
    const signInRes = await app.request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "mia@tenant.test", password: PASSWORD }),
    });
    expect(await signInRes.json()).toMatchObject({ twoFactorRedirect: true });

    // Platform administrators are exempt from organization policy.
    expect((await admin.sites.list({})).total).toBeGreaterThan(0);
    await admin.organizations.update({ id: tenantOrgId, requireTwoFactor: false });
    expect((await owner.account.me()).twoFactorRequired).toBe(false);
  });
});
