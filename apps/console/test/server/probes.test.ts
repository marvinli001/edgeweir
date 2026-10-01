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

const missing = "00000000-0000-4000-8000-000000000000";

describe("probe, scheduling and node address procedures", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let groupId = "";
  let regionId = "";
  let nodeId = "";
  let probeId = "";

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const audits = async (action: string) =>
    (await admin.auditLogs.list({ action })).items.map((i) => i.metadata);

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    groupId = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    regionId = (await admin.regions.create({ name: "East", code: "east" })).id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, nodeGroupId: groupId, name: "edge-1" })
      .returning();
    nodeId = node?.id ?? "";
    await ctx.db.insert(schema.nodeIp).values([
      { nodeId, address: "8.8.8.8" },
      { nodeId, address: "10.1.1.1" },
    ]);
    const [probe] = await ctx.db
      .insert(schema.probe)
      .values({ name: "east-1", regionId, hostname: "p1", agentVersion: "0.14.0" })
      .returning();
    probeId = probe?.id ?? "";
  });
  afterAll(() => pglite.close());

  it("creates a probe token shown once with the node channel URL and CA pin", async () => {
    const token = await admin.probes.createToken({ name: "north-1", regionId });
    expect(token).toMatchObject({
      serverUrl: ctx.env.nodeApiUrl,
      caSha256: ctx.nodeCa.fingerprintSha256,
    });
    expect(token.token).toMatch(/^ewp_/);
    expect(new Date(token.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(new Date(token.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(token.command).toContain("EDGEWEIR_TOKEN");
    const [entry] = (await admin.auditLogs.list({ action: "probe.token_create" })).items;
    expect(entry).toMatchObject({ targetType: "region", targetId: regionId, actorType: "user" });
    expect(JSON.stringify(entry)).not.toContain(token.token);
    expect((await rpcError(admin.probes.createToken({ name: "x", regionId: missing }))).code).toBe(
      "REGION_NOT_FOUND",
    );
    expect(
      (await rpcError(admin.probes.createToken({ name: "x", regionId, ttlMinutes: 1 }))).status,
    ).toBe(400);
  });

  it("lists, renames, disables and deletes probes; their region cannot go first", async () => {
    const [listed] = await admin.probes.list();
    expect(listed).toMatchObject({
      id: probeId,
      name: "east-1",
      regionId,
      regionName: "East",
      regionCode: "east",
      enabled: true,
      online: false,
      lastRound: null,
    });
    // edge-1's public address × the cluster's HTTP listener.
    expect(listed?.targets).toBe(1);
    const updated = await admin.probes.update({ id: probeId, name: "east-a", enabled: false });
    expect(updated).toMatchObject({ name: "east-a", enabled: false });
    expect(await audits("probe.update")).toEqual([
      { from: { name: "east-1", enabled: true }, id: probeId, name: "east-a", enabled: false },
    ]);
    const deleting = await rpcError(admin.regions.delete({ id: regionId }));
    expect(deleting).toMatchObject({ code: "REGION_IN_USE", status: 409, data: { probes: 1 } });
    expect((await rpcError(admin.probes.update({ id: missing, name: "x" }))).code).toBe(
      "PROBE_NOT_FOUND",
    );
    expect((await rpcError(admin.probes.delete({ id: missing }))).code).toBe("PROBE_NOT_FOUND");
    expect((await rpcError(admin.probes.results({ probeId: missing }))).code).toBe(
      "PROBE_NOT_FOUND",
    );
    expect((await rpcError(admin.probes.results({ nodeId: missing }))).code).toBe("NODE_NOT_FOUND");
    expect(await admin.probes.results({ probeId })).toEqual([]);
    // A node id is a prober too (a node that probes).
    expect(await admin.probes.results({ probeId: nodeId })).toEqual([]);
    const second = await ctx.db.insert(schema.probe).values({ name: "gone", regionId }).returning();
    await admin.probes.delete({ id: second[0]?.id ?? "" });
    expect((await admin.probes.list()).map((p) => p.id)).toEqual([probeId]);
    expect((await admin.auditLogs.list({ action: "probe.delete" })).items[0]).toMatchObject({
      targetId: second[0]?.id,
      targetName: "gone",
    });
  });

  it("reads and checks the probe settings", async () => {
    expect(await admin.settings.probes()).toEqual({
      intervalSeconds: 10,
      timeoutMs: 3000,
      attempts: 3,
      lossPercent: 50,
      ipDownSeconds: 30,
      ipUpSeconds: 60,
    });
    const short = {
      intervalSeconds: 5,
      timeoutMs: 1000,
      attempts: 2,
      lossPercent: 50,
      ipDownSeconds: 5,
      ipUpSeconds: 5,
    };
    expect(await admin.settings.setProbes(short)).toEqual(short);
    expect(await admin.settings.probes()).toEqual(short);
    expect(await audits("system.probes_update")).toEqual([
      {
        from: {
          intervalSeconds: 10,
          timeoutMs: 3000,
          attempts: 3,
          lossPercent: 50,
          ipDownSeconds: 30,
          ipUpSeconds: 60,
        },
        to: short,
      },
    ]);
    for (const bad of [
      { intervalSeconds: 4 },
      { intervalSeconds: 61 },
      { timeoutMs: 499 },
      { timeoutMs: 10001 },
      { attempts: 0 },
      { attempts: 11 },
      { lossPercent: 0 },
      { ipDownSeconds: 4 },
      { ipUpSeconds: 3601 },
      // An attempt may not outlast the interval.
      { intervalSeconds: 5, timeoutMs: 6000 },
    ])
      expect((await rpcError(admin.settings.setProbes({ ...short, ...bad }))).status).toBe(400);
  });

  it("sets a node's scheduling addresses and its probe switch", async () => {
    let node = await admin.nodes.get({ id: nodeId });
    expect(node).toMatchObject({
      probeEnabled: false,
      metrics: null,
      schedulingLevel: 0,
      schedulingAddresses: [{ address: "8.8.8.8", level: 0, source: "reported", reachable: true }],
    });
    for (const address of ["10.0.0.0/8", "example.com", "127.0.0.1", "ff02::1"]) {
      const error = await rpcError(
        admin.nodes.setAddresses({ id: nodeId, addresses: [{ address, level: 0 }] }),
      );
      expect(error).toMatchObject({ code: "NODE_ADDRESS_INVALID", data: { address } });
    }
    expect(
      (
        await rpcError(
          admin.nodes.setAddresses({
            id: nodeId,
            addresses: [
              { address: "2001:db8::1", level: 0 },
              { address: "2001:DB8::1", level: 1 },
            ],
          }),
        )
      ).code,
    ).toBe("NODE_ADDRESS_INVALID");
    // A primary address is required; at most 8; levels 0-2.
    for (const addresses of [
      [{ address: "8.8.4.4", level: 1 }],
      Array.from({ length: 9 }, (_, i) => ({ address: `8.8.4.${i}`, level: 0 })),
      [{ address: "8.8.4.4", level: 3 }],
    ])
      expect((await rpcError(admin.nodes.setAddresses({ id: nodeId, addresses }))).status).toBe(
        400,
      );
    node = await admin.nodes.setAddresses({
      id: nodeId,
      addresses: [
        { address: "172.16.0.1", level: 0 },
        { address: " 2001:DB8::2 ", level: 2 },
      ],
    });
    expect(node.schedulingAddresses).toEqual([
      { address: "172.16.0.1", level: 0, source: "configured", reachable: true },
      { address: "2001:db8::2", level: 2, source: "configured", reachable: true },
    ]);
    // The reported addresses stay what the node reports.
    expect(node.ipAddresses).toEqual(["10.1.1.1", "8.8.8.8"]);
    expect(await audits("node.set_addresses")).toEqual([
      {
        from: [],
        to: [
          { address: "172.16.0.1", level: 0 },
          { address: "2001:db8::2", level: 2 },
        ],
      },
    ]);
    node = await admin.nodes.setAddresses({ id: nodeId, addresses: [] });
    expect(node.schedulingAddresses.map((a) => a.source)).toEqual(["reported"]);
    expect((await rpcError(admin.nodes.setAddresses({ id: missing, addresses: [] }))).code).toBe(
      "NODE_NOT_FOUND",
    );

    expect((await rpcError(admin.nodes.setProbe({ id: nodeId, enabled: true }))).code).toBe(
      "NODE_REGION_REQUIRED",
    );
    await admin.nodeGroups.update({ id: groupId, regionId });
    expect((await admin.nodes.setProbe({ id: nodeId, enabled: true })).probeEnabled).toBe(true);
    expect((await rpcError(admin.nodes.setProbe({ id: missing, enabled: true }))).code).toBe(
      "NODE_NOT_FOUND",
    );
    await admin.nodes.setProbe({ id: nodeId, enabled: false });
  });

  it("creates, lists, updates and deletes scheduling rules and checks them", async () => {
    const base = {
      clusterId,
      name: "hot",
      conditions: [{ metric: "cpu_percent" as const, comparator: "gt" as const, threshold: 90 }],
      action: "remove_node" as const,
    };
    const rule = await admin.scheduling.create(base);
    expect(rule).toMatchObject({
      clusterId,
      lineName: null,
      enabled: true,
      match: "all",
      holdSeconds: 300,
      recoverSeconds: 300,
      activeNodes: [],
      conditions: [
        {
          metric: "cpu_percent",
          aggregate: "avg",
          comparator: "gt",
          threshold: 90,
          durationSeconds: 0,
          regionId: null,
        },
      ],
    });
    expect((await admin.scheduling.list({ clusterId })).map((r) => r.id)).toEqual([rule.id]);
    expect((await admin.scheduling.list({})).map((r) => r.id)).toEqual([rule.id]);
    expect((await rpcError(admin.scheduling.list({ clusterId: missing }))).code).toBe(
      "CLUSTER_NOT_FOUND",
    );
    // backup_group needs a line, and lines must exist in the cluster's binding.
    expect(
      (await rpcError(admin.scheduling.create({ ...base, action: "backup_group" }))).code,
    ).toBe("SCHEDULING_RULE_INVALID");
    expect((await rpcError(admin.scheduling.create({ ...base, lineName: "main" }))).code).toBe(
      "SCHEDULING_RULE_INVALID",
    );
    await admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "manual",
        domain: "edge.rules.test",
        lines: [{ name: "main", nodeGroupId: groupId, overrides: [] }],
      },
    });
    const line = await admin.scheduling.create({
      ...base,
      lineName: "main",
      action: "backup_group",
      match: "any",
      conditions: [
        {
          metric: "probe_loss_percent",
          aggregate: "max",
          comparator: "ge",
          threshold: 50,
          durationSeconds: 30,
          regionId,
        },
        { metric: "connections", comparator: "ge", threshold: 10000 },
      ],
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    expect(line).toMatchObject({ lineName: "main", match: "any", holdSeconds: 0 });
    expect(
      (
        await rpcError(
          admin.scheduling.create({
            ...base,
            conditions: [
              { metric: "probe_latency_ms", comparator: "gt", threshold: 9, regionId: missing },
            ],
          }),
        )
      ).code,
    ).toBe("REGION_NOT_FOUND");
    for (const bad of [
      // A region only narrows probe metrics.
      { conditions: [{ metric: "cpu_percent", comparator: "gt", threshold: 1, regionId }] },
      { conditions: [] },
      { conditions: Array.from({ length: 9 }, () => base.conditions[0]) },
      {
        conditions: [
          { metric: "cpu_percent", comparator: "gt", threshold: 1, durationSeconds: 3601 },
        ],
      },
      { conditions: [{ metric: "disk", comparator: "gt", threshold: 1 }] },
      { holdSeconds: 86401 },
      { recoverSeconds: -1 },
      { action: "drain" },
      { lineName: "all" },
    ])
      expect(
        (await rpcError(admin.scheduling.create({ ...base, ...bad } as typeof base))).status,
      ).toBe(400);
    expect((await rpcError(admin.scheduling.create({ ...base, clusterId: missing }))).code).toBe(
      "CLUSTER_NOT_FOUND",
    );
    const updated = await admin.scheduling.update({
      id: rule.id,
      name: "very hot",
      holdSeconds: 60,
      conditions: [{ metric: "cpu_percent", comparator: "ge", threshold: 95 }],
    });
    expect(updated).toMatchObject({ name: "very hot", holdSeconds: 60 });
    expect(updated.conditions[0]).toMatchObject({ comparator: "ge", threshold: 95 });
    expect(
      (await rpcError(admin.scheduling.update({ id: rule.id, action: "backup_group" }))).code,
    ).toBe("SCHEDULING_RULE_INVALID");
    expect((await rpcError(admin.scheduling.update({ id: missing, name: "x" }))).code).toBe(
      "SCHEDULING_RULE_NOT_FOUND",
    );
    const [audit] = (await admin.auditLogs.list({ action: "scheduling.rule_update" })).items;
    expect(audit?.metadata).toMatchObject({
      from: { name: "hot", holdSeconds: 300 },
      to: { name: "very hot", holdSeconds: 60 },
      endedNodeIds: [],
    });
    expect((await admin.auditLogs.list({ action: "scheduling.rule_create" })).total).toBe(2);

    const preview = await admin.scheduling.preview({ clusterId });
    expect(preview.rules.map((r) => r.ruleId)).toEqual([rule.id, line.id]);
    expect(preview.rules[0]?.nodes).toEqual([
      expect.objectContaining({
        nodeId,
        nodeName: "edge-1",
        state: "idle",
        matches: false,
        inEffect: false,
        wouldActivate: false,
        conditions: [expect.objectContaining({ metric: "cpu_percent", value: null, holds: false })],
      }),
    ]);
    expect((await rpcError(admin.scheduling.preview({ clusterId: missing }))).code).toBe(
      "CLUSTER_NOT_FOUND",
    );

    await admin.scheduling.delete({ id: line.id });
    expect((await rpcError(admin.scheduling.delete({ id: line.id }))).code).toBe(
      "SCHEDULING_RULE_NOT_FOUND",
    );
    expect((await admin.auditLogs.list({ action: "scheduling.rule_delete" })).total).toBe(1);
    // Rules go with their cluster.
    const other = await admin.clusters.create({ name: "rules-only" });
    await admin.scheduling.create({ ...base, clusterId: other.id });
    await admin.clusters.delete({ id: other.id });
    expect((await admin.scheduling.list({})).map((r) => r.id)).toEqual([rule.id]);
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const service = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const [rule] = await admin.scheduling.list({ clusterId });
    const ruleId = rule?.id ?? "";
    const settings = await admin.settings.probes();
    const reads: [string, string][] = [
      ["GET", "/probes"],
      ["GET", "/probe-results"],
      ["GET", "/scheduling/rules"],
      ["GET", `/clusters/${clusterId}/scheduling/preview`],
      ["GET", "/settings/probes"],
    ];
    const writes: [string, string, unknown][] = [
      ["POST", "/probe-tokens", { name: "x", regionId }],
      ["PATCH", `/probes/${probeId}`, { name: "x" }],
      ["DELETE", `/probes/${probeId}`, undefined],
      ["PUT", "/settings/probes", settings],
      ["PUT", `/nodes/${nodeId}/probe`, { enabled: false }],
      ["PUT", `/nodes/${nodeId}/addresses`, { addresses: [] }],
      [
        "POST",
        "/scheduling/rules",
        {
          clusterId,
          name: "x",
          conditions: [{ metric: "load1", comparator: "gt", threshold: 9 }],
          action: "remove_node",
        },
      ],
      ["PATCH", `/scheduling/rules/${ruleId}`, { name: "x" }],
      ["DELETE", `/scheduling/rules/${ruleId}`, undefined],
    ];
    for (const [method, path] of reads) {
      expect((await api(reader, method, path)).status, `${method} ${path}`).toBe(200);
      const refused = await api(service, method, path);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect(readOnly.status, `${method} ${path}`).toBe(403);
      expect(readOnly.json.code, `${method} ${path}`).toBe("ACCESS_KEY_READ_ONLY");
      const refused = await api(service, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    // Nothing changed.
    expect((await admin.probes.list()).map((p) => p.name)).toEqual(["east-a"]);
    expect((await admin.scheduling.list({ clusterId })).map((r) => r.name)).toEqual(["very hot"]);
    // A write key reaches them; unknown ids are not found.
    for (const [method, path, body, code] of [
      ["PATCH", `/probes/${missing}`, { name: "x" }, "PROBE_NOT_FOUND"],
      ["DELETE", `/probes/${missing}`, undefined, "PROBE_NOT_FOUND"],
      ["PUT", `/nodes/${missing}/probe`, { enabled: false }, "NODE_NOT_FOUND"],
      ["PUT", `/nodes/${missing}/addresses`, { addresses: [] }, "NODE_NOT_FOUND"],
      ["PATCH", `/scheduling/rules/${missing}`, { name: "x" }, "SCHEDULING_RULE_NOT_FOUND"],
      ["DELETE", `/scheduling/rules/${missing}`, undefined, "SCHEDULING_RULE_NOT_FOUND"],
      ["GET", `/clusters/${missing}/scheduling/preview`, undefined, "CLUSTER_NOT_FOUND"],
      ["POST", "/probe-tokens", { name: "x", regionId: missing }, "REGION_NOT_FOUND"],
    ] as const) {
      const res = await api(writer, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json.code, `${method} ${path}`).toBe(code);
    }
    const created = await api(writer, "POST", "/probe-tokens", { name: "api", regionId });
    expect(created.status).toBe(200);
    expect(created.json.token).toMatch(/^ewp_/);
    // The token is shown once: no Idempotency-Key replay that would store it.
    const res = await app.request(`${origin}/api/v1/probe-tokens`, {
      method: "POST",
      headers: {
        "x-api-key": writer,
        "content-type": "application/json",
        "idempotency-key": "probe-token-1",
      },
      body: JSON.stringify({ name: "again", regionId }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_UNSUPPORTED");
    const rows = await ctx.db
      .select()
      .from(schema.probeToken)
      .where(eq(schema.probeToken.name, "again"));
    expect(rows).toEqual([]);
  });
});
