import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { releaseVersion, type UpgradeArtifact, type UpgradeJob } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  NodeTaskSchema,
  type ReportTaskResultRequest,
  TaskState,
  UpgradeTaskSchema,
} from "@edgeweir/proto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { outboundGet } from "../lib/outbound";
import { type Actor, recordAudit } from "./audit";
import { getReleaseSource } from "./release-source";
import {
  type Executor,
  nodeTarget,
  type RolloutTargets,
  rolloutTargets,
  targetFor,
} from "./revisions";

const job = schema.nodeUpgrade,
  delivery = schema.nodeUpgradeDelivery;
const ACTIVE = ["held", "pending", "running"];
const FRESH = 45_000,
  OBSERVE = 30_000;
/** A released delivery fails when its node has not finished within this time. */
export const UPGRADE_DEADLINE_MS = 30 * 60_000;
/** Share of the rollout nodes upgrading at the same time after promotion (at least one). */
export const MAX_UNAVAILABLE = 0.25;
/** Active nodes one upgrade covers at most. */
export const MAX_UPGRADE_NODES = 1000;
/** Node names an error lists before "+N". */
const LISTED_NODES = 10;
/** "a, b, c" for the first names, then "+N" for the rest. */
export function nodeNameList(names: readonly string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, LISTED_NODES).join(", ");
  return sorted.length > LISTED_NODES ? `${shown} +${sorted.length - LISTED_NODES}` : shown;
}
/** Deliveries of nodes disabled or deleted during the upgrade; the upgrade goes on without them. */
const NODE_REMOVED = "upgrade_node_removed";
type JobRow = typeof job.$inferSelect;
type DeliveryRow = typeof delivery.$inferSelect;
const removed = (d: Pick<DeliveryRow, "state" | "errorCode">) =>
  d.state === "cancelled" && d.errorCode === NODE_REMOVED;
