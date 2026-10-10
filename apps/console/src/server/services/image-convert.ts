import { IMAGE_CONVERT_FEATURE } from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  type ImageConvertSettings,
  type ImageSavings,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, sql } from "drizzle-orm";
import { readImageConvert } from "../lib/image-convert";
import { rangeWindow, sourceFor } from "./analytics";
import { type Actor, recordAudit } from "./audit";
import { publishRevision } from "./revisions";
import { findSite } from "./sites";

export async function getImageConvert(db: Database, id: string): Promise<ImageConvertSettings> {
  return readImageConvert((await findSite(db, id)).imageConvert);
}

/**
 * Replaces a site's settings and publishes its cluster (a hot update on
 * nodes; a configuration that does not change for nodes, e.g. while off,
 * creates no revision). Audited with the names of the changed settings.
 */
export async function updateImageConvert(
  db: Database,
  input: ImageConvertSettings & { id: string },
  ctx: { actor: Actor },
): Promise<ImageConvertSettings> {
  const { id, ...settings } = input;
  return db.transaction(async (tx) => {
    const site = await findSite(tx, id, true);
    const before = readImageConvert(site.imageConvert);
    const changed = (Object.keys(settings) as (keyof ImageConvertSettings)[]).filter(
      (key) => settings[key] !== before[key],
    );
    await tx
      .update(schema.site)
      .set({ imageConvert: settings, updatedAt: new Date() })
      .where(eq(schema.site.id, site.id));
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_updated", params: { site: site.name } },
      actor: ctx.actor,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.image_convert_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { changed, enabled: settings.enabled },
    });
    return settings;
  });
}

/**
 * Bytes WebP / AVIF responses of the site saved over a range
 * (MinuteStats.image_bytes_saved); `unsupportedNodes` counts the active
 * nodes of the site's cluster that do not convert (no image-convert-v1).
 */
export async function imageSavings(
  db: Database,
  query: { id: string; range: AnalyticsRange },
  now = Date.now(),
): Promise<ImageSavings> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${stats.imageBytesSaved}), 0)::bigint`.mapWith(Number),
    })
    .from(stats)
    .where(
      and(
        eq(stats.siteId, site.id),
        sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
        sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
      ),
    );
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    bytesSaved: row?.bytes ?? 0,
    unsupportedNodes: nodes.filter(
      (node) => !nodeSupportsFeature(node.features, IMAGE_CONVERT_FEATURE),
    ).length,
  };
}
