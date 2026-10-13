import { forbiddenOriginRange, normalizeCidr, type OriginAllowList } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import * as z from "zod";
import { fail } from "../lib/errors";
import type { Actor } from "./audit";
import { type Executor, publishClusters } from "./revisions";
import { defineSetting } from "./settings";

/** system_setting key of the platform's origin allow list: `{ cidrs: string[] }`. */
const ORIGIN_ALLOW_LIST_KEY = "origin_allow_list";

/** Normalized, sorted, without duplicates; entries that are no CIDR are left out. */
function normalizeCidrs(stored: unknown): string[] {
  const cidrs = Array.isArray(stored) ? stored : [];
  const normalized = cidrs.flatMap((c) => {
    const n = typeof c === "string" ? normalizeCidr(c) : null;
    return n ? [n] : [];
  });
  return [...new Set(normalized)].sort();
}

/**
 * Read entry by entry: a stored entry that is no CIDR is left out instead of the whole list.
 * Input is normalized by the contract already.
 */
const originAllowListSetting = defineSetting({
  key: ORIGIN_ALLOW_LIST_KEY,
  schema: z.object({ cidrs: z.unknown().transform(normalizeCidrs) }),
  defaults: { cidrs: [] },
  auditAction: "system.origin_allow_list_update",
  targetName: ORIGIN_ALLOW_LIST_KEY,
});

export const getOriginAllowList = originAllowListSetting.read;

/**
 * The special-purpose CIDRs origins may use anyway (normalized, sorted,
 * without duplicates). Every cluster's NodeConfig carries it.
 */
export async function loadOriginAllowList(db: Executor): Promise<string[]> {
  return (await getOriginAllowList(db)).cidrs;
}

/**
 * Refuses origins whose address is a special-purpose IP literal outside the
 * platform allow list, or a localhost name (N-H2). Host names are checked by
 * the nodes on every DNS answer.
 */
export async function assertOriginsAllowed(
  db: Executor,
  origins: readonly { address: string }[],
): Promise<void> {
  const allowed = await loadOriginAllowList(db);
  for (const { address } of origins) {
    const range = forbiddenOriginRange(address, allowed);
    if (range) {
      fail(
        "ORIGIN_ADDRESS_FORBIDDEN",
        `origin address ${address} is in the special-purpose range ${range}, which the platform does not allow`,
        { address, range },
      );
    }
  }
}

/**
 * Replaces the platform's origin allow list (already normalized by the
 * contract) and publishes a new revision for every cluster, all in one
 * transaction with the audit entry.
 */
export async function setOriginAllowList(
  db: Database,
  input: { cidrs: string[] },
  actor: Actor,
): Promise<OriginAllowList> {
  const cidrs = [...new Set(input.cidrs)].sort();
  return db.transaction((tx) =>
    originAllowListSetting.write(
      tx,
      actor,
      { cidrs },
      {
        afterWrite: async () => {
          const clusters = await tx
            .select({ id: schema.cluster.id, name: schema.cluster.name })
            .from(schema.cluster);
          const published = await publishClusters(
            tx,
            clusters.map((c) => c.id),
            { reason: { code: "origin_allow_list_updated", params: {} }, actor },
          );
          const revisions: Record<string, number> = {};
          for (const cluster of clusters)
            revisions[cluster.name] = published.get(cluster.id)?.row.revision ?? 0;
          return { revisions };
        },
        metadata: (before) => ({
          cidrs,
          added: cidrs.filter((c) => !before.cidrs.includes(c)),
          removed: before.cidrs.filter((c) => !cidrs.includes(c)),
        }),
      },
    ),
  );
}
