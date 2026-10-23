import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { systemActor } from "../../src/server/services/audit";
import { compileBindingPlan } from "../../src/server/services/dns";
import {
  latestRevision,
  nodeTarget,
  pruneRevisions,
  publishRevision,
} from "../../src/server/services/revisions";
import { evaluateRollout } from "../../src/server/services/rollout";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("configuration canary with automatic rollback", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let defaultGroup: string;
  let canaryGroup: string;
  let canary: { id: string; clusterId: string; nodeGroupId: string | null };
  let stable: { id: string; clusterId: string; nodeGroupId: string | null };
  let providerId: string;
  let renames = 0;

  const policy = {
    enabled: true,
    windowSeconds: 300,
    autoPromote: true,
    errorRatioMultiplier: 2,
    errorRatioFloor: 0.05,
    minRequests: 10,
  };
  const change = async () => {
    renames++;
    return (await admin.sites.update({ id: siteId, name: `shop-${renames}` })).revision.revision;
  };
  const rollout = () => admin.clusters.rollout({ id: clusterId });
  const target = async (node: typeof canary) => (await nodeTarget(ctx.db, node))?.revision;
  /** Heartbeat at `at`: the node reports `revision` applied (at `appliedAt`) or failed. */
  const report = async (
    node: typeof canary,
    revision: number,
    opts: {
      at?: Date;
      appliedAt?: Date;
      state?: "applied" | "failed";
      healthy?: boolean;
      certificateFailures?: schema.NodeCertificateFailure[];
    } = {},
  ) => {
    const at = opts.at ?? new Date();
    const [row] = await ctx.db
      .select()
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          eq(schema.configRevision.revision, revision),
        ),
      );
    const values = {
      nodeId: node.id,
      appliedRevision: opts.state === "failed" ? 0 : revision,
      appliedContentHash: opts.state === "failed" ? "" : (row?.contentHash ?? ""),
      state: opts.state ?? "applied",
      dataPlaneHealthy: opts.healthy ?? true,
      appliedAt: opts.appliedAt ?? null,
      reportedAt: at,
      certificateFailures: opts.certificateFailures ?? [],
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
    await ctx.db.update(schema.node).set({ lastSeenAt: at }).where(eq(schema.node.id, node.id));
  };
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
  const nextMinute = (ms: number) => Math.ceil(ms / 60_000) * 60_000;
  /** The node's statistics watermark (ReportStatsV2.complete_until). */
  const statsUntil = async (node: typeof canary, until: number) => {
    const values = { nodeId: node.id, completeUntil: new Date(until) };
    await ctx.db
      .insert(schema.nodeStatsCursor)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeStatsCursor.nodeId, set: values });
  };
  /** The running window: its candidate, start and end (as shown). */
  const running = async () => {
    const r = await rollout();
    return {
      candidate: r.candidateRevision ?? 0,
      start: new Date(r.windowStartedAt ?? 0).getTime(),
      end: new Date(r.windowEndsAt ?? 0).getTime(),
    };
  };
  /** Heartbeats of both nodes at `at`, the canary node on the candidate it applied at `appliedAt`. */
  const beat = async (at: number, appliedAt: number) => {
    const { candidate } = await running();
    await report(canary, candidate, { at: new Date(at), appliedAt: new Date(appliedAt) });
    await report(stable, (await rollout()).stableRevision ?? 0, { at: new Date(at) });
  };
  const dnsPolicy = () => ({
    mode: "auto" as const,
    providerId,
    domain: "edge.cdn.test",
    ttl: 60,
    lineAliases: false,
    allLabel: "all",
    lines: [
      {
        name: "stable",
        nodeGroupId: defaultGroup,
        overrides: [{ nodeId: stable.id, addresses: ["10.42.0.2"] }],
      },
      {
        name: "canary",
        nodeGroupId: canaryGroup,
        overrides: [{ nodeId: canary.id, addresses: ["10.42.0.1"] }],
      },
    ],
  });
  const planned = async (now = Date.now()) =>
    (await compileBindingPlan(ctx.db, clusterId, dnsPolicy(), now)).records
      .filter((r) => r.name === "all.edge")
      .map((r) => r.data)
      .sort();

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    defaultGroup = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    const group = await admin.nodeGroups.create({ clusterId, name: "canary", isCanary: true });
    expect(group.isCanary).toBe(true);
    canaryGroup = group.id;
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.canary.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const [a, b] = await ctx.db
      .insert(schema.node)
      .values(
        (
          [
            [canaryGroup, "edge-canary"],
            [defaultGroup, "edge-stable"],
          ] as const
        ).map(([nodeGroupId, name]) => ({
          clusterId,
          nodeGroupId,
          name,
          lastSeenAt: new Date(),
          supportedFeatures: ["tls-v1", "http01-v1", "rules-v1", "stats-sequence-v1"],
        })),
      )
      .returning();
    if (!a || !b) throw new Error("nodes missing");
    canary = { id: a.id, clusterId, nodeGroupId: canaryGroup };
    stable = { id: b.id, clusterId, nodeGroupId: defaultGroup };
    const latest = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await report(canary, latest);
    await report(stable, latest);
    providerId = (
      await ctx.db
        .insert(schema.platformDnsProvider)
        .values({ name: "test", provider: "test", zone: "cdn.test", credentialEnvelope: "{}" })
        .returning()
    )[0]?.id as string;
  });
  afterAll(() => pglite.close());

  it("sends every node the latest revision while the policy is off", async () => {
    const revision = await change();
    expect(await target(canary)).toBe(revision);
    expect(await target(stable)).toBe(revision);
    expect((await rollout()).state).toBe("idle");
  });

  it("gives a change to the canary group only and keeps the others in DNS during the window", async () => {
    const before = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await report(canary, before);
    await report(stable, before);
    const saved = await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy });
    expect(saved).toMatchObject({ state: "idle", stableRevision: before, policy });
    expect((await admin.auditLogs.list({ action: "cluster.rollout_policy_update" })).total).toBe(1);

    const candidate = await change();
    const running = await rollout();
    expect(running).toMatchObject({
      state: "canary",
      stableRevision: before,
      candidateRevision: candidate,
    });
    expect(running.canaryNodes).toEqual([
      expect.objectContaining({ id: canary.id, participating: true }),
    ]);
    expect(await target(canary)).toBe(candidate);
    expect(await target(stable)).toBe(before);
    // The non-canary node runs its target and stays in DNS; the canary node
    // keeps its records while it applies the candidate, for 2 minutes.
    expect(await planned()).toEqual(["10.42.0.1", "10.42.0.2"]);
    const seen = (at: Date) =>
      ctx.db
        .update(schema.node)
        .set({ lastSeenAt: at })
        .where(eq(schema.node.clusterId, clusterId));
    await seen(later(121));
    expect(await planned(later(121).getTime())).toEqual(["10.42.0.2"]);
    await seen(new Date());
    await report(canary, candidate);
    expect(await planned()).toEqual(["10.42.0.1", "10.42.0.2"]);
    // Before the window ends nothing is decided.
    await report(canary, candidate, { at: later(60) });
    await report(stable, before, { at: later(60) });
    expect(await evaluateRollout(ctx, clusterId, later(60))).toBe("canary");
    expect(await planned(later(60).getTime())).toEqual(["10.42.0.1", "10.42.0.2"]);
  });

  it("promotes automatically after a healthy window", async () => {
    const { candidateRevision } = await rollout();
    const { start } = await running();
    await beat(Date.now() + 301_000, Date.now());
    // The window spans whole minutes of statistics: it ends once the canary node's are in.
    const { end } = await running();
    expect(end).toBe(nextMinute(start + 300_000));
    await statsUntil(canary, end - 60_000);
    await beat(end + 1000, Date.now());
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 1000))).toBe("canary");
    await statsUntil(canary, end);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 1000))).toBe("promoted");
    const done = await rollout();
    expect(done).toMatchObject({
      state: "promoted",
      outcome: "auto_promote",
      stableRevision: candidateRevision,
      candidateRevision: null,
    });
    expect(await target(stable)).toBe(candidateRevision);
    const [entry] = (await admin.auditLogs.list({ action: "cluster.rollout_promote" })).items;
    expect(entry).toMatchObject({ actorType: "system", metadata: { outcome: "auto_promote" } });
  });

  it("rolls back a candidate whose certificate a canary node refuses handshakes for", async () => {
    const good = (await rollout()).stableRevision ?? 0;
    await report(canary, good);
    await report(stable, good);
    const failure = (certificateId: string, servingFingerprint = "") => ({
      certificateId,
      fingerprint: "a".repeat(64),
      reason: "invalid_material" as const,
      message: "x509: invalid ECDSA parameters",
      servingFingerprint,
    });
    const cert = "00000000-0000-4000-8000-0000000000c1";
    // Earlier material served, or a failure the stable nodes report too: not the candidate's doing.
    let candidate = await change();
    await report(canary, candidate, { certificateFailures: [failure(cert, "b".repeat(64))] });
    expect(await evaluateRollout(ctx, clusterId)).toBe("canary");
    await report(stable, good, { certificateFailures: [failure(cert)] });
    await report(canary, candidate, { certificateFailures: [failure(cert)] });
    expect(await evaluateRollout(ctx, clusterId)).toBe("canary");
    // Refused on the canary only: rolled back.
    await report(stable, good);
    candidate = (await rollout()).candidateRevision ?? 0;
    await report(canary, candidate, { certificateFailures: [failure(cert)] });
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    expect(await rollout()).toMatchObject({ state: "rolled_back", outcome: "apply_failed" });
  });

  it("rolls back a candidate a canary node failed to apply; the others never get it", async () => {
    const good = (await rollout()).stableRevision ?? 0;
    await report(canary, good);
    await report(stable, good);
    const bad = await change();
    expect(await target(stable)).toBe(good);
    await report(canary, bad, { state: "failed" });
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    const after = await rollout();
    expect(after).toMatchObject({
      state: "rolled_back",
      outcome: "apply_failed",
      candidateRevision: null,
      lastCandidateRevision: bad,
    });
    const restored = after.stableRevision ?? 0;
    expect(restored).toBeGreaterThan(bad);
    // The restored revision has the good content under a new number, for every node.
    const rows = await admin.clusters.revisions({ id: clusterId });
    const byNumber = (n: number) => rows.find((r) => r.revision === n);
    expect(byNumber(restored)).toMatchObject({
      contentHash: byNumber(good)?.contentHash,
      reasonCode: "rollout_rollback",
      reasonParams: { revision: bad },
    });
    expect(await target(canary)).toBe(restored);
    expect(await target(stable)).toBe(restored);
    // The non-canary node never had the candidate and stays in DNS (same content).
    expect(await planned()).toContain("10.42.0.2");
    const [entry] = (await admin.auditLogs.list({ action: "cluster.rollout_rollback" })).items;
    expect(entry).toMatchObject({
      actorType: "system",
      metadata: { candidate: bad, outcome: "apply_failed" },
    });
    const [state] = await ctx.db
      .select()
      .from(schema.alertState)
      .where(eq(schema.alertState.key, `config_rollout_failed/platform/${clusterId}`));
    expect(state?.active).toBe(true);
    const events = await admin.alerts.events({});
    expect(events.find((e) => e.kind === "config_rollout_failed")).toMatchObject({
      siteId: null,
      status: "firing",
    });
    // The database kept the change: the next publication goes through the canary again.
    const next = await change();
    expect((await rollout()).candidateRevision).toBe(next);
  });

  it("replaces the candidate when another change arrives during the window, keeping its start", async () => {
    const first = await rollout();
    const replacement = await change();
    const second = await rollout();
    expect(second.candidateRevision).toBe(replacement);
    expect(second.candidateRevision).not.toBe(first.candidateRevision);
    expect(second.windowStartedAt).toBe(first.windowStartedAt);
    expect(second.stableRevision).toBe(first.stableRevision);
  });

  it("rolls back when the canary 5xx ratio passes the threshold, counting the candidate's minutes only", async () => {
    const { start } = await running();
    // The canary node applies the candidate 30 seconds into a minute: that
    // minute's 5xx are the previous configuration's (a failing one, say).
    const applied = Math.floor(start / 60_000) * 60_000 + 90_000;
    const since = applied + 30_000;
    const stats = (minute: number, canary5xx: number) =>
      ctx.db.insert(schema.nodeMinuteStats).values([
        {
          minute: new Date(minute),
          nodeId: canary.id,
          siteId,
          requests: 20,
          statusCodes: { "502": canary5xx, "200": 20 - canary5xx },
        },
        {
          minute: new Date(minute),
          nodeId: stable.id,
          siteId,
          requests: 40,
          statusCodes: { "200": 39, "503": 1 },
        },
      ]);
    await stats(applied - 30_000, 20);
    await beat(since + 30_000, applied);
    expect((await rollout()).window).toEqual({
      canaryRequests: 0,
      canary5xx: 0,
      baselineRequests: 0,
      baseline5xx: 0,
    });
    expect(await evaluateRollout(ctx, clusterId, new Date(since + 30_000))).toBe("canary");
    // The candidate's own 5xx still roll it back.
    await stats(since, 19);
    expect((await rollout()).window).toEqual({
      canaryRequests: 20,
      canary5xx: 19,
      baselineRequests: 40,
      baseline5xx: 1,
    });
    expect(await evaluateRollout(ctx, clusterId, new Date(since + 30_000))).toBe("rolled_back");
    expect((await rollout()).outcome).toBe("error_ratio");
    await ctx.db.delete(schema.nodeMinuteStats);
  });

  it("does not decide on fewer canary requests than the minimum and promotes after the window", async () => {
    const stableRevision = (await rollout()).stableRevision ?? 0;
    await report(canary, stableRevision);
    await report(stable, stableRevision);
    await change();
    const { start } = await running();
    const applied = start + 1000;
    const since = nextMinute(applied);
    await ctx.db.insert(schema.nodeMinuteStats).values({
      minute: new Date(since),
      nodeId: canary.id,
      siteId,
      requests: policy.minRequests - 1,
      statusCodes: { "502": policy.minRequests - 1 },
    });
    await beat(since + 61_000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(since + 61_000))).toBe("canary");
    const { end } = await running();
    await statsUntil(canary, end);
    await beat(end + 1000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 1000))).toBe("promoted");
    await ctx.db.delete(schema.nodeMinuteStats);
  });

  it("promotes a window without traffic once its statistics are in, or after a grace when they lag", async () => {
    await change();
    const { start } = await running();
    const applied = start + 1000;
    await beat(applied, applied);
    const { end } = await running();
    // No statistics past the window's start: it waits two minutes past its end.
    await statsUntil(canary, Math.floor(start / 60_000) * 60_000);
    await beat(end + 119_000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 119_000))).toBe("canary");
    await beat(end + 120_000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 120_000))).toBe("promoted");
  });

  it("observes a candidate that replaced another late in the window for a whole minute", async () => {
    await change();
    const { start } = await running();
    const end = nextMinute(start + 300_000);
    await change();
    // The replacement is applied a second before the window's last minute ends.
    const applied = end - 1000;
    await beat(applied, applied);
    expect((await running()).end).toBe(end + 60_000);
    await statsUntil(canary, end);
    await beat(end + 30_000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 30_000))).toBe("canary");
    await statsUntil(canary, end + 60_000);
    await beat(end + 61_000, applied);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 61_000))).toBe("promoted");
  });

  it("rolls back when a canary node reports an unhealthy data plane or goes offline", async () => {
    await change();
    const { candidateRevision } = await rollout();
    await report(canary, candidateRevision ?? 0, { healthy: false });
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    expect((await rollout()).outcome).toBe("unhealthy");
    await report(canary, (await rollout()).stableRevision ?? 0);
    await change();
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.node.id, canary.id));
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    expect((await rollout()).outcome).toBe("unhealthy");
  });

  it("publishes to every node without an online canary node, with an audit entry and an alert", async () => {
    // The canary node is still offline from the previous test.
    const revision = await change();
    const direct = await rollout();
    expect(direct).toMatchObject({
      state: "direct",
      outcome: "no_canary",
      stableRevision: revision,
      candidateRevision: null,
    });
    expect(await target(stable)).toBe(revision);
    expect((await admin.auditLogs.list({ action: "cluster.rollout_direct" })).total).toBe(1);
    const events = await admin.alerts.events({});
    expect(events.find((e) => e.kind === "config_rollout_no_canary")?.status).toBe("firing");
    // With a canary node back online the next change is a canary again and the alert resolves.
    await report(canary, revision);
    await report(stable, revision);
    const candidate = await change();
    expect((await rollout()).candidateRevision).toBe(candidate);
    const latestEvents = await admin.alerts.events({});
    expect(latestEvents.find((e) => e.kind === "config_rollout_no_canary")?.status).toBe(
      "resolved",
    );
  });

  it("waits for an administrator without auto promotion; promote and abort are audited", async () => {
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy, autoPromote: false });
    const { start } = await running();
    await beat(start + 1000, start + 1000);
    const { end } = await running();
    await statsUntil(canary, end);
    await beat(end + 1000, start + 1000);
    expect(await evaluateRollout(ctx, clusterId, new Date(end + 1000))).toBe("awaiting_promotion");
    const promoted = await admin.clusters.promoteRollout({ id: clusterId });
    expect(promoted).toMatchObject({ state: "promoted", outcome: "manual_promote" });
    expect((await rpcError(admin.clusters.promoteRollout({ id: clusterId }))).code).toBe(
      "ROLLOUT_NOT_ACTIVE",
    );
    const [entry] = (await admin.auditLogs.list({ action: "cluster.rollout_promote" })).items;
    expect(entry).toMatchObject({ actorType: "user", metadata: { outcome: "manual_promote" } });
    const good = (await rollout()).stableRevision ?? 0;
    await report(canary, good);
    await report(stable, good);
    const candidate = await change();
    const aborted = await admin.clusters.abortRollout({ id: clusterId });
    expect(aborted).toMatchObject({
      state: "rolled_back",
      outcome: "manual_abort",
      lastCandidateRevision: candidate,
    });
    expect((await admin.auditLogs.list({ action: "cluster.rollout_abort" })).total).toBe(1);
    // The operator's abort publishes the restored revision as the operator.
    const [restored] = await ctx.db
      .select({ createdByUserId: schema.configRevision.createdByUserId })
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          eq(schema.configRevision.revision, aborted.stableRevision ?? 0),
        ),
      );
    expect(restored?.createdByUserId).toBe((await admin.account.me()).user.id);
    expect((await rpcError(admin.clusters.abortRollout({ id: clusterId }))).code).toBe(
      "ROLLOUT_NOT_ACTIVE",
    );
  });

  it("gives ACME challenges to every node at once, canary or not", async () => {
    const candidate = await change();
    const [certificate] = await ctx.db
      .insert(schema.certificate)
      .values({
        name: "shop",
        names: ["shop.canary.test"],
        source: "acme",
        status: "issuing",
        operationStartedAt: new Date(),
      })
      .returning();
    if (!certificate?.operationStartedAt) throw new Error("certificate missing");
    await ctx.db.insert(schema.acmeChallenge).values({
      certificateId: certificate.id,
      domain: "shop.canary.test",
      token: "canary-token",
      keyAuthorization: "canary-token.key",
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
    for (const node of [canary, stable]) {
      const revision = await nodeTarget(ctx.db, node);
      const config = decodeNodeConfig(revision?.ir ?? new Uint8Array());
      expect(
        config.httpChallenges.map((c) => c.token),
        node.id,
      ).toEqual(["canary-token"]);
    }
    const running = await rollout();
    expect(running.state).toBe("canary");
    expect(running.candidateRevision).toBeGreaterThan(candidate);
    expect(running.stableRevision).toBeLessThan(running.candidateRevision ?? 0);
  });

  it("sends an administrator's rollback to every node and keeps pinned revisions", async () => {
    const good = (await rollout()).stableRevision ?? 1;
    const restored = await admin.clusters.rollback({ id: clusterId, revision: good });
    const after = await rollout();
    expect(after).toMatchObject({
      state: "promoted",
      outcome: "manual_rollback",
      stableRevision: restored.revision,
      candidateRevision: null,
    });
    expect(await target(canary)).toBe(restored.revision);
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy });
    const candidate = await change();
    for (let i = 0; i < 4; i++) {
      await change();
    }
    const pinned = (await rollout()).stableRevision ?? 0;
    expect(await pruneRevisions(ctx.db, 2)).toBeGreaterThan(0);
    const kept = (await admin.clusters.revisions({ id: clusterId })).map((r) => r.revision);
    expect(kept).toContain(pinned);
    expect(candidate).toBeLessThan((await rollout()).candidateRevision ?? 0);
  });

  it("promotes the candidate when the policy is turned off during a window", async () => {
    const { candidateRevision } = await rollout();
    expect(candidateRevision).not.toBeNull();
    const off = await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy, enabled: false });
    expect(off.state).toBe("idle");
    expect(await target(stable)).toBe(candidateRevision);
    expect((await ctx.db.select().from(schema.clusterRollout))[0]).toMatchObject({
      outcome: "policy_disabled",
      stableRevision: null,
    });
  });

  it("checks a policy save against the policy's own version, which publications leave alone", async () => {
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy });
    const read = await rollout();
    await change();
    const moved = await rollout();
    expect(moved.state).toBe("canary");
    expect(moved.updatedAt).not.toBe(read.updatedAt);
    expect(moved.policyUpdatedAt).toBe(read.policyUpdatedAt);
    // A form read before the publication saves.
    const saved = await admin.clusters.setRolloutPolicy({
      id: clusterId,
      ...policy,
      minRequests: 11,
      expectedUpdatedAt: read.policyUpdatedAt,
    });
    expect(saved.policy.minRequests).toBe(11);
    expect(saved.policyUpdatedAt).not.toBe(read.policyUpdatedAt);
    // One read before another policy change is refused.
    expect(
      await rpcError(
        admin.clusters.setRolloutPolicy({
          id: clusterId,
          ...policy,
          expectedUpdatedAt: read.policyUpdatedAt,
        }),
      ),
    ).toMatchObject({ code: "UPDATED_AT_MISMATCH" });
    // The rollout's updatedAt, which clients sent before policyUpdatedAt, passes while unchanged.
    const again = await admin.clusters.setRolloutPolicy({
      id: clusterId,
      ...policy,
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(again.policy.minRequests).toBe(policy.minRequests);
  });
});
