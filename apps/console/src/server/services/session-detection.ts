import type { SessionDetectionSettings } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { readSessionDetection } from "../lib/session-detection";
import type { Actor } from "./audit";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

export async function getSessionDetection(
  db: Database,
  id: string,
): Promise<SessionDetectionSettings> {
  return readSessionDetection((await findSite(db, id)).sessionDetection);
}

/**
 * Replaces a site's session detection and publishes its cluster (a hot
 * update on nodes; nothing new for nodes, e.g. rules changed while off,
 * creates no revision). Nodes without session-detection-v1 refuse it
 * (NODE_CAPABILITY_REQUIRED from the publish). Audited with the mode
 * before and after and the number of interstitial rules.
 */
export async function updateSessionDetection(
  db: Database,
  input: SessionDetectionSettings & { id: string },
  ctx: { actor: Actor },
): Promise<SessionDetectionSettings> {
  const { id, ...settings } = input;
  return db.transaction(async (tx) => {
    const site = await findSite(tx, id, true);
    const before = readSessionDetection(site.sessionDetection);
    await tx
      .update(schema.site)
      .set({ sessionDetection: settings, updatedAt: new Date() })
      .where(eq(schema.site.id, site.id));
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_updated",
      action: "site.session_detection_update",
      metadata: {
        modeBefore: before.mode,
        mode: settings.mode,
        interstitial: settings.interstitial,
        interstitialRules: settings.interstitialRules.length,
      },
    });
    return settings;
  });
}
