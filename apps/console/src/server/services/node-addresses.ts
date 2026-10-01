import { forbiddenOriginRange, formatIp, parseIp, unicastAddress } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "./revisions";

type NodeIpRow = typeof schema.nodeIp.$inferSelect;

/** An address DNS and probes use for a node, with its level (0 primary, 1-2 backups). */
export interface SchedulingAddress {
  address: string;
  level: number;
  source: "reported" | "configured";
}

/** Highest scheduling level (backup 2). */
export const MAX_ADDRESS_LEVEL = 2;
/** Configured scheduling addresses per node. */
export const MAX_CONFIGURED_ADDRESSES = 8;

/**
 * A node's scheduling addresses from its node_ip rows: the configured ones
 * (the operator's explicit choice, any unicast address including private
 * ranges) when there are any, otherwise the public addresses the node
 * reports, all at level 0.
 */
export function schedulingAddressesOf(rows: readonly NodeIpRow[]): SchedulingAddress[] {
  const configured = rows.filter((r) => r.source === "configured");
  const picked = configured.length
    ? configured.flatMap((r) => {
        const address = unicastAddress(r.address);
        return address
          ? [
              {
                address,
                level: Math.min(Math.max(r.level, 0), MAX_ADDRESS_LEVEL),
                source: "configured" as const,
              },
            ]
          : [];
      })
    : rows
        .filter((r) => r.source !== "configured" && forbiddenOriginRange(r.address, []) === null)
        .flatMap((r) => {
          const ip = parseIp(r.address);
          return ip ? [{ address: formatIp(ip), level: 0, source: "reported" as const }] : [];
        });
  const seen = new Set<string>();
  return picked
    .filter((a) => !seen.has(a.address) && seen.add(a.address))
    .sort(
      (a, b) => a.level - b.level || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
}

/**
 * The addresses a node answers with: the reachable addresses (not down by
 * the probes) of its lowest level that has any, or of the lowest such level
 * at or above `forcedLevel` (a backup_ip scheduling action) when there is
 * one. When every address is down the node answers with none: its lines
 * fall back to their backup groups or to the mass removal protection.
 */
export function effectiveAddresses(
  addresses: readonly SchedulingAddress[],
  down: ReadonlySet<string>,
  forcedLevel = 0,
): { level: number; addresses: string[] } {
  const levels = [...new Set(addresses.map((a) => a.level))].sort((a, b) => a - b);
  const reachableAt = (level: number) =>
    addresses.filter((a) => a.level === level && !down.has(a.address)).map((a) => a.address);
  const auto = levels.find((level) => reachableAt(level).length > 0);
  if (auto === undefined) return { level: levels[0] ?? 0, addresses: [] };
  // A backup level that cannot be reached is not forced on the node.
  const level =
    levels.find((l) => l >= Math.max(auto, forcedLevel) && reachableAt(l).length > 0) ?? auto;
  return { level, addresses: reachableAt(level) };
}

/** node_ip rows of the nodes, by node id. */
export async function nodeIpRows(db: Executor, nodeIds: readonly string[]) {
  const rows = nodeIds.length
    ? await db
        .select()
        .from(schema.nodeIp)
        .where(inArray(schema.nodeIp.nodeId, [...nodeIds]))
    : [];
  const byNode = new Map<string, NodeIpRow[]>();
  for (const row of rows) byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  return byNode;
}

/** Addresses the probes count as down, by node id. */
export async function downAddresses(db: Executor, nodeIds: readonly string[]) {
  const rows = nodeIds.length
    ? await db
        .select({
          nodeId: schema.nodeAddressState.nodeId,
          address: schema.nodeAddressState.address,
        })
        .from(schema.nodeAddressState)
        .where(
          and(
            inArray(schema.nodeAddressState.nodeId, [...nodeIds]),
            eq(schema.nodeAddressState.down, true),
          ),
        )
    : [];
  const byNode = new Map<string, Set<string>>();
  for (const row of rows)
    byNode.set(row.nodeId, (byNode.get(row.nodeId) ?? new Set()).add(row.address));
  return byNode;
}
