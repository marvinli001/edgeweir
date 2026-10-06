import { decodeNodeConfig, nodeRequirements } from "@edgeweir/config-compiler";
import {
  type Node,
  type NodeAddressesInput,
  nodeSupportsFeature,
  unicastAddress,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { fail } from "../lib/errors";
import { isOnline, ONLINE_WINDOW_SECONDS } from "../lib/node-online";
import { type Actor, recordAudit } from "./audit";
import { skipNodeTasks } from "./cache-tasks";
import { publishClusterDns } from "./dns";
import {
  downAddresses,
  effectiveAddresses,
  MAX_CONFIGURED_ADDRESSES,
  nodeIpRows,
  schedulingAddressesOf,
} from "./node-addresses";
import { findNodeGroup } from "./node-groups";
import {
  type Executor,
  latestRevision,
  notifyClusterTargets,
  publishRevision,
  type RevisionHead,
  type RolloutTargets,
  rolloutTargets,
  targetFor,
} from "./revisions";
import { discardNodeUpgrades } from "./upgrades";

export { isOnline, ONLINE_WINDOW_SECONDS };

type NodeRow = typeof schema.node.$inferSelect;

async function toNodeDtos(db: Executor, rows: NodeRow[]): Promise<Node[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const statuses = await db
    .select()
    .from(schema.nodeConfigStatus)
    .where(inArray(schema.nodeConfigStatus.nodeId, ids));
  const ips = await nodeIpRows(db, ids);
  const down = await downAddresses(db, ids);
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster);
  const groupIds = [...new Set(rows.map((r) => r.nodeGroupId).filter((v): v is string => !!v))];
  const groups = groupIds.length
    ? await db
        .select({
          id: schema.nodeGroup.id,
          name: schema.nodeGroup.name,
          regionName: schema.region.name,
        })
        .from(schema.nodeGroup)
        .leftJoin(schema.region, eq(schema.region.id, schema.nodeGroup.regionId))
        .where(inArray(schema.nodeGroup.id, groupIds))
    : [];
  const required = new Map<string, string[]>();
  const targets = new Map<string, RolloutTargets<RevisionHead>>();
  for (const clusterId of new Set(rows.map((r) => r.clusterId))) {
    const latest = await latestRevision(db, clusterId);
    required.set(clusterId, latest ? nodeRequirements(decodeNodeConfig(latest.ir)) : []);
    targets.set(clusterId, await rolloutTargets(db, clusterId, "head"));
  }
  return rows.map((r) => {
    const st = statuses.find((s) => s.nodeId === r.id);
    const group = groups.find((g) => g.id === r.nodeGroupId);
    const own = ips.get(r.id) ?? [];
    const scheduling = schedulingAddressesOf(own);
    const unreachable = down.get(r.id) ?? new Set<string>();
    return {
      id: r.id,
      name: r.name,
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
      nodeGroupId: r.nodeGroupId,
      nodeGroupName: group?.name ?? null,
      regionName: group?.regionName ?? null,
      hostname: r.hostname,
      status: r.status === "disabled" ? "disabled" : "active",
      online: isOnline(r.lastSeenAt),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      enrolledAt: r.enrolledAt?.toISOString() ?? null,
      agentVersion: r.agentVersion,
      supportedFeatures: r.supportedFeatures,
      upgradeRequired:
        (!!r.agentVersion && !r.supportedFeatures.includes("stats-sequence-v1")) ||
        (required.get(r.clusterId) ?? []).some((f) => !nodeSupportsFeature(r.supportedFeatures, f)),
      engine: r.engine,
      engineVersion: r.engineVersion,
      os: r.os,
      arch: r.arch,
      // The addresses the node reports (configured ones are schedulingAddresses).
      ipAddresses: [
        ...new Set(own.filter((i) => i.source !== "configured").map((i) => i.address)),
      ].sort(),
      certFingerprint: r.certFingerprint,
      certNotAfter: r.certNotAfter?.toISOString() ?? null,
      appliedRevision: st?.appliedRevision ?? 0,
      targetRevision: (() => {
        const clusterTargets = targets.get(r.clusterId);
        return clusterTargets ? (targetFor(r, clusterTargets)?.revision ?? null) : null;
      })(),
      appliedContentHash: st?.appliedContentHash ?? "",
      applyState: (st?.state as Node["applyState"]) ?? null,
      applyMessage: st?.message ?? "",
      dataPlaneHealthy: st?.dataPlaneHealthy ?? false,
      banStatus: r.banStatus ?? null,
      probeEnabled: r.probeEnabled,
      metrics: r.metrics ?? null,
      schedulingAddresses: scheduling.map((a) => ({
        ...a,
        reachable: !unreachable.has(a.address),
      })),
      schedulingLevel: effectiveAddresses(scheduling, unreachable).level,
      remoteAddress: r.remoteAddress,
      dnsIssue: scheduling.length === 0 ? "no_public_address" : null,
      // A refusal counts until the node gets through again.
      authError:
        r.lastAuthError && r.lastAuthErrorAt && (!r.lastSeenAt || r.lastAuthErrorAt > r.lastSeenAt)
          ? r.lastAuthError
          : null,
      cache: { maxSizeGb: r.cacheMaxSizeGb, usage: cacheUsage(r.cacheUsage) },
    };
  });
}

