import { MARKDOWN_FEATURE } from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  type MarkdownSettings,
  type MarkdownStats,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, sql } from "drizzle-orm";
import { readMarkdown } from "../lib/markdown";
import { rangeWindow, sourceFor } from "./analytics";
import type { Actor } from "./audit";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

export async function getMarkdown(db: Database, id: string): Promise<MarkdownSettings> {
  return readMarkdown((await findSite(db, id)).markdown);
}

/**
 * Replaces a site's settings (prefixes stored sorted and unique) and
 * publishes its cluster (a hot update on nodes; no revision while the
 * configuration nodes see stays the same). Audited with the names of the
 * changed settings.
 */
export async function updateMarkdown(
  db: Database,
  input: MarkdownSettings & { id: string },
  ctx: { actor: Actor },
): Promise<MarkdownSettings> {
  const { id, ...rest } = input;
  const settings = readMarkdown(rest);
  return db.transaction(async (tx) => {
    const site = await findSite(tx, id, true);
    const before = readMarkdown(site.markdown);
    const changed = (Object.keys(settings) as (keyof MarkdownSettings)[]).filter(
      (key) => JSON.stringify(settings[key]) !== JSON.stringify(before[key]),
    );
    await tx
      .update(schema.site)
      .set({ markdown: settings, updatedAt: new Date() })
      .where(eq(schema.site.id, site.id));
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_updated",
      action: "site.markdown_update",
      metadata: { changed, enabled: settings.enabled },
    });
    return settings;
  });
}

/**
 * Markdown responses of the site over a range
 * (MinuteStats.markdown_responses); `unsupportedNodes` counts the active
 * nodes of the site's cluster that do not convert (no markdown-v1).
 */
export async function markdownStats(
  db: Database,
  query: { id: string; range: AnalyticsRange },
  now = Date.now(),
): Promise<MarkdownStats> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const [row] = await db
    .select({
      responses: sql<number>`coalesce(sum(${stats.markdownResponses}), 0)::bigint`.mapWith(Number),
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
    responses: row?.responses ?? 0,
    unsupportedNodes: nodes.filter((node) => !nodeSupportsFeature(node.features, MARKDOWN_FEATURE))
      .length,
  };
}
