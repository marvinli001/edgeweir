import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  type CacheRuleModel,
  type CacheZoneModel,
  type CompileInput,
  DEFAULT_CACHE_ZONE,
  decodeNodeConfig,
  expressionOf,
  keysZoneMbFor,
  type OfflineHostModel,
  type RuleModel,
  ruleModelOf,
  type SiteModel,
  TLS_PENDING_DOMAINS_FEATURE,
} from "@edgeweir/config-compiler";
import { nodeSupportsFeature, normalizeCidr, ruleAction, tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { CertificateRefSchema, HttpChallengeSchema, type NodeConfig } from "@edgeweir/proto";
import {
  bindLists,
  type Expression,
  type Phase,
  parseExpression,
  parseValueExpression,
} from "@edgeweir/rule-engine";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { parseCacheCondition } from "../lib/cache-conditions";
import { readCacheKey } from "../lib/cache-key";
import { uncoveredDomains } from "../lib/certificate-names";
import { fail } from "../lib/errors";
import { activeHealthCheckModel, sessionAffinityModel } from "../lib/pool-settings";
import { readContentSettings, readMaintenance } from "../lib/site-content";
import { PURGE_KEY } from "../lib/site-secrets";
import { loadEdgeModel } from "./edge";
import { errorPagesModel, loadPlatformErrorPages, loadSiteErrorPages } from "./error-pages";
import { loadL4AppModels } from "./l4-config";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import { loadPlatformProtection, loadSiteProtectionModels } from "./protection";
import { type Executor, latestRevision, type Tx } from "./revisions";
import { loadSiteWafModels } from "./waf";

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
 * Domains of the cluster's disabled sites: nodes answer them with the
 * platform's page for disabled sites instead of the unknown host page.
 * Current state, also when a revision is rolled back.
 */
export async function loadOfflineHosts(
  db: Executor,
  clusterId: string,
): Promise<OfflineHostModel[]> {
  const rows = await db
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(and(eq(schema.site.clusterId, clusterId), eq(schema.site.enabled, false)));
  return rows.map((row) => ({
    name: row.name,
    wildcard: row.kind === "wildcard",
    ...(row.kind === "suffix" || row.kind === "regex" ? { match: row.kind } : {}),
    reason: "disabled" as const,
  }));
}

/**
 * Loads every site of a cluster with its domains, origins and rules. Rules
 * and cache rule conditions are compiled for served sites only
 * (compileStoredRules); a served site with a refused one that has no
 * compiled form is left out (not enabled).
 */
export async function loadSiteModels(
  db: Executor,
  clusterId: string,
  opts: {
    strictSiteId?: string;
    previous?: () => Promise<NodeConfig | undefined>;
    invalid?: InvalidRule[];
  } = {},
): Promise<SiteModel[]> {
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
    .where(inArray(schema.siteDomain.siteId, siteIds))
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
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
  const purgeKeys = await db
    .select({
      id: schema.siteSecret.id,
      siteId: schema.siteSecret.siteId,
      version: schema.siteSecret.version,
    })
    .from(schema.siteSecret)
    .where(and(inArray(schema.siteSecret.siteId, siteIds), eq(schema.siteSecret.kind, PURGE_KEY)));

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
  const previous = opts.previous ?? previousConfig(db, clusterId);
  const compiled = new Map<string, Awaited<ReturnType<typeof compileStoredRules>>>();
  const bindings = listBindings(lists);
  for (const site of sites.filter((s) => s.enabled)) {
    const last = async () => (await previous())?.sites.find((s) => s.id === site.id);
    compiled.set(
      site.id,
      await compileStoredRules(
        site.name,
        edgeRules.filter((rule) => rule.siteId === site.id),
        rules.filter((rule) => rule.siteId === site.id),
        bindings,
        {
          strict: site.id === opts.strictSiteId,
          previous: last,
          invalid: opts.invalid ?? [],
        },
      ),
    );
  }
  const protection = await loadSiteProtectionModels(db, siteIds);
  const waf = await loadSiteWafModels(db, siteIds);
  const errorPages = await loadSiteErrorPages(db, siteIds);
  const certificateIds = [...new Set(sites.flatMap((s) => s.certificateId ?? []))];
  const chains = new Map(
    (certificateIds.length
      ? await db
          .select({ id: schema.certificate.id, chainPem: schema.certificate.chainPem })
          .from(schema.certificate)
          .where(inArray(schema.certificate.id, certificateIds))
      : []
    ).map((c) => [c.id, c.chainPem]),
  );
  // Nodes that serve a domain the site's certificate does not cover over
  // HTTP meanwhile: every active node of the cluster has to.
  const nodes = certificateIds.length
    ? await db
        .select({ features: schema.node.supportedFeatures })
        .from(schema.node)
        .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")))
    : [];
  const httpWhilePending = nodes.every((node) =>
    nodeSupportsFeature(node.features, TLS_PENDING_DOMAINS_FEATURE),
  );
  /**
   * The domains a site serves. Nodes refuse a site whose certificate misses
   * a domain, so a domain an ACME certificate is being reissued for
   * (coverSiteDomains) is served over HTTP only until the new chain covers
   * it (tlsPending), or, while a node of the cluster lacks
   * tls-pending-domains-v1, waits unserved. Its HTTP-01 challenge is
   * answered meanwhile either way.
   */
  const served = (
    site: (typeof sites)[number],
    rows: { name: string; kind: string }[],
  ): SiteModel["domains"] => {
    // Patterns are ordered by the site's creation time, then the order they were saved in.
    let pattern = 0;
    const all: SiteModel["domains"] = rows.map((row) => ({
      name: row.name,
      wildcard: row.kind === "wildcard",
      ...(row.kind === "suffix" ? { match: "suffix" as const } : {}),
      ...(row.kind === "regex"
        ? { match: "regex" as const, order: site.createdAt.getTime() * 16 + pattern++ }
        : {}),
    }));
    const chain = site.certificateId ? chains.get(site.certificateId) : undefined;
    if (!chain) return all;
    try {
      // Suffix and pattern domains are never uncovered (nodes check each host).
      const uncovered = new Set(uncoveredDomains(chain, rows));
      const pending = rows.map((row) => uncovered.has(row));
      return httpWhilePending
        ? all.map((domain, i) => (pending[i] ? { ...domain, tlsPending: true } : domain))
        : all.filter((_, i) => !pending[i]);
    } catch {
      return all;
    }
  };
  return sites
    .map((s): SiteModel => {
      const pool = pools
        .filter((p) => p.siteId === s.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      const site = compiled.get(s.id);
      return {
        rules: site?.rules ?? [],
        id: s.id,
        name: s.name,
        // Disabled sites are not shipped (their DNS records stay).
        enabled: s.enabled && !site?.missing,
        cacheGeneration: s.cacheGeneration,
        logSampleRate: s.logSampleRate,
        domains: served(
          s,
          domains.filter((d) => d.siteId === s.id),
        ),
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
                protocol: pool.protocol === "http2" ? "http2" : "http1",
                grpc: pool.grpc,
                tries: pool.tries,
                statusRetry: pool.statusRetry,
              }
            : undefined,
          // Compiled only while on; the settings are kept while off.
          activeHealthCheck: pool ? activeHealthCheckModel(pool.activeHealthCheck) : null,
          sessionAffinity: pool ? sessionAffinityModel(pool.sessionAffinity) : null,
        },
        cacheRules: site?.cacheRules ?? [],
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
          ? errorPagesModel(errorPages.get(s.id) ?? [], s.interceptOriginErrors)
          : null,
        rangeSlice: s.rangeSlice,
        websocket: s.websocket,
        ports: { http: [...s.httpPorts], https: [...s.httpsPorts] },
        ...contentModel(
          s,
          purgeKeys.find((key) => key.siteId === s.id),
        ),
        certificateId: s.certificateId ?? "",
        // Always compiled: the node's per-site server, which carries compression, exists only
        // with it, and a site without a certificate or saved HTTPS settings is compressed with
        // the defaults the HTTPS tab shows.
        tls: (() => {
          const { certificateId: _certificateId, ...tls } = tlsSettings.parse({
            ...s.tlsSettings,
            certificateId: s.certificateId,
          });
          return tls;
        })(),
      };
    })
    .filter((site) => site.domains.length > 0);
}