/** The node's default cache zone as last measured (the cluster has one zone). */
function cacheUsage(usage: NodeRow["cacheUsage"]): Node["cache"]["usage"] {
  const zone = usage?.zones[0];
  return zone
    ? { usedBytes: zone.usedBytes, maxBytes: zone.maxBytes, measuredAt: zone.measuredAt }
    : null;
}

/**
 * Sets the node's own cache zone size (null: the cluster's), publishes the
 * cluster (only this node's nginx.conf changes; cache-zone-v1 while a node
 * has its own size) and audits the change.
 */
export async function setNodeCache(
  db: Database,
  input: { id: string; maxSizeGb: number | null },
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const row = await findNode(tx, input.id);
    await tx
      .update(schema.node)
      .set({ cacheMaxSizeGb: input.maxSizeGb })
      .where(eq(schema.node.id, row.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "node_cache_updated", params: { node: row.name } },
      actor,
    });
    await recordAudit(tx, actor, {
      action: "node.cache_update",
      targetType: "node",
      targetId: row.id,
      targetName: row.name,
      metadata: { from: row.cacheMaxSizeGb, to: input.maxSizeGb, revision: revision.revision },
    });
    return getNode(tx, row.id);
  });
}

export async function listNodes(db: Database, clusterId?: string): Promise<Node[]> {
  const rows = await db
    .select()
    .from(schema.node)
    .where(clusterId ? eq(schema.node.clusterId, clusterId) : undefined)
    .orderBy(asc(schema.node.createdAt));
  return toNodeDtos(db, rows);
}

async function findNode(db: Executor, id: string): Promise<NodeRow> {
  const [row] = await db.select().from(schema.node).where(eq(schema.node.id, id));
  if (!row) fail("NODE_NOT_FOUND", "node not found");
  return row;
}

export async function getNode(db: Executor, id: string): Promise<Node> {
  const [dto] = await toNodeDtos(db, [await findNode(db, id)]);
  if (!dto) fail("NODE_NOT_FOUND", "node not found");
  return dto;
}

/** Renames a node and/or moves it to another node group of the same cluster. */
export async function updateNode(
  db: Database,
  input: { id: string; name?: string; nodeGroupId?: string },
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const before = await findNode(tx, input.id);
    let groupName: string | undefined;
    if (input.nodeGroupId !== undefined) {
      const group = await findNodeGroup(tx, input.nodeGroupId);
      if (group.clusterId !== before.clusterId) {
        fail(
          "NODE_GROUP_CLUSTER_MISMATCH",
          "the node group belongs to another cluster than the node",
        );
      }
      groupName = group.name;
    }
    const [updated] = await tx
      .update(schema.node)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.nodeGroupId !== undefined ? { nodeGroupId: input.nodeGroupId } : {}),
      })
      .where(eq(schema.node.id, input.id))
      .returning();
    if (!updated) throw new Error("node update failed");
    const moved = input.nodeGroupId !== undefined && input.nodeGroupId !== before.nodeGroupId;
    // Moving in or out of a canary group changes the node's target revision.
    if (moved) await notifyClusterTargets(tx, before.clusterId);
    await recordAudit(tx, actor, {
      action: moved && input.name === undefined ? "node.move" : "node.update",
      targetType: "node",
      targetId: updated.id,
      targetName: updated.name,
      metadata: {
        from: { name: before.name, nodeGroupId: before.nodeGroupId },
        ...input,
        ...(groupName ? { nodeGroup: groupName } : {}),
      },
    });
    return getNode(tx, updated.id);
  });
}

