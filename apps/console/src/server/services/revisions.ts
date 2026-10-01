import { clone, create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  ACTIVE_HEALTH_FEATURE,
  BROTLI_FEATURE,
  ConfigCapacityError,
  canonicalize,
  compileNodeConfig,
  compileOfflineHosts,
  compilePlatformErrorPages,
  compileRules,
  configExpressions,
  contentHash,
  DEFAULT_SITE_PROTECTION,
  decodeNodeConfig,
  ERROR_PAGES_FEATURE,
  encodeNodeConfig,
  geoFeatures,
  MAX_SITES_PER_CLUSTER,
  MODSECURITY_FEATURE,
  moduleFeatures,
  nodeRequirements,
  type OfflineHostModel,
  poolAndPageFeatures,
  protectionFeatures,
  RULES_V2_FEATURE,
  type RuleModel,
  rulesFeatures,
  SESSION_AFFINITY_FEATURE,
  type SiteModel,
  usesChallengeKeys,
  ZSTD_FEATURE,
} from "@edgeweir/config-compiler";
import {
  nodeSupportsFeature,
  normalizeCidr,
  type ReasonParams,
  type Revision,
  type RevisionReasonCode,
  reasonText,
  ruleAction,
  tlsSettings,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  CertificateRefSchema,
  ChallengeKeyRefSchema,
  HttpChallengeSchema,
  IpListSchema,
  type NodeConfig,
  NodeConfigSchema,
  PlatformProtectionSchema,
  type RuleExpression,
  SiteProtectionSchema,
} from "@edgeweir/proto";
import {
  bindLists,
  type Expression,
  listReferences,
  type Phase,
  parseExpression,
  parseValueExpression,
} from "@edgeweir/rule-engine";
import { and, asc, desc, eq, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { parseCacheCondition } from "../lib/cache-conditions";
import { readCacheKey } from "../lib/cache-key";
import { assertCertificateNames } from "../lib/certificate-names";
import { fail } from "../lib/errors";
import { CONFIG_CHANNEL } from "../lib/events";
import { lockClusterPublish } from "../lib/locks";
import { isOnline } from "../lib/node-online";
import { activeHealthCheckModel, sessionAffinityModel } from "../lib/pool-settings";
import { isServing } from "../lib/site-state";
import { recordAudit, systemActor } from "./audit";
import { ensureChallengeKeys } from "./challenge-keys";
import { loadPlatformErrorPages, loadSiteErrorPages } from "./error-pages";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import { loadPlatformProtection, loadSiteProtectionModels } from "./protection";
import { isAdminRole } from "./users";
import { loadSiteWafModels } from "./waf";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

export const REVISION_RETENTION = 200;

type RevisionRow = typeof schema.configRevision.$inferSelect;

export function toRevisionDto(row: RevisionRow): Revision {
  return {
    clusterId: row.clusterId,
    revision: row.revision,
    contentHash: row.contentHash,
    siteCount: row.siteCount,
    reason: row.reason,
    reasonCode: row.reasonCode,
    reasonParams: row.reasonParams,
    createdAt: row.createdAt.toISOString(),
  };
}

/** system_setting key of the platform's origin allow list: `{ cidrs: string[] }`. */
export const ORIGIN_ALLOW_LIST_KEY = "origin_allow_list";

/**
 * The special-purpose CIDRs origins may use anyway (normalized, sorted,
 * without duplicates). Every cluster's NodeConfig carries it.
 */
export async function loadOriginAllowList(db: Executor): Promise<string[]> {
  const [row] = await db
    .select({ value: schema.systemSetting.value })
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, ORIGIN_ALLOW_LIST_KEY));
  const stored = row?.value.cidrs;
  const cidrs = Array.isArray(stored) ? stored : [];
  const normalized = cidrs.flatMap((c) => {
    const n = typeof c === "string" ? normalizeCidr(c) : null;
    return n ? [n] : [];
  });
  return [...new Set(normalized)].sort();
}

/**
 * Verified domains of the cluster's sites that are not served (disabled, or
 * suspended by the platform): nodes answer them with the platform's page for
 * the reason instead of the unknown host page. Current state, also when a
 * revision is rolled back.
 */
export async function loadOfflineHosts(
  db: Executor,
  clusterId: string,
): Promise<OfflineHostModel[]> {
  const rows = await db
    .select({
      name: schema.siteDomain.name,
      wildcard: schema.siteDomain.wildcard,
      suspended: schema.site.suspended,
    })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(
      and(
        eq(schema.site.clusterId, clusterId),
        eq(schema.siteDomain.verified, true),
        or(eq(schema.site.enabled, false), eq(schema.site.suspended, true)),
      ),
    );
  return rows.map((row) => ({
    name: row.name,
    wildcard: row.wildcard,
    reason: row.suspended ? "suspended" : "disabled",
  }));
}