/**
 * The site-content-v1 settings of a site (proto v0.24.0): the PURGE key
 * reference while the method is on and a key exists, X-Cache, maintenance
 * while on, the charset while set and the body limit.
 */
function contentModel(
  s: typeof schema.site.$inferSelect,
  purgeKey: { id: string; version: number } | undefined,
): Pick<SiteModel, "purge" | "hideXCache" | "maintenance" | "charset" | "requestBodyLimit"> {
  const maintenance = readMaintenance(s.maintenance);
  const { charset, requestBodyLimit } = readContentSettings(s);
  return {
    purge:
      s.purgeMethod && purgeKey
        ? { credentialId: purgeKey.id, credentialVersion: purgeKey.version }
        : null,
    hideXCache: s.hideXCache,
    maintenance: maintenance.enabled
      ? {
          template: maintenance.template,
          retryAfterSeconds: maintenance.retryAfterSeconds,
          allowedCidrs: maintenance.allowedCidrs,
          allowedPathPrefixes: maintenance.allowedPathPrefixes,
        }
      : null,
    charset:
      charset.name === "off"
        ? null
        : { name: charset.name, force: charset.force, uppercase: charset.uppercase },
    requestBodyLimit,
  };
}

/** IP list names to ids (list names are unique). */
export function listBindings(
  lists: Pick<typeof schema.ipList.$inferSelect, "id" | "name">[],
): Record<string, string> {
  const bindings: Record<string, string> = Object.create(null);
  for (const list of lists) bindings[list.name] = list.id;
  return bindings;
}

