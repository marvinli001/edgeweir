import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { lockRecompile } from "../lib/locks";
import { recordAudit, systemActor } from "./audit";
import { publishRevision } from "./revisions";

/**
 * Changes whenever an upgrade changes what stored data compiles to (a
 * migration that releases routes, say): every cluster then gets a fresh
 * revision once, instead of waiting for its next change.
 */
export const RECOMPILE_MARKER = "single-operator";
const RECOMPILE_KEY = "config_recompiled";

/** Publishes every cluster once per marker; a cluster that fails keeps its revision. */
export async function recompileAfterUpgrade(app: AppContext) {
  await app.db.transaction(async (tx) => {
    await lockRecompile(tx);
    const [done] = await tx
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, RECOMPILE_KEY));
    if (done?.value.marker === RECOMPILE_MARKER) return;
    const clusters = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .orderBy(schema.cluster.id);
    let failed = 0;
    for (const cluster of clusters) {
      try {
        await tx.transaction((inner) =>
          publishRevision(inner, {
            clusterId: cluster.id,
            reason: { code: "recompiled", params: {} },
          }),
        );
      } catch (error) {
        failed++;
        app.log.warn("recompile after upgrade failed", { clusterId: cluster.id, error });
      }
    }
    const value = { marker: RECOMPILE_MARKER };
    await tx
      .insert(schema.systemSetting)
      .values({ key: RECOMPILE_KEY, value })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
    await recordAudit(tx, systemActor, {
      action: "system.recompile",
      targetType: "system",
      metadata: { marker: RECOMPILE_MARKER, clusters: clusters.length, failed },
    });
  });
}