/**
 * Disables or re-enables a node. A disabled node is refused by the node
 * channel (it keeps serving its last-known-good configuration) until enabled,
 * except for certificate renewal, so it still has a valid one by then;
 * its unfinished cache task deliveries are marked skipped, and the purges it
 * missed are made up with whole-site purges once it pulls tasks again.
 */
export async function setNodeStatus(
  db: Database,
  id: string,
  status: "active" | "disabled",
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const row = await findNode(tx, id);
    await tx.update(schema.node).set({ status }).where(eq(schema.node.id, id));
    const skippedTasks = status === "disabled" ? await skipNodeTasks(tx, id) : 0;
    if (status === "disabled") await discardNodeUpgrades(tx, id);
    await recordAudit(tx, actor, {
      action: status === "disabled" ? "node.disable" : "node.enable",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      ...(skippedTasks ? { metadata: { skippedTasks } } : {}),
    });
    return getNode(tx, id);
  });
}

/**
 * Deletes a node and revokes its client certificate: the node channel refuses
 * the certificate from now on, so the agent cannot reconnect without a new
 * enrollment token.
 */
export async function deleteNode(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await findNode(tx, id);
    // Also the certificate a renewal replaced, still accepted until the node used the new one.
    const serials = [
      ...(row.certSerial
        ? [{ serial: row.certSerial, fingerprintSha256: row.certFingerprint }]
        : []),
      ...(row.previousCertSerial
        ? [{ serial: row.previousCertSerial, fingerprintSha256: "" }]
        : []),
    ];
    if (serials.length) {
      await tx
        .insert(schema.nodeCertificateRevocation)
        .values(
          serials.map((s) => ({
            serial: normalizeSerial(s.serial),
            nodeId: row.id,
            fingerprintSha256: s.fingerprintSha256 ?? "",
            reason: "node deleted",
          })),
        )
        .onConflictDoNothing();
    }
    await discardNodeUpgrades(tx, id);
    // Results it measured as a probe (results about it go with the row).
    await tx.delete(schema.probeResult).where(eq(schema.probeResult.proberId, id));
    await tx.delete(schema.node).where(eq(schema.node.id, id));
    await recordAudit(tx, actor, {
      action: "node.delete",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      metadata: {
        clusterId: row.clusterId,
        certSerial: row.certSerial,
        certFingerprint: row.certFingerprint,
      },
    });
  });
}

/** Addresses kept per node. */
export const MAX_NODE_ADDRESSES = 64;

/**
 * Replaces the addresses a node reported before with the ones it reports
 * now, so a changed address or a rotated IPv6 temporary address leaves DNS
 * and ban protection. Only single unicast addresses are kept; a report
 * without any (the host could not read its interfaces) keeps the last ones.
 */
export async function replaceReportedAddresses(
  tx: Executor,
  nodeId: string,
  reported: readonly string[],
): Promise<void> {
  const addresses = [
    ...new Set(reported.map(unicastAddress).filter((a): a is string => a !== null)),
  ].slice(0, MAX_NODE_ADDRESSES);
  if (addresses.length === 0) return;
  await tx
    .delete(schema.nodeIp)
    .where(
      and(
        eq(schema.nodeIp.nodeId, nodeId),
        eq(schema.nodeIp.source, "reported"),
        notInArray(schema.nodeIp.address, addresses),
      ),
    );
  await tx
    .insert(schema.nodeIp)
    .values(addresses.map((address) => ({ nodeId, address, source: "reported" })))
    .onConflictDoNothing();
}