/** A rule model, or why the current validator refuses the stored rule. */
function tryCompileRuleModel(
  row: typeof schema.edgeRule.$inferSelect,
  bindings: Record<string, string>,
): RuleModel | { invalid: string } {
  let expression: Expression;
  let action: RuleModel["action"];
  try {
    expression = parseExpression(row.expression, row.phase as Phase);
    action = ruleAction.parse(row.action);
    // Value expressions: targets and set query parameters, header values (rules-v3).
    const values =
      action.kind === "redirect" || action.kind === "rewrite"
        ? [action.target, ...(action.setQuery ?? []).map((param) => param.expression)]
        : action.kind === "request_header" || action.kind === "response_header"
          ? [action.expression]
          : [];
    for (const source of values) if (source) parseValueExpression(source, row.phase as Phase);
  } catch (error) {
    return { invalid: (error as Error).message };
  }
  return {
    id: row.id,
    phase: row.phase,
    expression: bindLists(expression, bindings),
    action,
  };
}

/** A cache rule's model, or why the current validator refuses its stored condition. */
function tryCacheRuleModel(
  r: typeof schema.cacheRule.$inferSelect,
  bindings: Record<string, string>,
): CacheRuleModel | { invalid: string } {
  let condition: Expression | undefined;
  try {
    condition = r.expression ? bindLists(parseCacheCondition(r.expression), bindings) : undefined;
  } catch (error) {
    return { invalid: (error as Error).message };
  }
  return {
    id: r.id,
    priority: r.priority,
    pathPrefixes: r.pathPrefixes,
    paths: r.paths,
    extensions: r.extensions,
    statusCodes: r.statusCodes,
    minSizeBytes: r.minSizeBytes,
    maxSizeBytes: r.maxSizeBytes,
    expression: r.expression,
    condition,
    browserTtlSeconds: r.browserTtlSeconds,
    action: r.action === "bypass" ? "bypass" : "cache",
    edgeTtlSeconds: r.edgeTtlSeconds,
    originCacheControl: r.originCacheControl === "respect" ? "respect" : "override",
    staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
    staleIfErrorSeconds: r.staleIfErrorSeconds,
    cacheAuthorized: r.cacheAuthorized,
    cacheSetCookie: r.cacheSetCookie,
  };
}

/**
 * A stored rule or cache rule the current validator refuses (stored by an
 * earlier, more lenient version); a cache rule is named after its site.
 */
interface InvalidRule {
  id: string;
  name: string;
  message: string;
}

const ruleInvalid = (rule: { name: string; message: string }): never =>
  fail("RULE_INVALID", `rule ${rule.name} is no longer valid: ${rule.message}`);

/**
 * Compiles a site's stored rules and cache rule conditions (or, without
 * `cacheRows`, the platform's rules). One the current validator refuses
 * keeps its last compiled form (`previous`: the site in the latest
 * revision) and is added to `invalid`; `strict` (the change is about this
 * site) refuses it with RULE_INVALID instead. `missing` is a refused one
 * without a compiled form.
 */
