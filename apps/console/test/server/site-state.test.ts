import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision, publishRevision } from "../../src/server/services/revisions";
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

describe("site enabling and platform suspension", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let other: ApiClient;
  let clusterId: string;
  let siteId: string;
  let organizationId: string;

  const origins = [{ address: "origin.test", port: 8080 }];
  const shippedSites = async () => {
    const latest = await latestRevision(ctx.db, clusterId);
    return decodeNodeConfig(latest?.ir ?? new Uint8Array()).sites.map((s) => s.id);
  };
  const revisionCount = async () => (await admin.clusters.revisions({ id: clusterId })).length;
  const auditCount = async (action: string) =>
    (await admin.auditLogs.list({ action, limit: 200 })).total;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const org = await admin.organizations.create({ name: "Shop", defaultClusterId: clusterId });
    organizationId = org.id;
    await admin.users.create({
      name: "Owner",
      email: "owner@shop.test",
      password: PASSWORD,
      organizationId,
      role: "owner",
    });
    await admin.users.create({
      name: "Member",
      email: "member@shop.test",
      password: PASSWORD,
      organizationId,
      role: "member",
    });
    const second = await admin.organizations.create({ name: "Other", defaultClusterId: clusterId });
    await admin.users.create({
      name: "Other",
      email: "other@other.test",
      password: PASSWORD,
      organizationId: second.id,
      role: "owner",
    });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@shop.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@shop.test"));
    other = rpcClient(app, origin, await signIn(app, origin, "other@other.test"));
    siteId = (await owner.sites.create({ name: "shop", domains: ["www.shop.test"], origins })).site
      .id;
    await approveSiteDomains(admin, siteId);
  });
  afterAll(() => pglite.close());

  it("disables and enables a site with a revision and an audit entry per change", async () => {
    expect(await shippedSites()).toContain(siteId);
    const before = await owner.sites.get({ id: siteId });
    expect(before).toMatchObject({ enabled: true, suspended: false, suspendReason: null });
    const revisions = await revisionCount();

    const disabled = await owner.sites.setEnabled({
      id: siteId,
      enabled: false,
      expectedUpdatedAt: before.updatedAt,
    });
    expect(disabled.site.enabled).toBe(false);
    expect(disabled.revision).toMatchObject({
      reasonCode: "site_disabled",
      reasonParams: { site: "shop" },
    });
    expect(await revisionCount()).toBe(revisions + 1);
    expect(await shippedSites()).not.toContain(siteId);
    expect(await auditCount("site.disable")).toBe(1);

    // Unchanged state: the current state back, no revision, no audit entry.
    const again = await owner.sites.setEnabled({ id: siteId, enabled: false });
    expect(again.revision.revision).toBe(disabled.revision.revision);
    expect(await revisionCount()).toBe(revisions + 1);
    expect(await auditCount("site.disable")).toBe(1);

    const enabled = await owner.sites.setEnabled({ id: siteId, enabled: true });
    expect(enabled.revision.reasonCode).toBe("site_enabled");
    expect(await shippedSites()).toContain(siteId);
    expect(await auditCount("site.enable")).toBe(1);
  });

  it("refuses a stale expectedUpdatedAt with the current value", async () => {
    const current = await owner.sites.get({ id: siteId });
    const error = await rpcError(
      owner.sites.setEnabled({
        id: siteId,
        enabled: false,
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(error.code).toBe("UPDATED_AT_MISMATCH");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ updatedAt: current.updatedAt });
    expect((await owner.sites.get({ id: siteId })).enabled).toBe(true);
  });

  it("lets only owners, admins and platform administrators switch a site", async () => {
    const error = await rpcError(member.sites.setEnabled({ id: siteId, enabled: false }));
    expect(error.status).toBe(403);
    expect(error.code).toBe("ORG_ADMIN_REQUIRED");
    expect((await rpcError(other.sites.setEnabled({ id: siteId, enabled: false }))).code).toBe(
      "SITE_NOT_FOUND",
    );
    expect((await owner.sites.get({ id: siteId })).enabled).toBe(true);
    const viaAdmin = await admin.sites.setEnabled({ id: siteId, enabled: false });
    expect(viaAdmin.site.enabled).toBe(false);
    await admin.sites.setEnabled({ id: siteId, enabled: true });
  });

  it("suspends and resumes a site; tenants see the reason, cannot resume and stay dark", async () => {
    const revisions = await revisionCount();
    const suspended = await admin.admin.sites.suspend({
      id: siteId,
      reason: "billing",
      note: "invoice 42 overdue",
    });
    expect(suspended.site).toMatchObject({
      suspended: true,
      suspendReason: "billing",
      suspendNote: "invoice 42 overdue",
    });
    expect(suspended.revision.reasonCode).toBe("site_suspended");
    expect(await revisionCount()).toBe(revisions + 1);
    expect(await shippedSites()).not.toContain(siteId);

    // Tenants see the localized reason, never the platform's note.
    const seen = await owner.sites.get({ id: siteId });
    expect(seen).toMatchObject({ suspended: true, suspendReason: "billing", suspendNote: "" });
    expect(seen.suspendedAt).not.toBeNull();
    const listed = (await owner.sites.list({})).items.find((s) => s.id === siteId);
    expect(listed?.suspendNote).toBe("");

    // Tenants cannot lift it: the admin procedure is 403 and enabling does not ship it.
    expect((await rpcError(owner.admin.sites.resume({ id: siteId }))).status).toBe(403);
    expect(
      (await rpcError(owner.admin.sites.suspend({ id: siteId, reason: "other" }))).status,
    ).toBe(403);
    await owner.sites.setEnabled({ id: siteId, enabled: false });
    await owner.sites.setEnabled({ id: siteId, enabled: true });
    expect(await shippedSites()).not.toContain(siteId);

    // Same suspension again: nothing changes; another reason is audited without a revision.
    const count = await revisionCount();
    await admin.admin.sites.suspend({ id: siteId, reason: "billing", note: "invoice 42 overdue" });
    expect(await auditCount("site.suspend")).toBe(1);
    const changed = await admin.admin.sites.suspend({ id: siteId, reason: "abuse" });
    expect(changed.site.suspendReason).toBe("abuse");
    expect(await auditCount("site.suspend")).toBe(2);
    expect(await revisionCount()).toBe(count);

    const resumed = await admin.admin.sites.resume({
      id: siteId,
      expectedUpdatedAt: changed.site.updatedAt,
    });
    expect(resumed.site).toMatchObject({ suspended: false, suspendReason: null, suspendNote: "" });
    expect(resumed.revision.reasonCode).toBe("site_resumed");
    expect(await shippedSites()).toContain(siteId);
    expect(await auditCount("site.resume")).toBe(1);
    const [entry] = (await admin.auditLogs.list({ action: "site.resume" })).items;
    expect(entry).toMatchObject({
      targetId: siteId,
      organizationId,
      metadata: { reason: "abuse" },
    });
  });

  it("rejects notes over 256 characters and unknown reasons", async () => {
    expect(
      (
        await rpcError(
          admin.admin.sites.suspend({ id: siteId, reason: "other", note: "x".repeat(257) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await rpcError(
          admin.admin.sites.suspend({ id: siteId, reason: "late" as unknown as "other" }),
        )
      ).status,
    ).toBe(400);
  });

  it("refuses purges and prefetches of disabled or suspended sites with a clear code", async () => {
    await owner.sites.setEnabled({ id: siteId, enabled: false });
    expect((await rpcError(owner.sites.purgeAll({ id: siteId }))).code).toBe("SITE_DISABLED");
    expect(
      (await rpcError(owner.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })))
        .code,
    ).toBe("SITE_DISABLED");
    expect(
      (await rpcError(owner.cacheTasks.create({ type: "site", siteIds: [siteId] }))).code,
    ).toBe("SITE_DISABLED");
    await owner.sites.setEnabled({ id: siteId, enabled: true });
    await admin.admin.sites.suspend({ id: siteId, reason: "security" });
    expect(
      (
        await rpcError(
          owner.cacheTasks.create({ type: "prefetch", urls: ["http://www.shop.test/a"] }),
        )
      ).code,
    ).toBe("SITE_SUSPENDED");
    expect((await rpcError(admin.sites.purgeAll({ id: siteId }))).code).toBe("SITE_SUSPENDED");
    await admin.admin.sites.resume({ id: siteId });
    expect(
      (await owner.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })).type,
    ).toBe("url");
  });

  it("keeps answering HTTP-01 challenges for a suspended site (renewals continue)", async () => {
    await admin.admin.sites.suspend({ id: siteId, reason: "billing" });
    const [certificate] = await ctx.db
      .insert(schema.certificate)
      .values({
        organizationId,
        name: "www.shop.test",
        names: ["www.shop.test"],
        source: "acme",
        status: "issuing",
        operationStartedAt: new Date(),
      })
      .returning();
    if (!certificate?.operationStartedAt) throw new Error("certificate missing");
    await ctx.db.insert(schema.acmeChallenge).values({
      certificateId: certificate.id,
      domain: "www.shop.test",
      token: "renewal-token",
      keyAuthorization: "renewal-token.thumbprint",
      expiresAt: new Date(Date.now() + 600_000),
      operationStartedAt: certificate.operationStartedAt,
    });
    await ctx.db.transaction((tx) =>
      publishRevision(tx, { clusterId, reason: { code: "acme_challenge_updated", params: {} } }),
    );
    const latest = await latestRevision(ctx.db, clusterId);
    const config = decodeNodeConfig(latest?.ir ?? new Uint8Array());
    expect(config.sites.map((s) => s.id)).not.toContain(siteId);
    expect(config.httpChallenges.map((c) => [c.domain, c.token])).toEqual([
      ["www.shop.test", "renewal-token"],
    ]);
    await admin.admin.sites.resume({ id: siteId });
  });
});
