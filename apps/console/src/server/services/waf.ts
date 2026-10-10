import {
  ACCESS_AUTH_FEATURE,
  ACCESS_CONTROL_FEATURE,
  ACCESS_LOGS_V2_FEATURE,
  ACTIVE_HEALTH_FEATURE,
  BROTLI_FEATURE,
  CHALLENGE_V2_FEATURE,
  CLIENT_CERT_FEATURE,
  ERROR_PAGES_FEATURE,
  IMAGE_CONVERT_FEATURE,
  MODSECURITY_FEATURE,
  MULTI_CERTIFICATE_FEATURE,
  ORIGIN_HTTP2_FEATURE,
  RULES_BODY_FEATURE,
  RULES_V2_FEATURE,
  RULES_V3_FEATURE,
  SESSION_AFFINITY_FEATURE,
  SITE_CONTENT_FEATURE,
  type SiteWafModel,
  WAF_V2_FEATURE,
  ZSTD_FEATURE,
} from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  CLIENT_IP_FEATURE,
  CRS_EVALUATION_FILES,
  crsDetectionRule,
  DOMAINS_V2_FEATURE,
  EDGE_PORTS_FEATURE,
  type FeatureAvailability,
  nodeSupportsFeature,
  PREFETCH_V2_FEATURE,
  PURGE_TAG_FEATURE,
  type SiteFeatures,
  type SiteWaf,
  type SiteWafUpdateInput,
  WAF_DEFAULTS,
  type WafExclusion,
  type WafMode,
  type WafTopRules,
  wafExclusion,
  wafMode,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { rangeWindow, sourceFor } from "./analytics";
import { type Actor, recordAudit } from "./audit";
import { type Executor, publishRevision } from "./revisions";
import { findSite } from "./sites";

type WafRow = typeof schema.siteWaf.$inferSelect;

/** The stored exclusions that are valid (the contract's shape, rule ids and targets sorted). */
function readExclusions(value: unknown): WafExclusion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = wafExclusion.safeParse(entry);
    return parsed.success ? [normalizeExclusion(parsed.data)] : [];
  });
}

/** An exclusion as stored: rule ids ascending, targets sorted, exact only with a path. */
function normalizeExclusion(e: WafExclusion): WafExclusion {
  return {
    path: e.path,
    exact: e.path !== "" && e.exact,
    ruleIds: [...new Set(e.ruleIds)].sort((a, b) => a - b),
    targets: [...new Set(e.targets)].sort(),
  };
}

