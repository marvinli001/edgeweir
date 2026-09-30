import type { PlatformAlertKind } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import type { Executor } from "./revisions";

/** alert_state key of a platform alert (no site). */
export const platformAlertKey = (kind: PlatformAlertKind, resourceId: string) =>
  `${kind}/platform/${resourceId}`;

/**
 * Fires a platform alert (cluster or DNS) once: a firing event for platform
 * channels, unless the same alert is already firing. `name` is shown where
 * site alerts show the site name.
 */
export async function raisePlatformAlert(
  tx: Executor,
  kind: PlatformAlertKind,
  resourceId: string,
  name: string,
  now = new Date(),
) {
  const key = platformAlertKey(kind, resourceId);
  const [state] = await tx.select().from(schema.alertState).where(eq(schema.alertState.key, key));
  if (state?.active) return false;
  await tx
    .insert(schema.alertState)
    .values({ key, siteId: null, kind, resourceId, active: true, updatedAt: now })
    .onConflictDoUpdate({ target: schema.alertState.key, set: { active: true, updatedAt: now } });
  await tx.insert(schema.alertEvent).values({
    siteId: null,
    kind,
    resourceId,
    status: "firing",
    payload: { siteName: name, domain: "" },
    occurredAt: now,
  });
  return true;
}

/** Resolves a firing platform alert (a resolved event); nothing when it is not firing. */
export async function resolvePlatformAlert(
  tx: Executor,
  kind: PlatformAlertKind,
  resourceId: string,
  name: string,
  now = new Date(),
) {
  const key = platformAlertKey(kind, resourceId);
  const [state] = await tx
    .select()
    .from(schema.alertState)
    .where(and(eq(schema.alertState.key, key), eq(schema.alertState.active, true)));
  if (!state) return false;
  await tx
    .update(schema.alertState)
    .set({ active: false, updatedAt: now })
    .where(eq(schema.alertState.key, key));
  await tx.insert(schema.alertEvent).values({
    siteId: null,
    kind,
    resourceId,
    status: "resolved",
    payload: { siteName: name, domain: "" },
    occurredAt: now,
  });
  return true;
}
