import { forbiddenOriginRange, type OriginAllowList } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { loadOriginAllowList, ORIGIN_ALLOW_LIST_KEY } from "./config-input";
import { type Executor, publishClusters } from "./revisions";

export async function getOriginAllowList(db: Executor): Promise<OriginAllowList> {
  return { cidrs: await loadOriginAllowList(db) };
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
  await db.transaction(async (tx) => {
    const before = await loadOriginAllowList(tx);
    const value = { cidrs };
    await tx
      .insert(schema.systemSetting)
      .values({ key: ORIGIN_ALLOW_LIST_KEY, value })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
    const clusters = await tx
      .select({ id: schema.cluster.id, name: schema.cluster.name })
      .from(schema.cluster);
    const published = await publishClusters(
      tx,
      clusters.map((c) => c.id),
      {
        reason: { code: "origin_allow_list_updated", params: {} },
        actor,
      },
    );
    const revisions: Record<string, number> = {};
    for (const cluster of clusters)
      revisions[cluster.name] = published.get(cluster.id)?.row.revision ?? 0;
    await recordAudit(tx, actor, {
      action: "system.origin_allow_list_update",
      targetType: "system_setting",
      targetId: ORIGIN_ALLOW_LIST_KEY,
      targetName: ORIGIN_ALLOW_LIST_KEY,
      metadata: {
        cidrs,
        added: cidrs.filter((c) => !before.includes(c)),
        removed: before.filter((c) => !cidrs.includes(c)),
        revisions,
      },
    });
  });
  return getOriginAllowList(db);
}
