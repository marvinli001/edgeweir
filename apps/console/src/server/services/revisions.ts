import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  ConfigCapacityError,
  canonicalize,
  compileNodeConfig,
  compileRules,
  contentHash,
  decodeNodeConfig,
  encodeNodeConfig,
  geoFeatures,
  MAX_SITES_PER_CLUSTER,
  nodeRequirements,
  type RuleModel,
  type SiteModel,
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
  HttpChallengeSchema,
  IpListSchema,
  type NodeConfig,
} from "@edgeweir/proto";
import { bindLists, listReferences, type Phase, parseExpression } from "@edgeweir/rule-engine";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { readCacheKey } from "../lib/cache-key";
import { assertCertificateNames } from "../lib/certificate-names";
import { fail } from "../lib/errors";
import { CONFIG_CHANNEL } from "../lib/events";
import { isAdminRole } from "./users";

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
  return sites
    .map((s): SiteModel => {
      const pool = pools
        .filter((p) => p.siteId === s.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      return {
        rules: edgeRules
          .filter((rule) => rule.siteId === s.id)
          .map((rule) =>
            compileRuleModel(
              rule,
              lists.filter(
                (list) => list.organizationId === null || list.organizationId === s.organizationId,
              ),
            ),
          ),
        id: s.id,
        name: s.name,
        enabled: s.enabled,
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
            action: r.action === "bypass" ? "bypass" : "cache",
            edgeTtlSeconds: r.edgeTtlSeconds,
            originCacheControl: r.originCacheControl === "respect" ? "respect" : "override",
            staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
            staleIfErrorSeconds: r.staleIfErrorSeconds,
            cacheAuthorized: r.cacheAuthorized,
          })),
        cacheKey: readCacheKey(s.cacheKey),
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

function compileRuleModel(
  row: typeof schema.edgeRule.$inferSelect,
  lists: (typeof schema.ipList.$inferSelect)[],
): RuleModel {
  const bindings: Record<string, string> = Object.create(null);
  for (const list of lists.filter((l) => l.organizationId === null)) bindings[list.name] = list.id;
  for (const list of lists.filter((l) => l.organizationId !== null)) bindings[list.name] = list.id;
  return {
    id: row.id,
    phase: row.phase,
    expression: bindLists(parseExpression(row.expression, row.phase as Phase), bindings),
    action: ruleAction.parse(row.action),
  };
}

/** Why a revision is published; rendered per locale in the UI. */
export interface RevisionReason {
  code: RevisionReasonCode;
  params: ReasonParams;
}

async function insertRevision(
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
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${opts.clusterId}`}))`,
  );
  const sites = await loadSiteModels(tx, opts.clusterId);
  const organizations = await tx
    .selectDistinct({ id: schema.site.organizationId })
    .from(schema.site)
    .where(and(eq(schema.site.clusterId, opts.clusterId), eq(schema.site.enabled, true)));
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
  const platformRules = globalRules.map((rule) =>
    compileRuleModel(
      rule,
      lists.filter((list) => list.organizationId === null),
    ),
  );
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
      and(
        eq(schema.site.organizationId, schema.certificate.organizationId),
        eq(schema.site.clusterId, opts.clusterId),
        eq(schema.site.enabled, true),
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
  return insertRevision(
    tx,
    opts.clusterId,
    (revision) =>
      compileNodeConfig(
        {
          clusterId: opts.clusterId,
          sites,
          originAllowedCidrs,
          certificates,
          httpChallenges,
          ipLists,
          platformRules,
        },
        revision,
      ),
    opts.reason,
    opts.userId ?? null,
  );
}

/**
 * Publishes the content of an older revision as a new revision. The origin
 * allow list is platform policy, not cluster content: the new revision
 * carries the current list, not the one the old revision had.
 */
export async function rollbackToRevision(
  tx: Tx,
  opts: { clusterId: string; revision: number; userId?: string | null },
): Promise<{ row: RevisionRow; created: boolean } | undefined> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${opts.clusterId}`}))`,
  );
  const target = await getRevision(tx, opts.clusterId, opts.revision);
  if (!target) return undefined;
  const originAllowedCidrs = await loadOriginAllowList(tx);
  const restored = decodeNodeConfig(target.ir);
  const currentSites = await tx
    .select()
    .from(schema.site)
    .where(eq(schema.site.clusterId, opts.clusterId));
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
    for (const rule of site.rules) {
      if (
        !rule.expression ||
        listReferences(rule.expression).some(
          (id) =>
            !currentLists.some(
              (list) =>
                list.id === id && (list.organizationId === null || list.organizationId === org),
            ),
        )
      )
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback IP list is unavailable");
    }
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
  restored.platformRules = compileRules(
    platformRules.map((rule) =>
      compileRuleModel(
        rule,
        currentLists.filter((list) => list.organizationId === null),
      ),
    ),
  );
  restored.requiredFeatures = restored.requiredFeatures.filter(
    (f) => f !== "rules-v1" && !f.startsWith("geoip-"),
  );
  const rules = [...restored.platformRules, ...restored.sites.flatMap((s) => s.rules)];
  if (rules.length || restored.ipLists.some((l) => l.platform && l.kind !== "collection"))
    restored.requiredFeatures.push("rules-v1");
  restored.requiredFeatures.push(
    ...rules.flatMap((r) => (r.expression ? geoFeatures(r.expression) : [])),
  );
  // Challenge tokens are short-lived issuance state, never rollback content.
  restored.httpChallenges = [];
  restored.requiredFeatures = restored.requiredFeatures.filter((f) => f !== "http01-v1");
  return insertRevision(
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
}

/** Deletes revisions beyond the retention window, keeping the newest ones. */
export async function pruneRevisions(db: Executor, keep = REVISION_RETENTION): Promise<number> {
  const clusters = await db.select({ id: schema.cluster.id }).from(schema.cluster);
  let removed = 0;
  for (const { id } of clusters) {
    const latest = await latestRevision(db, id);
    if (!latest || latest.revision <= keep) continue;
    const deleted = await db
      .delete(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, id),
          lt(schema.configRevision.revision, latest.revision - keep + 1),
        ),
      )
      .returning({ id: schema.configRevision.id });
    removed += deleted.length;
  }
  return removed;
}
