import type { Revision } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision, pruneRevisions } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("retained configuration history", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let readKey: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    readKey = (await admin.accessKeys.create({ name: "history reader", scope: "read" })).key;
    clusterId = (await admin.clusters.create({ name: "history" })).id;
    const initial = await latestRevision(ctx.db, clusterId);
    if (!initial) throw new Error("missing initial revision");
    await ctx.db.insert(schema.configRevision).values(
      Array.from({ length: 204 }, (_, index) => ({
        ...initial,
        id: undefined,
        revision: index + 2,
      })),
    );
    const created = await admin.sites.create({
      clusterId,
      name: "history site",
      domains: ["history.test"],
      origins: [{ address: "origin.test" }],
    });
    siteId = created.site.id;
    expect(created.revision.revision).toBe(206);
    const current = await latestRevision(ctx.db, clusterId);
    if (!current) throw new Error("missing current revision");
    await ctx.db.insert(schema.configRevision).values(
      [207, 208].map((revision) => ({
        ...current,
        id: undefined,
        revision,
        reason: "ACME challenge updated",
        reasonCode: "acme_challenge_updated",
      })),
    );
    await ctx.db.insert(schema.clusterRollout).values({ clusterId, stableRevision: 1 });
    // 200 ordinary revisions, the pinned stable revision and two recent challenge revisions.
    expect(await pruneRevisions(ctx.db)).toBe(5);
  });
  afterAll(() => pglite.close());

  it("reads every retained revision across gaps without shifting when a new one arrives", async () => {
    const defaults = await admin.clusters.revisions({ id: clusterId });
    expect(defaults).toHaveLength(100);
    expect(defaults[0]?.revision).toBe(208);
    let page = await admin.clusters.revisions({ id: clusterId, limit: 20 });
    const seen = page.map((row) => row.revision);
    const current = await latestRevision(ctx.db, clusterId);
    if (!current) throw new Error("missing current revision");
    await ctx.db.insert(schema.configRevision).values({ ...current, id: undefined, revision: 209 });

    while (page.length === 20) {
      const before = page.at(-1)?.revision ?? 0;
      page = await admin.clusters.revisions({
        id: clusterId,
        before,
        limit: 20,
      });
      expect(page.every((row) => row.revision < before)).toBe(true);
      seen.push(...page.map((row) => row.revision));
    }
    expect(seen).toEqual([208, 207, ...Array.from({ length: 200 }, (_, i) => 206 - i), 1]);
    expect(await admin.clusters.revisions({ id: clusterId, before: 1 })).toEqual([]);
    const other = (await admin.clusters.list()).find((cluster) => cluster.id !== clusterId);
    if (!other) throw new Error("missing other cluster");
    expect(await admin.clusters.revisions({ id: other.id, before: 209 })).toHaveLength(1);
  });

  it("keeps impact preview and rollback available for the oldest retained revision", async () => {
    const [oldest] = await admin.clusters.revisions({ id: clusterId, before: 7 });
    expect(oldest?.revision).toBe(1);
    const preview = await admin.clusters.rollbackPreview({ id: clusterId, revision: 1 });
    expect(preview).toMatchObject({
      revision: 1,
      unchanged: false,
      sites: { added: [], changed: [], removed: [{ id: siteId, name: "history site" }] },
    });
    const rolledBack = await admin.clusters.rollback({ id: clusterId, revision: 1 });
    expect(rolledBack.revision).toBeGreaterThan(preview.currentRevision ?? 0);
    expect(rolledBack.siteCount).toBe(0);
  });

  it("parses before and limit from the REST query string and returns the revision array", async () => {
    const headers = { "x-api-key": readKey };
    const url = `${origin}/api/v1/clusters/${clusterId}/revisions`;
    const first = await app.request(url, { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toHaveLength(100);

    const page = await app.request(`${url}?before=207&limit=1`, { headers });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject([{ clusterId, revision: 206 }]);

    const older = await app.request(`${url}?before=206&limit=100`, { headers });
    expect(older.status).toBe(200);
    const rows = (await older.json()) as Revision[];
    expect(rows).toHaveLength(100);
    expect(rows[0]?.revision).toBe(205);
    expect(rows.every((row) => row.revision < 206)).toBe(true);

    const end = await app.request(`${url}?before=1&limit=20`, { headers });
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual([]);
  });

  it("rejects malformed REST query strings instead of ignoring the page bounds", async () => {
    for (const query of ["before=invalid", "before=0", "limit=101", "limit=1.5"]) {
      const response = await app.request(
        `${origin}/api/v1/clusters/${clusterId}/revisions?${query}`,
        { headers: { "x-api-key": readKey } },
      );
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("rejects invalid page bounds and keeps missing-cluster errors", async () => {
    for (const input of [{ before: 0 }, { limit: 101 }]) {
      expect((await rpcError(admin.clusters.revisions({ id: clusterId, ...input }))).code).toBe(
        "BAD_REQUEST",
      );
    }
    expect(
      (
        await rpcError(
          admin.clusters.revisions({ id: "00000000-0000-4000-8000-000000000000", before: 7 }),
        )
      ).code,
    ).toBe("CLUSTER_NOT_FOUND");
  });
});