/** Loads every site of a cluster with its domains, origins and rules. */
export async function loadSiteModels(db: Executor, clusterId: string): Promise<SiteModel[]> {
  const sites = await db
    .select()
    .from(schema.site)
    .where(eq(schema.site.clusterId, clusterId))
    .orderBy(asc(schema.site.id));
  if (sites.length === 0) return [];
  const siteIds = sites.map((s) => s.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(and(inArray(schema.siteDomain.siteId, siteIds), eq(schema.siteDomain.verified, true)));
  const pools = await db
    .select()
    .from(schema.originPool)
    .where(inArray(schema.originPool.siteId, siteIds));
  const rules = await db
    .select()
    .from(schema.cacheRule)
    .where(inArray(schema.cacheRule.siteId, siteIds));
  const origins = pools.length
    ? await db
        .select()
        .from(schema.origin)
        .where(
          inArray(
            schema.origin.poolId,
            pools.map((p) => p.id),
          ),
        )
    : [];
  const credentials = await db
    .select({ id: schema.originCredential.id, version: schema.originCredential.version })
    .from(schema.originCredential)
    .where(inArray(schema.originCredential.siteId, siteIds));

  const edgeRules = await db
    .select()
    .from(schema.edgeRule)
    .where(and(inArray(schema.edgeRule.siteId, siteIds), eq(schema.edgeRule.enabled, true)))
    .orderBy(asc(schema.edgeRule.priority));
  const lists = await db.select().from(schema.ipList);
  const redirects = await db
    .select()
    .from(schema.bulkRedirect)
    .where(inArray(schema.bulkRedirect.siteId, siteIds))
    .orderBy(asc(schema.bulkRedirect.position));
  const protection = await loadSiteProtectionModels(db, siteIds);
  const waf = await loadSiteWafModels(db, siteIds);
  const errorPages = await loadSiteErrorPages(db, siteIds);
  return sites
    .map((s): SiteModel => {
      const pool = pools
        .filter((p) => p.siteId === s.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      const bindings = listBindings(
        lists.filter(
          (list) => list.organizationId === null || list.organizationId === s.organizationId,
        ),
      );
      return {
        rules: edgeRules
          .filter((rule) => rule.siteId === s.id)
          .map((rule) => compileRuleModel(rule, bindings)),
        id: s.id,
        name: s.name,
        // Disabled or suspended sites are not shipped (their DNS records stay).
        enabled: isServing(s),
        cacheGeneration: s.cacheGeneration,
        logSampleRate: s.logSampleRate,
        domains: domains
          .filter((d) => d.siteId === s.id)
          .map((d) => ({ name: d.name, wildcard: d.wildcard })),
        originPool: {
          id: pool?.id ?? s.id,
          policy: (pool?.policy ?? "weighted_random") as SiteModel["originPool"]["policy"],
          origins: origins
            .filter((o) => o.poolId === pool?.id)
            .map((o) => {
              const credential = credentials.find((c) => c.id === o.credentialId);
              return {
                id: o.id,
                address: o.address,
                port: o.port,
                scheme: o.scheme === "https" ? "https" : "http",
                weight: o.weight,
                backup: o.backup,
                hostHeader: o.hostHeader,
                sni: o.sni,
                group: o.groupName,
                s3: credential
                  ? {
                      region: o.s3Region,
                      bucket: o.s3Bucket,
                      credentialId: credential.id,
                      credentialVersion: credential.version,
                    }
                  : null,
              };
            }),
          settings: pool
            ? {
                tlsVerify: pool.tlsVerify,
                maxFails: pool.maxFails,
                recoverySeconds: pool.recoverySeconds,
                connectTimeoutMs: pool.connectTimeoutMs,
                sendTimeoutMs: pool.sendTimeoutMs,
                readTimeoutMs: pool.readTimeoutMs,
                keepalive: pool.keepalive,
                keepaliveIdleSeconds: pool.keepaliveIdleSeconds,
                keepaliveMaxRequests: pool.keepaliveMaxRequests,
              }
            : undefined,
          // Compiled only while on; the settings are kept while off.
          activeHealthCheck: pool ? activeHealthCheckModel(pool.activeHealthCheck) : null,
          sessionAffinity: pool ? sessionAffinityModel(pool.sessionAffinity) : null,
        },
        cacheRules: rules
          .filter((r) => r.siteId === s.id)
          .map((r) => ({
            id: r.id,
            priority: r.priority,
            pathPrefixes: r.pathPrefixes,
            paths: r.paths,
            extensions: r.extensions,
            statusCodes: r.statusCodes,
            minSizeBytes: r.minSizeBytes,
            maxSizeBytes: r.maxSizeBytes,
            expression: r.expression,
            condition: r.expression ? cacheRuleCondition(r.expression, bindings) : undefined,
            browserTtlSeconds: r.browserTtlSeconds,
            action: r.action === "bypass" ? "bypass" : "cache",
            edgeTtlSeconds: r.edgeTtlSeconds,
            originCacheControl: r.originCacheControl === "respect" ? "respect" : "override",
            staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
            staleIfErrorSeconds: r.staleIfErrorSeconds,
            cacheAuthorized: r.cacheAuthorized,
          })),
        bulkRedirects: redirects
          .filter((r) => r.siteId === s.id)
          .map((r) => ({
            source: r.source,
            target: r.target,
            statusCode: r.statusCode,
            preserveQuery: r.preserveQuery,
          })),
        cacheKey: readCacheKey(s.cacheKey),
        protection: protection.get(s.id),
        waf: waf.get(s.id) ?? null,
        keepCacheTag: s.keepCacheTag,
        errorPages: errorPages.has(s.id)
          ? { pages: errorPages.get(s.id) ?? [], interceptOriginErrors: s.interceptOriginErrors }
          : null,
        rangeSlice: s.rangeSlice,
        websocket: s.websocket,
        certificateId: s.certificateId ?? "",
        tls:
          s.certificateId || Object.keys(s.tlsSettings).length
            ? (() => {
                const settings = tlsSettings.parse({
                  ...s.tlsSettings,
                  certificateId: s.certificateId,
                });
                return {
                  forceHttps: settings.forceHttps,
                  hstsMaxAge: settings.hstsMaxAge,
                  hstsIncludeSubdomains: settings.hstsIncludeSubdomains,
                  hstsPreload: settings.hstsPreload,
                  minimumVersion: settings.minimumVersion,
                  cipherProfile: settings.cipherProfile,
                  http2: settings.http2,
                  http3: settings.http3,
                  brotli: settings.brotli,
                  brotliLevel: settings.brotliLevel,
                  brotliMinLength: settings.brotliMinLength,
                  brotliTypes: settings.brotliTypes,
                  zstd: settings.zstd,
                  zstdLevel: settings.zstdLevel,
                  zstdMinLength: settings.zstdMinLength,
                  zstdTypes: settings.zstdTypes,
                  gzip: settings.gzip,
                  gzipMinLength: settings.gzipMinLength,
                  gzipTypes: settings.gzipTypes,
                  ocspStapling: settings.ocspStapling,
                };
              })()
            : undefined,
      };
    })
    .filter((site) => site.domains.length > 0);
}

export async function latestRevision(
  db: Executor,
  clusterId: string,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(eq(schema.configRevision.clusterId, clusterId))
    .orderBy(desc(schema.configRevision.revision))
    .limit(1);
  return row;
}

export async function getRevision(
  db: Executor,
  clusterId: string,
  revision: number,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(
      and(
        eq(schema.configRevision.clusterId, clusterId),
        eq(schema.configRevision.revision, revision),
      ),
    );
  return row;
}

/** IP list names to ids: an organization's lists over the platform's lists of the same name. */
export function listBindings(
  lists: Pick<typeof schema.ipList.$inferSelect, "id" | "name" | "organizationId">[],
): Record<string, string> {
  const bindings: Record<string, string> = Object.create(null);
  for (const list of lists.filter((l) => l.organizationId === null)) bindings[list.name] = list.id;
  for (const list of lists.filter((l) => l.organizationId !== null)) bindings[list.name] = list.id;
  return bindings;
}

function compileRuleModel(
  row: typeof schema.edgeRule.$inferSelect,
  bindings: Record<string, string>,
): RuleModel {
  let expression: Expression;
  let action: RuleModel["action"];
  try {
    expression = parseExpression(row.expression, row.phase as Phase);
    action = ruleAction.parse(row.action);
    if ((action.kind === "redirect" || action.kind === "rewrite") && action.target)
      parseValueExpression(action.target, row.phase as Phase);
  } catch (error) {
    // A stored rule the current validator refuses (e.g. regex syntax that is no
    // longer accepted) blocks publication until it is rewritten.
    fail("RULE_INVALID", `rule ${row.name} is no longer valid: ${(error as Error).message}`);
  }
  return {
    id: row.id,
    phase: row.phase,
    expression: bindLists(expression, bindings),
    action,
  };
}

/** A stored cache rule condition with its IP lists bound, or RULE_INVALID. */
function cacheRuleCondition(source: string, bindings: Record<string, string>): Expression {
  try {
    return bindLists(parseCacheCondition(source), bindings);
  } catch (error) {
    fail("RULE_INVALID", `cache rule is no longer valid: ${(error as Error).message}`);
  }
}

/** Why a revision is published; rendered per locale in the UI. */
export interface RevisionReason {
  code: RevisionReasonCode;
  params: ReasonParams;
}

export async function insertRevision(
  tx: Tx,
  clusterId: string,
  build: (revision: bigint) => NodeConfig,
  reason: RevisionReason,
  userId: string | null,
): Promise<{ row: RevisionRow; created: boolean }> {
  const latest = await latestRevision(tx, clusterId);
  // Restoring a database cannot rewind an edge node's durable LKG revision.
  // Even unchanged content needs a fresh revision when a node is ahead.
  const [reported] = await tx
    .select({ revision: sql<number>`coalesce(max(${schema.nodeConfigStatus.appliedRevision}), 0)` })
    .from(schema.nodeConfigStatus)
    .innerJoin(schema.node, eq(schema.node.id, schema.nodeConfigStatus.nodeId))
    .where(
      and(
        eq(schema.node.clusterId, clusterId),
        eq(schema.nodeConfigStatus.revisionReceiptVerified, true),
      ),
    );
  const highest = Math.max(latest?.revision ?? 0, Number(reported?.revision ?? 0));
  if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER)
    throw new Error("configuration revision exhausted");
  const next = BigInt(highest) + 1n;
  let config: NodeConfig;
  try {
    config = build(next);
  } catch (error) {
    if (error instanceof ConfigCapacityError)
      fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
    throw error;
  }
  // Rollback also passes through this guard, rather than only the compiler.
  if (config.sites.length > MAX_SITES_PER_CLUSTER)
    fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
  if (latest && latest.revision >= highest && latest.contentHash === config.contentHash) {
    return { row: latest, created: false };
  }
  const previousFeatures = new Set(latest ? nodeRequirements(decodeNodeConfig(latest.ir)) : []);
  const addedFeatures = nodeRequirements(config).filter(
    (feature) => !previousFeatures.has(feature),
  );
  if (addedFeatures.length) {
    const [user] = userId
      ? await tx
          .select({ role: schema.user.role })
          .from(schema.user)
          .where(eq(schema.user.id, userId))
      : [];
    // Only a platform administrator may deliberately require an upgrade across
    // the cluster. Tenant and background changes must preserve other sites' delivery.
    if (!isAdminRole(user?.role)) {
      const nodes = await tx
        .select({ features: schema.node.supportedFeatures })
        .from(schema.node)
        .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")));
      const missing = addedFeatures.filter((feature) =>
        nodes.some((node) => !nodeSupportsFeature(node.features, feature)),
      );
      if (missing.length)
        fail("NODE_CAPABILITY_REQUIRED", "cluster nodes do not support this change", {
          features: missing.join(", "),
        });
    }
  }
  const [row] = await tx
    .insert(schema.configRevision)
    .values({
      clusterId,
      revision: Number(next),
      contentHash: config.contentHash,
      ir: encodeNodeConfig(config),
      siteCount: config.sites.length,
      reason: reasonText(reason.code, reason.params),
      reasonCode: reason.code,
      reasonParams: reason.params,
      createdByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("failed to insert revision");
  // Delivered to every console instance when the transaction commits.
  await tx.execute(
    sql`select pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({
      clusterId,
      revision: row.revision,
      contentHash: row.contentHash,
    })})`,
  );
  return { row, created: true };
}

/**
 * Compiles the cluster's current sites into a NodeConfig and stores it as the
 * next revision. Identical content does not produce a new revision.
 * Must run inside a transaction; serialised per cluster with an advisory lock.
 */
export async function publishRevision(
  tx: Tx,
  opts: { clusterId: string; reason: RevisionReason; userId?: string | null },
): Promise<{ row: RevisionRow; created: boolean }> {
  await lockClusterPublish(tx, opts.clusterId);
  const sites = await loadSiteModels(tx, opts.clusterId);
  const organizations = await tx
    .selectDistinct({ id: schema.site.organizationId })
    .from(schema.site)
    .where(
      and(
        eq(schema.site.clusterId, opts.clusterId),
        eq(schema.site.enabled, true),
        eq(schema.site.suspended, false),
      ),
    );
  const allLists = await tx.select().from(schema.ipList);
  const lists = allLists.filter(
    (list) =>
      list.organizationId === null || organizations.some((org) => org.id === list.organizationId),
  );
  const ipLists = lists.map((list) => ({
    id: list.id,
    name: list.name,
    entries: list.entries,
    kind: list.kind,
    platform: list.organizationId === null,
  }));
  const globalRules = await tx
    .select()
    .from(schema.edgeRule)
    .where(and(sql`${schema.edgeRule.siteId} is null`, eq(schema.edgeRule.enabled, true)))
    .orderBy(asc(schema.edgeRule.priority));
  const platformBindings = listBindings(lists.filter((list) => list.organizationId === null));
  const platformRules = globalRules.map((rule) => compileRuleModel(rule, platformBindings));
  const originAllowedCidrs = await loadOriginAllowList(tx);
  const certIds = [
    ...new Set(
      sites.filter((s) => s.enabled && s.certificateId).map((s) => s.certificateId as string),
    ),
  ];
  const certRows = certIds.length
    ? await tx.select().from(schema.certificate).where(inArray(schema.certificate.id, certIds))
    : [];
  const certificates = certRows.map((c) =>
    create(CertificateRefSchema, {
      id: c.id,
      names: c.names,
      sha256Fingerprint: c.fingerprint,
      notAfter: c.notAfter ? timestampFromDate(c.notAfter) : undefined,
    }),
  );
  const challenges = await tx
    .selectDistinct({ challenge: schema.acmeChallenge })
    .from(schema.acmeChallenge)
    .innerJoin(schema.certificate, eq(schema.certificate.id, schema.acmeChallenge.certificateId))
    .innerJoin(
      schema.site,
      // Disabled and suspended sites keep answering HTTP-01: renewals continue.
      and(
        eq(schema.site.organizationId, schema.certificate.organizationId),
        eq(schema.site.clusterId, opts.clusterId),
      ),
    )
    .innerJoin(
      schema.siteDomain,
      and(
        eq(schema.siteDomain.siteId, schema.site.id),
        eq(schema.siteDomain.verified, true),
        eq(schema.siteDomain.name, schema.acmeChallenge.domain),
        eq(schema.siteDomain.wildcard, false),
      ),
    )
    .where(
      and(
        gt(schema.acmeChallenge.expiresAt, new Date()),
        eq(schema.acmeChallenge.operationStartedAt, schema.certificate.operationStartedAt),
      ),
    );
  const httpChallenges = challenges
    .map(({ challenge }) => challenge)
    .map((c) =>
      create(HttpChallengeSchema, {
        domain: c.domain,
        token: c.token,
        keyAuthorization: c.keyAuthorization,
        expiresAt: timestampFromDate(c.expiresAt),
      }),
    );
  const platformProtection = await loadPlatformProtection(tx);
  const input = {
    clusterId: opts.clusterId,
    sites,
    originAllowedCidrs,
    certificates,
    httpChallenges,
    ipLists,
    platformRules,
    platformProtection,
    platformErrorPages: await loadPlatformErrorPages(tx),
    offlineHosts: await loadOfflineHosts(tx, opts.clusterId),
  };
  // A cluster gets its challenge keys the first time its configuration uses
  // challenges or session affinity.
  const challengeKeys = usesChallengeKeys(input)
    ? await ensureChallengeKeys(tx, opts.clusterId)
    : [];
  const build = (revision: bigint) => compileNodeConfig({ ...input, challengeKeys }, revision);
  const rollout = await loadRollout(tx, opts.clusterId);
  if (!rollout?.enabled)
    return insertRevision(tx, opts.clusterId, build, opts.reason, opts.userId ?? null);
  return publishThroughCanary(tx, rollout, build, opts.reason, opts.userId ?? null);
}

/**
 * Publishes several clusters in one transaction: each once, in cluster id
 * order, the order in which every transaction takes their publish locks.
 */
export async function publishClusters(
  tx: Tx,
  clusterIds: Iterable<string>,
  opts: { reason: RevisionReason; userId?: string | null },
): Promise<Map<string, Awaited<ReturnType<typeof publishRevision>>>> {
  const results = new Map<string, Awaited<ReturnType<typeof publishRevision>>>();
  for (const clusterId of [...new Set(clusterIds)].sort())
    results.set(clusterId, await publishRevision(tx, { clusterId, ...opts }));
  return results;
}

type RolloutRow = typeof schema.clusterRollout.$inferSelect;

export async function loadRollout(
  db: Executor,
  clusterId: string,
): Promise<RolloutRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.clusterRollout)
    .where(eq(schema.clusterRollout.clusterId, clusterId));
  return row;
}

export async function updateRollout(
  tx: Executor,
  clusterId: string,
  values: Partial<Omit<RolloutRow, "clusterId">>,
) {
  await tx
    .update(schema.clusterRollout)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.clusterRollout.clusterId, clusterId));
}

