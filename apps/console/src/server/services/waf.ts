import {
  ACTIVE_HEALTH_FEATURE,
  BROTLI_FEATURE,
  ERROR_PAGES_FEATURE,
  MODSECURITY_FEATURE,
  SESSION_AFFINITY_FEATURE,
  type SiteWafModel,
  ZSTD_FEATURE,
} from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  type FeatureAvailability,
  nodeSupportsFeature,
  PREFETCH_V2_FEATURE,
  PURGE_TAG_FEATURE,
  type SiteFeatures,
  type SiteWaf,
  type SiteWafUpdateInput,
  WAF_DEFAULTS,
  WAF_SETTINGS_DEFAULTS,
  type WafMode,
  type WafSettings,
  type WafTopRules,
  wafMode,
  wafSettings,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { rangeWindow, sourceFor } from "./analytics";
import { type Actor, recordAudit } from "./audit";
import { publisher, readSetting, writeSetting } from "./protection";
import { type Executor, publishRevision } from "./revisions";
import { findSite, type SiteScope } from "./sites";

/** system_setting key of the platform CRS policy (`WafSettings`). */
export const WAF_SETTINGS_KEY = "waf_settings";

type WafRow = typeof schema.siteWaf.$inferSelect;

export async function getWafSettings(db: Executor): Promise<WafSettings> {
  const parsed = wafSettings.safeParse({
    ...WAF_SETTINGS_DEFAULTS,
    ...((await readSetting(db, WAF_SETTINGS_KEY)) ?? {}),
  });
  return parsed.success ? parsed.data : WAF_SETTINGS_DEFAULTS;
}

/**
 * Saves the platform CRS policy. Nothing is published: sites that already
 * run CRS keep it, and tenants can then only turn it off.
 */
