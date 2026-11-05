import "reflect-metadata";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { TIERED_CACHE_DEFAULTS } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { systemActor } from "../../src/server/services/audit";
import { createCluster } from "../../src/server/services/clusters";
import { updateNodeExtensionSettings } from "../../src/server/services/extension-node-settings";
import { updateExtension } from "../../src/server/services/extensions";
import { latestRevision } from "../../src/server/services/revisions";
import { PACKAGE, PUBLIC_JWK, SIGNATURE } from "./extension-fixtures";
import { seedNodeExtension } from "./extension-node-fixtures";
import {
  type ApiClient,
  createTestContext,
  createTestDatabase,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const binding = (port: number, bind = "0.0.0.0") => ({
  listeners: { status: { port, bind, allow: ["10.1.2.3/8"] } },
});

describe("independent node extension settings", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let secondCluster: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    secondCluster = (await admin.clusters.create({ name: "second", description: "" })).id;
    await admin.extensionKeys.add({ publisher: "example.org", key: PUBLIC_JWK });
  });
  afterAll(() => client.close());

  it("keeps defaults off, saves bindings separately and preflights without side effects", async () => {
    const id = "node-defaults";
    const [pkg] = await seedNodeExtension(ctx.db, id);
    expect((await admin.extensions.list()).find((extension) => extension.id === id)?.scope).toBe(
      "node",
    );
    expect(await admin.extensions.nodeSettings({ id })).toMatchObject({
      settings: { listeners: {} },
      targetClusterIds: expect.arrayContaining([clusterId, secondCluster]),
    });
    const revisions = await ctx.db.select().from(schema.configRevision);
    const audits = await ctx.db.select().from(schema.auditLog);
    const checked = await admin.extensions.checkNodeSettings({ id, settings: binding(9145) });
    expect(checked.settings.listeners.status).toEqual({
      port: 9145,
      bind: "0.0.0.0",
      allow: ["10.0.0.0/8"],
    });
    expect(await ctx.db.select().from(schema.extensionNodeSetting)).toEqual([]);
    expect(await ctx.db.select().from(schema.auditLog)).toEqual(audits);
    const saved = await admin.extensions.updateNodeSettings({ id, settings: binding(9145) });
    expect(saved.settings).toEqual(checked.settings);
    expect((await ctx.db.select().from(schema.configRevision)).length).toBe(revisions.length);
    const [version] = await ctx.db
      .select()
      .from(schema.extensionVersion)
      .where(eq(schema.extensionVersion.extensionId, id));
    expect(Buffer.from(version?.package ?? [])).toEqual(pkg?.package);
    expect(version?.signature).toBe(pkg?.signature);
    expect(version?.manifest).toEqual(pkg?.manifest);
    expect((await admin.extensions.get({ id })).config).toEqual({ label: "status" });
    const audit = (await admin.auditLogs.list({ action: "extension.node_settings_update" })).items;
    expect(audit[0]).toMatchObject({
      targetId: id,
      metadata: { targetClusterIds: checked.targetClusterIds, revisions: {} },
    });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain("10.0.0.0");
  });

  it("refuses unknown names including null, old aliases and signed method/body overrides", async () => {
    const id = "node-strict";
    await seedNodeExtension(ctx.db, id);
    for (const [settings, code] of [
      [{ listeners: { old_name: null } }, "EXTENSION_NODE_SETTINGS_INVALID"],
      [{ ...binding(9145), clusters: [] }, "BAD_REQUEST"],
      [
        { listeners: { status: { port: 9145, allow: ["10.0.0.0/8"], methods: ["POST"] } } },
        "BAD_REQUEST",
      ],
      [
        { listeners: { status: { port: 9145, allow: ["10.0.0.0/8"], max_body: 65536 } } },
        "BAD_REQUEST",
      ],
    ] as const) {
      expect(
        await rpcError(admin.extensions.updateNodeSettings({ id, settings: settings as never })),
      ).toMatchObject({ code, status: 400 });
    }
    expect(await admin.extensions.nodeSettings({ id })).toMatchObject({
      settings: { listeners: {} },
    });
    expect(
      await admin.extensions.updateNodeSettings({ id, settings: { clusterIds: null } }),
    ).toMatchObject({
      settings: { listeners: {}, clusterIds: null },
      targetClusterIds: expect.arrayContaining([clusterId, secondCluster]),
    });
    expect(
      await admin.extensions.updateNodeSettings({ id, settings: { listeners: { status: null } } }),
    ).toMatchObject({ settings: { listeners: { status: null } } });
    expect(
      await rpcError(
        admin.extensions.updateNodeSettings({
          id,
          settings: { listeners: {}, clusterIds: ["00000000-0000-4000-8000-000000000000"] },
        }),
      ),
    ).toMatchObject({ code: "CLUSTER_NOT_FOUND" });
  });

  it.each([false, true])(
    "keeps a cluster explicitly targeted by an enabled=%s extension",
    async (enabled) => {
      const id = enabled ? "node-delete-enabled" : "node-delete-disabled";
      const target = await admin.clusters.create({ name: id, description: "" });
      await seedNodeExtension(ctx.db, id);
      await admin.extensions.updateNodeSettings({
        id,
        settings: { listeners: {}, clusterIds: [target.id] },
      });
      if (enabled) await admin.extensions.update({ id, enabled: true });
      const originalCluster = await ctx.db
        .select()
        .from(schema.cluster)
        .where(eq(schema.cluster.id, target.id));
      const originalSettings = await ctx.db
        .select()
        .from(schema.extensionNodeSetting)
        .where(eq(schema.extensionNodeSetting.extensionId, id));
      const originalAudits = await ctx.db.select().from(schema.auditLog);

      expect(await rpcError(admin.clusters.delete({ id: target.id }))).toMatchObject({
        code: "CLUSTER_NODE_EXTENSION_IN_USE",
        status: 409,
        data: { extensions: id },
      });
      expect(
        await ctx.db.select().from(schema.cluster).where(eq(schema.cluster.id, target.id)),
      ).toEqual(originalCluster);
      expect(
        await ctx.db
          .select()
          .from(schema.extensionNodeSetting)
          .where(eq(schema.extensionNodeSetting.extensionId, id)),
      ).toEqual(originalSettings);
      expect(await ctx.db.select().from(schema.auditLog)).toEqual(originalAudits);
      expect((await admin.extensions.nodeSettings({ id })).targetClusterIds).toEqual([target.id]);

      await admin.extensions.updateNodeSettings({
        id,
        settings: { listeners: {}, clusterIds: [] },
      });
      await admin.clusters.delete({ id: target.id });
      expect(
        await ctx.db.select().from(schema.cluster).where(eq(schema.cluster.id, target.id)),
      ).toEqual([]);
      expect(await admin.extensions.nodeSettings({ id })).toMatchObject({
        settings: { listeners: {}, clusterIds: [] },
        targetClusterIds: [],
      });
      expect(
        (await admin.auditLogs.list({ action: "cluster.delete" })).items.filter(
          (entry) => entry.targetId === target.id,
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps null as all clusters without treating it as an explicit deletion reference", async () => {
    const id = "node-null-targets";
    const target = await admin.clusters.create({ name: id, description: "" });
    await seedNodeExtension(ctx.db, id);
    await admin.extensions.updateNodeSettings({ id, settings: { clusterIds: null } });
    expect(await admin.extensions.nodeSettings({ id })).toMatchObject({
      settings: { listeners: {}, clusterIds: null },
      targetClusterIds: expect.arrayContaining([target.id]),
    });
    await admin.clusters.delete({ id: target.id });
    const saved = await admin.extensions.nodeSettings({ id });
    expect(saved.settings.clusterIds).toBeNull();
    expect(saved.targetClusterIds).not.toContain(target.id);
  });

  it("checks edge ports, UDP pools, L4 ranges and the configured tier port", async () => {
    const id = "node-reserved";
    await seedNodeExtension(ctx.db, id);
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [9200], httpsPorts: [9201] });
    await admin.clusters.setPortPools({
      clusterId,
      pools: [{ protocol: "udp", from: 9210, to: 9215 }],
    });
    // An L4 application remains a reservation even if an old/imported row has lost its pool.
    const [appRow] = await ctx.db
      .insert(schema.l4App)
      .values({
        clusterId,
        name: "imported range",
        protocol: "tcp",
        port: 9220,
        portEnd: 9225,
        cnamePrefix: "node-reserved-range",
      })
      .returning();
    for (const [port, owner] of [
      [9200, "edge/internal"],
      [9201, "edge/internal"],
      [9213, "l4_pool"],
      [9223, "l4_app"],
      [TIERED_CACHE_DEFAULTS.port, "tiered_cache"],
    ] as const) {
      expect(
        await rpcError(
          admin.extensions.checkNodeSettings({
            id,
            settings: { ...binding(port), clusterIds: [clusterId] },
          }),
        ),
      ).toMatchObject({ code: "PORT_BINDING_CONFLICT", status: 409, data: { port, owner } });
    }
    expect(
      await admin.extensions.checkNodeSettings({
        id,
        settings: { ...binding(9200), clusterIds: [secondCluster] },
      }),
    ).toMatchObject({ targetClusterIds: [secondCluster] });
    expect(
      await admin.extensions.checkNodeSettings({
        id,
        settings: { ...binding(9200), clusterIds: [] },
      }),
    ).toMatchObject({ targetClusterIds: [] });
    await ctx.db.delete(schema.l4App).where(eq(schema.l4App.id, appRow?.id ?? ""));
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [], httpsPorts: [] });
    await admin.clusters.setPortPools({ clusterId, pools: [] });
  });

  it("checks both directions and revalidates re-enable and target changes", async () => {
    const id = "node-owner";
    const other = "node-other";
    await seedNodeExtension(ctx.db, id);
    await seedNodeExtension(ctx.db, other);
    await admin.extensions.updateNodeSettings({
      id,
      settings: { ...binding(9300), clusterIds: [clusterId] },
    });
    await admin.extensions.update({ id, enabled: true });
    expect(
      await rpcError(
        admin.extensions.checkNodeSettings({
          id: other,
          settings: { ...binding(9300), clusterIds: null },
        }),
      ),
    ).toMatchObject({ code: "PORT_BINDING_CONFLICT" });
    for (const mutate of [
      () => admin.clusters.setListenPorts({ clusterId, httpPorts: [9300], httpsPorts: [] }),
      () =>
        admin.clusters.setPortPools({
          clusterId,
          pools: [{ protocol: "udp", from: 9299, to: 9301 }],
        }),
      () =>
        admin.tieredCache.update({
          topology: "off",
          upperNodeIds: [],
          upperNodeGroupIds: [],
          port: 9300,
        }),
      () =>
        admin.extensions.updateNodeSettings({
          id: other,
          settings: { ...binding(9300, "::"), clusterIds: [clusterId] },
        }),
    ]) {
      expect(await rpcError(mutate())).toMatchObject({ code: "PORT_BINDING_CONFLICT" });
    }
    await admin.extensions.updateNodeSettings({
      id: other,
      settings: { ...binding(9300, "::"), clusterIds: [secondCluster] },
    });
    await admin.extensions.update({ id: other, enabled: true });
    expect(
      await rpcError(admin.extensions.updateNodeSettings({ id, settings: binding(9300) })),
    ).toMatchObject({ code: "PORT_BINDING_CONFLICT" });
    expect((await admin.extensions.nodeSettings({ id })).targetClusterIds).toEqual([clusterId]);
    await admin.extensions.update({ id, enabled: false });
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [9300], httpsPorts: [] });
    expect(await rpcError(admin.extensions.update({ id, enabled: true }))).toMatchObject({
      code: "PORT_BINDING_CONFLICT",
    });
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [], httpsPorts: [] });
    await admin.extensions.update({ id: other, enabled: false });
  });

  it("rechecks all bindings after the kill switch releases them", async () => {
    const id = "node-kill";
    await seedNodeExtension(ctx.db, id);
    await admin.extensions.updateNodeSettings({ id, settings: binding(9400) });
    await admin.extensions.update({ id, enabled: true });
    await admin.extensions.updateSettings({ disabled: true });
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [9400], httpsPorts: [] });
    expect(await rpcError(admin.extensions.updateSettings({ disabled: false }))).toMatchObject({
      code: "PORT_BINDING_CONFLICT",
    });
    expect(await admin.extensions.settings()).toEqual({ disabled: true });
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [], httpsPorts: [] });
    await admin.extensions.updateSettings({ disabled: false });
    await admin.extensions.update({ id, enabled: false });
  });

  it("validates target manifests on upgrade/rollback and refuses scope changes while disabled", async () => {
    const id = "node-versions";
    await seedNodeExtension(ctx.db, id, [
      {},
      {},
      {
        listeners: [{ name: "changed", default_port: 9500, methods: ["HEAD"] }],
      },
      { scope: undefined, hooks: ["init"], listeners: undefined },
    ]);
    await admin.extensions.updateNodeSettings({ id, settings: binding(9500) });
    await admin.extensions.activate({ id, version: "1.0.1" });
    const beforeAudits = (await admin.auditLogs.list({ action: "extension.activate" })).items
      .length;
    expect(await rpcError(admin.extensions.activate({ id, version: "1.0.2" }))).toMatchObject({
      code: "EXTENSION_NODE_SETTINGS_INVALID",
    });
    expect(await rpcError(admin.extensions.activate({ id, version: "1.0.3" }))).toMatchObject({
      code: "EXTENSION_SCOPE_CHANGE",
    });
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [9500], httpsPorts: [] });
    expect(await rpcError(admin.extensions.activate({ id, version: "1.0.0" }))).toMatchObject({
      code: "PORT_BINDING_CONFLICT",
    });
    expect((await admin.extensions.get({ id })).version).toBe("1.0.1");
    expect((await admin.auditLogs.list({ action: "extension.activate" })).items.length).toBe(
      beforeAudits,
    );
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [], httpsPorts: [] });
    await admin.extensions.activate({ id, version: "1.0.0" });
    const [siteVersion] = await ctx.db
      .select()
      .from(schema.extensionVersion)
      .where(
        and(
          eq(schema.extensionVersion.extensionId, id),
          eq(schema.extensionVersion.version, "1.0.3"),
        ),
      );
    expect(
      await rpcError(
        admin.extensions.install({
          package: Buffer.from(siteVersion?.package ?? []).toString("base64"),
          signature: siteVersion?.signature ?? "",
        }),
      ),
    ).toMatchObject({ code: "EXTENSION_SCOPE_CHANGE" });
    await seedNodeExtension(ctx.db, "site-to-node", [
      { scope: undefined, hooks: ["init"], listeners: undefined },
      {},
    ]);
    expect(
      await rpcError(admin.extensions.activate({ id: "site-to-node", version: "1.0.1" })),
    ).toMatchObject({ code: "EXTENSION_SCOPE_CHANGE" });
  });

  it("checks an all-cluster binding when the first cluster is added", async () => {
    const isolated = await createTestDatabase();
    try {
      const id = "node-all-clusters";
      await seedNodeExtension(isolated.db, id);
      await updateNodeExtensionSettings(
        isolated.db,
        { id, settings: binding(TIERED_CACHE_DEFAULTS.port) },
        systemActor,
      );
      await updateExtension(isolated.db, { id, enabled: true }, systemActor);
      await expect(
        createCluster(isolated.db, { name: "first", description: "" }, systemActor),
      ).rejects.toMatchObject({ code: "PORT_BINDING_CONFLICT" });
      expect(await isolated.db.select().from(schema.cluster)).toEqual([]);
      expect(
        (await isolated.db.select().from(schema.auditLog)).some(
          (entry) => entry.action === "cluster.create",
        ),
      ).toBe(false);
    } finally {
      await isolated.client.close();
    }
  });

  it("requires target-node features without putting node packages on the site delivery path", async () => {
    const id = "node-features";
    await seedNodeExtension(ctx.db, id);
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "old node",
        supportedFeatures: ["extensions-v1", "extensions-v2"],
      })
      .returning();
    expect(await rpcError(admin.extensions.update({ id, enabled: true }))).toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
    });
    await admin.extensions.updateNodeSettings({ id, settings: { listeners: {}, clusterIds: [] } });
    await admin.extensions.update({ id, enabled: true });
    expect(
      await rpcError(
        admin.extensions.updateNodeSettings({
          id,
          settings: { listeners: {}, clusterIds: [clusterId] },
        }),
      ),
    ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node?.id ?? ""));
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [9600], httpsPorts: [] });
    const revision = await latestRevision(ctx.db, clusterId);
    expect(decodeNodeConfig(revision?.ir ?? new Uint8Array()).extensions).toEqual([]);
  });

  it("retains site installation and authenticates the shared HTTP API", async () => {
    await admin.extensions.install({ package: PACKAGE.toString("base64"), signature: SIGNATURE });
    expect(await rpcError(admin.extensions.nodeSettings({ id: "hello-header" }))).toMatchObject({
      code: "EXTENSION_SCOPE_MISMATCH",
    });
    const site = await admin.sites.create({
      name: "legacy",
      domains: ["node-settings.test"],
      origins: [{ address: "origin.example.com" }],
    });
    expect(
      (await admin.extensions.forSite({ siteId: site.site.id })).map((entry) => entry.id).sort(),
    ).toEqual(["hello-header", "site-to-node"]);
    expect(
      await rpcError(
        admin.extensions.updateSite({
          id: "node-defaults",
          siteId: site.site.id,
          enabled: true,
          config: {},
        }),
      ),
    ).toMatchObject({ code: "EXTENSION_SCOPE_MISMATCH" });
    const reader = (await admin.accessKeys.create({ name: "node-reader", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "node-writer", scope: "write" })).key;
    const request = (key: string, method: string, path = "", body?: unknown) =>
      app.request(`${origin}/api/v1/extensions/node-strict/node-settings${path}`, {
        method,
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await request("", "GET")).status).toBe(401);
    expect((await request(reader, "GET")).status).toBe(200);
    expect((await request(reader, "PUT", "", { settings: { listeners: {} } })).status).toBe(403);
    expect((await request(writer, "POST", "/check", { settings: { listeners: {} } })).status).toBe(
      200,
    );
    expect(
      (await request(writer, "PUT", "", { settings: { listeners: {} }, oldSettings: null })).status,
    ).toBe(400);
    expect((await request(writer, "PUT", "", { settings: { listeners: {} } })).status).toBe(200);
  });
});