/**
 * The revisions nodes of a cluster get: the candidate (if any) goes to the
 * canary nodes of the running window that are still active, every other
 * node gets the stable one.
 */
export interface RolloutTargets {
  stable: RevisionRow | undefined;
  candidate: RevisionRow | undefined;
  canaryNodeIds: Set<string>;
}

export async function rolloutTargets(db: Executor, clusterId: string): Promise<RolloutTargets> {
  const rollout = await loadRollout(db, clusterId);
  const latest = await latestRevision(db, clusterId);
  if (!rollout?.enabled) return { stable: latest, candidate: undefined, canaryNodeIds: new Set() };
  const stable =
    rollout.stableRevision === null
      ? latest
      : ((await getRevision(db, clusterId, rollout.stableRevision)) ?? latest);
  const candidate =
    rollout.candidateRevision === null
      ? undefined
      : await getRevision(db, clusterId, rollout.candidateRevision);
  const nodes =
    candidate && rollout.canaryNodeIds.length
      ? await db
          .select({ id: schema.node.id })
          .from(schema.node)
          .where(
            and(
              inArray(schema.node.id, rollout.canaryNodeIds),
              eq(schema.node.clusterId, clusterId),
              eq(schema.node.status, "active"),
            ),
          )
      : [];
  return { stable, candidate, canaryNodeIds: new Set(nodes.map((n) => n.id)) };
}

