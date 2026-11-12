import type { nodeTrafficLimitInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { fail } from "../lib/errors";
import { type Actor, recordAudit, systemActor } from "./audit";
import { skipNodeTasks } from "./cache-tasks";
import { publishClusterDns } from "./dns";
import type { Tx } from "./revisions";
import { discardNodeUpgrades } from "./upgrades";

export function trafficLimitView(value: schema.NodeTrafficLimitData | null) {
  if (!value) return null;
  const { baseline: _baseline, ...visible } = value;
  return visible;
}

export async function saveNodeTrafficLimit(
  db: Database,
  input: z.infer<typeof nodeTrafficLimitInput>,
  actor: Actor,
) {
  await db.transaction(async (tx) => {
    const [node] = await tx
      .select()
      .from(schema.node)
      .where(eq(schema.node.id, input.id))
      .for("update");
    if (!node) return fail("NODE_NOT_FOUND", "node not found");
    let value: schema.NodeTrafficLimitData | null = null;
    if (input.bytesLimit !== null) {
      const network = node.metrics?.network;
      if (!network)
        return fail(
          "NODE_NETWORK_COUNTERS_REQUIRED",
          "upgrade the node to report exact network counters",
        );
      if (Date.now() - Date.parse(network.sampledAt) > 90_000)
        return fail("NODE_NETWORK_COUNTERS_STALE", "a fresh network counter sample is required");
      const names = [...new Set(input.interfaces)].sort();
      if (names.some((name) => !network.interfaces.some((n) => n.name === name)))
        return fail("NODE_NETWORK_INTERFACE_UNKNOWN", "select an interface reported by the node");
      const previous = node.trafficLimit;
      const same = previous && JSON.stringify(previous.interfaces) === JSON.stringify(names);
      if (previous && !same && !input.reset)
        return fail("NODE_NETWORK_RESET_REQUIRED", "reset usage when changing counted interfaces");
      value =
        same && !input.reset
          ? { ...previous, bytesLimit: input.bytesLimit }
          : {
              bytesLimit: input.bytesLimit,
              interfaces: names,
              bytesReceived: "0",
              bytesSent: "0",
              startedAt: new Date().toISOString(),
              reachedAt: null,
              measuredAt: network.sampledAt,
              baseline: network,
            };
      value.reachedAt =
        BigInt(value.bytesReceived) + BigInt(value.bytesSent) >= BigInt(value.bytesLimit)
          ? (value.reachedAt ?? new Date().toISOString())
          : null;
    }
    await tx.update(schema.node).set({ trafficLimit: value }).where(eq(schema.node.id, input.id));
    await recordAudit(tx, actor, {
      action: "node.traffic_limit_update",
      targetType: "node",
      targetId: node.id,
      targetName: node.name,
      metadata: { bytesLimit: input.bytesLimit, interfaces: input.interfaces, reset: input.reset },
    });
    if (value?.reachedAt) await enforceNodeTrafficLimit(tx, node);
  });
}

async function enforceNodeTrafficLimit(tx: Tx, node: { id: string; clusterId: string }) {
  const nodeId = node.id;
  await tx.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
  await skipNodeTasks(tx, nodeId);
  await discardNodeUpgrades(tx, nodeId);
  await publishClusterDns(tx, node.clusterId, "health");
}

/** A raw cumulative counter difference, never an integral of a sampled rate. */
export async function accountNodeTraffic(
  tx: Tx,
  nodeId: string,
  network: schema.NetworkCountersData | undefined,
) {
  if (!network) return;
  const [node] = await tx
    .select()
    .from(schema.node)
    .where(eq(schema.node.id, nodeId))
    .for("update");
  const limit = node?.trafficLimit;
  if (!limit || Date.parse(network.sampledAt) <= Date.parse(limit.measuredAt)) return;
  const sameBoot = limit.baseline.bootId === network.bootId;
  let received = BigInt(limit.bytesReceived),
    sent = BigInt(limit.bytesSent);
  for (const current of network.interfaces) {
    if (limit.interfaces.length && !limit.interfaces.includes(current.name)) continue;
    const previous = sameBoot
      ? limit.baseline.interfaces.find((n) => n.name === current.name)
      : undefined;
    const rx = BigInt(current.bytesReceived),
      txBytes = BigInt(current.bytesSent);
    const beforeRx = BigInt(previous?.bytesReceived ?? "0"),
      beforeTx = BigInt(previous?.bytesSent ?? "0");
    received += rx >= beforeRx ? rx - beforeRx : rx;
    sent += txBytes >= beforeTx ? txBytes - beforeTx : txBytes;
  }
  const reached = received + sent >= BigInt(limit.bytesLimit);
  const value = {
    ...limit,
    bytesReceived: received.toString(),
    bytesSent: sent.toString(),
    measuredAt: network.sampledAt,
    baseline: sameBoot
      ? {
          ...network,
          interfaces: [
            ...limit.baseline.interfaces.filter(
              (n) => !network.interfaces.some((current) => current.name === n.name),
            ),
            ...network.interfaces,
          ],
        }
      : network,
    reachedAt: limit.reachedAt ?? (reached ? new Date().toISOString() : null),
  };
  await tx.update(schema.node).set({ trafficLimit: value }).where(eq(schema.node.id, nodeId));
  if (reached && node.status === "active") {
    await enforceNodeTrafficLimit(tx, node);
    await recordAudit(tx, systemActor, {
      action: "node.traffic_limit_reached",
      targetType: "node",
      targetId: nodeId,
      targetName: node.name,
      metadata: {
        bytesLimit: limit.bytesLimit,
        bytesReceived: value.bytesReceived,
        bytesSent: value.bytesSent,
      },
    });
  }
}