async function compileStoredRules(
  siteName: string,
  rows: (typeof schema.edgeRule.$inferSelect)[],
  cacheRows: (typeof schema.cacheRule.$inferSelect)[],
  bindings: Record<string, string>,
  opts: {
    strict: boolean;
    previous: () => Promise<Pick<NodeConfig["sites"][number], "rules" | "cacheRules"> | undefined>;
    invalid: InvalidRule[];
  },
): Promise<{ rules: RuleModel[]; cacheRules: CacheRuleModel[]; missing?: InvalidRule }> {
  const out: Awaited<ReturnType<typeof compileStoredRules>> = { rules: [], cacheRules: [] };
  const refused = (rule: InvalidRule) => {
    if (opts.strict) ruleInvalid(rule);
    opts.invalid.push(rule);
  };
  for (const row of rows) {
    const model = tryCompileRuleModel(row, bindings);
    if (!("invalid" in model)) {
      out.rules.push(model);
      continue;
    }
    const rule = { id: row.id, name: row.name, message: model.invalid };
    refused(rule);
    const last = (await opts.previous())?.rules.find((r) => r.id === row.id);
    if (last) out.rules.push(ruleModelOf(last));
    else out.missing ??= rule;
  }
  for (const row of cacheRows) {
    const model = tryCacheRuleModel(row, bindings);
    if (!("invalid" in model)) {
      out.cacheRules.push(model);
      continue;
    }
    const rule = { id: row.id, name: siteName, message: model.invalid };
    if (opts.strict) fail("RULE_INVALID", `cache rule is no longer valid: ${model.invalid}`);
    refused(rule);
    const last = (await opts.previous())?.cacheRules.find((r) => r.id === row.id);
    const base = tryCacheRuleModel({ ...row, expression: "" }, bindings) as CacheRuleModel;
    if (last?.match?.condition)
      out.cacheRules.push({ ...base, condition: expressionOf(last.match.condition) });
    else if (last)
      out.cacheRules.push({
        ...base,
        pathPrefixes: [...(last.match?.pathPrefixes ?? [])],
        paths: [...(last.match?.paths ?? [])],
        extensions: [...(last.match?.extensions ?? [])],
      });
    else out.missing ??= rule;
  }
  return out;
}

/** The decoded latest revision of a cluster, read once and only when asked for. */
export function previousConfig(db: Executor, clusterId: string) {
  let config: Promise<NodeConfig | undefined> | undefined;
  return () => {
    config ??= latestRevision(db, clusterId).then((row) =>
      row ? decodeNodeConfig(row.ir) : undefined,
    );
    return config;
  };
}

/** The platform's stored rules, refused ones in their last compiled form (else RULE_INVALID). */
export async function platformRuleModels(
  tx: Executor,
  lists: (typeof schema.ipList.$inferSelect)[],
  previous: () => Promise<NodeConfig | undefined>,
  invalid: InvalidRule[],
) {
  const rows = await tx
    .select()
    .from(schema.edgeRule)
    .where(and(sql`${schema.edgeRule.siteId} is null`, eq(schema.edgeRule.enabled, true)))
    .orderBy(asc(schema.edgeRule.priority));
  const platform = await compileStoredRules("", rows, [], listBindings(lists), {
    strict: false,
    previous: async () => ({ rules: (await previous())?.platformRules ?? [], cacheRules: [] }),
    invalid,
  });
  if (platform.missing) ruleInvalid(platform.missing);
  return platform.rules;
}

/**
 * Raises a platform alert for each stored rule that kept its last compiled
 * form, and resolves those of rules that compile again or are gone.
 */
async function syncRuleAlerts(tx: Tx, invalid: InvalidRule[]) {
  for (const rule of invalid)
    await raisePlatformAlert(tx, "config_rule_invalid", rule.id, rule.name);
  const firing = await tx
    .select({ resourceId: schema.alertState.resourceId })
    .from(schema.alertState)
    .where(
      and(eq(schema.alertState.kind, "config_rule_invalid"), eq(schema.alertState.active, true)),
    );
  const stale = firing.filter((state) => !invalid.some((rule) => rule.id === state.resourceId));
  if (!stale.length) return;
  const bindings = listBindings(await tx.select().from(schema.ipList));
  for (const { resourceId } of stale) {
    const [rule] = await tx
      .select()
      .from(schema.edgeRule)
      .where(eq(schema.edgeRule.id, resourceId));
    const [cache] = rule
      ? []
      : await tx.select().from(schema.cacheRule).where(eq(schema.cacheRule.id, resourceId));
    const still =
      (rule?.enabled && "invalid" in tryCompileRuleModel(rule, bindings)) ||
      (cache && "invalid" in tryCacheRuleModel(cache, bindings));
    if (!still) await resolvePlatformAlert(tx, "config_rule_invalid", resourceId, rule?.name ?? "");
  }
}