/**
 * A node's target. Canary nodes are those of the window, not the current
 * members of canary groups: a node that leaves the group keeps the
 * candidate it may already run (nodes never apply a lower revision), and
 * one that joins waits for the next window.
 */
export function targetFor(node: { id: string }, targets: RolloutTargets): RevisionRow | undefined {
  if (targets.candidate && targets.canaryNodeIds.has(node.id)) return targets.candidate;
  return targets.stable;
}

/** The revision a node should run (its target), per the cluster's rollout. */
export async function nodeTarget(
  db: Executor,
  node: { id: string; clusterId: string },
): Promise<RevisionRow | undefined> {
  return targetFor(node, await rolloutTargets(db, node.clusterId));
}

/** Tells every console instance's watch streams of the cluster to re-read their targets. */
export async function notifyClusterTargets(tx: Executor, clusterId: string) {
  const latest = await latestRevision(tx, clusterId);
  if (!latest) return;
  await tx.execute(
    sql`select pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({
      clusterId,
      revision: latest.revision,
      contentHash: latest.contentHash,
    })})`,
  );
}

/** Active canary-group nodes of a cluster that are online now. */
export async function onlineCanaryNodes(tx: Executor, clusterId: string, now = Date.now()) {
  const rows = await tx
    .select({ id: schema.node.id, name: schema.node.name, lastSeenAt: schema.node.lastSeenAt })
    .from(schema.node)
    .innerJoin(schema.nodeGroup, eq(schema.nodeGroup.id, schema.node.nodeGroupId))
    .where(
      and(
        eq(schema.node.clusterId, clusterId),
        eq(schema.node.status, "active"),
        eq(schema.nodeGroup.isCanary, true),
      ),
    );
  return rows.filter((n) => isOnline(n.lastSeenAt, now));
}

