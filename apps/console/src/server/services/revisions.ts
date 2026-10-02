import { clone } from "@bufbuild/protobuf";
import {
  ConfigCapacityError,
  compileNodeConfig,
  decodeNodeConfig,
  encodeNodeConfig,
  MAX_SITES_PER_CLUSTER,
  nodeRequirements,
  usesChallengeKeys,
} from "@edgeweir/config-compiler";
import {
  type ReasonParams,
  type Revision,
  type RevisionReasonCode,
  reasonText,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { type NodeConfig, NodeConfigSchema } from "@edgeweir/proto";
import { and, desc, eq, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { CONFIG_CHANNEL } from "../lib/events";
import { lockClusterPublish } from "../lib/locks";
import { assertNodeFeatures } from "../lib/node-features";
import { isOnline } from "../lib/node-online";
import { type Actor, recordAudit, systemActor } from "./audit";
import { ensureChallengeKeys } from "./challenge-keys";
import { loadConfigInput } from "./config-input";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import { currentStable } from "./rollback";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

/**
 * The account behind a change, recorded as a revision's publisher (the
 * actor a change is published with) and in every `created_by_user_id`: the
 * operator, signed in or with an AccessKey. Service accounts and background
 * jobs are nobody (their ids are not users), which also keeps them behind
 * the capability gate of insertRevision.
 */
export const publisher = (actor: { type: string; id: string }) =>
  actor.type === "user" || actor.type === "api_key" ? actor.id : null;

export const REVISION_RETENTION = 200;

type RevisionRow = typeof schema.configRevision.$inferSelect;

export function toRevisionDto(row: RevisionRow): Revision {
  return {
    clusterId: row.clusterId,
    revision: row.revision,
    contentHash: row.contentHash,
    siteCount: row.siteCount,
    reason: row.reason,
    reasonCode: row.reasonCode,
    reasonParams: row.reasonParams,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function latestRevision(
  db: Executor,
  clusterId: string,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(eq(schema.configRevision.clusterId, clusterId))
    .orderBy(desc(schema.configRevision.revision))
    .limit(1);
  return row;
}

export async function getRevision(
  db: Executor,
  clusterId: string,
  revision: number,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(
      and(
        eq(schema.configRevision.clusterId, clusterId),
        eq(schema.configRevision.revision, revision),
      ),
    );
  return row;
}

/** Why a revision is published; rendered per locale in the UI. */
export interface RevisionReason {
  code: RevisionReasonCode;
  params: ReasonParams;
}

export async function insertRevision(
  tx: Tx,
  clusterId: string,
  build: (revision: bigint) => NodeConfig,
  reason: RevisionReason,
  userId: string | null,
): Promise<{ row: RevisionRow; created: boolean }> {
  const latest = await latestRevision(tx, clusterId);
  // Restoring a database cannot rewind an edge node's durable LKG revision.
  // Even unchanged content needs a fresh revision when a node is ahead.
  const [reported] = await tx
    .select({ revision: sql<number>`coalesce(max(${schema.nodeConfigStatus.appliedRevision}), 0)` })
    .from(schema.nodeConfigStatus)
    .innerJoin(schema.node, eq(schema.node.id, schema.nodeConfigStatus.nodeId))
    .where(
      and(
        eq(schema.node.clusterId, clusterId),
        eq(schema.nodeConfigStatus.revisionReceiptVerified, true),
      ),
    );
  const highest = Math.max(latest?.revision ?? 0, Number(reported?.revision ?? 0));
  if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER)
    throw new Error("configuration revision exhausted");
  const next = BigInt(highest) + 1n;
  let config: NodeConfig;
  try {
    config = build(next);
  } catch (error) {
    if (error instanceof ConfigCapacityError)
      fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
    throw error;
  }
  // Rollback also passes through this guard, rather than only the compiler.
  if (config.sites.length > MAX_SITES_PER_CLUSTER)
    fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
  if (latest && latest.revision >= highest && latest.contentHash === config.contentHash) {
    return { row: latest, created: false };
  }
  const previousFeatures = new Set(latest ? nodeRequirements(decodeNodeConfig(latest.ir)) : []);
  const addedFeatures = nodeRequirements(config).filter(
    (feature) => !previousFeatures.has(feature),
  );
  // Only the operator may deliberately require an upgrade across the cluster;
  // service accounts and background changes must keep every site delivered.
  if (!userId) {
    await assertNodeFeatures(
      tx,
      [clusterId],
      addedFeatures,
      "cluster nodes do not support this change",
    );
  }
  const [row] = await tx
    .insert(schema.configRevision)
    .values({
      clusterId,
      revision: Number(next),
      contentHash: config.contentHash,
      ir: encodeNodeConfig(config),
      siteCount: config.sites.length,
      reason: reasonText(reason.code, reason.params),
      reasonCode: reason.code,
      reasonParams: reason.params,
      createdByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("failed to insert revision");
  // Delivered to every console instance when the transaction commits.
  await tx.execute(
    sql`select pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({
      clusterId,
      revision: row.revision,
      contentHash: row.contentHash,
    })})`,
  );
  return { row, created: true };
}

export interface PublishOptions {
  reason: RevisionReason;
  /** Who publishes (systemActor for background jobs); the revision records publisher(actor). */
  actor: Actor;
  /**
   * The site the change is about: its stored rules must compile
   * (RULE_INVALID). Elsewhere a rule the current validator refuses keeps
   * its last compiled form and raises the platform alert config_rule_invalid.
   */
  site?: string;
}

/**
 * Compiles the cluster's current sites into a NodeConfig and stores it as the
 * next revision. Identical content does not produce a new revision.
 * Must run inside a transaction; serialised per cluster with an advisory lock.
 */
export async function publishRevision(
  tx: Tx,
  opts: PublishOptions & { clusterId: string },
): Promise<{ row: RevisionRow; created: boolean }> {
  await lockClusterPublish(tx, opts.clusterId);
  const input = await loadConfigInput(tx, opts.clusterId, { site: opts.site });
  // A cluster gets its challenge keys the first time its configuration uses
  // challenges or session affinity.
  const challengeKeys = usesChallengeKeys(input)
    ? await ensureChallengeKeys(tx, opts.clusterId)
    : [];
  const build = (revision: bigint) => compileNodeConfig({ ...input, challengeKeys }, revision);
  const userId = publisher(opts.actor);
  const rollout = await loadRollout(tx, opts.clusterId);
  if (!rollout?.enabled) return insertRevision(tx, opts.clusterId, build, opts.reason, userId);
  return publishThroughCanary(tx, rollout, build, opts.reason, userId);
}

/**
 * Publishes several clusters in one transaction: each once, in cluster id
 * order, the order in which every transaction takes their publish locks.
 */
export async function publishClusters(
  tx: Tx,
  clusterIds: Iterable<string>,
  opts: PublishOptions,
): Promise<Map<string, Awaited<ReturnType<typeof publishRevision>>>> {
  const results = new Map<string, Awaited<ReturnType<typeof publishRevision>>>();
  for (const clusterId of [...new Set(clusterIds)].sort())
    results.set(clusterId, await publishRevision(tx, { clusterId, ...opts }));
  return results;
}

type RolloutRow = typeof schema.clusterRollout.$inferSelect;

export async function loadRollout(
  db: Executor,
  clusterId: string,
): Promise<RolloutRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.clusterRollout)
    .where(eq(schema.clusterRollout.clusterId, clusterId));
  return row;
}

export async function updateRollout(
  tx: Executor,
  clusterId: string,
  values: Partial<Omit<RolloutRow, "clusterId">>,
) {
  await tx
    .update(schema.clusterRollout)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.clusterRollout.clusterId, clusterId));
}

/**
 * The revisions nodes of a cluster get: the candidate (if any) goes to the
 * canary nodes of the running window that are still active, every other
 * node gets the stable one.
 */
export interface RolloutTargets {
  stable: RevisionRow | undefined;
  candidate: RevisionRow | undefined;
  canaryNodeIds: Set<string>;
}

export async function rolloutTargets(db: Executor, clusterId: string): Promise<RolloutTargets> {
  const rollout = await loadRollout(db, clusterId);
  const latest = await latestRevision(db, clusterId);
  if (!rollout?.enabled) return { stable: latest, candidate: undefined, canaryNodeIds: new Set() };
  const stable =
    rollout.stableRevision === null
      ? latest
      : ((await getRevision(db, clusterId, rollout.stableRevision)) ?? latest);
  const candidate =
    rollout.candidateRevision === null
      ? undefined
      : await getRevision(db, clusterId, rollout.candidateRevision);
  const nodes =
    candidate && rollout.canaryNodeIds.length
      ? await db
          .select({ id: schema.node.id })
          .from(schema.node)
          .where(
            and(
              inArray(schema.node.id, rollout.canaryNodeIds),
              eq(schema.node.clusterId, clusterId),
              eq(schema.node.status, "active"),
            ),
          )
      : [];
  return { stable, candidate, canaryNodeIds: new Set(nodes.map((n) => n.id)) };
}

/**
 * A node's target. Canary nodes are those of the window, not the current
 * members of canary groups: a node that leaves the group keeps the
 * candidate it may already run (nodes never apply a lower revision), and
 * one that joins waits for the next window.
 */
export function targetFor(node: { id: string }, targets: RolloutTargets): RevisionRow | undefined {
  if (targets.candidate && targets.canaryNodeIds.has(node.id)) return targets.candidate;
  return targets.stable;
}

/** The revision a node should run (its target), per the cluster's rollout. */
export async function nodeTarget(
  db: Executor,
  node: { id: string; clusterId: string },
): Promise<RevisionRow | undefined> {
  return targetFor(node, await rolloutTargets(db, node.clusterId));
}

/** Tells every console instance's watch streams of the cluster to re-read their targets. */
export async function notifyClusterTargets(tx: Executor, clusterId: string) {
  const latest = await latestRevision(tx, clusterId);
  if (!latest) return;
  await tx.execute(
    sql`select pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({
      clusterId,
      revision: latest.revision,
      contentHash: latest.contentHash,
    })})`,
  );
}

/** Active canary-group nodes of a cluster that are online now. */
export async function onlineCanaryNodes(tx: Executor, clusterId: string, now = Date.now()) {
  const rows = await tx
    .select({ id: schema.node.id, name: schema.node.name, lastSeenAt: schema.node.lastSeenAt })
    .from(schema.node)
    .innerJoin(schema.nodeGroup, eq(schema.nodeGroup.id, schema.node.nodeGroupId))
    .where(
      and(
        eq(schema.node.clusterId, clusterId),
        eq(schema.node.status, "active"),
        eq(schema.nodeGroup.isCanary, true),
      ),
    );
  return rows.filter((n) => isOnline(n.lastSeenAt, now));
}

/**
 * Publishing with the configuration canary on. What does not wait for a
 * canary (currentStable: ACME challenges, sites taken offline, removed
 * domains, renewed certificates, challenge keys, Under Attack) goes into
 * the stable revision of every node at once; when that is the
 * whole change, the change is the new stable revision. Without an online
 * canary node the change goes to every node too (audited and alerted).
 * Otherwise the change becomes the candidate for the canary nodes. A
 * candidate replaced during its window keeps the window's start and nodes,
 * so frequent publications cannot hold back the other nodes forever.
 */
async function publishThroughCanary(
  tx: Tx,
  rollout: RolloutRow,
  build: (revision: bigint) => NodeConfig,
  reason: RevisionReason,
  userId: string | null,
): Promise<{ row: RevisionRow; created: boolean }> {
  const clusterId = rollout.clusterId;
  const preview = previewConfig(build);
  const stable =
    (rollout.stableRevision !== null
      ? await getRevision(tx, clusterId, rollout.stableRevision)
      : undefined) ?? (await latestRevision(tx, clusterId));
  if (!stable) return insertRevision(tx, clusterId, build, reason, userId);
  const patched = await currentStable(
    tx,
    clusterId,
    decodeNodeConfig(stable.ir),
    preview.httpChallenges,
  );
  const now = new Date();
  if (preview.contentHash === patched.contentHash) {
    const result = await insertRevision(tx, clusterId, build, reason, userId);
    if (result.row.revision !== stable.revision || rollout.candidateRevision !== null)
      await updateRollout(tx, clusterId, {
        stableRevision: result.row.revision,
        candidateRevision: null,
        ...(rollout.candidateRevision !== null
          ? {
              state: "idle",
              outcome: "withdrawn",
              lastCandidateRevision: rollout.candidateRevision,
              finishedAt: now,
            }
          : {}),
      });
    return result;
  }
  // A running window keeps its canary nodes: they may already run its candidate.
  const running = rollout.candidateRevision !== null;
  const canary = running ? [] : await onlineCanaryNodes(tx, clusterId, now.getTime());
  if (!running && canary.length === 0) {
    const result = await insertRevision(tx, clusterId, build, reason, userId);
    if (result.created) {
      await updateRollout(tx, clusterId, {
        stableRevision: result.row.revision,
        candidateRevision: null,
        lastCandidateRevision: rollout.candidateRevision,
        state: "direct",
        outcome: "no_canary",
        windowStartedAt: null,
        canaryNodeIds: [],
        finishedAt: now,
      });
      const [cluster] = await tx
        .select({ name: schema.cluster.name })
        .from(schema.cluster)
        .where(eq(schema.cluster.id, clusterId));
      await recordAudit(tx, systemActor, {
        action: "cluster.rollout_direct",
        targetType: "cluster",
        targetId: clusterId,
        targetName: cluster?.name ?? "",
        metadata: { revision: result.row.revision, reason: "no_canary" },
      });
      await raisePlatformAlert(tx, "config_rollout_no_canary", clusterId, cluster?.name ?? "", now);
    }
    return result;
  }
  if (patched.contentHash !== stable.contentHash) {
    const restabled = await insertRevision(
      tx,
      clusterId,
      (revision) => {
        const config = clone(NodeConfigSchema, patched);
        config.revision = revision;
        return config;
      },
      reason,
      userId,
    );
    await updateRollout(tx, clusterId, { stableRevision: restabled.row.revision });
  }
  const result = await insertRevision(tx, clusterId, build, reason, userId);
  if (result.created || !running) {
    await updateRollout(tx, clusterId, {
      candidateRevision: result.row.revision,
      state: "canary",
      ...(running ? {} : { windowStartedAt: now, canaryNodeIds: canary.map((n) => n.id) }),
      outcome: "",
      finishedAt: null,
    });
    const [cluster] = await tx
      .select({ name: schema.cluster.name })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    await resolvePlatformAlert(tx, "config_rollout_no_canary", clusterId, cluster?.name ?? "", now);
  }
  return result;
}

/** The compiled content (revision 0) of a build, with capacity errors as API errors. */
function previewConfig(build: (revision: bigint) => NodeConfig): NodeConfig {
  try {
    return build(0n);
  } catch (error) {
    if (error instanceof ConfigCapacityError)
      fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
    throw error;
  }
}

/** Revisions published only to carry ACME HTTP-01 challenges. */
const CHALLENGE_REASON: RevisionReasonCode = "acme_challenge_updated";
/** How long a challenge revision that is no longer current is kept. */
export const CHALLENGE_REVISION_TTL = 3_600_000;

/**
 * Deletes revisions beyond the retention window, keeping the newest `keep`.
 * Challenge revisions do not count (each issuance publishes one; a batch
 * of issuances would push the rollback history out) and go when an hour
 * old, unless current: their challenges expire within minutes and a
 * rollback never restores them.
 */
export async function pruneRevisions(
  db: Executor,
  keep = REVISION_RETENTION,
  now = Date.now(),
): Promise<number> {
  const clusters = await db.select({ id: schema.cluster.id }).from(schema.cluster);
  let removed = 0;
  for (const { id } of clusters) {
    const latest = await latestRevision(db, id);
    if (!latest) continue;
    // The stable and candidate revisions of a rollout are kept however old they are.
    const rollout = await loadRollout(db, id);
    const pinned = [latest.revision, rollout?.stableRevision, rollout?.candidateRevision].filter(
      (r): r is number => typeof r === "number",
    );
    const [oldestKept] = await db
      .select({ revision: schema.configRevision.revision })
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, id),
          ne(schema.configRevision.reasonCode, CHALLENGE_REASON),
        ),
      )
      .orderBy(desc(schema.configRevision.revision))
      .offset(keep - 1)
      .limit(1);
    const deleted = await db
      .delete(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, id),
          notInArray(schema.configRevision.revision, pinned),
          or(
            oldestKept ? lt(schema.configRevision.revision, oldestKept.revision) : undefined,
            and(
              eq(schema.configRevision.reasonCode, CHALLENGE_REASON),
              lt(schema.configRevision.createdAt, new Date(now - CHALLENGE_REVISION_TTL)),
            ),
          ),
        ),
      )
      .returning({ id: schema.configRevision.id });
    removed += deleted.length;
  }
  return removed;
}
