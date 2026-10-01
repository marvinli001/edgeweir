import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision, publishRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("site enabling", async () => {
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
  });
  afterAll(() => pglite.close());

  it("disables and enables a site with a revision and an audit entry per change", async () => {
    expect(await shippedSites()).toContain(siteId);
    const before = await owner.sites.get({ id: siteId });
    expect(before).toMatchObject({ enabled: true });
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

  it("refuses purges and prefetches of disabled sites with a clear code", async () => {
    await owner.sites.setEnabled({ id: siteId, enabled: false });
    expect((await rpcError(owner.sites.purgeAll({ id: siteId }))).code).toBe("SITE_DISABLED");
    expect(
      (await rpcError(owner.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })))
        .code,
    ).toBe("SITE_DISABLED");
    expect(
      (await rpcError(owner.cacheTasks.create({ type: "site", siteIds: [siteId] }))).code,
    ).toBe("SITE_DISABLED");
    expect(
      (
        await rpcError(
          owner.cacheTasks.create({ type: "prefetch", urls: ["http://www.shop.test/a"] }),
        )
      ).code,
    ).toBe("SITE_DISABLED");
    await owner.sites.setEnabled({ id: siteId, enabled: true });
    expect(
      (await owner.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })).type,
    ).toBe("url");
  });

  it("keeps answering HTTP-01 challenges for a disabled site (renewals continue)", async () => {
    await owner.sites.setEnabled({ id: siteId, enabled: false });
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
    await owner.sites.setEnabled({ id: siteId, enabled: true });
  });
});