/**
 * `config` with the ACME HTTP-01 challenges of `challenges`: issuance
 * state that every node needs at once, so it never waits for a canary.
 */
export function withChallenges(config: NodeConfig, challenges: NodeConfig["httpChallenges"]) {
  const out = clone(NodeConfigSchema, config);
  out.httpChallenges = challenges.map((c) => clone(HttpChallengeSchema, c));
  out.requiredFeatures = out.requiredFeatures.filter((f) => f !== "http01-v1");
  if (out.httpChallenges.length) out.requiredFeatures.push("http01-v1");
  const canonical = canonicalize(out);
  canonical.contentHash = contentHash(canonical);
  return canonical;
}

/**
 * Publishing with the configuration canary on. A change that only differs
 * from the stable revision in ACME challenges goes to every node. Without
 * an online canary node the change goes to every node too (audited and
 * alerted). Otherwise the stable revision first takes the current
 * challenges, then the change becomes the candidate for the canary nodes
 * and the observation window (re)starts.
 */
async function publishThroughCanary(
  tx: Tx,
  rollout: RolloutRow,
  build: (revision: bigint) => NodeConfig,
  reason: RevisionReason,
  userId: string | null,
): Promise<{ row: RevisionRow; created: boolean }> {
  const clusterId = rollout.clusterId;
  const preview = previewConfig(build);
  const stable =
    (rollout.stableRevision !== null
      ? await getRevision(tx, clusterId, rollout.stableRevision)
      : undefined) ?? (await latestRevision(tx, clusterId));
  if (!stable) return insertRevision(tx, clusterId, build, reason, userId);
  const patched = withChallenges(decodeNodeConfig(stable.ir), preview.httpChallenges);
  const now = new Date();
  if (preview.contentHash === patched.contentHash) {
    const result = await insertRevision(tx, clusterId, build, reason, userId);
    if (result.row.revision !== stable.revision || rollout.candidateRevision !== null)
      await updateRollout(tx, clusterId, {
        stableRevision: result.row.revision,
        candidateRevision: null,
        ...(rollout.candidateRevision !== null
          ? {
              state: "idle",
              outcome: "withdrawn",
              lastCandidateRevision: rollout.candidateRevision,
              finishedAt: now,
            }
          : {}),
      });
    return result;
  }
  // A running window keeps its canary nodes: they may already run its candidate.
  const running = rollout.candidateRevision !== null;
  const canary = running ? [] : await onlineCanaryNodes(tx, clusterId, now.getTime());
  if (!running && canary.length === 0) {
    const result = await insertRevision(tx, clusterId, build, reason, userId);
    if (result.created) {
      await updateRollout(tx, clusterId, {
        stableRevision: result.row.revision,
        candidateRevision: null,
        lastCandidateRevision: rollout.candidateRevision,
        state: "direct",
        outcome: "no_canary",
        windowStartedAt: null,
        canaryNodeIds: [],
        finishedAt: now,
      });
      const [cluster] = await tx
        .select({ name: schema.cluster.name })
        .from(schema.cluster)
        .where(eq(schema.cluster.id, clusterId));
      await recordAudit(tx, systemActor, {
        action: "cluster.rollout_direct",
        targetType: "cluster",
        targetId: clusterId,
        targetName: cluster?.name ?? "",
        metadata: { revision: result.row.revision, reason: "no_canary" },
      });
      await raisePlatformAlert(tx, "config_rollout_no_canary", clusterId, cluster?.name ?? "", now);
    }
    return result;
  }
  if (patched.contentHash !== stable.contentHash) {
    const restabled = await insertRevision(
      tx,
      clusterId,
      (revision) => {
        const config = clone(NodeConfigSchema, patched);
        config.revision = revision;
        return config;
      },
      { code: "acme_challenge_updated", params: {} },
      null,
    );
    await updateRollout(tx, clusterId, { stableRevision: restabled.row.revision });
  }
  const result = await insertRevision(tx, clusterId, build, reason, userId);
  if (result.created || !running) {
    await updateRollout(tx, clusterId, {
      candidateRevision: result.row.revision,
      state: "canary",
      windowStartedAt: now,
      ...(running ? {} : { canaryNodeIds: canary.map((n) => n.id) }),
      outcome: "",
      finishedAt: null,
    });
    const [cluster] = await tx
      .select({ name: schema.cluster.name })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    await resolvePlatformAlert(tx, "config_rollout_no_canary", clusterId, cluster?.name ?? "", now);
  }
  return result;
}

