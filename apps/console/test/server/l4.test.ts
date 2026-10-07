import { decodeNodeConfig, MAX_L4_APPS_PER_CLUSTER } from "@edgeweir/config-compiler";
import { l4AppCreateInput, l4AppUpdateInput, portPoolsInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { L4Protocol } from "@edgeweir/proto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { Actor } from "../../src/server/services/audit";
import { bindingPolicy, compileBindingPlan, loadBinding } from "../../src/server/services/dns";
import {
  createL4App,
  deleteL4App,
  setL4AppEnabled,
  setPortPools,
  updateL4App,
} from "../../src/server/services/l4";
import { latestRevision } from "../../src/server/services/revisions";
import { currentStable } from "../../src/server/services/rollback";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const missing = "00000000-0000-4000-8000-000000000000";
const service: Actor = { type: "service_account", id: "sa-1", name: "integration" };

describe("port pools and layer-4 applications", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let groupId = "";
  /** The TCP application "game" and the UDP application "voice". */
  let gameId = "";
  let voiceId = "";

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async (cluster = clusterId) => {
    const row = await latestRevision(ctx.db, cluster);
    if (!row) throw new Error("no revision");
    return { row, config: decodeNodeConfig(row.ir) };
  };
  const audits = async (action: string) =>
    (await admin.auditLogs.list({ action })).items.map((item) => ({
      targetId: item.targetId,
      targetName: item.targetName,
      metadata: item.metadata,
    }));
  const appCount = async () => (await ctx.db.select({ n: count() }).from(schema.l4App))[0]?.n ?? 0;
  const tcp = { address: "game.example.com", port: 25565 };
  const pools = [
    { protocol: "udp" as const, from: 30000, to: 30010 },
    { protocol: "tcp" as const, from: 20000, to: 20100 },
    { protocol: "both" as const, from: 40000, to: 40000 },
  ];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    groupId = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
  });
  afterAll(() => pglite.close());

  it("replaces a cluster's port pools sorted and audited, refusing overlaps and listener ports", async () => {
    expect(await admin.clusters.portPools({ clusterId })).toEqual({
      clusterId,
      pools: [],
      reservedPorts: [80, 443],
      nodesWithoutL4: [],
      nodesWithoutL4V2: [],
    });
    const saved = await admin.clusters.setPortPools({ clusterId, pools });
    expect(saved.pools).toEqual([
      { protocol: "tcp", from: 20000, to: 20100 },
      { protocol: "udp", from: 30000, to: 30010 },
      { protocol: "both", from: 40000, to: 40000 },
    ]);
    expect(await admin.clusters.portPools({ clusterId })).toEqual(saved);
    expect(await audits("cluster.port_pools_update")).toEqual([
      {
        targetId: clusterId,
        targetName: "default",
        metadata: {
          from: [],
          pools: ["20000-20100/tcp", "30000-30010/udp", "40000-40000/both"],
        },
      },
    ]);
    // Pools of a protocol must not share ports; TCP and UDP pools may.
    for (const [a, b] of [
      [
        { protocol: "tcp", from: 20000, to: 20100 },
        { protocol: "both", from: 20100, to: 20200 },
      ],
      [
        { protocol: "udp", from: 5000, to: 5000 },
        { protocol: "udp", from: 5000, to: 5000 },
      ],
    ] as const) {
      const error = await rpcError(admin.clusters.setPortPools({ clusterId, pools: [b, a] }));
      expect(error).toMatchObject({
        code: "L4_PORT_POOL_OVERLAP",
        status: 400,
        data: { pools: `${a.from}-${a.to}/${a.protocol}, ${b.from}-${b.to}/${b.protocol}` },
      });
    }
    const other = await admin.clusters.create({ name: "pools" });
    await admin.clusters.setPortPools({
      clusterId: other.id,
      pools: [
        { protocol: "tcp", from: 6000, to: 7000 },
        { protocol: "udp", from: 6000, to: 7000 },
      ],
    });
    // Below 1024, inverted, too many pools: invalid input.
    for (const bad of [
      [{ protocol: "tcp", from: 1023, to: 2000 }],
      [{ protocol: "tcp", from: 3000, to: 2000 }],
      [{ protocol: "sctp", from: 3000, to: 3000 }],
      Array.from({ length: 65 }, (_, i) => ({ protocol: "tcp", from: 2000 + i, to: 2000 + i })),
    ])
      expect(
        (await rpcError(admin.clusters.setPortPools({ clusterId, pools: bad as never }))).status,
      ).toBe(400);
    // A listener port of the cluster's configuration is reserved.
    await ctx.db.transaction(async (tx) => {
      const { insertRevision } = await import("../../src/server/services/revisions");
      const { compileNodeConfig } = await import("@edgeweir/config-compiler");
      await insertRevision(
        tx,
        other.id,
        (revision) =>
          compileNodeConfig(
            {
              clusterId: other.id,
              sites: [],
              listeners: [
                { port: 80, protocol: "http" },
                { port: 8443, protocol: "https" },
              ],
            },
            revision,
          ),
        { code: "recompiled", params: {} },
        null,
      );
    });
    expect((await admin.clusters.portPools({ clusterId: other.id })).reservedPorts).toEqual([
      80, 443, 8443,
    ]);
    expect(
      await rpcError(
        admin.clusters.setPortPools({
          clusterId: other.id,
          pools: [{ protocol: "udp", from: 8000, to: 9000 }],
        }),
      ),
    ).toMatchObject({ code: "L4_PORT_RESERVED", status: 400, data: { port: 8443 } });
    expect((await admin.clusters.portPools({ clusterId: other.id })).pools).toHaveLength(2);
    for (const call of [
      () => admin.clusters.portPools({ clusterId: missing }),
      () => admin.clusters.setPortPools({ clusterId: missing, pools: [] }),
    ])
      expect((await rpcError(call())).code).toBe("CLUSTER_NOT_FOUND");
    // Pools go with their cluster.
    await admin.clusters.delete({ id: other.id });
    expect(await ctx.db.select().from(schema.clusterPortPool)).toHaveLength(3);
  });

  it("creates TCP and UDP applications with their defaults, a revision and an audit entry", async () => {
    const before = (await config()).row.revision;
    const created = await admin.l4Apps.create({
      clusterId,
      name: "game",
      protocol: "tcp",
      port: 20010,
      origins: [tcp],
    });
    gameId = created.app.id;
    expect(created.app).toMatchObject({
      clusterId,
      clusterName: "default",
      name: "game",
      protocol: "tcp",
      port: 20010,
      enabled: true,
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      origins: [{ address: "game.example.com", port: 25565, weight: 1, backup: false }],
      maxFails: 3,
      failTimeoutSeconds: 30,
      connectTimeoutMs: 5000,
      idleTimeoutSeconds: 600,
      allowListIds: [],
      blockListIds: [],
      maxConnections: 0,
      newConnectionsPerSecond: 0,
      dnsTarget: null,
      dnsLines: [],
    });
    expect(created.revision).toMatchObject({
      revision: before + 1,
      reasonCode: "l4_app_created",
      reasonParams: { app: "game" },
      reason: "L4 application game created",
    });
    const voice = await admin.l4Apps.create({
      clusterId,
      name: "voice",
      protocol: "udp",
      port: 30005,
      origins: [
        { address: "8.8.4.4", port: 3478, weight: 5 },
        { address: "voice-b.example.com", port: 3478, backup: true },
      ],
      maxConnections: 100,
      newConnectionsPerSecond: 10,
    });
    voiceId = voice.app.id;
    expect(voice.app.idleTimeoutSeconds).toBe(30);
    const { config: compiled } = await config();
    expect(compiled.requiredFeatures).toContain("l4-v1");
    expect(compiled.l4Apps.map((a) => [a.id, a.protocol, a.port])).toEqual(
      [
        [gameId, L4Protocol.TCP, 20010],
        [voiceId, L4Protocol.UDP, 30005],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    const compiledVoice = compiled.l4Apps.find((a) => a.id === voiceId);
    expect(compiledVoice).toMatchObject({
      idleTimeoutSeconds: 30,
      maxConnections: 100,
      newConnectionsPerSecond: 10,
      maxFails: 3,
      failTimeoutSeconds: 30,
      connectTimeoutMs: 5000,
    });
    expect(compiledVoice?.origins.map((o) => [o.address, o.weight, o.backup])).toEqual(
      voice.app.origins
        .map((o) => [o.id, o.address, o.weight, o.backup] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([, ...rest]) => rest),
    );
    expect(await audits("l4_app.create")).toEqual([
      {
        targetId: voiceId,
        targetName: "voice",
        metadata: {
          clusterId,
          protocol: "udp",
          port: 30005,
          enabled: true,
          origins: ["8.8.4.4:3478", "voice-b.example.com:3478"],
          revision: voice.revision.revision,
        },
      },
      expect.objectContaining({ targetId: gameId, targetName: "game" }),
    ]);
    expect((await admin.l4Apps.list({ clusterId })).map((a) => a.name)).toEqual(["game", "voice"]);
    expect((await admin.l4Apps.list({})).map((a) => a.id)).toEqual([gameId, voiceId]);
    expect(await admin.l4Apps.get({ id: gameId })).toEqual(created.app);
    // TCP and UDP may share a port of a pool for both.
    const both = await admin.l4Apps.create({
      clusterId,
      name: "both-tcp",
      protocol: "tcp",
      port: 40000,
      origins: [tcp],
    });
    const bothUdp = await admin.l4Apps.create({
      clusterId,
      name: "both-udp",
      protocol: "udp",
      port: 40000,
      origins: [tcp],
    });
    for (const id of [both.app.id, bothUdp.app.id]) await admin.l4Apps.delete({ id });
  });

  it("refuses ports outside the pools or in use, PROXY protocol on UDP, special-purpose origins and unknown lists", async () => {
    const before = (await config()).row.revision;
    const apps = await appCount();
    const create = (input: Record<string, unknown>) =>
      rpcError(
        admin.l4Apps.create({
          clusterId,
          name: "x",
          protocol: "tcp",
          port: 20050,
          origins: [tcp],
          ...input,
        } as never),
      );
    expect(await create({ port: 20500 })).toMatchObject({
      code: "L4_PORT_OUTSIDE_POOL",
      status: 400,
      data: { port: 20500 },
    });
    // 30000-30010 is a UDP pool.
    expect(await create({ port: 30001 })).toMatchObject({
      code: "L4_PORT_OUTSIDE_POOL",
      data: { port: 30001 },
    });
    expect(await create({ port: 20010 })).toMatchObject({
      code: "L4_PORT_IN_USE",
      status: 409,
      data: { apps: "game (20010/tcp)" },
    });
    for (const proxy of [
      { acceptProxyProtocol: true },
      { proxyProtocolVersion: 1 },
      { proxyProtocolVersion: 2 },
    ])
      expect(await create({ protocol: "udp", port: 30001, ...proxy })).toMatchObject({
        code: "L4_PROXY_PROTOCOL_UNSUPPORTED",
        status: 400,
      });
    expect(await create({ origins: [{ address: "127.0.0.1", port: 22 }] })).toMatchObject({
      code: "ORIGIN_ADDRESS_FORBIDDEN",
      data: { address: "127.0.0.1", range: "127.0.0.0/8" },
    });
    expect(await create({ origins: [{ address: "localhost", port: 22 }] })).toMatchObject({
      code: "ORIGIN_ADDRESS_FORBIDDEN",
    });
    expect(await create({ allowListIds: [missing] })).toMatchObject({
      code: "IP_LIST_NOT_FOUND",
      status: 404,
    });
    expect(await create({ blockListIds: [missing] })).toMatchObject({ code: "IP_LIST_NOT_FOUND" });
    // Invalid input.
    for (const input of [
      { port: 1023 },
      { protocol: "sctp" },
      { proxyProtocolVersion: 3 },
      { origins: [] },
      { origins: Array.from({ length: 33 }, () => tcp) },
      { origins: [{ ...tcp, backup: true }] },
      { origins: [{ ...tcp, weight: 0 }] },
      { origins: [{ ...tcp, weight: 101 }] },
      { origins: [{ address: "bad host", port: 1 }] },
      { origins: [{ address: "o.test", port: 0 }] },
      { name: "" },
      { maxFails: 0 },
      { failTimeoutSeconds: 3601 },
      { connectTimeoutMs: 99 },
      { idleTimeoutSeconds: 86401 },
      { maxConnections: -1 },
      { allowListIds: ["not-a-uuid"] },
    ])
      expect((await create(input)).status, JSON.stringify(input)).toBe(400);
    expect((await create({ clusterId: missing })).code).toBe("CLUSTER_NOT_FOUND");
    // The same checks apply to updates, against the application's other fields.
    expect(await rpcError(admin.l4Apps.update({ id: voiceId, port: 20010 }))).toMatchObject({
      code: "L4_PORT_OUTSIDE_POOL",
    });
    expect(
      await rpcError(admin.l4Apps.update({ id: voiceId, protocol: "tcp", port: 20010 })),
    ).toMatchObject({ code: "L4_PORT_IN_USE", data: { apps: "game (20010/tcp)" } });
    expect(
      await rpcError(admin.l4Apps.update({ id: voiceId, acceptProxyProtocol: true })),
    ).toMatchObject({ code: "L4_PROXY_PROTOCOL_UNSUPPORTED" });
    await admin.l4Apps.update({ id: gameId, proxyProtocolVersion: 1 });
    expect(
      await rpcError(admin.l4Apps.update({ id: gameId, protocol: "udp", port: 30002 })),
    ).toMatchObject({ code: "L4_PROXY_PROTOCOL_UNSUPPORTED" });
    expect(
      await rpcError(
        admin.l4Apps.update({ id: gameId, origins: [{ address: "10.1.2.3", port: 1 }] }),
      ),
    ).toMatchObject({ code: "ORIGIN_ADDRESS_FORBIDDEN", data: { range: "10.0.0.0/8" } });
    await admin.l4Apps.update({ id: gameId, proxyProtocolVersion: 0 });
    expect(await appCount()).toBe(apps);
    // The two updates to game published; nothing else did.
    expect((await config()).row.revision).toBe(before + 2);
    // Allowed special-purpose addresses may be origins.
    await admin.settings.setOriginAllowList({ cidrs: ["10.0.0.0/8"] });
    const allowed = await admin.l4Apps.update({
      id: gameId,
      origins: [tcp, { address: "10.1.2.3", port: 25565 }],
    });
    expect(allowed.app.origins.map((o) => o.address)).toEqual(["game.example.com", "10.1.2.3"]);
    await admin.l4Apps.update({ id: gameId, origins: [tcp] });
    await admin.settings.setOriginAllowList({ cidrs: [] });
  });

  it("updates applications in place, keeps origin ids and audits the changed fields", async () => {
    const current = await admin.l4Apps.get({ id: gameId });
    const firstOrigin = current.origins[0]?.id;
    const updated = await admin.l4Apps.update({
      id: gameId,
      expectedUpdatedAt: current.updatedAt,
      name: "game",
      port: 20011,
      acceptProxyProtocol: true,
      proxyProtocolVersion: 2,
      origins: [tcp, { address: "8.8.8.8", port: 25565, backup: true, weight: 2 }],
      connectTimeoutMs: 1500,
    });
    expect(updated.app).toMatchObject({
      port: 20011,
      acceptProxyProtocol: true,
      proxyProtocolVersion: 2,
      connectTimeoutMs: 1500,
      origins: [
        { id: firstOrigin, address: "game.example.com", port: 25565 },
        { address: "8.8.8.8", port: 25565, weight: 2, backup: true },
      ],
    });
    expect(updated.revision).toMatchObject({
      reasonCode: "l4_app_updated",
      reasonParams: { app: "game" },
    });
    expect(new Date(updated.app.updatedAt).getTime()).toBeGreaterThan(
      new Date(current.updatedAt).getTime(),
    );
    const [entry] = await audits("l4_app.update");
    expect(entry).toEqual({
      targetId: gameId,
      targetName: "game",
      metadata: {
        changed: [
          "port",
          "acceptProxyProtocol",
          "proxyProtocolVersion",
          "connectTimeoutMs",
          "origins",
        ],
        from: {
          port: 20010,
          acceptProxyProtocol: false,
          proxyProtocolVersion: 0,
          connectTimeoutMs: 5000,
          origins: ["game.example.com:25565"],
        },
        to: {
          port: 20011,
          acceptProxyProtocol: true,
          proxyProtocolVersion: 2,
          connectTimeoutMs: 1500,
          origins: ["game.example.com:25565", "8.8.8.8:25565"],
        },
        revision: updated.revision.revision,
      },
    });
    const compiled = (await config()).config.l4Apps.find((a) => a.id === gameId);
    expect(compiled).toMatchObject({
      port: 20011,
      acceptProxyProtocol: true,
      proxyProtocolVersion: 2,
      connectTimeoutMs: 1500,
    });
    expect(compiled?.origins.find((o) => o.id === firstOrigin)?.address).toBe("game.example.com");
    // A stale updatedAt is refused.
    expect(
      await rpcError(
        admin.l4Apps.update({ id: gameId, expectedUpdatedAt: current.updatedAt, name: "late" }),
      ),
    ).toMatchObject({ code: "UPDATED_AT_MISMATCH", status: 409 });
    for (const call of [
      () => admin.l4Apps.get({ id: missing }),
      () => admin.l4Apps.update({ id: missing, name: "x" }),
      () => admin.l4Apps.delete({ id: missing }),
      () => admin.l4Apps.setEnabled({ id: missing, enabled: false }),
      () =>
        admin.l4Apps.stats({
          id: missing,
          from: "2026-10-01T00:00:00Z",
          to: "2026-10-01T01:00:00Z",
        }),
    ])
      expect((await rpcError(call())).code).toBe("L4_APP_NOT_FOUND");
    expect((await rpcError(admin.l4Apps.list({ clusterId: missing }))).code).toBe(
      "CLUSTER_NOT_FOUND",
    );
  });

  it("switches applications off and on: a disabled one keeps its port but is not shipped", async () => {
    const off = await admin.l4Apps.setEnabled({ id: voiceId, enabled: false });
    expect(off.app.enabled).toBe(false);
    expect(off.revision.reasonCode).toBe("l4_app_updated");
    const { config: compiled, row } = await config();
    expect(compiled.l4Apps.map((a) => a.id)).toEqual([gameId]);
    // Setting the same state changes nothing.
    const again = await admin.l4Apps.setEnabled({ id: voiceId, enabled: false });
    expect(again.revision.revision).toBe(row.revision);
    // The port stays taken while the application is off.
    expect(
      await rpcError(
        admin.l4Apps.create({
          clusterId,
          name: "y",
          protocol: "udp",
          port: 30005,
          origins: [tcp],
        }),
      ),
    ).toMatchObject({ code: "L4_PORT_IN_USE", data: { apps: "voice (30005/udp)" } });
    const on = await admin.l4Apps.setEnabled({
      id: voiceId,
      enabled: true,
      expectedUpdatedAt: off.app.updatedAt,
    });
    expect(on.app.enabled).toBe(true);
    expect((await config()).config.l4Apps).toHaveLength(2);
    expect((await audits("l4_app.disable")).map((a) => a.targetId)).toEqual([voiceId]);
    expect((await audits("l4_app.enable")).map((a) => a.targetId)).toEqual([voiceId]);
  });

  it("refuses shrinking a pool below the ports applications use, disabled ones included", async () => {
    await admin.l4Apps.setEnabled({ id: voiceId, enabled: false });
    const error = await rpcError(
      admin.clusters.setPortPools({
        clusterId,
        pools: [{ protocol: "tcp", from: 20000, to: 20010 }],
      }),
    );
    expect(error).toMatchObject({
      code: "L4_PORT_IN_USE",
      status: 409,
      data: { apps: "game (20011/tcp), voice (30005/udp)" },
    });
    // A pool for both protocols holds them as well.
    const moved = await admin.clusters.setPortPools({
      clusterId,
      pools: [
        { protocol: "both", from: 20000, to: 20011 },
        { protocol: "both", from: 30005, to: 30005 },
      ],
    });
    expect(moved.pools).toHaveLength(2);
    await admin.clusters.setPortPools({ clusterId, pools });
    await admin.l4Apps.setEnabled({ id: voiceId, enabled: true });
  });

  it("refers to IP lists, compiles them sorted and keeps a list in use from deletion", async () => {
    const office = await admin.ipLists.create({ name: "office", entries: ["198.51.100.0/24"] });
    const abuse = await admin.ipLists.create({
      name: "abuse",
      entries: ["203.0.113.0/24"],
      kind: "block",
    });
    const updated = await admin.l4Apps.update({
      id: gameId,
      allowListIds: [office.id, office.id],
      blockListIds: [abuse.id],
    });
    expect(updated.app).toMatchObject({ allowListIds: [office.id], blockListIds: [abuse.id] });
    const compiled = (await config()).config;
    expect(compiled.l4Apps.find((a) => a.id === gameId)).toMatchObject({
      allowListIds: [office.id],
      blockListIds: [abuse.id],
    });
    expect(compiled.ipLists.map((l) => l.id).sort()).toEqual([office.id, abuse.id].sort());
    for (const id of [office.id, abuse.id])
      expect(await rpcError(admin.ipLists.delete({ id }))).toMatchObject({
        code: "IP_LIST_IN_USE",
        status: 409,
        data: { users: "game" },
      });
    await admin.l4Apps.update({ id: gameId, allowListIds: [], blockListIds: [] });
    await admin.ipLists.delete({ id: office.id });
    await admin.ipLists.delete({ id: abuse.id });
  });

  it("publishes a CNAME per enabled application in the cluster's DNS plan, like sites", async () => {
    const site = await admin.sites.create({
      name: "shop",
      domains: ["shop.l4.test"],
      origins: [{ address: "origin.test" }],
    });
    const plain = await admin.clusters.create({ name: "no-apps" });
    const binding = (nodeGroupId: string) => ({
      mode: "manual" as const,
      providerId: null,
      domain: "edge.l4.test",
      ttl: 60,
      lines: [{ name: "main", nodeGroupId, overrides: [] }],
      lineAliases: true,
    });
    const plan = async (cluster: string) =>
      compileBindingPlan(ctx.db, cluster, bindingPolicy(await loadBinding(ctx.db, cluster)));
    await admin.dns.saveBinding({ clusterId, binding: binding(groupId) });
    const plainGroup = (await admin.nodeGroups.list({ clusterId: plain.id }))[0]?.id ?? "";
    await admin.dns.saveBinding({
      clusterId: plain.id,
      binding: { ...binding(plainGroup), domain: "plain.l4.test" },
    });
    const withApps = await plan(clusterId);
    const cname = (name: string, data: string) => ({ name, type: "CNAME", data, ttl: 60 });
    const appRecords = [gameId, voiceId].flatMap((id) => [
      cname(id, "all.edge.l4.test"),
      cname(`main.${id}`, "main.edge.l4.test"),
    ]);
    expect(withApps.records).toEqual(expect.arrayContaining(appRecords));
    expect(withApps.records).toEqual(
      expect.arrayContaining([
        cname(site.site.id, "all.edge.l4.test"),
        cname(`main.${site.site.id}`, "main.edge.l4.test"),
      ]),
    );
    expect(withApps.managedNames).toEqual(
      expect.arrayContaining([
        { name: gameId, type: "CNAME" },
        { name: `main.${gameId}`, type: "CNAME" },
      ]),
    );
    // The applications add their CNAMEs and nothing else.
    await admin.l4Apps.setEnabled({ id: gameId, enabled: false });
    await admin.l4Apps.setEnabled({ id: voiceId, enabled: false });
    const withoutApps = await plan(clusterId);
    expect(withoutApps.records).toEqual(
      withApps.records.filter((r) => !appRecords.some((a) => a.name === r.name)),
    );
    expect(withoutApps.records.some((r) => r.name.includes(gameId))).toBe(false);
    await admin.l4Apps.setEnabled({ id: gameId, enabled: true });
    await admin.l4Apps.setEnabled({ id: voiceId, enabled: true });
    // A binding without applications plans what it did before.
    const plainPlan = await plan(plain.id);
    expect(plainPlan.records.every((r) => r.type !== "CNAME")).toBe(true);
    // The manual binding's revision lists the records; the DTO names the target.
    const stored = await admin.dns.binding({ clusterId });
    expect(stored.records).toEqual(expect.arrayContaining(appRecords));
    expect((await admin.l4Apps.get({ id: gameId })).dnsTarget).toBe(`${gameId}.edge.l4.test`);
    expect((await admin.l4Apps.get({ id: gameId })).dnsLines).toEqual([
      { name: "main", target: `main.${gameId}.edge.l4.test` },
    ]);
    expect((await admin.dns.siteTarget({ siteId: site.site.id })).target).toBe(
      `${site.site.id}.edge.l4.test`,
    );
    await admin.dns.saveBinding({
      clusterId,
      binding: { ...binding(groupId), lineAliases: false },
    });
    expect((await admin.l4Apps.get({ id: gameId })).dnsLines).toEqual([
      { name: "main", target: "main.edge.l4.test" },
    ]);
    for (const id of [clusterId, plain.id])
      await admin.dns.saveBinding({
        clusterId: id,
        binding: { mode: "off", providerId: null, domain: "", ttl: 600, lines: [] },
      });
    expect((await admin.l4Apps.get({ id: gameId })).dnsTarget).toBeNull();
    await admin.sites.delete({ id: site.site.id });
    await admin.clusters.delete({ id: plain.id });
  });

  it("holds l4-v1 for changes without the operator while an active node lacks it", async () => {
    const cluster = await admin.clusters.create({ name: "gated" });
    await setPortPools(
      ctx.db,
      portPoolsInput.parse({
        clusterId: cluster.id,
        pools: [{ protocol: "tcp", from: 9000, to: 9100 }],
      }),
      service,
    );
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: cluster.id,
        name: "old-node",
        supportedFeatures: ["rules-v1", "stats-sequence-v1"],
      })
      .returning();
    const nodeId = node?.id ?? "";
    expect((await admin.clusters.portPools({ clusterId: cluster.id })).nodesWithoutL4).toEqual([
      { id: nodeId, name: "old-node" },
    ]);
    const input = l4AppCreateInput.parse({
      clusterId: cluster.id,
      name: "svc",
      protocol: "tcp",
      port: 9000,
      origins: [tcp],
    });
    const before = (await config(cluster.id)).row.revision;
    await expect(createL4App(ctx, input, service)).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      status: 409,
      data: { features: "l4-v1" },
    });
    expect(await admin.l4Apps.list({ clusterId: cluster.id })).toEqual([]);
    expect((await config(cluster.id)).row.revision).toBe(before);
    // A disabled application needs nothing.
    const draft = await createL4App(ctx, { ...input, enabled: false }, service);
    await expect(
      setL4AppEnabled(ctx.db, { id: draft.app.id, enabled: true }, service),
    ).rejects.toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
    await deleteL4App(ctx.db, draft.app.id, service);
    // A disabled node does not count.
    await ctx.db.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
    expect((await admin.clusters.portPools({ clusterId: cluster.id })).nodesWithoutL4).toEqual([]);
    const created = await createL4App(ctx, input, service);
    await deleteL4App(ctx.db, created.app.id, service);
    await ctx.db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, nodeId));
    // The operator may deliberately require the upgrade.
    const operator = await admin.l4Apps.create(input);
    expect((await config(cluster.id)).config.requiredFeatures).toEqual(["l4-v1"]);
    // Once the node reports l4-v1, changes without the operator may use it.
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1", "stats-sequence-v1", "l4-v1"] })
      .where(eq(schema.node.id, nodeId));
    await updateL4App(ctx, l4AppUpdateInput.parse({ id: operator.app.id, port: 9001 }), service);
    await admin.l4Apps.delete({ id: operator.app.id });
    expect((await config(cluster.id)).config.requiredFeatures).toEqual([]);
    await ctx.db.delete(schema.node).where(eq(schema.node.id, nodeId));
    await admin.clusters.delete({ id: cluster.id });
  });

  it("limits the applications of a cluster", async () => {
    const cluster = await admin.clusters.create({ name: "full" });
    await admin.clusters.setPortPools({
      clusterId: cluster.id,
      pools: [{ protocol: "udp", from: 10000, to: 10000 + MAX_L4_APPS_PER_CLUSTER }],
    });
    await ctx.db.insert(schema.l4App).values(
      Array.from({ length: MAX_L4_APPS_PER_CLUSTER }, (_, i) => ({
        clusterId: cluster.id,
        name: `a${i}`,
        protocol: "udp",
        port: 10000 + i,
        enabled: false,
      })),
    );
    expect(
      await rpcError(
        admin.l4Apps.create({
          clusterId: cluster.id,
          name: "one more",
          protocol: "udp",
          port: 10000 + MAX_L4_APPS_PER_CLUSTER,
          origins: [tcp],
        }),
      ),
    ).toMatchObject({
      code: "L4_APP_LIMIT",
      status: 409,
      data: { limit: MAX_L4_APPS_PER_CLUSTER },
    });
    await admin.clusters.delete({ id: cluster.id });
    expect(
      await ctx.db.select().from(schema.l4App).where(eq(schema.l4App.clusterId, cluster.id)),
    ).toEqual([]);
  });

  it("rolls back applications as configuration history, never resurrecting deleted ones", async () => {
    const created = await admin.l4Apps.create({
      clusterId,
      name: "history",
      protocol: "tcp",
      port: 20020,
      origins: [tcp],
    });
    const atCreation = created.revision.revision;
    await admin.l4Apps.update({ id: created.app.id, port: 20021, maxFails: 9 });
    const rolledBack = await admin.clusters.rollback({ id: clusterId, revision: atCreation });
    const restored = (await config()).config;
    expect(rolledBack.revision).toBe((await config()).row.revision);
    expect(restored.l4Apps.find((a) => a.id === created.app.id)).toMatchObject({
      port: 20020,
      maxFails: 3,
    });
    expect(restored.requiredFeatures).toContain("l4-v1");
    // A disabled application stays off.
    await admin.l4Apps.setEnabled({ id: created.app.id, enabled: false });
    await admin.clusters.rollback({ id: clusterId, revision: atCreation });
    expect((await config()).config.l4Apps.map((a) => a.id)).not.toContain(created.app.id);
    // Neither a deleted application nor a port outside today's pools comes back.
    await admin.l4Apps.delete({ id: created.app.id });
    expect(
      await rpcError(admin.clusters.rollback({ id: clusterId, revision: atCreation })),
    ).toMatchObject({ code: "ROLLBACK_RESOURCE_UNAVAILABLE" });
    const game = await admin.l4Apps.get({ id: gameId });
    const gameRevision = (await config()).row.revision;
    await admin.l4Apps.update({ id: gameId, port: 20030 });
    await admin.clusters.setPortPools({
      clusterId,
      pools: pools.map((p) => (p.protocol === "tcp" ? { ...p, from: 20030 } : p)),
    });
    expect(
      await rpcError(admin.clusters.rollback({ id: clusterId, revision: gameRevision })),
    ).toMatchObject({ code: "ROLLBACK_RESOURCE_UNAVAILABLE" });
    // The canary's stable revision drops what is gone instead.
    const stable = await ctx.db.transaction(async (tx) => {
      const { getRevision } = await import("../../src/server/services/revisions");
      const row = await getRevision(tx, clusterId, gameRevision);
      return currentStable(tx, clusterId, decodeNodeConfig(row?.ir ?? new Uint8Array()));
    });
    expect(stable.l4Apps.map((a) => a.id)).toEqual([voiceId]);
    await admin.clusters.setPortPools({ clusterId, pools });
    await admin.l4Apps.update({ id: gameId, port: game.port });
  });

  it("deletes applications with a revision and an audit entry", async () => {
    const created = await admin.l4Apps.create({
      clusterId,
      name: "short-lived",
      protocol: "tcp",
      port: 20090,
      origins: [tcp],
    });
    const deleted = await admin.l4Apps.delete({ id: created.app.id });
    expect(deleted.revision).toMatchObject({
      reasonCode: "l4_app_deleted",
      reasonParams: { app: "short-lived" },
    });
    expect((await config()).config.l4Apps.map((a) => a.id)).not.toContain(created.app.id);
    expect(
      await ctx.db.select().from(schema.l4Origin).where(eq(schema.l4Origin.appId, created.app.id)),
    ).toEqual([]);
    const [entry] = await audits("l4_app.delete");
    expect(entry).toEqual({
      targetId: created.app.id,
      targetName: "short-lived",
      metadata: { clusterId, protocol: "tcp", port: 20090, revision: deleted.revision.revision },
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const range = "from=2026-10-01T00:00:00Z&to=2026-10-01T01:00:00Z";
    const reads: [string, string][] = [
      ["GET", `/clusters/${clusterId}/port-pools`],
      ["GET", "/l4-apps"],
      ["GET", `/l4-apps?clusterId=${clusterId}`],
      ["GET", `/l4-apps/${gameId}`],
      ["GET", `/l4-apps/${gameId}/stats?${range}`],
    ];
    const newApp = { clusterId, name: "x", protocol: "tcp", port: 20060, origins: [tcp] };
    const writes: [string, string, unknown][] = [
      ["PUT", `/clusters/${clusterId}/port-pools`, { pools: [] }],
      ["POST", "/l4-apps", newApp],
      ["PATCH", `/l4-apps/${gameId}`, { name: "x" }],
      ["PUT", `/l4-apps/${gameId}/enabled`, { enabled: false }],
      ["DELETE", `/l4-apps/${gameId}`, undefined],
    ];
    for (const [method, path] of reads) {
      expect((await api(reader, method, path)).status, `${method} ${path}`).toBe(200);
      const refused = await api(key, method, path);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect(readOnly.status, `${method} ${path}`).toBe(403);
      expect(readOnly.json.code, `${method} ${path}`).toBe("ACCESS_KEY_READ_ONLY");
      const refused = await api(key, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    // Nothing changed.
    expect((await admin.l4Apps.get({ id: gameId })).enabled).toBe(true);
    expect((await admin.clusters.portPools({ clusterId })).pools).toHaveLength(3);
    // A write key reaches them; unknown ids are not found.
    for (const [method, path, body, code] of [
      ["GET", `/clusters/${missing}/port-pools`, undefined, "CLUSTER_NOT_FOUND"],
      ["PUT", `/clusters/${missing}/port-pools`, { pools: [] }, "CLUSTER_NOT_FOUND"],
      ["GET", `/l4-apps?clusterId=${missing}`, undefined, "CLUSTER_NOT_FOUND"],
      ["GET", `/l4-apps/${missing}`, undefined, "L4_APP_NOT_FOUND"],
      ["GET", `/l4-apps/${missing}/stats?${range}`, undefined, "L4_APP_NOT_FOUND"],
      ["POST", "/l4-apps", { ...newApp, clusterId: missing }, "CLUSTER_NOT_FOUND"],
      ["PATCH", `/l4-apps/${missing}`, { name: "x" }, "L4_APP_NOT_FOUND"],
      ["PUT", `/l4-apps/${missing}/enabled`, { enabled: false }, "L4_APP_NOT_FOUND"],
      ["DELETE", `/l4-apps/${missing}`, undefined, "L4_APP_NOT_FOUND"],
    ] as const) {
      const res = await api(writer, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json.code, `${method} ${path}`).toBe(code);
    }
    const created = await api(writer, "POST", "/l4-apps", newApp);
    expect(created.status).toBe(201);
    const appId = (created.json.app as { id: string }).id;
    const [entry] = (await admin.auditLogs.list({ action: "l4_app.create" })).items;
    expect(entry).toMatchObject({ targetId: appId, actorType: "api_key" });
    expect((await api(writer, "DELETE", `/l4-apps/${appId}`)).status).toBe(200);
    expect(
      await ctx.db
        .select()
        .from(schema.l4App)
        .where(and(eq(schema.l4App.clusterId, clusterId), eq(schema.l4App.port, 20060))),
    ).toEqual([]);
  });
});
