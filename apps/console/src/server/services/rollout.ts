import { clone } from "@bufbuild/protobuf";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import type {
  ClusterRollout,
  RolloutOutcome,
  RolloutPolicy,
  RolloutState,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { NodeConfigSchema } from "@edgeweir/proto";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { lockClusterPublish } from "../lib/locks";
import { isOnline } from "../lib/node-online";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit, systemActor } from "./audit";
import { distinctReasons, siteChanges } from "./config-changes";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import {
  type Executor,
  getRevision,
  insertRevision,
  latestRevision,
  loadRollout,
  notifyClusterTargets,
  onlineCanaryNodes,
  type Tx,
  toRevisionDto,
  updateRollout,
} from "./revisions";
import { currentStable } from "./rollback";

type RolloutRow = typeof schema.clusterRollout.$inferSelect;

const ACTIVE: RolloutState[] = ["canary", "awaiting_promotion"];

async function clusterName(tx: Executor, clusterId: string) {
  const [row] = await tx
    .select({ name: schema.cluster.name })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  if (!row) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return row.name;
}

/** The candidate becomes the stable revision of every node. */
async function promote(tx: Tx, row: RolloutRow, outcome: RolloutOutcome, actor: Actor) {
  const name = await clusterName(tx, row.clusterId);
  await updateRollout(tx, row.clusterId, {
    stableRevision: row.candidateRevision,
    candidateRevision: null,
    lastCandidateRevision: row.candidateRevision,
    state: "promoted",
    outcome,
    finishedAt: new Date(),
  });
  await recordAudit(tx, actor, {
    action: "cluster.rollout_promote",
    targetType: "cluster",
    targetId: row.clusterId,
    targetName: name,
    metadata: { revision: row.candidateRevision, outcome },
  });
  await resolvePlatformAlert(tx, "config_rollout_failed", row.clusterId, name);
  await notifyClusterTargets(tx, row.clusterId);
}

/**
 * The canary nodes go back to the stable content: as a new revision (nodes
 * never apply an older revision number), which becomes the stable revision
 * of every node. The database keeps the change; the next publication goes
 * through the canary again. Like an administrator's rollback, it ships
 * nothing the current state no longer has (sites taken offline, removed
 * domains, renewed certificates; see currentStable).
 */
async function rollBack(tx: Tx, row: RolloutRow, outcome: RolloutOutcome, actor: Actor) {
  const name = await clusterName(tx, row.clusterId);
  const stable =
    (row.stableRevision !== null
      ? await getRevision(tx, row.clusterId, row.stableRevision)
      : undefined) ?? (await latestRevision(tx, row.clusterId));
  if (!stable) throw new Error("rollout without a stable revision");
  const content = await currentStable(tx, row.clusterId, decodeNodeConfig(stable.ir));
  const { row: restored } = await insertRevision(
    tx,
    row.clusterId,
    (revision) => {
      const config = clone(NodeConfigSchema, content);
      config.revision = revision;
      return config;
    },
    { code: "rollout_rollback", params: { revision: row.candidateRevision ?? 0 } },
    null,
  );
  await updateRollout(tx, row.clusterId, {
    stableRevision: restored.revision,
    candidateRevision: null,
    lastCandidateRevision: row.candidateRevision,
    state: "rolled_back",
    outcome,
    finishedAt: new Date(),
  });
  await recordAudit(tx, actor, {
    action: outcome === "manual_abort" ? "cluster.rollout_abort" : "cluster.rollout_rollback",
    targetType: "cluster",
    targetId: row.clusterId,
    targetName: name,
    metadata: { candidate: row.candidateRevision, restored: restored.revision, outcome },
  });
  await raisePlatformAlert(tx, "config_rollout_failed", row.clusterId, name);
  await notifyClusterTargets(tx, row.clusterId);
}

interface WindowTraffic {
  canaryRequests: number;
  canary5xx: number;
  baselineRequests: number;
  baseline5xx: number;
}

/** Requests and 5xx of the window so far: canary nodes against the cluster's other active nodes. */
async function windowTraffic(
  db: Executor,
  row: RolloutRow,
  participating: string[],
): Promise<WindowTraffic> {
  if (!row.windowStartedAt)
    return { canaryRequests: 0, canary5xx: 0, baselineRequests: 0, baseline5xx: 0 };
  const since = new Date(Math.floor(row.windowStartedAt.getTime() / 60_000) * 60_000);
  const result = await db.execute<{ canary: boolean; requests: string; errors: string }>(sql`
    select (m.node_id = any(${`{${participating.join(",")}}`}::uuid[])) as canary,
      coalesce(sum(m.requests), 0) as requests,
      coalesce(sum((select coalesce(sum(value::numeric), 0) from jsonb_each_text(m.status_codes) where key like '5%')), 0) as errors
    from node_minute_stats m
    join node n on n.id = m.node_id
    where n.cluster_id = ${row.clusterId}::uuid and n.status = 'active' and m.minute >= ${since.toISOString()}::timestamptz
    group by 1
  `);
  const out = { canaryRequests: 0, canary5xx: 0, baselineRequests: 0, baseline5xx: 0 };
  for (const r of result.rows) {
    if (r.canary) {
      out.canaryRequests = Number(r.requests);
      out.canary5xx = Number(r.errors);
    } else {
      out.baselineRequests = Number(r.requests);
      out.baseline5xx = Number(r.errors);
    }
  }
  return out;
}

