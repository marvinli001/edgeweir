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
  OBSERVE = 30_000,
  EXPIRE = 30 * 60_000;
type JobRow = typeof job.$inferSelect;
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
      canary = items.filter((d) => d.phase === "canary"),
      clusterTargets = targets.get(r.clusterId);
    const healthy = (d: typeof delivery.$inferSelect) => {
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
async function refresh(db: Executor, id: string) {
  const rows = await db
    .select({ state: delivery.state })
    .from(delivery)
    .where(eq(delivery.upgradeId, id));
  const [current] = await db.select().from(job).where(eq(job.id, id));
  if (!current || current.state === "cancelled") return;
  if (rows.some((d) => d.state === "failed")) {
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
  } else if (rows.length && rows.every((d) => d.state === "succeeded"))
    await db.update(job).set({ state: "succeeded" }).where(eq(job.id, id));
}
export async function expireUpgrades(db: Database, now = new Date()) {
  const expired = await db
    .selectDistinct({ id: job.id, clusterId: job.clusterId })
    .from(job)
    .innerJoin(delivery, eq(delivery.upgradeId, job.id))
    .where(
      and(lt(job.createdAt, new Date(now.getTime() - EXPIRE)), inArray(delivery.state, ACTIVE)),
    );
  for (const row of expired)
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${row.clusterId}`}))`);
      await tx
        .update(delivery)
        .set({
          state: "failed",
          message: "upgrade task expired",
          errorCode: "upgrade_expired",
          finishedAt: now,
        })
        .where(and(eq(delivery.upgradeId, row.id), inArray(delivery.state, ACTIVE)));
      await refresh(tx, row.id);
    });
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${group.clusterId}`}))`);
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
      .limit(1001);
    const clusterTargets = await rolloutTargets(tx, cluster.id);
    const canary = nodes.filter((n) => n.node.nodeGroupId === group.id),
      now = Date.now();
    if (
      !canary.length ||
      nodes.length > 1000 ||
      nodes.some(
        ({ node: n, status: s }) =>
          n.os !== "linux" ||
          !release.artifacts.some((a) => a.arch === n.arch) ||
          !n.supportedFeatures.includes("self-upgrade-v1") ||
          !n.lastSeenAt ||
          now - n.lastSeenAt.getTime() > FRESH ||
          !s?.dataPlaneHealthy ||
          s.state !== "applied" ||
          s.appliedContentHash !== targetFor(n, clusterTargets)?.contentHash,
      )
    )
      fail(
        "UPGRADE_NODES_UNAVAILABLE",
        "all target nodes must be online, healthy and support signed upgrades",
      );
    const conflict = await tx
      .select({ id: delivery.id })
      .from(delivery)
      .where(
        and(
          inArray(
            delivery.nodeId,
            nodes.map((n) => n.node.id),
          ),
          inArray(delivery.state, ACTIVE),
        ),
      )
      .limit(1);
    if (conflict.length) fail("UPGRADE_BUSY", "a node already has an active upgrade");
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${row.clusterId}`}))`);
    const current = await getJob(tx, id);
    const [dto] = await dtos(tx, [current]);
    if (!dto?.canPromote)
      fail("UPGRADE_NOT_READY", "canary nodes must remain healthy before promotion");
    await tx
      .update(delivery)
      .set({ state: "pending" })
      .where(and(eq(delivery.upgradeId, id), eq(delivery.state, "held")));
    const [updated] = await tx
      .update(job)
      .set({ state: "rollout" })
      .where(eq(job.id, id))
      .returning();
    if (!updated) throw new Error("upgrade disappeared");
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${row.clusterId}`}))`);
    const running = await tx
      .select()
      .from(delivery)
      .where(and(eq(delivery.upgradeId, id), eq(delivery.state, "running")))
      .limit(1);
    if (running.length) fail("UPGRADE_BUSY", "wait for the running upgrade to finish or roll back");
    if (!["canary", "rollout"].includes((await getJob(tx, id)).state))
      fail("UPGRADE_BUSY", "upgrade has already finished");
    await tx
      .update(delivery)
      .set({
        state: "cancelled",
        errorCode: "upgrade_cancelled",
        message: "cancelled by administrator",
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
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${node.clusterId}`}))`);
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
    if (Date.now() - row.job.createdAt.getTime() > EXPIRE) {
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
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`upgrade/${found.job.clusterId}`}))`,
    );
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