export async function setWafSettings(
  db: Database,
  input: WafSettings,
  actor: Actor,
): Promise<WafSettings> {
  return db.transaction(async (tx) => {
    const before = await getWafSettings(tx);
    await writeSetting(tx, WAF_SETTINGS_KEY, input);
    await recordAudit(tx, actor, {
      action: "system.waf_update",
      targetType: "system_setting",
      targetId: WAF_SETTINGS_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
}

function toDto(siteId: string, row: WafRow | undefined): SiteWaf {
  const mode = wafMode.safeParse(row?.mode);
  return {
    siteId,
    mode: mode.success ? mode.data : WAF_DEFAULTS.mode,
    paranoiaLevel: row?.paranoiaLevel ?? WAF_DEFAULTS.paranoiaLevel,
    anomalyThreshold: row?.anomalyThreshold ?? WAF_DEFAULTS.anomalyThreshold,
    excludedRuleIds: row?.excludedRuleIds ?? [],
    requestBodyLimit: row?.requestBodyLimit ?? WAF_DEFAULTS.requestBodyLimit,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Compiler models of the sites that run CRS (sites without a row or turned off are absent). */
export async function loadSiteWafModels(
  db: Executor,
  siteIds: string[],
): Promise<Map<string, SiteWafModel>> {
  const rows = siteIds.length
    ? await db
        .select()
        .from(schema.siteWaf)
        .where(and(inArray(schema.siteWaf.siteId, siteIds), ne(schema.siteWaf.mode, "off")))
    : [];
  return new Map(
    rows.flatMap((row): [string, SiteWafModel][] =>
      row.mode === "detect" || row.mode === "block"
        ? [
            [
              row.siteId,
              {
                mode: row.mode,
                paranoiaLevel: row.paranoiaLevel,
                anomalyThreshold: row.anomalyThreshold,
                excludedRuleIds: row.excludedRuleIds,
                requestBodyLimit: row.requestBodyLimit,
              },
            ],
          ]
        : [],
    ),
  );
}

async function wafRow(db: Executor, siteId: string, lock = false) {
  const query = db.select().from(schema.siteWaf).where(eq(schema.siteWaf.siteId, siteId));
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

export async function getSiteWaf(db: Database, siteId: string, scope: SiteScope): Promise<SiteWaf> {
  await findSite(db, siteId, scope);
  return toDto(siteId, await wafRow(db, siteId));
}

/**
 * Changes the fields given (organization owners and admins), publishes the
 * site's cluster and audits the change. While the platform does not let
 * tenants use CRS, tenants can only turn it off (WAF_CRS_FORBIDDEN).
 * Turning it on where active nodes lack modsecurity-v1 fails with
 * NODE_CAPABILITY_REQUIRED unless an administrator does it.
 */
export async function updateSiteWaf(
  db: Database,
  input: SiteWafUpdateInput,
  ctx: { scope: SiteScope; actor: Actor; isAdmin: boolean },
): Promise<SiteWaf> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, ctx.scope, true);
    const row = await wafRow(tx, site.id, true);
    const before = toDto(site.id, row);
    const next: { mode: WafMode } & Omit<SiteWaf, "siteId" | "updatedAt" | "mode"> = {
      mode: input.mode ?? before.mode,
      paranoiaLevel: input.paranoiaLevel ?? before.paranoiaLevel,
      anomalyThreshold: input.anomalyThreshold ?? before.anomalyThreshold,
      excludedRuleIds: [...(input.excludedRuleIds ?? before.excludedRuleIds)].sort((a, b) => a - b),
      requestBodyLimit: input.requestBodyLimit ?? before.requestBodyLimit,
    };
    if (next.mode !== "off" && !ctx.isAdmin && !(await getWafSettings(tx)).tenantCrs)
      fail("WAF_CRS_FORBIDDEN", "the platform does not allow tenants to turn on OWASP CRS");
    const [saved] = await tx
      .insert(schema.siteWaf)
      .values({ siteId: site.id, ...next })
      .onConflictDoUpdate({
        target: schema.siteWaf.siteId,
        set: { ...next, updatedAt: new Date() },
      })
      .returning();
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_waf_updated", params: { site: site.name } },
      userId: publisher(ctx.actor),
    });
    const after = toDto(site.id, saved);
    const strip = ({ siteId: _s, updatedAt: _u, ...rest }: SiteWaf) => rest;
    await recordAudit(tx, ctx.actor, {
      action: "site.waf_update",
      organizationId: site.organizationId,
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { from: strip(before), to: strip(after) },
    });
    return after;
  });
}

const AVAILABLE: FeatureAvailability = { available: true, reason: null };

/**
 * Whether Brotli, Zstandard, CRS, active health checks, session affinity
 * (which also needs challenge-v1 for its keys) and error pages can be turned
 * on for a site now: every active node of its cluster must report the
 * feature (administrators may still require it through the API, as with
 * other features), and CRS must be allowed for tenants unless the caller is
 * an administrator. purgeByTag and prefetchVariants tell whether the
 * cluster's nodes run host and tag purges, and mobile and sitemap
 * prefetches; nobody can create those tasks otherwise.
 */
export async function siteFeatures(
  db: Database,
  siteId: string,
  ctx: { scope: SiteScope; isAdmin: boolean },
): Promise<SiteFeatures> {
  const site = await findSite(db, siteId, ctx.scope);
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  const byNodes = (...features: string[]): FeatureAvailability =>
    nodes.every((node) => features.every((feature) => nodeSupportsFeature(node.features, feature)))
      ? AVAILABLE
      : { available: false, reason: "nodes" };
  return {
    brotli: byNodes(BROTLI_FEATURE),
    zstd: byNodes(ZSTD_FEATURE),
    crs:
      !ctx.isAdmin && !(await getWafSettings(db)).tenantCrs
        ? { available: false, reason: "platform" }
        : byNodes(MODSECURITY_FEATURE),
    activeHealthCheck: byNodes(ACTIVE_HEALTH_FEATURE),
    sessionAffinity: byNodes(SESSION_AFFINITY_FEATURE, "challenge-v1"),
    errorPages: byNodes(ERROR_PAGES_FEATURE),
    purgeByTag: byNodes(PURGE_TAG_FEATURE),
    prefetchVariants: byNodes(PREFETCH_V2_FEATURE),
  };
}

/** Most-matched CRS rules of a site over a range, from the nodes' bounded per-minute counters. */
export async function topWafRules(
  db: Database,
  scope: SiteScope,
  query: { id: string; range: AnalyticsRange; limit: number },
  now = Date.now(),
): Promise<WafTopRules> {
  await findSite(db, query.id, scope);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const result = await db.execute<{ rule: string; requests: string | number }>(sql`
    select entry.key as rule, sum(entry.value::bigint)::bigint as requests
    from ${stats} cross join lateral jsonb_each_text(${stats.wafRules}) entry
    where ${stats.siteId} = ${query.id}::uuid
      and ${stats.minute} >= ${window.from.toISOString()}::timestamptz
      and ${stats.minute} < ${window.end.toISOString()}::timestamptz
      and entry.key ~ '^[1-9][0-9]{0,9}$'
    group by entry.key order by requests desc, entry.key::bigint limit ${query.limit}`);
  return {
    approximate: true,
    items: result.rows.map((row) => ({ ruleId: Number(row.rule), requests: Number(row.requests) })),
  };
}
