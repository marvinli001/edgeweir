import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { reconcileDns } from "../../src/server/services/dns";
import { type Prober, recordProbeResults } from "../../src/server/services/probes";
import { latestRevision } from "../../src/server/services/revisions";
import {
  evaluateAfterProbeReport,
  evaluateScheduling,
  previewScheduling,
} from "../../src/server/services/scheduling";
import { dnsFixture } from "./dns-fixture";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

// Probe-driven address levels (ADR-0029 §6) and scheduling rules (§3),
// evaluated with a fake clock, fake node metrics and fake probe results.

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

type Metrics = { cpu?: number; memory?: number; connections?: number; egressMbps?: number };

describe("scheduling", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let mainGroup = "";
  let backupGroup = "";
  let east = "";
  let north = "";
  const nodes: Record<string, string> = {};
  const probers: Record<string, Prober> = {};
  /** The fake clock, one hour per test apart (older probe results fall out of the window). */
  let now = new Date();
  const tick = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  const evaluate = () => evaluateScheduling(ctx, { now });

  const addNode = async (name: string, groupId: string, addresses: string[]) => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, nodeGroupId: groupId, name, lastSeenAt: new Date() })
      .returning();
    if (!node) throw new Error("node missing");
    await ctx.db
      .insert(schema.nodeIp)
      .values(addresses.map((address) => ({ nodeId: node.id, address })));
    const revision = await latestRevision(ctx.db, clusterId);
    if (!revision) throw new Error("revision missing");
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId: node.id,
      appliedRevision: revision.revision,
      appliedContentHash: revision.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    });
    nodes[name] = node.id;
  };
  const addProber = async (name: string, regionId: string) => {
    const [row] = await ctx.db.insert(schema.probe).values({ name, regionId }).returning();
    if (!row) throw new Error("probe missing");
    probers[name] = { kind: "probe", id: row.id, name, regionId };
  };
  const node = (name: string) => nodes[name] ?? "";
  /** One round of a prober for a node's address on port 80: `lost` of 4 attempts. */
  const report = (prober: string, nodeName: string, address: string, lost: number, rttMs = 20) =>
    recordProbeResults(
      ctx.db,
      probers[prober] as Prober,
      [
        {
          nodeId: node(nodeName),
          address,
          port: 80,
          sent: 4,
          lost,
          rttMs,
          error: lost ? "timeout" : "",
        },
      ],
      now,
    );
  const metrics = (name: string, m: Metrics) =>
    ctx.db
      .update(schema.node)
      .set({
        metrics: {
          cpuPercent: m.cpu ?? 10,
          load1: 0.5,
          load5: 0.5,
          load15: 0.5,
          memoryUsedBytes: (m.memory ?? 10) * 10,
          memoryTotalBytes: 1000,
          egressBps: (m.egressMbps ?? 1) * 1e6,
          activeConnections: m.connections ?? 5,
          reportedAt: now.toISOString(),
        },
      })
      .where(eq(schema.node.id, node(name)));
  const published = async () => (await admin.dns.binding({ clusterId })).records;
  const allEdge = async () =>
    (await published())
      .filter((r) => r.name === "all.edge" && r.type === "A" && !r.line)
      .map((r) => r.data)
      .sort();
  const lineEdge = async () =>
    (await published())
      .filter((r) => r.name === "main.edge" && r.type === "A")
      .map((r) => r.data)
      .sort();
  const revisions = () => admin.dns.bindingRevisions({ clusterId });
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  const alert = async (ruleId: string, nodeName: string) =>
    (
      await ctx.db
        .select()
        .from(schema.alertState)
        .where(eq(schema.alertState.key, `scheduling_action/platform/${ruleId}:${node(nodeName)}`))
    )[0]?.active ?? false;
  const state = async (ruleId: string, nodeName: string) =>
    (
      await ctx.db
        .select()
        .from(schema.schedulingState)
        .where(
          and(
            eq(schema.schedulingState.ruleId, ruleId),
            eq(schema.schedulingState.nodeId, node(nodeName)),
          ),
        )
    )[0]?.state ?? "idle";
  const nextHour = () => {
    now = new Date(Math.ceil((now.getTime() + 3_600_000) / 3_600_000) * 3_600_000);
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-s", { zones: ["s.test"] });
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    mainGroup = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    backupGroup = (await admin.nodeGroups.create({ clusterId, name: "backup" })).id;
    east = (await admin.regions.create({ name: "East", code: "east" })).id;
    north = (await admin.regions.create({ name: "North", code: "north" })).id;
    await admin.sites.create({
      name: "shop",
      domains: ["shop.sched.test"],
      origins: [{ address: "origin.test" }],
    });
    await addNode("n1", mainGroup, ["8.8.1.1"]);
    await addNode("n2", mainGroup, ["8.8.1.2"]);
    await addNode("n3", mainGroup, ["8.8.1.3"]);
    await addNode("b1", backupGroup, ["8.8.2.1"]);
    // n1 answers with configured addresses: primary 8.8.10.1, backup 8.8.10.2.
    await admin.nodes.setAddresses({
      id: node("n1"),
      addresses: [
        { address: "8.8.10.1", level: 0 },
        { address: "8.8.10.2", level: 1 },
      ],
    });
    await addProber("p1", east);
    await addProber("p2", north);
    await addProber("p3", east);
    const provider = await admin.dns.createProvider({
      name: "Steering",
      provider: "test",
      zone: "s.test",
      credentials: { api_token: "token-s" },
    });
    await admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "auto",
        providerId: provider.id,
        domain: "edge.s.test",
        ttl: 60,
        lines: [
          {
            name: "main",
            nodeGroupId: mainGroup,
            overrides: [],
            backupNodeGroupIds: [backupGroup],
          },
        ],
      },
    });
    await reconcileDns(ctx);
  });
  afterAll(() => db.close());

  it("moves a node to its backup address while most probers lose the primary, and back", async () => {
    nextHour();
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    const round = async (lost: { p1: number; p2: number; p3: number }) => {
      await report("p1", "n1", "8.8.10.1", lost.p1);
      await report("p2", "n1", "8.8.10.1", lost.p2);
      await report("p3", "n1", "8.8.10.1", lost.p3);
      await report("p1", "n1", "8.8.10.2", 0);
      await evaluate();
    };
    // One of three probers losing it is not enough.
    await round({ p1: 4, p2: 0, p3: 0 });
    tick(40);
    await round({ p1: 4, p2: 0, p3: 0 });
    expect(await allEdge()).toContain("8.8.10.1");
    // Two of three (more than half) losing ≥ 50 % of their attempts: down after 30 s.
    tick(10);
    await round({ p1: 4, p2: 2, p3: 0 });
    tick(20);
    await round({ p1: 4, p2: 2, p3: 0 });
    expect(await allEdge()).toContain("8.8.10.1");
    tick(10);
    await round({ p1: 4, p2: 2, p3: 0 });
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.2"]);
    expect((await revisions())[0]).toMatchObject({ reason: "health" });
    const dto = await admin.nodes.get({ id: node("n1") });
    expect(dto.schedulingLevel).toBe(1);
    expect(dto.schedulingAddresses).toEqual([
      { address: "8.8.10.1", level: 0, source: "configured", reachable: false },
      { address: "8.8.10.2", level: 1, source: "configured", reachable: true },
    ]);
    // Answering again: back to the primary after 60 s without failing.
    tick(10);
    await round({ p1: 0, p2: 0, p3: 1 });
    tick(50);
    await round({ p1: 0, p2: 0, p3: 0 });
    expect(await allEdge()).toContain("8.8.10.2");
    tick(10);
    await round({ p1: 0, p2: 0, p3: 0 });
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    expect((await admin.nodes.get({ id: node("n1") })).schedulingLevel).toBe(0);
    // A disabled prober's results do not count: p1 alone of p1 and p3 is half, not more.
    await admin.probes.update({ id: probers.p2?.id ?? "", enabled: false });
    tick(10);
    await round({ p1: 4, p2: 4, p3: 0 });
    tick(40);
    await round({ p1: 4, p2: 4, p3: 0 });
    expect(await allEdge()).toContain("8.8.10.1");
    // Both of the two: down.
    tick(10);
    await round({ p1: 4, p2: 4, p3: 4 });
    tick(30);
    await round({ p1: 4, p2: 4, p3: 4 });
    expect(await allEdge()).toContain("8.8.10.2");
    await admin.probes.update({ id: probers.p2?.id ?? "", enabled: true });
    // No fresh results at all: not failing, so up again after ipUpSeconds.
    tick(70);
    await evaluate();
    expect(await allEdge()).toContain("8.8.10.2");
    tick(60);
    await evaluate();
    expect(await allEdge()).toContain("8.8.10.1");
  });

  it("takes a node whose every address is down out of its lines, which fall back to their backups", async () => {
    nextHour();
    const providerId = (await admin.dns.binding({ clusterId })).binding.providerId;
    const binding = (minHealthyIps: number) =>
      admin.dns.saveBinding({
        clusterId,
        binding: {
          mode: "auto",
          providerId,
          domain: "edge.s.test",
          ttl: 60,
          lines: [
            {
              name: "main",
              nodeGroupId: mainGroup,
              overrides: [],
              backupNodeGroupIds: [backupGroup],
              minHealthyIps,
            },
          ],
        },
      });
    await binding(3);
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    const round = async () => {
      for (const prober of ["p1", "p2", "p3"])
        for (const address of ["8.8.10.1", "8.8.10.2"]) await report(prober, "n1", address, 4);
      await evaluate();
    };
    await round();
    tick(30);
    await round();
    const dto = await admin.nodes.get({ id: node("n1") });
    expect(dto.schedulingAddresses.map((a) => a.reachable)).toEqual([false, false]);
    // n1 answers with nothing: 2 of 3 healthy addresses, the backup group has 1 of 3,
    // so the line answers with every healthy address of its groups.
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.2.1"]);
    expect((await admin.dns.binding({ clusterId })).blocked).toBeNull();
    // No failing results any more (the last ones leave the 30 s window), then 60 s: back.
    tick(31);
    await evaluate();
    tick(59);
    await evaluate();
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.2.1"]);
    tick(1);
    await evaluate();
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    await binding(1);
  });

  it("activates after the durations, holds, recovers after M seconds and re-triggers while recovering", async () => {
    nextHour();
    const rule = await admin.scheduling.create({
      clusterId,
      name: "hot and slow",
      conditions: [
        { metric: "cpu_percent", comparator: "gt", threshold: 80, durationSeconds: 20 },
        { metric: "probe_latency_ms", aggregate: "avg", comparator: "ge", threshold: 100 },
      ],
      action: "remove_node",
      holdSeconds: 60,
      recoverSeconds: 30,
    });
    const slow = async () => {
      await report("p1", "n2", "8.8.1.2", 0, 120);
      await report("p2", "n2", "8.8.1.2", 0, 100);
      await report("p3", "n2", "8.8.1.2", 1, 80);
    };
    // avg(120, 100, 80) = 100 ≥ 100 and CPU 90 > 80, but not yet for 20 s: pending.
    await metrics("n2", { cpu: 90 });
    await slow();
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("pending");
    let preview = await previewScheduling(ctx.db, clusterId, now);
    let entry = preview.rules
      .find((r) => r.ruleId === rule.id)
      ?.nodes.find((n) => n.nodeId === node("n2"));
    expect(entry).toMatchObject({ state: "pending", matches: false, wouldActivate: false });
    expect(entry?.conditions.map((c) => [c.value, c.holds, c.satisfied])).toEqual([
      [90, true, false],
      [100, true, true],
    ]);
    tick(19);
    await metrics("n2", { cpu: 90 });
    await slow();
    preview = await previewScheduling(ctx.db, clusterId, now);
    entry = preview.rules
      .find((r) => r.ruleId === rule.id)
      ?.nodes.find((n) => n.nodeId === node("n2"));
    expect(entry?.conditions[0]).toMatchObject({ heldSeconds: 19, satisfied: false });
    tick(1);
    await metrics("n2", { cpu: 90 });
    preview = await previewScheduling(ctx.db, clusterId, now);
    entry = preview.rules
      .find((r) => r.ruleId === rule.id)
      ?.nodes.find((n) => n.nodeId === node("n2"));
    expect(entry).toMatchObject({ state: "pending", matches: true, wouldActivate: true });
    // The preview wrote nothing.
    expect(await state(rule.id, "n2")).toBe("pending");
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("active");
    expect(await allEdge()).toEqual(["8.8.1.3", "8.8.10.1"]);
    expect(await lineEdge()).toEqual(["8.8.1.3", "8.8.10.1"]);
    const [activation] = await revisions();
    expect(activation).toMatchObject({
      reason: "scheduling",
      reasonParams: {
        ruleId: rule.id,
        rule: "hot and slow",
        nodeId: node("n2"),
        node: "n2",
        action: "remove_node",
        event: "activated",
      },
    });
    const [activated] = await audits("scheduling.activate");
    expect(activated).toMatchObject({
      actorType: "system",
      targetType: "scheduling_rule",
      targetId: rule.id,
      metadata: expect.objectContaining({
        nodeId: node("n2"),
        action: "remove_node",
        dnsRevision: activation?.revision,
      }),
    });
    expect(await alert(rule.id, "n2")).toBe(true);
    expect((await admin.scheduling.list({ clusterId }))[0]?.activeNodes).toEqual([
      { nodeId: node("n2"), nodeName: "n2", since: now.toISOString() },
    ]);
    // Clear at t+30: recovering. CPU back up at t+45: active again, no second activation.
    tick(10);
    await metrics("n2", { cpu: 50 });
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("recovering");
    tick(15);
    await metrics("n2", { cpu: 95 });
    await slow();
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("active");
    expect(await audits("scheduling.activate")).toHaveLength(1);
    // Clear from t+50: 30 s later (t+80), 60 s after the start: recovered.
    tick(5);
    await metrics("n2", { cpu: 50 });
    await evaluate();
    tick(29);
    await metrics("n2", { cpu: 50 });
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("recovering");
    preview = await previewScheduling(ctx.db, clusterId, now);
    entry = preview.rules
      .find((r) => r.ruleId === rule.id)
      ?.nodes.find((n) => n.nodeId === node("n2"));
    expect(entry).toMatchObject({ state: "recovering", inEffect: true, wouldRecover: false });
    expect(entry?.recoversAt).toBe(new Date(now.getTime() + 1000).toISOString());
    tick(1);
    await metrics("n2", { cpu: 50 });
    await evaluate();
    expect(await state(rule.id, "n2")).toBe("idle");
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    expect((await revisions())[0]?.reasonParams).toMatchObject({ event: "recovered" });
    expect(await audits("scheduling.recover")).toHaveLength(1);
    expect((await audits("scheduling.recover"))[0]?.actorType).toBe("system");
    expect(await alert(rule.id, "n2")).toBe(false);
    const events = await ctx.db
      .select()
      .from(schema.alertEvent)
      .where(eq(schema.alertEvent.kind, "scheduling_action"));
    expect(events.map((e) => e.status)).toEqual(["firing", "resolved"]);
    await admin.scheduling.delete({ id: rule.id });
  });

  it("holds an action at least holdSeconds", async () => {
    nextHour();
    const rule = await admin.scheduling.create({
      clusterId,
      name: "brief",
      conditions: [{ metric: "connections", comparator: "ge", threshold: 1000 }],
      action: "remove_node",
      holdSeconds: 120,
      recoverSeconds: 0,
    });
    await metrics("n3", { connections: 5000 });
    await evaluate();
    expect(await state(rule.id, "n3")).toBe("active");
    tick(10);
    await metrics("n3", { connections: 10 });
    await evaluate();
    expect(await state(rule.id, "n3")).toBe("recovering");
    tick(109);
    await metrics("n3", { connections: 10 });
    await evaluate();
    expect(await state(rule.id, "n3")).toBe("recovering");
    tick(1);
    await metrics("n3", { connections: 10 });
    await evaluate();
    expect(await state(rule.id, "n3")).toBe("idle");
    await admin.scheduling.delete({ id: rule.id });
  });

  it("combines with any, aggregates over the probers of a region and ignores stale metrics", async () => {
    nextHour();
    const any = await admin.scheduling.create({
      clusterId,
      name: "memory or egress",
      match: "any",
      conditions: [
        { metric: "memory_percent", comparator: "gt", threshold: 90 },
        { metric: "egress_mbps", comparator: "ge", threshold: 900 },
      ],
      action: "remove_node",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    const eastLoss = await admin.scheduling.create({
      clusterId,
      name: "east loses it",
      conditions: [
        {
          metric: "probe_loss_percent",
          aggregate: "max",
          comparator: "ge",
          threshold: 50,
          regionId: east,
        },
      ],
      action: "remove_node",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    const northLoss = await admin.scheduling.create({
      clusterId,
      name: "everybody loses it",
      conditions: [
        { metric: "probe_loss_percent", aggregate: "min", comparator: "ge", threshold: 50 },
      ],
      action: "remove_node",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    await metrics("n3", { memory: 95 });
    await metrics("n2", { egressMbps: 950 });
    // n2 lost by p1 (east) only: max over east = 50 %, min over all = 0 %.
    await report("p1", "n2", "8.8.1.2", 2);
    await report("p3", "n2", "8.8.1.2", 0);
    await report("p2", "n2", "8.8.1.2", 0);
    await evaluate();
    expect(await state(any.id, "n3")).toBe("active");
    expect(await state(any.id, "n2")).toBe("active");
    expect(await state(any.id, "n1")).toBe("idle");
    expect(await state(eastLoss.id, "n2")).toBe("active");
    expect(await state(northLoss.id, "n2")).toBe("idle");
    const preview = await previewScheduling(ctx.db, clusterId, now);
    const value = (ruleId: string, nodeName: string) =>
      preview.rules.find((r) => r.ruleId === ruleId)?.nodes.find((n) => n.nodeId === node(nodeName))
        ?.conditions[0]?.value;
    expect(value(eastLoss.id, "n2")).toBe(50);
    expect(value(northLoss.id, "n2")).toBe(0);
    expect(await allEdge()).toEqual(["8.8.10.1"]);
    // Metrics older than a minute count as missing: the conditions clear.
    tick(61);
    await evaluate();
    expect(await state(any.id, "n3")).toBe("idle");
    expect(await state(any.id, "n2")).toBe("idle");
    // Probe results older than the window (3 × 10 s) count as missing as well.
    expect(await state(eastLoss.id, "n2")).toBe("idle");
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    for (const rule of [any, eastLoss, northLoss]) await admin.scheduling.delete({ id: rule.id });
  });

  it("switches a line to its backup group and forces a node's next address level", async () => {
    nextHour();
    const group = await admin.scheduling.create({
      clusterId,
      lineName: "main",
      name: "line to backup",
      conditions: [{ metric: "cpu_percent", comparator: "ge", threshold: 99 }],
      action: "backup_group",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    const ip = await admin.scheduling.create({
      clusterId,
      name: "n1 to backup address",
      conditions: [{ metric: "memory_percent", comparator: "ge", threshold: 50 }],
      action: "backup_ip",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    await metrics("n1", { memory: 60 });
    await evaluate();
    expect(await state(ip.id, "n1")).toBe("active");
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.2"]);
    // backup_group: one node of the line's group matching switches the line.
    await metrics("n2", { cpu: 100 });
    await metrics("n1", { memory: 60 });
    await evaluate();
    expect(await state(group.id, "n2")).toBe("active");
    expect(await state(ip.id, "n2")).toBe("idle");
    // The backup group's own nodes are not judged by a backup_group rule.
    expect(
      (await previewScheduling(ctx.db, clusterId, now)).rules
        .find((r) => r.ruleId === group.id)
        ?.nodes.map((n) => n.nodeName)
        .sort(),
    ).toEqual(["n1", "n2", "n3"]);
    expect(await allEdge()).toEqual(["8.8.2.1"]);
    expect(await lineEdge()).toEqual(["8.8.2.1"]);
    expect((await admin.dns.binding({ clusterId })).blocked).toBeNull();
    tick(5);
    await metrics("n2", { cpu: 10 });
    await metrics("n1", { memory: 60 });
    await evaluate();
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.2"]);
    expect((await admin.dns.binding({ clusterId })).blocked).toBeNull();
    // Disabling a rule ends its action at once (DNS revision, alert resolved).
    await admin.scheduling.update({ id: ip.id, enabled: false });
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    expect(await alert(ip.id, "n1")).toBe(false);
    expect((await revisions())[0]?.reasonParams).toMatchObject({
      ruleId: ip.id,
      event: "recovered",
    });
    const [update] = await audits("scheduling.rule_update");
    expect(update?.metadata).toMatchObject({ endedNodeIds: [node("n1")] });
    // A name change keeps the state.
    await admin.scheduling.update({ id: group.id, name: "renamed" });
    for (const rule of [group, ip]) await admin.scheduling.delete({ id: rule.id });
  });

  it("keeps the records when a removal would empty them (mass removal protection)", async () => {
    nextHour();
    const rule = await admin.scheduling.create({
      clusterId,
      name: "everything",
      conditions: [{ metric: "cpu_percent", comparator: "ge", threshold: 0 }],
      action: "remove_node",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    // Every node of the line and of its backup group matches.
    for (const name of ["n1", "n2", "n3", "b1"]) await metrics(name, {});
    const result = await evaluate();
    // The removals pass one by one (the backup group answers once the
    // group is empty) until a plan would leave the line without an address.
    expect((await allEdge()).length).toBeGreaterThan(0);
    expect((await admin.dns.binding({ clusterId })).blocked).toMatchObject({ status: "blocked" });
    const [blockedAlert] = await ctx.db
      .select()
      .from(schema.alertState)
      .where(eq(schema.alertState.key, `dns_mass_removal_blocked/platform/${clusterId}`));
    expect(blockedAlert?.active).toBe(true);
    const activations = (await audits("scheduling.activate")).filter((a) => a.targetId === rule.id);
    expect(activations).toHaveLength(4);
    expect(activations.some((a) => a.metadata.dnsRevision === null)).toBe(true);
    expect(result.published).toEqual([clusterId]);
    // Deleting the rule ends every action; the records are complete again.
    await admin.scheduling.delete({ id: rule.id });
    expect(await allEdge()).toEqual(["8.8.1.2", "8.8.1.3", "8.8.10.1"]);
    expect((await admin.dns.binding({ clusterId })).blocked).toBeNull();
    const deleted = (await audits("scheduling.rule_delete")).find((a) => a.targetId === rule.id);
    expect([...((deleted?.metadata.endedNodeIds as string[] | undefined) ?? [])].sort()).toEqual(
      [node("n1"), node("n2"), node("n3"), node("b1")].sort(),
    );
  });

  it("evaluates the clusters of a probe report at once, at most every 2 s", async () => {
    nextHour();
    const rule = await admin.scheduling.create({
      clusterId,
      name: "report",
      conditions: [{ metric: "probe_loss_percent", comparator: "ge", threshold: 100 }],
      action: "remove_node",
      holdSeconds: 0,
      recoverSeconds: 0,
    });
    // Real time here (the evaluation reads the clock): only these results count.
    await ctx.db.delete(schema.probeResult);
    now = new Date();
    await report("p1", "n3", "8.8.1.3", 4);
    await evaluateAfterProbeReport(ctx, [clusterId]);
    expect(await state(rule.id, "n3")).toBe("active");
    await report("p1", "n3", "8.8.1.3", 0);
    await evaluateAfterProbeReport(ctx, [clusterId]);
    // Within 2 s of the last evaluation: skipped.
    expect(await state(rule.id, "n3")).toBe("active");
    // The DNS write runs in the background.
    await vi.waitFor(async () => {
      expect((await admin.dns.binding({ clusterId })).applied).toBe(true);
    });
    expect(await allEdge()).not.toContain("8.8.1.3");
    await admin.scheduling.delete({ id: rule.id });
  });
});
