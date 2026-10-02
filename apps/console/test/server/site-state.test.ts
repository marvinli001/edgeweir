import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { systemActor } from "../../src/server/services/audit";
import { latestRevision, publishRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
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
  let clusterId: string;
  let siteId: string;

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
    siteId = (await admin.sites.create({ name: "shop", domains: ["www.shop.test"], origins })).site
      .id;
  });
  afterAll(() => pglite.close());

  it("disables and enables a site with a revision and an audit entry per change", async () => {
    expect(await shippedSites()).toContain(siteId);
    const before = await admin.sites.get({ id: siteId });
    expect(before).toMatchObject({ enabled: true });
    const revisions = await revisionCount();

    const disabled = await admin.sites.setEnabled({
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
    const again = await admin.sites.setEnabled({ id: siteId, enabled: false });
    expect(again.revision.revision).toBe(disabled.revision.revision);
    expect(await revisionCount()).toBe(revisions + 1);
    expect(await auditCount("site.disable")).toBe(1);

    const enabled = await admin.sites.setEnabled({ id: siteId, enabled: true });
    expect(enabled.revision.reasonCode).toBe("site_enabled");
    expect(await shippedSites()).toContain(siteId);
    expect(await auditCount("site.enable")).toBe(1);
  });

  it("refuses a stale expectedUpdatedAt with the current value", async () => {
    const current = await admin.sites.get({ id: siteId });
    const error = await rpcError(
      admin.sites.setEnabled({
        id: siteId,
        enabled: false,
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(error.code).toBe("UPDATED_AT_MISMATCH");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ updatedAt: current.updatedAt });
    expect((await admin.sites.get({ id: siteId })).enabled).toBe(true);
  });

  it("refuses purges and prefetches of disabled sites with a clear code", async () => {
    await admin.sites.setEnabled({ id: siteId, enabled: false });
    expect((await rpcError(admin.sites.purgeAll({ id: siteId }))).code).toBe("SITE_DISABLED");
    expect(
      (await rpcError(admin.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })))
        .code,
    ).toBe("SITE_DISABLED");
    expect(
      (await rpcError(admin.cacheTasks.create({ type: "site", siteIds: [siteId] }))).code,
    ).toBe("SITE_DISABLED");
    expect(
      (
        await rpcError(
          admin.cacheTasks.create({ type: "prefetch", urls: ["http://www.shop.test/a"] }),
        )
      ).code,
    ).toBe("SITE_DISABLED");
    await admin.sites.setEnabled({ id: siteId, enabled: true });
    expect(
      (await admin.cacheTasks.create({ type: "url", urls: ["http://www.shop.test/a"] })).type,
    ).toBe("url");
  });

  it("keeps answering HTTP-01 challenges for a disabled site (renewals continue)", async () => {
    await admin.sites.setEnabled({ id: siteId, enabled: false });
    const [certificate] = await ctx.db
      .insert(schema.certificate)
      .values({
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
      publishRevision(tx, {
        clusterId,
        reason: { code: "acme_challenge_updated", params: {} },
        actor: systemActor,
      }),
    );
    const latest = await latestRevision(ctx.db, clusterId);
    const config = decodeNodeConfig(latest?.ir ?? new Uint8Array());
    expect(config.sites.map((s) => s.id)).not.toContain(siteId);
    expect(config.httpChallenges.map((c) => [c.domain, c.token])).toEqual([
      ["www.shop.test", "renewal-token"],
    ]);
    await admin.sites.setEnabled({ id: siteId, enabled: true });
  });
});