/**
 * Replaces the node's configured scheduling addresses (empty: DNS and
 * probes go back to the public addresses it reports) and publishes the
 * cluster's DNS binding with them; the reconciliation writes it.
 */
export async function setNodeAddresses(
  db: Database,
  input: NodeAddressesInput,
  actor: Actor,
): Promise<Node> {
  const addresses: { address: string; level: number }[] = [];
  for (const entry of input.addresses.slice(0, MAX_CONFIGURED_ADDRESSES)) {
    const address = unicastAddress(entry.address);
    if (!address || entry.address.includes("/") || addresses.some((a) => a.address === address))
      fail("NODE_ADDRESS_INVALID", "not a single unicast IP address", {
        address: entry.address,
      });
    addresses.push({ address, level: entry.level });
  }
  return db.transaction(async (tx) => {
    const row = await findNode(tx, input.id);
    const before = (await nodeIpRows(tx, [row.id])).get(row.id) ?? [];
    await tx
      .delete(schema.nodeIp)
      .where(and(eq(schema.nodeIp.nodeId, row.id), eq(schema.nodeIp.source, "configured")));
    if (addresses.length)
      await tx.insert(schema.nodeIp).values(
        addresses.map((a) => ({
          nodeId: row.id,
          address: a.address,
          level: a.level,
          source: "configured",
          kind: "configured",
        })),
      );
    await recordAudit(tx, actor, {
      action: "node.set_addresses",
      targetType: "node",
      targetId: row.id,
      targetName: row.name,
      metadata: {
        from: before
          .filter((a) => a.source === "configured")
          .map((a) => ({ address: a.address, level: a.level })),
        to: addresses,
      },
    });
    await publishClusterDns(tx, row.clusterId, "manual");
    return getNode(tx, row.id);
  });
}

/**
 * Lets the node probe the other nodes (ReportStatusResponse.probe) from its
 * node group's region, which it needs; turning it off drops its results.
 */
export async function setNodeProbe(
  db: Database,
  input: { id: string; enabled: boolean },
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const row = await findNode(tx, input.id);
    if (input.enabled) {
      const [group] = row.nodeGroupId
        ? await tx
            .select({ regionId: schema.nodeGroup.regionId })
            .from(schema.nodeGroup)
            .where(eq(schema.nodeGroup.id, row.nodeGroupId))
        : [];
      if (!group?.regionId)
        fail("NODE_REGION_REQUIRED", "the node's group needs a region before the node can probe");
    } else {
      await tx.delete(schema.probeResult).where(eq(schema.probeResult.proberId, row.id));
    }
    await tx
      .update(schema.node)
      .set({ probeEnabled: input.enabled })
      .where(eq(schema.node.id, row.id));
    await recordAudit(tx, actor, {
      action: "node.set_probe",
      targetType: "node",
      targetId: row.id,
      targetName: row.name,
      metadata: { from: row.probeEnabled, to: input.enabled },
    });
    return getNode(tx, row.id);
  });
}

/** Canonical form of a certificate serial for comparisons (hex, no colons or leading zeros). */
export function normalizeSerial(serial: string | null | undefined): string {
  return (serial ?? "").toLowerCase().replace(/:/g, "").replace(/^0+/, "");
}

/**
 * Which of a node's certificates a client certificate serial is: the current
 * one, the one a renewal replaced (until the node uses the new one), or null.
 */
export function acceptedCertificate(
  node: { certSerial: string | null; previousCertSerial: string | null },
  serial: string | undefined,
): "current" | "previous" | null {
  const key = normalizeSerial(serial);
  if (!key) return null;
  if (key === normalizeSerial(node.certSerial)) return "current";
  return key === normalizeSerial(node.previousCertSerial) ? "previous" : null;
}

export async function isSerialRevoked(db: Executor, serial: string | undefined): Promise<boolean> {
  const key = normalizeSerial(serial);
  if (!key) return false;
  const [row] = await db
    .select({ serial: schema.nodeCertificateRevocation.serial })
    .from(schema.nodeCertificateRevocation)
    .where(eq(schema.nodeCertificateRevocation.serial, key));
  return !!row;
}