function toDto(siteId: string, row: WafRow | undefined): SiteWaf {
  const mode = wafMode.safeParse(row?.mode);
  return {
    siteId,
    mode: mode.success ? mode.data : WAF_DEFAULTS.mode,
    paranoiaLevel: row?.paranoiaLevel ?? WAF_DEFAULTS.paranoiaLevel,
    anomalyThreshold: row?.anomalyThreshold ?? WAF_DEFAULTS.anomalyThreshold,
    exclusions: readExclusions(row?.exclusions),
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
                exclusions: readExclusions(row.exclusions),
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

export async function getSiteWaf(db: Database, siteId: string): Promise<SiteWaf> {
  await findSite(db, siteId);
  return toDto(siteId, await wafRow(db, siteId));
}

/**
 * Changes the fields given, publishes the site's cluster and audits the
 * change. Turning it on where active nodes lack modsecurity-v1 holds the
 * cluster's configuration until they are upgraded (see siteFeatures).
 */
export async function updateSiteWaf(
  db: Database,
  input: SiteWafUpdateInput,
  ctx: { actor: Actor },
): Promise<SiteWaf> {
  return db.transaction(async (tx) => {
    const refused = [...new Set((input.exclusions ?? []).flatMap((e) => e.ruleIds))].filter(
      (id) => !crsDetectionRule(id),
    );
    if (refused.length)
      fail("WAF_RULE_NOT_EXCLUDABLE", "CRS setup and evaluation rules cannot be excluded", {
        ids: refused.slice(0, 5).join(", "),
      });
    const site = await findSite(tx, input.id, true);
    const row = await wafRow(tx, site.id, true);
    const before = toDto(site.id, row);
    const next: { mode: WafMode } & Omit<SiteWaf, "siteId" | "updatedAt" | "mode"> = {
      mode: input.mode ?? before.mode,
      paranoiaLevel: input.paranoiaLevel ?? before.paranoiaLevel,
      anomalyThreshold: input.anomalyThreshold ?? before.anomalyThreshold,
      exclusions: (input.exclusions ?? before.exclusions).map(normalizeExclusion),
      requestBodyLimit: input.requestBodyLimit ?? before.requestBodyLimit,
    };
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
      actor: ctx.actor,
    });
    const after = toDto(site.id, saved);
    const strip = ({ siteId: _s, updatedAt: _u, ...rest }: SiteWaf) => rest;
    await recordAudit(tx, ctx.actor, {
      action: "site.waf_update",
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
 * (which also needs challenge-v1 for its keys), HTTP/2 and gRPC towards the
 * origins, error pages and the rule engine extensions (rules-v2, rules-v3)
 * can be turned on for a site now: every active
 * node of its cluster must report the feature (it may still be required
 * through the API, as with other features). purgeByTag and prefetchVariants
 * tell whether the cluster's nodes run host and tag purges, and mobile and
 * sitemap prefetches; nobody can create those tasks otherwise.
 */
export async function siteFeatures(db: Database, siteId: string): Promise<SiteFeatures> {
  const site = await findSite(db, siteId);
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
    crs: byNodes(MODSECURITY_FEATURE),
    activeHealthCheck: byNodes(ACTIVE_HEALTH_FEATURE),
    sessionAffinity: byNodes(SESSION_AFFINITY_FEATURE, "challenge-v1"),
    originHttp2: byNodes(ORIGIN_HTTP2_FEATURE),
    errorPages: byNodes(ERROR_PAGES_FEATURE),
    purgeByTag: byNodes(PURGE_TAG_FEATURE),
    prefetchVariants: byNodes(PREFETCH_V2_FEATURE),
    rulesV2: byNodes(RULES_V2_FEATURE),
    rulesV3: byNodes(RULES_V3_FEATURE),
    edgePorts: byNodes(EDGE_PORTS_FEATURE),
    clientIp: byNodes(CLIENT_IP_FEATURE),
    siteContent: byNodes(SITE_CONTENT_FEATURE),
    domainsV2: byNodes(DOMAINS_V2_FEATURE),
    multiCertificate: byNodes(MULTI_CERTIFICATE_FEATURE),
    clientCertificate: byNodes(CLIENT_CERT_FEATURE),
    accessAuth: byNodes(ACCESS_AUTH_FEATURE),
    accessControl: byNodes(ACCESS_CONTROL_FEATURE),
    wafV2: byNodes(WAF_V2_FEATURE),
    rulesBody: byNodes(RULES_BODY_FEATURE),
    challengeV2: byNodes(CHALLENGE_V2_FEATURE),
    accessLogsV2: byNodes(ACCESS_LOGS_V2_FEATURE),
    imageConvert: byNodes(IMAGE_CONVERT_FEATURE),
  };
}

/**
 * Most-matched CRS detection rules of a site over a range, from the nodes'
 * bounded per-minute counters; setup and evaluation rules (949110 matches
 * every blocked request) are left out.
 */
export async function topWafRules(
  db: Database,
  query: { id: string; range: AnalyticsRange; limit: number },
  now = Date.now(),
): Promise<WafTopRules> {
  await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const result = await db.execute<{ rule: string; requests: string | number }>(sql`
    select entry.key as rule, sum(entry.value::bigint)::bigint as requests
    from ${stats} cross join lateral jsonb_each_text(${stats.wafRules}) entry
    where ${stats.siteId} = ${query.id}::uuid
      and ${stats.minute} >= ${window.from.toISOString()}::timestamptz
      and ${stats.minute} < ${window.end.toISOString()}::timestamptz
      and entry.key ~ '^[1-9][0-9]{0,9}$'
      and entry.key::bigint / 1000 not in (${sql.raw(CRS_EVALUATION_FILES.join(", "))})
    group by entry.key order by requests desc, entry.key::bigint limit ${query.limit}`);
  return {
    approximate: true,
    items: result.rows.map((row) => ({ ruleId: Number(row.rule), requests: Number(row.requests) })),
  };
}