/**
 * Canary nodes that decide the running window: online at its start and
 * still active, the nodes that get its candidate (rolloutTargets).
 */
async function participants(db: Executor, row: RolloutRow) {
  if (!row.canaryNodeIds.length) return [];
  return db
    .select({ node: schema.node, status: schema.nodeConfigStatus })
    .from(schema.node)
    .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
    .where(
      and(
        inArray(schema.node.id, row.canaryNodeIds),
        eq(schema.node.status, "active"),
        eq(schema.node.clusterId, row.clusterId),
      ),
    );
}

/**
 * Decides a running rollout: roll back when a canary node failed to apply
 * the candidate, reported an unhealthy data plane or went offline during
 * the window, or when the canary 5xx ratio passes the threshold; promote
 * (or wait for the operator) once the window has passed and every
 * canary node runs the candidate healthily. Returns the resulting state.
 */
export async function evaluateRollout(
  app: AppContext,
  clusterId: string,
  now = new Date(),
): Promise<RolloutState | null> {
  return app.db.transaction(async (tx) => {
    await lockClusterPublish(tx, clusterId);
    const row = await loadRollout(tx, clusterId);
    if (!row?.enabled || !ACTIVE.includes(row.state as RolloutState) || !row.windowStartedAt)
      return (row?.state as RolloutState | undefined) ?? null;
    const candidate =
      row.candidateRevision !== null
        ? await getRevision(tx, clusterId, row.candidateRevision)
        : undefined;
    if (!candidate) {
      await updateRollout(tx, clusterId, { state: "idle", candidateRevision: null });
      return "idle";
    }
    const nodes = await participants(tx, row);
    if (nodes.length === 0) {
      await promote(tx, row, "no_canary", systemActor);
      return "promoted";
    }
    const started = row.windowStartedAt.getTime();
    for (const { node, status } of nodes) {
      const fresh = !!status && status.reportedAt.getTime() >= started;
      if (fresh && status.state === "failed") {
        await rollBack(tx, row, "apply_failed", systemActor);
        return "rolled_back";
      }
      if (!isOnline(node.lastSeenAt, now.getTime()) || (fresh && !status.dataPlaneHealthy)) {
        await rollBack(tx, row, "unhealthy", systemActor);
        return "rolled_back";
      }
    }
    const traffic = await windowTraffic(
      tx,
      row,
      nodes.map((n) => n.node.id),
    );
    if (traffic.canaryRequests >= row.minRequests) {
      const baseline = traffic.baselineRequests
        ? traffic.baseline5xx / traffic.baselineRequests
        : 0;
      const threshold = Math.max(baseline * row.errorRatioMultiplier, row.errorRatioFloor);
      if (traffic.canary5xx / traffic.canaryRequests > threshold) {
        await rollBack(tx, row, "error_ratio", systemActor);
        return "rolled_back";
      }
    }
    const applied = nodes.every(
      ({ status }) =>
        status?.state === "applied" &&
        status.dataPlaneHealthy &&
        status.appliedContentHash === candidate.contentHash,
    );
    const elapsed = now.getTime() - started;
    if (elapsed < row.windowSeconds * 1000) return row.state as RolloutState;
    if (!applied) {
      // A canary node that has not applied the candidate within twice the window never will.
      if (elapsed >= 2 * row.windowSeconds * 1000) {
        await rollBack(tx, row, "apply_timeout", systemActor);
        return "rolled_back";
      }
      return row.state as RolloutState;
    }
    if (row.autoPromote) {
      await promote(tx, row, "auto_promote", systemActor);
      return "promoted";
    }
    if (row.state !== "awaiting_promotion")
      await updateRollout(tx, clusterId, { state: "awaiting_promotion" });
    return "awaiting_promotion";
  });
}

/** Worker and canary heartbeats: evaluates every cluster with a running rollout. */
export async function evaluateRollouts(app: AppContext, now = new Date()) {
  const rows = await app.db
    .select({ clusterId: schema.clusterRollout.clusterId })
    .from(schema.clusterRollout)
    .where(
      and(eq(schema.clusterRollout.enabled, true), inArray(schema.clusterRollout.state, ACTIVE)),
    );
  for (const { clusterId } of rows) await evaluateRollout(app, clusterId, now);
}

