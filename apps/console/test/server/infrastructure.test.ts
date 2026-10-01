import { contract } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

type Route = { method?: string; path?: string };

/** Every contract procedure with its HTTP route under /api/v1. */
function procedureRoutes(node: unknown, prefix = ""): [string, Route][] {
  if (node && typeof node === "object" && "~orpc" in node)
    return [[prefix, (node as { "~orpc": { route: Route } })["~orpc"].route]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    procedureRoutes(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("infrastructure procedures and read-only AccessKeys", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
  });
  afterAll(() => pglite.close());

  it("refuses every write procedure to a read-only AccessKey and changes nothing", async () => {
    const { key } = await admin.accessKeys.create({ name: "readonly", scope: "read" });
    const api = (method: string, path: string, body: unknown) =>
      app.request(`${origin}/api/v1${path}`, {
        method,
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const uuid = "00000000-0000-4000-8000-000000000000";
    // rules.validate is a POST but only checks an expression.
    const writes = procedureRoutes(contract).filter(
      ([name, route]) => route.method !== "GET" && name !== "rules.validate",
    );
    expect(writes.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "system.setup",
        "accessKeys.create",
        "serviceAccounts.createKey",
        "sites.create",
        "sites.delete",
        "clusters.createEnrollmentToken",
        "nodes.delete",
        "settings.setOriginAllowList",
      ]),
    );
    const audit = (await admin.auditLogs.list({})).total;
    for (const [name, route] of writes) {
      const res = await api(
        route.method ?? "POST",
        (route.path ?? "").replace(/\{\w+\}/g, uuid),
        {},
      );
      expect(res.status, name).toBe(403);
      expect(((await res.json()) as { code?: string }).code, name).toBe("ACCESS_KEY_READ_ONLY");
    }
    expect((await admin.auditLogs.list({})).total).toBe(audit);
    const validated = await api("POST", "/rules/validate", {
      expression: "http.host gt 5",
      phase: "waf-custom",
    });
    expect(validated.status).toBe(200);
  });

  it("renames clusters and refuses to delete clusters that still hold sites", async () => {
    const created = await admin.clusters.create({ name: "edge-b", description: "second" });
    expect(created.latestRevision).toMatchObject({ revision: 1, reasonCode: "cluster_created" });
    const dup = await rpcError(admin.clusters.update({ id: created.id, name: "default" }));
    expect(dup).toMatchObject({
      code: "CLUSTER_NAME_TAKEN",
      status: 409,
      data: { name: "default" },
    });
    const renamed = await admin.clusters.update({ id: created.id, name: "edge-bj" });
    expect(renamed).toMatchObject({ name: "edge-bj", description: "second" });

    const site = await admin.sites.create({
      name: "pinned",
      clusterId: created.id,
      domains: ["pinned.test"],
      origins: [{ address: "origin.internal" }],
    });
    const busy = await rpcError(admin.clusters.delete({ id: created.id }));
    expect(busy).toMatchObject({
      code: "CLUSTER_NOT_EMPTY",
      status: 409,
      data: { nodes: 0, sites: 1 },
    });
    await admin.sites.delete({ id: site.site.id });
    expect(await admin.clusters.delete({ id: created.id })).toEqual({ ok: true });
    expect((await rpcError(admin.clusters.get({ id: created.id }))).code).toBe("CLUSTER_NOT_FOUND");
  });

  it("manages regions and node groups", async () => {
    const [cluster] = await admin.clusters.list();
    if (!cluster) throw new Error("no cluster");
    const east = await admin.regions.create({ name: "East China", code: "CN-East" });
    expect(east).toMatchObject({ code: "cn-east", nodeGroupCount: 0 });
    expect((await rpcError(admin.regions.create({ name: "Dup", code: "cn-east" }))).code).toBe(
      "REGION_CODE_TAKEN",
    );
    const renamedRegion = await admin.regions.update({ id: east.id, name: "East" });
    expect(renamedRegion.name).toBe("East");

    const groups = await admin.nodeGroups.list({ clusterId: cluster.id });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "default", isDefault: true });
    const group = await admin.nodeGroups.create({
      clusterId: cluster.id,
      name: "shanghai",
      regionId: east.id,
    });
    expect(group).toMatchObject({ regionName: "East", regionCode: "cn-east", nodeCount: 0 });
    expect(
      (await rpcError(admin.nodeGroups.create({ clusterId: cluster.id, name: "shanghai" }))).code,
    ).toBe("NODE_GROUP_NAME_TAKEN");
    const moved = await admin.nodeGroups.update({ id: group.id, name: "sh", regionId: null });
    expect(moved).toMatchObject({ name: "sh", regionId: null });
    const regions = await admin.regions.list();
    expect(regions.find((r) => r.id === east.id)?.nodeGroupCount).toBe(0);

    const defaultGroup = groups[0];
    if (!defaultGroup) throw new Error("no default group");
    expect((await rpcError(admin.nodeGroups.delete({ id: defaultGroup.id }))).code).toBe(
      "NODE_GROUP_IS_DEFAULT",
    );
    expect(await admin.nodeGroups.delete({ id: group.id })).toEqual({ ok: true });
    expect(await admin.regions.delete({ id: east.id })).toEqual({ ok: true });
    expect(await admin.regions.list()).toEqual([]);
  });

  it("renames, moves, disables, enables and deletes nodes (revoking the certificate)", async () => {
    const [cluster] = await admin.clusters.list();
    if (!cluster) throw new Error("no cluster");
    const [defaultGroup] = await admin.nodeGroups.list({ clusterId: cluster.id });
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: cluster.id,
        nodeGroupId: defaultGroup?.id ?? null,
        name: "edge-1",
        certSerial: "0A:1B:2C",
        certFingerprint: "ab".repeat(32),
      })
      .returning();
    if (!node) throw new Error("no node");
    const group = await admin.nodeGroups.create({ clusterId: cluster.id, name: "canary" });

    const other = await admin.clusters.create({ name: "elsewhere" });
    const [otherGroup] = await admin.nodeGroups.list({ clusterId: other.id });
    const mismatch = await rpcError(
      admin.nodes.update({ id: node.id, nodeGroupId: otherGroup?.id ?? "" }),
    );
    expect(mismatch.code).toBe("NODE_GROUP_CLUSTER_MISMATCH");

    const updated = await admin.nodes.update({
      id: node.id,
      name: "edge-sh-1",
      nodeGroupId: group.id,
    });
    expect(updated).toMatchObject({
      name: "edge-sh-1",
      nodeGroupId: group.id,
      nodeGroupName: "canary",
    });
    expect(
      (await admin.nodeGroups.list({ clusterId: cluster.id })).find((g) => g.id === group.id),
    ).toMatchObject({ nodeCount: 1 });

    expect((await admin.nodes.disable({ id: node.id })).status).toBe("disabled");
    expect((await admin.nodes.enable({ id: node.id })).status).toBe("active");

    // Deleting the group moves its nodes back to the default group.
    await admin.nodeGroups.delete({ id: group.id });
    expect((await admin.nodes.get({ id: node.id })).nodeGroupId).toBe(defaultGroup?.id);

    expect(await admin.nodes.delete({ id: node.id })).toEqual({ ok: true });
    expect((await rpcError(admin.nodes.get({ id: node.id }))).code).toBe("NODE_NOT_FOUND");
    const revoked = await ctx.db
      .select()
      .from(schema.nodeCertificateRevocation)
      .where(eq(schema.nodeCertificateRevocation.nodeId, node.id));
    expect(revoked).toMatchObject([{ serial: "a1b2c", reason: "node deleted" }]);
    await admin.clusters.delete({ id: other.id });
  });

  it("filters and pages the audit log and shows actor and target names", async () => {
    const all = await admin.auditLogs.list({ limit: 200 });
    expect(all.total).toBeGreaterThan(10);
    const facets = await admin.auditLogs.facets();
    expect(facets.actions).toEqual(expect.arrayContaining(["cluster.create", "node.delete"]));
    expect(facets.targetTypes).toEqual(expect.arrayContaining(["cluster", "node", "user"]));

    const deletes = await admin.auditLogs.list({ action: "node.delete" });
    expect(deletes.total).toBe(1);
    expect(deletes.items[0]).toMatchObject({
      actorType: "user",
      actorName: "Platform Admin",
      targetType: "node",
      targetName: "edge-sh-1",
    });

    const clusters = await admin.auditLogs.list({ targetType: "cluster", limit: 2 });
    expect(clusters.items).toHaveLength(2);
    const page2 = await admin.auditLogs.list({ targetType: "cluster", limit: 2, offset: 2 });
    expect(page2.total).toBe(clusters.total);
    expect(page2.items[0]?.id).toBeLessThan(clusters.items[1]?.id ?? 0);

    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await admin.auditLogs.list({ from: future })).total).toBe(0);
    expect((await admin.auditLogs.list({ to: future })).total).toBe(all.total);
  });
});
