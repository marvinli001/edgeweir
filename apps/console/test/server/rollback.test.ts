import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { getRevision, latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("configuration rollback", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  /** Revisions: 1 cluster created, 2 site created, 3 site updated. */
  const REV_CREATED = 2;

  const rollbackAudits = async () =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "cluster.rollback"),
          eq(schema.auditLog.targetId, clusterId),
        ),
      )
      .orderBy(schema.auditLog.id);
  const sitesOf = async (revision: number) => {
    const row = await getRevision(ctx.db, clusterId, revision);
    return decodeNodeConfig(row?.ir ?? new Uint8Array()).sites;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const created = await admin.sites.create({
      name: "shop",
      domains: ["shop.test"],
      origins: [{ address: "origin.test" }],
      cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 60 }],
    });
    siteId = created.site.id;
    expect(created.revision.revision).toBe(REV_CREATED);
    const updated = await admin.sites.update({
      id: siteId,
      domains: ["shop.test", "www.shop.test"],
      cacheRules: [],
    });
    expect(updated.revision.revision).toBe(REV_CREATED + 1);
    await client.exec(`
      create table test_fail_audit (action text primary key);
      create function test_fail_audit() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from test_fail_audit where action = new.action) then
          raise exception 'audit write failed (test): %', new.action;
        end if;
        return new;
      end $$;
      create trigger test_fail_audit before insert on audit_log
        for each row execute function test_fail_audit();
    `);
  });
  afterAll(() => client.close());

  it("publishes the old content as a new revision and audits it", async () => {
    const target = await getRevision(ctx.db, clusterId, REV_CREATED);
    const revision = await admin.clusters.rollback({ id: clusterId, revision: REV_CREATED });
    expect(revision).toMatchObject({
      clusterId,
      revision: REV_CREATED + 2,
      contentHash: target?.contentHash,
      reasonCode: "rollback",
      reasonParams: { revision: REV_CREATED },
      reason: `rollback to revision ${REV_CREATED}`,
      siteCount: 1,
    });
    // The new revision carries the old sites (one domain, one cache rule) under its own number.
    const latest = await latestRevision(ctx.db, clusterId);
    const config = decodeNodeConfig(latest?.ir ?? new Uint8Array());
    expect(config.revision).toBe(BigInt(REV_CREATED + 2));
    expect(config.contentHash).toBe(target?.contentHash);
    expect(config.sites).toEqual(await sitesOf(REV_CREATED));
    expect(config.sites[0]?.domains.map((d) => d.name)).toEqual(["shop.test"]);
    expect(config.sites[0]?.cacheRules).toHaveLength(1);
    expect(latest?.createdByUserId).toBe((await admin.account.me()).user.id);

    const [entry] = await rollbackAudits();
    expect(entry).toMatchObject({
      actorType: "user",
      actorName: "Platform Admin",
      targetType: "cluster",
      targetName: "default",
      metadata: {
        toRevision: REV_CREATED,
        revision: REV_CREATED + 2,
        contentHash: target?.contentHash,
        created: true,
      },
    });
    const listed = await admin.auditLogs.list({ action: "cluster.rollback" });
    expect(listed.total).toBe(1);
  });

  it("audits a rollback to the content that is already live without a new revision", async () => {
    const before = await latestRevision(ctx.db, clusterId);
    const revision = await admin.clusters.rollback({ id: clusterId, revision: REV_CREATED });
    expect(revision.revision).toBe(before?.revision);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before?.revision);
    const entries = await rollbackAudits();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.metadata).toMatchObject({ revision: before?.revision, created: false });
  });

  it("writes nothing for unknown revisions or clusters", async () => {
    const before = await latestRevision(ctx.db, clusterId);
    const missing = await rpcError(admin.clusters.rollback({ id: clusterId, revision: 999 }));
    expect(missing).toMatchObject({ code: "REVISION_NOT_FOUND", status: 404 });
    const unknown = await rpcError(
      admin.clusters.rollback({ id: "00000000-0000-4000-8000-000000000000", revision: 1 }),
    );
    expect(unknown).toMatchObject({ code: "CLUSTER_NOT_FOUND", status: 404 });
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before?.revision);
    expect(await rollbackAudits()).toHaveLength(2);
  });

  it("keeps no revision when its audit entry cannot be written (same transaction)", async () => {
    const before = await latestRevision(ctx.db, clusterId);
    await client.query("insert into test_fail_audit (action) values ('cluster.rollback')");
    try {
      const error = await rpcError(admin.clusters.rollback({ id: clusterId, revision: 1 }));
      expect(error.status).toBe(500);
    } finally {
      await client.query("delete from test_fail_audit");
    }
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before?.revision);
    expect(await rollbackAudits()).toHaveLength(2);

    // Without the failure the same rollback goes through.
    const revision = await admin.clusters.rollback({ id: clusterId, revision: 1 });
    expect(revision).toMatchObject({ revision: (before?.revision ?? 0) + 1, siteCount: 0 });
    expect(await rollbackAudits()).toHaveLength(3);
  });
});