/** Evaluates a cluster's rollout after a heartbeat of one of its canary nodes. */
export async function evaluateAfterHeartbeat(
  app: AppContext,
  node: { id: string; clusterId: string },
) {
  const row = await loadRollout(app.db, node.clusterId);
  if (!row?.enabled || !ACTIVE.includes(row.state as RolloutState)) return;
  if (!row.canaryNodeIds.includes(node.id)) return;
  try {
    await evaluateRollout(app, node.clusterId);
  } catch (error) {
    app.log.warn("rollout evaluation failed", { clusterId: node.clusterId, error });
  }
}

const DEFAULT_POLICY: RolloutPolicy = {
  enabled: false,
  windowSeconds: 300,
  autoPromote: true,
  errorRatioMultiplier: 2,
  errorRatioFloor: 0.05,
  minRequests: 100,
};

function policyOf(row: RolloutRow | undefined): RolloutPolicy {
  if (!row) return DEFAULT_POLICY;
  return {
    enabled: row.enabled,
    windowSeconds: row.windowSeconds,
    autoPromote: row.autoPromote,
    errorRatioMultiplier: row.errorRatioMultiplier,
    errorRatioFloor: row.errorRatioFloor,
    minRequests: row.minRequests,
  };
}

/** At most this many revisions explain a candidate. */
const MAX_CANDIDATE_REASONS = 50;

/**
 * What a running window's candidate changes against the stable revision:
 * sites by name, and the reasons of the revisions in (stable, candidate].
 */
async function candidateChanges(
  db: Executor,
  clusterId: string,
  stableRevision: number | null,
  candidateRevision: number,
): Promise<ClusterRollout["candidateChanges"]> {
  const candidate = await getRevision(db, clusterId, candidateRevision);
  if (!candidate) return null;
  const stable =
    stableRevision === null ? undefined : await getRevision(db, clusterId, stableRevision);
  const revisions = await db
    .select()
    .from(schema.configRevision)
    .where(
      and(
        eq(schema.configRevision.clusterId, clusterId),
        gt(schema.configRevision.revision, stableRevision ?? 0),
        lte(schema.configRevision.revision, candidateRevision),
      ),
    )
    .orderBy(asc(schema.configRevision.revision))
    .limit(MAX_CANDIDATE_REASONS);
  return {
    sites: siteChanges(
      stable ? decodeNodeConfig(stable.ir) : undefined,
      decodeNodeConfig(candidate.ir),
    ),
    reasons: distinctReasons(revisions.map(toRevisionDto)),
  };
}