/** The cluster's ACME HTTP-01 challenges of running certificate operations. */
export async function loadHttpChallenges(tx: Executor, clusterId: string) {
  const challenges = await tx
    .selectDistinct({ challenge: schema.acmeChallenge })
    .from(schema.acmeChallenge)
    .innerJoin(schema.certificate, eq(schema.certificate.id, schema.acmeChallenge.certificateId))
    .innerJoin(
      schema.site,
      // Disabled sites keep answering HTTP-01: renewals continue.
      eq(schema.site.clusterId, clusterId),
    )
    .innerJoin(
      schema.siteDomain,
      and(
        eq(schema.siteDomain.siteId, schema.site.id),
        eq(schema.siteDomain.name, schema.acmeChallenge.domain),
        eq(schema.siteDomain.kind, "exact"),
      ),
    )
    .where(
      and(
        gt(schema.acmeChallenge.expiresAt, new Date()),
        eq(schema.acmeChallenge.operationStartedAt, schema.certificate.operationStartedAt),
      ),
    );
  return challenges
    .map(({ challenge }) => challenge)
    .map((c) =>
      create(HttpChallengeSchema, {
        domain: c.domain,
        token: c.token,
        keyAuthorization: c.keyAuthorization,
        expiresAt: timestampFromDate(c.expiresAt),
      }),
    );
}

/**
 * The cluster's cache zone: its size on every node (a node may have its
 * own, cache-zone-v1) and inactive time. The defaults (10 GiB, 7 days)
 * compile as the configurations before cluster cache settings did.
 */
export async function loadCacheZones(db: Executor, clusterId: string): Promise<CacheZoneModel[]> {
  const [cluster] = await db
    .select({
      maxSizeGb: schema.cluster.cacheMaxSizeGb,
      inactiveDays: schema.cluster.cacheInactiveDays,
    })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  const nodes = await db
    .select({ id: schema.node.id, maxSizeGb: schema.node.cacheMaxSizeGb })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, clusterId), isNotNull(schema.node.cacheMaxSizeGb)));
  const maxSizeMb = (cluster?.maxSizeGb ?? 10) * 1024;
  return [
    {
      name: DEFAULT_CACHE_ZONE,
      maxSizeMb,
      keysZoneMb: keysZoneMbFor(maxSizeMb),
      inactiveSeconds: (cluster?.inactiveDays ?? 7) * 86_400,
      nodeSizes: nodes.flatMap((node) =>
        node.maxSizeGb === null
          ? []
          : [
              {
                nodeId: node.id,
                maxSizeMb: node.maxSizeGb * 1024,
                keysZoneMb: keysZoneMbFor(node.maxSizeGb * 1024),
              },
            ],
      ),
    },
  ];
}

/**
 * What the cluster's configuration is compiled from now, except its
 * challenge keys. Stored rules the current validator refuses keep their
 * last compiled form and raise config_rule_invalid (resolved once they
 * compile again); those of `site` refuse with RULE_INVALID instead.
 */
export async function loadConfigInput(
  tx: Tx,
  clusterId: string,
  opts: { site?: string } = {},
): Promise<CompileInput> {
  const previous = previousConfig(tx, clusterId);
  const invalid: InvalidRule[] = [];
  const sites = await loadSiteModels(tx, clusterId, {
    strictSiteId: opts.site,
    previous,
    invalid,
  });
  // Every list is the operator's: allow and block lists apply to every site,
  // and any rule may refer to any list.
  const lists = await tx.select().from(schema.ipList);
  const ipLists = lists.map((list) => ({
    id: list.id,
    name: list.name,
    entries: list.entries,
    kind: list.kind,
    platform: true,
  }));
  const platformRules = await platformRuleModels(tx, lists, previous, invalid);
  await syncRuleAlerts(tx, invalid);
  const originAllowedCidrs = await loadOriginAllowList(tx);
  const l4Apps = await loadL4AppModels(tx, clusterId);
  const certIds = [
    ...new Set([
      ...sites.filter((s) => s.enabled && s.certificateId).map((s) => s.certificateId as string),
      // TCP applications that terminate TLS (l4-v2).
      ...l4Apps.filter((a) => a.enabled && a.certificateId).map((a) => a.certificateId as string),
    ]),
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
  const httpChallenges = await loadHttpChallenges(tx, clusterId);
  const platformProtection = await loadPlatformProtection(tx);
  return {
    clusterId,
    cacheZones: await loadCacheZones(tx, clusterId),
    sites,
    originAllowedCidrs,
    certificates,
    httpChallenges,
    ipLists,
    platformRules,
    platformProtection,
    platformErrorPages: await loadPlatformErrorPages(tx),
    offlineHosts: await loadOfflineHosts(tx, clusterId),
    l4Apps,
    edge: await loadEdgeModel(tx, clusterId),
  };
}
