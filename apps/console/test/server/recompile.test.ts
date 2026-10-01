import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { RECOMPILE_MARKER, recompileAfterUpgrade } from "../../src/server/services/recompile";
import { latestRevision } from "../../src/server/services/revisions";
import { createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("recompile after an upgrade", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let clusterId: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    const admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    await admin.sites.create({
      name: "shop",
      domains: ["shop.test"],
      origins: [{ address: "origin.test" }],
    });
  });
  afterAll(() => client.close());

  it("publishes a domain a migration released, once per marker", async () => {
    const before = await latestRevision(ctx.db, clusterId);
    // As if an upgrade had added a route the stored revision does not have yet.
    const [site] = await ctx.db.select().from(schema.site);
    await ctx.db
      .insert(schema.siteDomain)
      .values({ siteId: site?.id ?? "", name: "www.shop.test" });

    await recompileAfterUpgrade(ctx);
    const after = await latestRevision(ctx.db, clusterId);
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(after?.reasonCode).toBe("recompiled");
    expect(
      decodeNodeConfig(after?.ir ?? new Uint8Array()).sites[0]?.domains.map((d) => d.name),
    ).toEqual(["shop.test", "www.shop.test"]);
    const [marker] = await ctx.db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, "config_recompiled"));
    expect(marker?.value).toEqual({ marker: RECOMPILE_MARKER });

    await recompileAfterUpgrade(ctx);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(after?.revision);
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.recompile"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ clusters: 1, failed: 0 });
  });
});