/** The compiled content (revision 0) of a build, with capacity errors as API errors. */
function previewConfig(build: (revision: bigint) => NodeConfig): NodeConfig {
  try {
    return build(0n);
  } catch (error) {
    if (error instanceof ConfigCapacityError)
      fail("CLUSTER_SITE_LIMIT", "cluster site capacity reached", { limit: MAX_SITES_PER_CLUSTER });
    throw error;
  }
}

/**
 * Publishes the content of an older revision as a new revision. The origin
 * allow list, the platform's error pages and the offline hosts are platform
 * policy and current state, not cluster content: the new revision carries
 * the current ones, not those the old revision had.
 */
export async function rollbackToRevision(
  tx: Tx,
  opts: { clusterId: string; revision: number; userId?: string | null },
): Promise<{ row: RevisionRow; created: boolean } | undefined> {
  await lockClusterPublish(tx, opts.clusterId);
  const target = await getRevision(tx, opts.clusterId, opts.revision);
  if (!target) return undefined;
  const originAllowedCidrs = await loadOriginAllowList(tx);
  const restored = decodeNodeConfig(target.ir);
  const currentSites = await tx
    .select()
    .from(schema.site)
    .where(eq(schema.site.clusterId, opts.clusterId));
  // Enabling and suspension are current policy: rollback never ships a site
  // that is disabled or suspended now.
  restored.sites = restored.sites.filter((site) => {
    const current = currentSites.find((s) => s.id === site.id);
    return !current || isServing(current);
  });
  const currentDomains = currentSites.length
    ? await tx
        .select()
        .from(schema.siteDomain)
        .where(
          inArray(
            schema.siteDomain.siteId,
            currentSites.map((site) => site.id),
          ),
        )
    : [];
  for (const site of restored.sites) {
    const current = currentSites.find((s) => s.id === site.id);
    // Rollback is configuration history, never authorization to resurrect a
    // deleted/transferred resource or reclaim a released tenant hostname.
    if (
      !current ||
      site.domains.some(
        (domain) =>
          !currentDomains.some(
            (d) =>
              d.verified &&
              d.siteId === site.id &&
              d.name === domain.name &&
              d.wildcard === domain.wildcard,
          ),
      )
    ) {
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback references a removed site or domain");
    }
    // Sampling is current privacy policy; rollback must not revive disabled collection.
    site.logSampleRate = current.logSampleRate;
    if (site.certificateId) {
      const [cert] = await tx
        .select()
        .from(schema.certificate)
        .where(
          and(
            eq(schema.certificate.id, site.certificateId),
            eq(schema.certificate.organizationId, current.organizationId),
          ),
        );
      if (!cert?.notAfter || cert.notAfter.getTime() <= Date.now())
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback certificate is unavailable or expired");
      assertCertificateNames(cert.chainPem, cert.names, site.domains);
      const ref = restored.certificates.find((c) => c.id === cert.id);
      if (!ref) fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback certificate reference is missing");
      ref.names = cert.names;
      ref.sha256Fingerprint = cert.fingerprint;
      ref.notAfter = timestampFromDate(cert.notAfter);
    }
  }
  const currentLists = (await tx.select().from(schema.ipList)).filter(
    (list) =>
      list.organizationId === null ||
      currentSites.some((site) => site.organizationId === list.organizationId),
  );
  for (const site of restored.sites) {
    const org = currentSites.find((s) => s.id === site.id)?.organizationId;
    const unavailable = (expression: RuleExpression) =>
      listReferences(expression).some(
        (id) =>
          !currentLists.some(
            (list) =>
              list.id === id && (list.organizationId === null || list.organizationId === org),
          ),
      );
    for (const rule of site.rules)
      if (!rule.expression || unavailable(rule.expression))
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback IP list is unavailable");
    for (const rule of site.cacheRules)
      if (rule.match?.condition && unavailable(rule.match.condition))
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback IP list is unavailable");
  }
  restored.requiredFeatures = restored.requiredFeatures.filter((f) => f !== "access-logs-v1");
  if (restored.sites.some((s) => s.logSampleRate > 0))
    restored.requiredFeatures.push("access-logs-v1");
  // Access lists and platform enforcement are current security policy.
  restored.ipLists = currentLists.map((list) =>
    create(IpListSchema, {
      id: list.id,
      name: list.name,
      kind: list.kind,
      entries: list.entries,
      platform: list.organizationId === null,
    }),
  );
  const platformRules = await tx
    .select()
    .from(schema.edgeRule)
    .where(and(sql`${schema.edgeRule.siteId} is null`, eq(schema.edgeRule.enabled, true)))
    .orderBy(asc(schema.edgeRule.priority));
  const platformBindings = listBindings(
    currentLists.filter((list) => list.organizationId === null),
  );
  restored.platformRules = compileRules(
    platformRules.map((rule) => compileRuleModel(rule, platformBindings)),
  );
  restored.requiredFeatures = restored.requiredFeatures.filter(
    (f) => f !== "rules-v1" && f !== RULES_V2_FEATURE && !f.startsWith("geoip-"),
  );
  const rules = [...restored.platformRules, ...restored.sites.flatMap((s) => s.rules)];
  if (rules.length || restored.ipLists.some((l) => l.platform && l.kind !== "collection"))
    restored.requiredFeatures.push("rules-v1");
  // Platform rules are current; targets and cache conditions read GeoIP too.
  restored.requiredFeatures.push(
    ...configExpressions(restored).flatMap(geoFeatures),
    ...rulesFeatures(restored),
  );
  // Sites dropped above no longer need the modules, health checks, affinity
  // or error pages they used.
  const siteFeatures = [
    BROTLI_FEATURE,
    ZSTD_FEATURE,
    MODSECURITY_FEATURE,
    ACTIVE_HEALTH_FEATURE,
    SESSION_AFFINITY_FEATURE,
    ERROR_PAGES_FEATURE,
  ];
  restored.requiredFeatures = restored.requiredFeatures.filter((f) => !siteFeatures.includes(f));
  restored.requiredFeatures.push(...moduleFeatures(restored), ...poolAndPageFeatures(restored));
  restored.platformErrorPages = compilePlatformErrorPages(await loadPlatformErrorPages(tx));
  restored.offlineHosts = compileOfflineHosts(await loadOfflineHosts(tx, opts.clusterId));
  // Challenge tokens are short-lived issuance state, never rollback content.
  restored.httpChallenges = [];
  restored.requiredFeatures = restored.requiredFeatures.filter((f) => f !== "http01-v1");
  await restoreProtection(tx, opts.clusterId, restored, currentSites);
  const result = await insertRevision(
    tx,
    opts.clusterId,
    (revision) => {
      const old = restored;
      old.revision = revision;
      old.originAllowedCidrs = originAllowedCidrs;
      const config = canonicalize(old);
      config.contentHash = contentHash(config);
      return config;
    },
    { code: "rollback", params: { revision: opts.revision } },
    opts.userId ?? null,
  );
  // An administrator's rollback restores known content: it goes to every node, no canary.
  const rollout = await loadRollout(tx, opts.clusterId);
  if (rollout?.enabled)
    await updateRollout(tx, opts.clusterId, {
      stableRevision: result.row.revision,
      candidateRevision: null,
      lastCandidateRevision: rollout.candidateRevision ?? rollout.lastCandidateRevision,
      state: "promoted",
      outcome: "manual_rollback",
      finishedAt: new Date(),
    });
  return result;
}