export async function getRollout(db: Executor, clusterId: string): Promise<ClusterRollout> {
  await clusterName(db, clusterId);
  const row = await loadRollout(db, clusterId);
  const running = !!row?.enabled && ACTIVE.includes(row.state as RolloutState);
  // Members of canary groups, and the window's canary nodes that left them.
  const nodes = await db
    .select({ node: schema.node, status: schema.nodeConfigStatus })
    .from(schema.node)
    .leftJoin(schema.nodeGroup, eq(schema.nodeGroup.id, schema.node.nodeGroupId))
    .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
    .where(
      and(
        eq(schema.node.clusterId, clusterId),
        eq(schema.node.status, "active"),
        running && row.canaryNodeIds.length
          ? or(eq(schema.nodeGroup.isCanary, true), inArray(schema.node.id, row.canaryNodeIds))
          : eq(schema.nodeGroup.isCanary, true),
      ),
    )
    .orderBy(schema.node.name);
  const latest = await latestRevision(db, clusterId);
  return {
    clusterId,
    policy: policyOf(row),
    state: (row?.enabled ? row.state : "idle") as RolloutState,
    stableRevision: row?.enabled
      ? (row.stableRevision ?? latest?.revision ?? null)
      : (latest?.revision ?? null),
    candidateRevision: row?.enabled ? row.candidateRevision : null,
    lastCandidateRevision: row?.lastCandidateRevision ?? null,
    windowStartedAt: running ? (row?.windowStartedAt?.toISOString() ?? null) : null,
    windowEndsAt:
      running && row?.windowStartedAt
        ? new Date(row.windowStartedAt.getTime() + row.windowSeconds * 1000).toISOString()
        : null,
    outcome: (row?.outcome ?? "") as RolloutOutcome,
    finishedAt: row?.finishedAt?.toISOString() ?? null,
    canaryNodes: nodes.map(({ node, status }) => ({
      id: node.id,
      name: node.name,
      online: isOnline(node.lastSeenAt),
      appliedRevision: status?.appliedRevision ?? 0,
      participating: running && !!row?.canaryNodeIds.includes(node.id),
    })),
    window:
      running && row
        ? await windowTraffic(
            db,
            row,
            row.canaryNodeIds.filter((id) => nodes.some((n) => n.node.id === id)),
          )
        : null,
    candidateChanges:
      running && row.candidateRevision !== null
        ? await candidateChanges(db, clusterId, row.stableRevision, row.candidateRevision)
        : null,
    policyUpdatedAt: (row?.policyUpdatedAt ?? new Date(0)).toISOString(),
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

/**
 * Saves the policy. Turning it on pins the current revision as stable;
 * turning it off during a rollout gives the candidate to every node.
 * `expectedUpdatedAt` is checked against the policy's own version, so a
 * publication or a rollout step since it was read does not refuse it.
 */
export async function setRolloutPolicy(
  db: Database,
  input: RolloutPolicy & { id: string; expectedUpdatedAt?: string },
  actor: Actor,
): Promise<ClusterRollout> {
  const { id: clusterId, expectedUpdatedAt, ...policy } = input;
  await db.transaction(async (tx) => {
    const name = await clusterName(tx, clusterId);
    await lockClusterPublish(tx, clusterId);
    const before = await loadRollout(tx, clusterId);
    // The row's updatedAt (what clients read before policyUpdatedAt existed) means nothing changed.
    if (
      expectedUpdatedAt !== undefined &&
      Date.parse(expectedUpdatedAt) !== (before?.updatedAt ?? new Date(0)).getTime()
    )
      assertUpdatedAt(before?.policyUpdatedAt ?? new Date(0), expectedUpdatedAt);
    const latest = await latestRevision(tx, clusterId);
    if (!before) await tx.insert(schema.clusterRollout).values({ clusterId, ...policy });
    else await updateRollout(tx, clusterId, { ...policy, policyUpdatedAt: new Date() });
    if (policy.enabled && !before?.enabled)
      await updateRollout(tx, clusterId, {
        state: "idle",
        stableRevision: latest?.revision ?? null,
        candidateRevision: null,
        windowStartedAt: null,
        canaryNodeIds: [],
        outcome: "",
        finishedAt: null,
      });
    if (!policy.enabled && before?.enabled) {
      if (before.candidateRevision !== null && ACTIVE.includes(before.state as RolloutState))
        await promote(tx, before, "policy_disabled", actor);
      await updateRollout(tx, clusterId, {
        state: "idle",
        stableRevision: null,
        candidateRevision: null,
      });
      await resolvePlatformAlert(tx, "config_rollout_no_canary", clusterId, name);
      await notifyClusterTargets(tx, clusterId);
    }
    await recordAudit(tx, actor, {
      action: "cluster.rollout_policy_update",
      targetType: "cluster",
      targetId: clusterId,
      targetName: name,
      metadata: { from: policyOf(before), to: policy },
    });
  });
  return getRollout(db, clusterId);
}

/** Gives the candidate to every node now. */
export async function promoteRollout(db: Database, clusterId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    await clusterName(tx, clusterId);
    await lockClusterPublish(tx, clusterId);
    const row = await loadRollout(tx, clusterId);
    if (
      !row?.enabled ||
      !ACTIVE.includes(row.state as RolloutState) ||
      row.candidateRevision === null
    )
      fail("ROLLOUT_NOT_ACTIVE", "no canary rollout is running");
    await promote(tx, row, "manual_promote", actor);
  });
  return getRollout(db, clusterId);
}

/** Stops the canary and returns its nodes to the stable revision. */
export async function abortRollout(db: Database, clusterId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    await clusterName(tx, clusterId);
    await lockClusterPublish(tx, clusterId);
    const row = await loadRollout(tx, clusterId);
    if (
      !row?.enabled ||
      !ACTIVE.includes(row.state as RolloutState) ||
      row.candidateRevision === null
    )
      fail("ROLLOUT_NOT_ACTIVE", "no canary rollout is running");
    await rollBack(tx, row, "manual_abort", actor);
  });
  return getRollout(db, clusterId);
}

/** Revision ids a cluster's nodes may run: the stable and candidate revisions and the latest. */
export async function publishedRevisions(db: Executor, clusterId: string) {
  const rollout = await loadRollout(db, clusterId);
  const latest = await latestRevision(db, clusterId);
  const ids = new Set<number>();
  if (latest) ids.add(latest.revision);
  if (rollout?.enabled) {
    if (rollout.stableRevision !== null) ids.add(rollout.stableRevision);
    if (rollout.candidateRevision !== null) ids.add(rollout.candidateRevision);
  }
  return [...ids];
}

export { onlineCanaryNodes };