const deadline = (now: Date) => new Date(now.getTime() + UPGRADE_DEADLINE_MS);
async function lockCluster(tx: Executor, clusterId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${clusterId}`}))`);
}
export async function nodeRelease(
  app: AppContext,
  version: string,
): Promise<{ version: string; artifacts: UpgradeArtifact[] }> {
  version = releaseVersion.parse(version);
  const source = await getReleaseSource(app);
  const base = `${source.effectiveUrl.replace(/\/+$/, "")}/v${version}/`;
  let text = "";
  try {
    if (source.source === "setting") {
      text = (
        await outboundGet(app, `${base}checksums.txt`, {
          maxBytes: 2 * 1024 * 1024,
          timeoutMs: 15000,
          maxRedirects: 3,
        })
      ).toString("utf8");
    } else {
      const res = await fetch(`${base}checksums.txt`, {
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      if (!res.ok || !res.body) throw new Error("manifest unavailable");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of res.body) {
        length += chunk.byteLength;
        if (length > 2 * 1024 * 1024) throw new Error("manifest too large");
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
  } catch {
    fail("UPGRADE_RELEASE_UNAVAILABLE", "release manifest is unavailable");
  }
  const artifacts: UpgradeArtifact[] = [];
  for (const arch of ["amd64", "arm64"] as const) {
    const name = `edgeweir-node_${version}_linux_${arch}.tar.gz`;
    const rows = text
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[1]?.replace(/^\*/, "") === name);
    if (rows.length > 1)
      fail("UPGRADE_RELEASE_UNAVAILABLE", "duplicate artifact in release manifest");
    const row = rows[0];
    if (row?.length === 2 && /^[0-9a-f]{64}$/.test(row[0] ?? ""))
      artifacts.push({
        arch,
        archiveUrl: base + name,
        sha256: row[0] as string,
        checksumsUrl: `${base}checksums.txt`,
        signatureUrl: `${base}checksums.txt.sigstore.json`,
      });
  }
  if (!artifacts.length) fail("UPGRADE_RELEASE_UNAVAILABLE", "release has no supported archive");
  return { version, artifacts };
}
/** A looked-up latest version is reused this long, a failed lookup a minute. */
export const LATEST_VERSION_TTL_MS = 10 * 60_000;
const LATEST_FAILED_TTL_MS = 60_000;
const latestVersions = new Map<string, { version: string | null; until: number }>();
/** Release files on GitHub; their latest version comes from the releases API. */
const GITHUB_DOWNLOADS =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download$/;

/** A response body of at most `maxBytes`, as text. */
async function limitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of res.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error("response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The newest node release of the release source, to prefill the upgrade
 * dialog; null when it cannot be told. GitHub releases (the default
 * source) answer through the releases API; a mirror through its
 * `<base>/latest` file, as install.sh reads it (a saved mirror under the
 * outbound policy). Cached per source for 10 minutes.
 */
export async function latestNodeVersion(app: AppContext, now = Date.now()): Promise<string | null> {
  const source = await getReleaseSource(app);
  const base = source.effectiveUrl.replace(/\/+$/, "");
  const cached = latestVersions.get(base);
  if (cached && cached.until > now) return cached.version;
  let version: string | null = null;
  try {
    const repo = base.match(GITHUB_DOWNLOADS)?.[1];
    let text: string;
    if (repo) {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/vnd.github+json", "user-agent": "edgeweir-console" },
      });
      const tag = (JSON.parse(await limitedText(res, 2 * 1024 * 1024)) as { tag_name?: unknown })
        .tag_name;
      text = typeof tag === "string" ? tag : "";
    } else if (source.source === "setting") {
      text = (
        await outboundGet(app, `${base}/latest`, {
          maxBytes: 1024,
          timeoutMs: 10_000,
          maxRedirects: 3,
        })
      ).toString("utf8");
    } else {
      text = await limitedText(
        await fetch(`${base}/latest`, { signal: AbortSignal.timeout(10_000), redirect: "follow" }),
        1024,
      );
    }
    const parsed = releaseVersion.safeParse(text);
    version = parsed.success ? parsed.data : null;
  } catch {
    version = null;
  }
  latestVersions.set(base, {
    version,
    until: now + (version ? LATEST_VERSION_TTL_MS : LATEST_FAILED_TTL_MS),
  });
  return version;
}

async function dtos(db: Executor, rows: JobRow[], now = Date.now()): Promise<UpgradeJob[]> {
  if (!rows.length) return [];
  const deliveries = await db
    .select()
    .from(delivery)
    .where(
      inArray(
        delivery.upgradeId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(delivery.phase), asc(delivery.nodeName));
  const ids = [...new Set(deliveries.map((d) => d.nodeId))];
  const nodes = ids.length
    ? await db
        .select({ node: schema.node, status: schema.nodeConfigStatus })
        .from(schema.node)
        .leftJoin(schema.nodeConfigStatus, eq(schema.node.id, schema.nodeConfigStatus.nodeId))
        .where(inArray(schema.node.id, ids))
    : [];
  const nodeMap = new Map(nodes.map((n) => [n.node.id, n]));
  // Healthy means running the node's own target (canary groups may run a candidate).
  const targets = new Map<string, RolloutTargets>();
  for (const clusterId of [...new Set(rows.map((r) => r.clusterId))])
    targets.set(clusterId, await rolloutTargets(db, clusterId));
  return rows.map((r) => {
    const items = deliveries.filter((d) => d.upgradeId === r.id),
      canary = items.filter((d) => d.phase === "canary" && !removed(d)),
      clusterTargets = targets.get(r.clusterId);
    const healthy = (d: DeliveryRow) => {
      const current = nodeMap.get(d.nodeId);
      const target =
        current && clusterTargets ? targetFor(current.node, clusterTargets) : undefined;
      return (
        d.state === "succeeded" &&
        d.healthySince &&
        now - d.healthySince.getTime() >= OBSERVE &&
        current?.node.clusterId === r.clusterId &&
        current.node.status === "active" &&
        current.node.agentVersion.replace(/^v/, "") === r.version &&
        current.node.lastSeenAt &&
        now - current.node.lastSeenAt.getTime() <= FRESH &&
        current.status?.dataPlaneHealthy &&
        current.status.state === "applied" &&
        target &&
        current.status.appliedContentHash === target.contentHash
      );
    };
    return {
      id: r.id,
      clusterId: r.clusterId,
      clusterName: r.clusterName,
      groupName: r.groupName,
      version: r.version,
      state: r.state as UpgradeJob["state"],
      createdAt: r.createdAt.toISOString(),
      canPromote:
        r.state === "canary" &&
        canary.length > 0 &&
        items.some((d) => d.state === "held") &&
        canary.every(healthy),
      deliveries: items.map((d) => ({
        id: d.id,
        nodeId: d.nodeId,
        nodeName: d.nodeName,
        phase: d.phase as "canary" | "rollout",
        state: d.state as UpgradeJob["deliveries"][number]["state"],
        message: d.message,
        errorCode: d.errorCode,
        deadlineAt:
          d.state === "pending" || d.state === "running"
            ? (d.deadlineAt?.toISOString() ?? null)
            : null,
        finishedAt: d.finishedAt?.toISOString() ?? null,
      })),
    };
  });
}
async function getJob(db: Executor, id: string) {
  const [row] = await db.select().from(job).where(eq(job.id, id));
  if (!row) fail("UPGRADE_NOT_FOUND", "upgrade not found");
  return row;
}
/**
 * Releases the next rollout deliveries (by node name) while fewer than
 * MAX_UNAVAILABLE of the rollout nodes are upgrading.
 */
async function releaseBatch(db: Executor, id: string, now: Date) {
  const rows = await db
    .select({ id: delivery.id, state: delivery.state })
    .from(delivery)
    .where(and(eq(delivery.upgradeId, id), eq(delivery.phase, "rollout")))
    .orderBy(asc(delivery.nodeName), asc(delivery.id));
  const limit = Math.max(1, Math.ceil(rows.length * MAX_UNAVAILABLE));
  const busy = rows.filter((d) => d.state === "pending" || d.state === "running").length;
  const next = rows.filter((d) => d.state === "held").slice(0, Math.max(0, limit - busy));
  if (next.length)
    await db
      .update(delivery)
      .set({ state: "pending", deadlineAt: deadline(now) })
      .where(
        and(
          inArray(
            delivery.id,
            next.map((d) => d.id),
          ),
          eq(delivery.state, "held"),
        ),
      );
}
async function refresh(db: Executor, id: string, now = new Date()) {
  const rows = (
    await db
      .select({ state: delivery.state, errorCode: delivery.errorCode })
      .from(delivery)
      .where(eq(delivery.upgradeId, id))
  ).filter((d) => !removed(d));
  const [current] = await db.select().from(job).where(eq(job.id, id));
  if (!current || current.state === "cancelled") return;
  if (rows.length === 0) {
    // Every node left the upgrade.
    await db.update(job).set({ state: "cancelled" }).where(eq(job.id, id));
  } else if (rows.some((d) => d.state === "failed")) {
    await db.update(job).set({ state: "failed" }).where(eq(job.id, id));
    await db
      .update(delivery)
      .set({
        state: "cancelled",
        message: "stopped after a failed node",
        errorCode: "upgrade_cancelled",
        finishedAt: new Date(),
      })
      .where(and(eq(delivery.upgradeId, id), inArray(delivery.state, ["held", "pending"])));
  } else if (rows.every((d) => d.state === "succeeded"))
    await db.update(job).set({ state: "succeeded" }).where(eq(job.id, id));
  else if (current.state === "rollout") await releaseBatch(db, id, now);
}
/**
 * Fails released deliveries past their deadline, which fails their upgrade.
 * Held deliveries have none: a canary is observed as long as the operator
 * wants, and rollout batches get their own time when released.
 */
export async function expireUpgrades(db: Database, now = new Date()) {
  const expired = await db
    .selectDistinct({ id: job.id, clusterId: job.clusterId })
    .from(job)
    .innerJoin(delivery, eq(delivery.upgradeId, job.id))
    .where(and(inArray(delivery.state, ["pending", "running"]), lt(delivery.deadlineAt, now)));
  for (const row of expired)
    await db.transaction(async (tx) => {
      await lockCluster(tx, row.clusterId);
      await tx
        .update(delivery)
        .set({
          state: "failed",
          message: "upgrade task expired",
          errorCode: "upgrade_expired",
          finishedAt: now,
        })
        .where(
          and(
            eq(delivery.upgradeId, row.id),
            inArray(delivery.state, ["pending", "running"]),
            lt(delivery.deadlineAt, now),
          ),
        );
      await refresh(tx, row.id, now);
    });
}
/**
 * Takes a disabled or deleted node out of its unfinished upgrades: they go
 * on with the other nodes instead of waiting for it until they expire.
 */
export async function discardNodeUpgrades(tx: Executor, nodeId: string, now = new Date()) {
  const rows = await tx
    .selectDistinct({ id: job.id, clusterId: job.clusterId })
    .from(delivery)
    .innerJoin(job, eq(job.id, delivery.upgradeId))
    .where(and(eq(delivery.nodeId, nodeId), inArray(delivery.state, ACTIVE)));
  for (const row of rows) {
    await lockCluster(tx, row.clusterId);
    await tx
      .update(delivery)
      .set({
        state: "cancelled",
        message: "node disabled or deleted",
        errorCode: NODE_REMOVED,
        leaseUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(delivery.upgradeId, row.id),
          eq(delivery.nodeId, nodeId),
          inArray(delivery.state, ACTIVE),
        ),
      );
    await refresh(tx, row.id, now);
  }
  return rows.length;
}
export async function listUpgrades(app: AppContext, clusterId?: string) {
  return dtos(
    app.db,
    await app.db
      .select()
      .from(job)
      .where(clusterId ? eq(job.clusterId, clusterId) : undefined)
      .orderBy(desc(job.createdAt))
      .limit(50),
  );
}
export async function createUpgrade(
  app: AppContext,
  input: { nodeGroupId: string; version: string },
  actor: Actor,
) {
  await expireUpgrades(app.db);
  const release = await nodeRelease(app, input.version);
  return app.db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(schema.nodeGroup)
      .where(eq(schema.nodeGroup.id, input.nodeGroupId))
      .for("update");
    if (!group) fail("NODE_GROUP_NOT_FOUND", "node group not found");
    await lockCluster(tx, group.clusterId);
    const [cluster] = await tx
      .select()
      .from(schema.cluster)
      .where(eq(schema.cluster.id, group.clusterId));
    if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
    const nodes = await tx
      .select({ node: schema.node, status: schema.nodeConfigStatus })
      .from(schema.node)
      .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
      .where(and(eq(schema.node.clusterId, cluster.id), eq(schema.node.status, "active")))
      .limit(MAX_UPGRADE_NODES + 1);
    if (nodes.length > MAX_UPGRADE_NODES)
      fail("UPGRADE_TOO_MANY_NODES", `an upgrade covers at most ${MAX_UPGRADE_NODES} nodes`, {
        limit: MAX_UPGRADE_NODES,
      });
    const clusterTargets = await rolloutTargets(tx, cluster.id);
    const canary = nodes.filter((n) => n.node.nodeGroupId === group.id),
      now = Date.now();
    if (!canary.length)
      fail("UPGRADE_CANARY_EMPTY", "the node group to upgrade first has no active nodes");
    const blocked = nodes.filter(
      ({ node: n, status: s }) =>
        n.os !== "linux" ||
        !release.artifacts.some((a) => a.arch === n.arch) ||
        !n.supportedFeatures.includes("self-upgrade-v1") ||
        !n.lastSeenAt ||
        now - n.lastSeenAt.getTime() > FRESH ||
        !s?.dataPlaneHealthy ||
        s.state !== "applied" ||
        s.appliedContentHash !== targetFor(n, clusterTargets)?.contentHash,
    );
    if (blocked.length) {
      const names = nodeNameList(blocked.map((n) => n.node.name));
      fail(
        "UPGRADE_NODES_UNAVAILABLE",
        `all active nodes must be online, healthy, in sync and support signed upgrades: ${names}`,
        { nodes: names },
      );
    }
    const conflict = await tx
      .selectDistinct({ name: delivery.nodeName })
      .from(delivery)
      .where(
        and(
          inArray(
            delivery.nodeId,
            nodes.map((n) => n.node.id),
          ),
          inArray(delivery.state, ACTIVE),
        ),
      );
    if (conflict.length) {
      const names = nodeNameList(conflict.map((c) => c.name));
      fail("UPGRADE_BUSY", `nodes already have an unfinished upgrade: ${names}`, { nodes: names });
    }
    const [created] = await tx
      .insert(job)
      .values({
        clusterId: cluster.id,
        clusterName: cluster.name,
        groupName: group.name,
        version: release.version,
        artifacts: release.artifacts,
      })
      .returning();
    if (!created) throw new Error("upgrade insert failed");
    await tx.insert(delivery).values(
      nodes.map(({ node: n }) => ({
        upgradeId: created.id,
        nodeId: n.id,
        nodeName: n.name,
        arch: n.arch,
        phase: n.nodeGroupId === group.id ? "canary" : "rollout",
        state: n.nodeGroupId === group.id ? "pending" : "held",
        deadlineAt: n.nodeGroupId === group.id ? deadline(new Date(now)) : null,
      })),
    );
    await recordAudit(tx, actor, {
      action: "node.upgrade_create",
      targetType: "node_upgrade",
      targetId: created.id,
      targetName: release.version,
      metadata: { clusterId: cluster.id, nodeGroupId: group.id, nodes: nodes.length },
    });
    const [dto] = await dtos(tx, [created]);
    if (!dto) throw new Error("upgrade missing");
    return dto;
  });
}
export async function promoteUpgrade(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const row = await getJob(tx, id);
    await lockCluster(tx, row.clusterId);
    const current = await getJob(tx, id);
    const [dto] = await dtos(tx, [current]);
    if (!dto?.canPromote)
      fail("UPGRADE_NOT_READY", "canary nodes must remain healthy before promotion");
    await tx.update(job).set({ state: "rollout" }).where(eq(job.id, id));
    // The rest follows in batches, each with its own deadline.
    await releaseBatch(tx, id, new Date());
    const updated = await getJob(tx, id);
    await recordAudit(tx, actor, {
      action: "node.upgrade_promote",
      targetType: "node_upgrade",
      targetId: id,
      targetName: row.version,
    });
    const [result] = await dtos(tx, [updated]);
    if (!result) throw new Error("upgrade missing");
    return result;
  });
}
export async function cancelUpgrade(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const row = await getJob(tx, id);
    await lockCluster(tx, row.clusterId);
    const running = await tx
      .select({ name: delivery.nodeName })
      .from(delivery)
      .where(and(eq(delivery.upgradeId, id), eq(delivery.state, "running")));
    if (running.length) {
      const names = nodeNameList(running.map((d) => d.name));
      fail("UPGRADE_BUSY", `wait for the running upgrade to finish or roll back: ${names}`, {
        nodes: names,
      });
    }
    if (!["canary", "rollout"].includes((await getJob(tx, id)).state))
      fail("UPGRADE_FINISHED", "upgrade has already finished");
    await tx
      .update(delivery)
      .set({
        state: "cancelled",
        errorCode: "upgrade_cancelled",
        message: "cancelled by the operator",
        finishedAt: new Date(),
      })
      .where(and(eq(delivery.upgradeId, id), inArray(delivery.state, ["held", "pending"])));
    const [updated] = await tx
      .update(job)
      .set({ state: "cancelled" })
      .where(eq(job.id, id))
      .returning();
    if (!updated) throw new Error("upgrade disappeared");
    await recordAudit(tx, actor, {
      action: "node.upgrade_cancel",
      targetType: "node_upgrade",
      targetId: id,
      targetName: row.version,
    });
    const [result] = await dtos(tx, [updated]);
    if (!result) throw new Error("upgrade missing");
    return result;
  });
}
export async function hasUpgradeTasks(db: Executor, nodeId: string) {
  const rows = await db
    .select({ id: delivery.id })
    .from(delivery)
    .innerJoin(job, eq(job.id, delivery.upgradeId))
    .where(
      and(
        eq(delivery.nodeId, nodeId),
        inArray(job.state, ["canary", "rollout"]),
        or(
          eq(delivery.state, "pending"),
          and(eq(delivery.state, "running"), lt(delivery.leaseUntil, new Date())),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
export async function pullUpgrade(
  app: AppContext,
  node: { id: string; clusterId: string; status: string; supportedFeatures: string[] },
) {
  if (node.status !== "active" || !node.supportedFeatures.includes("self-upgrade-v1")) return null;
  // Most pulls find no upgrade: only those that do take the cluster lock.
  if (!(await hasUpgradeTasks(app.db, node.id))) return null;
  return app.db.transaction(async (tx) => {
    await lockCluster(tx, node.clusterId);
    const [row] = await tx
      .select({ delivery, job })
      .from(delivery)
      .innerJoin(job, eq(job.id, delivery.upgradeId))
      .where(
        and(
          eq(delivery.nodeId, node.id),
          eq(job.clusterId, node.clusterId),
          inArray(job.state, ["canary", "rollout"]),
          or(
            eq(delivery.state, "pending"),
            and(eq(delivery.state, "running"), lt(delivery.leaseUntil, new Date())),
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) return null;
    if (row.delivery.deadlineAt && row.delivery.deadlineAt.getTime() < Date.now()) {
      await tx
        .update(delivery)
        .set({
          state: "failed",
          errorCode: "upgrade_expired",
          message: "upgrade task expired",
          finishedAt: new Date(),
        })
        .where(eq(delivery.id, row.delivery.id));
      await refresh(tx, row.job.id);
      return null;
    }
    const artifact = row.job.artifacts.find((a) => a.arch === row.delivery.arch);
    if (!artifact) throw new Error("upgrade artifact missing");
    await tx
      .update(delivery)
      .set({ state: "running", leaseUntil: new Date(Date.now() + 5 * 60_000) })
      .where(eq(delivery.id, row.delivery.id));
    return create(NodeTaskSchema, {
      id: row.delivery.id,
      createdAt: timestampFromDate(row.job.createdAt),
      kind: {
        case: "upgrade",
        value: create(UpgradeTaskSchema, { version: row.job.version, ...artifact }),
      },
    });
  });
}
export async function reportUpgrade(
  app: AppContext,
  nodeId: string,
  result: ReportTaskResultRequest,
): Promise<boolean> {
  return app.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ delivery, job })
      .from(delivery)
      .innerJoin(job, eq(job.id, delivery.upgradeId))
      .where(eq(delivery.id, result.taskId))
      .limit(1);
    if (!found) return false;
    if (found.delivery.nodeId !== nodeId)
      throw new ConnectError("upgrade belongs to another node", Code.PermissionDenied);
    await lockCluster(tx, found.job.clusterId);
    const [current] = await tx.select().from(delivery).where(eq(delivery.id, result.taskId));
    if (!current) return false;
    if (current.state !== "running") return true;
    const success = result.state === TaskState.SUCCEEDED;
    if (success) {
      const [receipt] = await tx
        .select({ node: schema.node, status: schema.nodeConfigStatus })
        .from(schema.node)
        .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
        .where(eq(schema.node.id, nodeId));
      const desired = receipt ? await nodeTarget(tx, receipt.node) : undefined;
      if (
        !receipt ||
        receipt.node.status !== "active" ||
        receipt.node.clusterId !== found.job.clusterId ||
        receipt.node.agentVersion.replace(/^v/, "") !== found.job.version ||
        !receipt.node.lastSeenAt ||
        Date.now() - receipt.node.lastSeenAt.getTime() > FRESH ||
        !receipt.status?.dataPlaneHealthy ||
        receipt.status.state !== "applied" ||
        !desired ||
        receipt.status.appliedContentHash !== desired.contentHash
      )
        throw new ConnectError(
          "upgrade success requires a fresh matching version and healthy config receipt",
          Code.FailedPrecondition,
        );
    }
    await tx
      .update(delivery)
      .set({
        state: success ? "succeeded" : "failed",
        message: result.message.slice(0, 1000),
        errorCode: success
          ? ""
          : result.errorCode === "upgrade_interrupted"
            ? "upgrade_interrupted"
            : result.errorCode === "upgrade_rolled_back"
              ? "upgrade_rolled_back"
              : "upgrade_rejected",
        finishedAt: new Date(),
        leaseUntil: null,
        healthySince: success ? new Date() : null,
      })
      .where(eq(delivery.id, result.taskId));
    await recordAudit(
      tx,
      { type: "node", id: nodeId, name: current.nodeName },
      {
        action: "node.upgrade_result",
        targetType: "node_upgrade",
        targetId: found.job.id,
        targetName: found.job.version,
        metadata: { taskId: result.taskId, success },
      },
    );
    await refresh(tx, found.job.id);
    return true;
  });
}

/** Positive and negative heartbeats define the canary observation window. */
export async function recordUpgradeHealth(
  tx: Executor,
  node: {
    id: string;
    clusterId: string;
    nodeGroupId: string | null;
    status: string;
    agentVersion: string;
    lastSeenAt: Date | null;
  },
  report: {
    state: string;
    dataPlaneHealthy: boolean;
    appliedRevision: number;
    appliedContentHash: string;
  },
  now: Date,
) {
  const rows = await tx
    .select({ delivery, version: job.version })
    .from(delivery)
    .innerJoin(job, eq(job.id, delivery.upgradeId))
    .where(
      and(
        eq(delivery.nodeId, node.id),
        eq(delivery.phase, "canary"),
        eq(delivery.state, "succeeded"),
        eq(job.state, "canary"),
      ),
    );
  if (!rows.length) return;
  const desired = await nodeTarget(tx, node);
  for (const row of rows) {
    const healthy =
      node.status === "active" &&
      node.agentVersion.replace(/^v/, "") === row.version &&
      report.state === "applied" &&
      report.dataPlaneHealthy &&
      desired?.contentHash === report.appliedContentHash;
    const continuous = !!node.lastSeenAt && now.getTime() - node.lastSeenAt.getTime() <= FRESH;
    await tx
      .update(delivery)
      .set({
        healthySince: healthy ? (continuous ? (row.delivery.healthySince ?? now) : now) : null,
      })
      .where(and(eq(delivery.id, row.delivery.id), eq(delivery.state, "succeeded")));
  }
}