/**
 * Brings the protection of a restored configuration in line with current
 * policy: platform Under Attack and JA4 logging are current settings, and
 * challenge keys are always the cluster's current keys (older ones are gone),
 * carried whenever challenges or a restored site's session affinity use them.
 * Sites keep their restored Under Attack and CC policy.
 */
async function restoreProtection(
  tx: Tx,
  clusterId: string,
  restored: NodeConfig,
  currentSites: { id: string }[],
) {
  const platform = await loadPlatformProtection(tx);
  const current = await loadSiteProtectionModels(
    tx,
    currentSites.map((site) => site.id),
  );
  const rules = [...restored.platformRules, ...restored.sites.flatMap((site) => site.rules)];
  const challenges =
    platform.underAttack ||
    rules.some((rule) => rule.action?.kind === "challenge" || rule.action?.underAttack === true) ||
    restored.sites.some((site) => site.protection?.underAttack || site.protection?.cc?.enabled);
  const affinity = restored.sites.some((site) => site.originPool?.sessionAffinity);
  const keys = challenges || affinity ? await ensureChallengeKeys(tx, clusterId) : [];
  restored.challengeKeys = keys.map((key) => create(ChallengeKeyRefSchema, key));
  restored.platformProtection = challenges ? create(PlatformProtectionSchema, platform) : undefined;
  for (const site of restored.sites) {
    const logJa4 = current.get(site.id)?.logJa4 ?? false;
    if (!challenges && !logJa4) {
      site.protection = undefined;
      continue;
    }
    // A site without protection in the restored revision had neither Under Attack nor CC.
    const defaults = current.get(site.id) ?? DEFAULT_SITE_PROTECTION;
    site.protection ??= create(SiteProtectionSchema, {
      underAttack: false,
      underAttackChallenge: defaults.underAttackChallenge,
      passTtlSeconds: defaults.passTtlSeconds,
      powDifficulty: defaults.powDifficulty,
      powHighDifficulty: defaults.powHighDifficulty,
    });
    site.protection.logJa4 = logJa4;
    if (!challenges) {
      site.protection.underAttack = false;
      site.protection.cc = undefined;
    }
  }
  restored.requiredFeatures = restored.requiredFeatures.filter(
    (f) => f !== "challenge-v1" && f !== "ja4-v1",
  );
  restored.requiredFeatures.push(...protectionFeatures(restored));
}

/** Deletes revisions beyond the retention window, keeping the newest ones. */
export async function pruneRevisions(db: Executor, keep = REVISION_RETENTION): Promise<number> {
  const clusters = await db.select({ id: schema.cluster.id }).from(schema.cluster);
  let removed = 0;
  for (const { id } of clusters) {
    const latest = await latestRevision(db, id);
    if (!latest || latest.revision <= keep) continue;
    // The stable and candidate revisions of a rollout are kept however old they are.
    const rollout = await loadRollout(db, id);
    const pinned = [rollout?.stableRevision, rollout?.candidateRevision].filter(
      (r): r is number => typeof r === "number",
    );
    const deleted = await db
      .delete(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, id),
          lt(schema.configRevision.revision, latest.revision - keep + 1),
          pinned.length ? notInArray(schema.configRevision.revision, pinned) : undefined,
        ),
      )
      .returning({ id: schema.configRevision.id });
    removed += deleted.length;
  }
  return removed;
}
