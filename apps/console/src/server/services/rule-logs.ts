import {
  type AnalyticsRange,
  type LoggedRules,
  nodeSupportsFeature,
  RULE_LOG_FEATURE,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, sql } from "drizzle-orm";
import { rangeWindow, sourceFor } from "./analytics";
import { findSite } from "./sites";

/**
 * Most-matched log rules of a site over a range, from the nodes' bounded per-minute counters
 * (MinuteStats.logged_rules), with the rules' current names: the site's own rules and platform
 * rules; a rule deleted since has no name. `unsupportedNodes` counts the active nodes of the
 * site's cluster that do not count matches (no rule-log-v1).
 */
export async function topLoggedRules(
  db: Database,
  query: { id: string; range: AnalyticsRange; limit: number },
  now = Date.now(),
): Promise<LoggedRules> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const rule = schema.edgeRule;
  const result = await db.execute<{
    rule: string;
    requests: string | number;
    name: string | null;
    platform: boolean;
  }>(sql`
    select counts.rule, counts.requests, ${rule.name} as name,
      (${rule.id} is not null and ${rule.siteId} is null) as platform
    from (
      select entry.key as rule, sum(entry.value::bigint)::bigint as requests
      from ${stats} cross join lateral jsonb_each_text(${stats.loggedRules}) entry
      where ${stats.siteId} = ${query.id}::uuid
        and ${stats.minute} >= ${window.from.toISOString()}::timestamptz
        and ${stats.minute} < ${window.end.toISOString()}::timestamptz
        and entry.key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      group by entry.key order by requests desc, entry.key limit ${query.limit}
    ) counts
    left join ${rule} on ${rule.id} = counts.rule::uuid
      and (${rule.siteId} = ${query.id}::uuid or ${rule.siteId} is null)
    order by counts.requests desc, counts.rule`);
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    approximate: true,
    items: result.rows.map((row) => ({
      ruleId: row.rule,
      name: row.name,
      platform: row.platform === true,
      requests: Number(row.requests),
    })),
    unsupportedNodes: nodes.filter((node) => !nodeSupportsFeature(node.features, RULE_LOG_FEATURE))
      .length,
  };
}
