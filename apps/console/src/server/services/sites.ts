import { randomUUID } from "node:crypto";
import type {
  AuditAction,
  Revision,
  RevisionReasonCode,
  Site,
  StarredSite,
  siteCreateInput,
  siteUpdateInput,
} from "@edgeweir/contract";
import { tlsSettings } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  like as like_,
  ne,
  notExists,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type * as z from "zod";
import {
  cacheConditionLists,
  storedCacheExpression,
  structuredForm,
} from "../lib/cache-conditions";
import { readCacheKey } from "../lib/cache-key";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { assertHostHeader } from "../lib/host-header";
import { lockDomains, lockStats } from "../lib/locks";
import { readActiveHealthCheck, readSessionAffinity } from "../lib/pool-settings";
import { readContentSettings } from "../lib/site-content";
import {
  asciiSearch,
  type DomainRow,
  formatDomain,
  namesHosts,
  normalizeDomains,
  unicodeDomainHolds,
  unicodeSearchTerm,
} from "../lib/site-domains";
import { PURGE_KEY, siteSecret, storeSiteSecret } from "../lib/site-secrets";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { coverSiteDomains } from "./certificates";
import { defaultClusterId } from "./clusters";
import { newCnamePrefix } from "./cname-prefixes";
import { listBindings } from "./config-input";
import { assertOriginsAllowed } from "./origin-allow-list";
import {
  type Executor,
  latestRevision,
  publishRevision,
  type Tx,
  toRevisionDto,
} from "./revisions";
import { actionOriginGroup, availableLists, failUnknownLists } from "./rules";
import { siteDeliveries } from "./site-delivery";
import { assertSitePorts, portsOf } from "./site-ports";
import { flushSiteUsage } from "./usage";

type SiteCreate = z.output<typeof siteCreateInput>;
type SiteUpdate = z.output<typeof siteUpdateInput>;
type OriginInput = SiteCreate["origins"][number];
type CacheRuleInput = SiteCreate["cacheRules"][number];
type OriginSettingsInput = SiteCreate["originSettings"];
type CacheSettingsInput = SiteCreate["cacheSettings"];
type ContentSettingsInput = SiteCreate["contentSettings"];

/** Envelope binding of an S3 secret access key: the column and the credential row (AAD). */
export const S3_SECRET_PURPOSE = "origin_credential.secret_envelope";
export const s3SecretBinding = (credentialId: string) => ({
  purpose: S3_SECRET_PURPOSE,
  recordId: credentialId,
});
/** The purpose version 1 envelopes were sealed with (no record id). */
export const LEGACY_S3_SECRET_PURPOSE = "origin-credential/s3-secret";

type SiteRow = typeof schema.site.$inferSelect;

async function toSiteDtos(db: Executor, rows: SiteRow[]): Promise<Site[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(inArray(schema.siteDomain.siteId, ids))
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
  const pools = await db
    .select()
    .from(schema.originPool)
    .where(inArray(schema.originPool.siteId, ids));
  const rules = await db
    .select()
    .from(schema.cacheRule)
    .where(inArray(schema.cacheRule.siteId, ids))
    .orderBy(asc(schema.cacheRule.priority), asc(schema.cacheRule.createdAt));
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster);
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
        .orderBy(asc(schema.origin.createdAt), asc(schema.origin.id))
    : [];
  const credentials = await db
    .select({ id: schema.originCredential.id, accessKeyId: schema.originCredential.accessKeyId })
    .from(schema.originCredential)
    .where(inArray(schema.originCredential.siteId, ids));
  const deliveries = await siteDeliveries(db, rows);
  const purgeKeys = await db
    .select({ siteId: schema.siteSecret.siteId })
    .from(schema.siteSecret)
    .where(and(inArray(schema.siteSecret.siteId, ids), eq(schema.siteSecret.kind, PURGE_KEY)));
  return rows.map((r) => {
    const sitePools = pools
      .filter((p) => p.siteId === r.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const poolIds = new Set(sitePools.map((p) => p.id));
    const pool = sitePools[0];
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
      delivery: deliveries.get(r.id) ?? {
        state: "pending",
        totalNodes: 0,
        servingNodes: 0,
        currentNodes: 0,
        canary: null,
      },
      cacheGeneration: r.cacheGeneration,
      ports: portsOf(r),
      domains: domains.filter((d) => d.siteId === r.id).map(formatDomain),
      cnamePrefix: r.cnamePrefix,
      origins: origins
        .filter((o) => poolIds.has(o.poolId))
        .map((o) => ({
          id: o.id,
          address: o.address,
          port: o.port,
          scheme: o.scheme === "https" ? "https" : "http",
          weight: o.weight,
          backup: o.backup,
          hostHeader: o.hostHeader,
          sni: o.sni,
          group: o.groupName,
          s3: o.credentialId
            ? {
                region: o.s3Region,
                bucket: o.s3Bucket,
                accessKeyId: credentials.find((c) => c.id === o.credentialId)?.accessKeyId ?? "",
              }
            : null,
        })),
      cacheRules: rules
        .filter((c) => c.siteId === r.id)
        .map((c) => {
          const expression = storedCacheExpression(c);
          const structured = structuredForm(expression);
          return {
            id: c.id,
            priority: c.priority,
            expression,
            // The builder's form of the condition when it has one.
            pathPrefixes: structured?.pathPrefixes ?? [],
            paths: structured?.paths ?? [],
            extensions: structured?.extensions ?? [],
            statusCodes: c.statusCodes,
            minSizeBytes: c.minSizeBytes,
            maxSizeBytes: c.maxSizeBytes,
            action: c.action === "bypass" ? "bypass" : "cache",
            edgeTtlSeconds: c.edgeTtlSeconds,
            originCacheControl: c.originCacheControl === "respect" ? "respect" : "override",
            staleWhileRevalidateSeconds: c.staleWhileRevalidateSeconds,
            staleIfErrorSeconds: c.staleIfErrorSeconds,
            cacheAuthorized: c.cacheAuthorized,
            browserTtlSeconds: c.browserTtlSeconds,
            cacheSetCookie: c.cacheSetCookie,
          };
        }),
      originSettings: {
        policy: (pool?.policy ?? "weighted_random") as Site["originSettings"]["policy"],
        tlsVerify: pool?.tlsVerify ?? true,
        maxFails: pool?.maxFails ?? 3,
        recoverySeconds: pool?.recoverySeconds ?? 30,
        connectTimeoutMs: pool?.connectTimeoutMs ?? 10_000,
        sendTimeoutMs: pool?.sendTimeoutMs ?? 60_000,
        readTimeoutMs: pool?.readTimeoutMs ?? 60_000,
        keepalive: pool?.keepalive ?? true,
        keepaliveIdleSeconds: pool?.keepaliveIdleSeconds ?? 60,
        keepaliveMaxRequests: pool?.keepaliveMaxRequests ?? 1000,
        websocket: r.websocket,
        protocol: pool?.protocol === "http2" ? "http2" : "http1",
        grpc: pool?.grpc ?? false,
        activeHealthCheck: readActiveHealthCheck(pool?.activeHealthCheck),
        sessionAffinity: readSessionAffinity(pool?.sessionAffinity),
        tries: pool?.tries ?? 3,
        statusRetry: pool?.statusRetry ?? true,
      },
      cacheSettings: {
        cacheKey: readCacheKey(r.cacheKey),
        rangeSlice: r.rangeSlice,
        keepCacheTag: r.keepCacheTag,
        xCache: !r.hideXCache,
        purgeMethod: {
          enabled: r.purgeMethod,
          keySet: purgeKeys.some((k) => k.siteId === r.id),
        },
      },
      contentSettings: readContentSettings(r),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** One page of sites, filtered by name/domain search and cluster. */
export async function listSites(
  db: Database,
  query: { search?: string; clusterId?: string; page: number; pageSize: number },
): Promise<{ items: Site[]; total: number }> {
  const filters: (SQL | undefined)[] = [];
  if (query.clusterId) filters.push(eq(schema.site.clusterId, query.clusterId));
  if (query.search) {
    const like = (term: string) => `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Unicode host names are stored as Punycode: search both forms.
    const ascii = asciiSearch(query.search);
    const term = unicodeSearchTerm(query.search);
    const patterns = [
      ...new Set([query.search, ...(ascii ? [ascii] : []), ...(term ? [term] : [])].map(like)),
    ];
    // Part of a Unicode label, or a term that runs past one (ASCII ones
    // too): decode the Punycode names and look in them.
    const unicodeIds = [
      ...new Set(
        (
          await db
            .select({
              siteId: schema.siteDomain.siteId,
              name: schema.siteDomain.name,
              kind: schema.siteDomain.kind,
            })
            .from(schema.siteDomain)
            .where(like_(schema.siteDomain.name, "%xn--%"))
        )
          .filter((row) => unicodeDomainHolds(row, term))
          .map((row) => row.siteId),
      ),
    ];
    // Domains are stored without "*.", "." or "~" but match searches like "*.demo".
    const formatted = sql`case ${schema.siteDomain.kind} when 'wildcard' then '*.' || ${schema.siteDomain.name} when 'suffix' then '.' || ${schema.siteDomain.name} when 'regex' then '~' || ${schema.siteDomain.name} else ${schema.siteDomain.name} end`;
    filters.push(
      or(
        ilike(schema.site.name, like(query.search)),
        unicodeIds.length ? inArray(schema.site.id, unicodeIds) : undefined,
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.siteDomain)
            .where(
              and(
                eq(schema.siteDomain.siteId, schema.site.id),
                or(...patterns.map((pattern) => ilike(formatted, pattern))),
              ),
            ),
        ),
      ),
    );
  }
  const where = and(...filters);
  const [total] = await db.select({ n: count() }).from(schema.site).where(where);
  const rows = await db
    .select()
    .from(schema.site)
    .where(where)
    .orderBy(asc(schema.site.createdAt), asc(schema.site.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { items: await toSiteDtos(db, rows), total: total?.n ?? 0 };
}

export async function findSite(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.site).where(eq(schema.site.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}

/**
 * Locks sites against their deletion until the transaction ends (FOR KEY
 * SHARE, in id order) and returns the ids of those that still exist. Each
 * argument is a list of ids or a subquery selecting them.
 *
 * Deleting a site (or an origin, in updateSite) locks the site row first and
 * then deletes the rows that reference it by cascade. A writer that changed
 * or deleted one of those rows first and then inserted another, whose
 * foreign key check waits for the site row, deadlocked with it (SQLSTATE
 * 40P01: the deletion, waiting first, was the one aborted). Background
 * writers of such rows (node reports, the alert sweep) call this before they
 * touch any of them, so both sides wait on the site row: a deletion waits
 * for the writer, and a writer that waited for a deletion finds the site
 * gone and skips its rows. FOR KEY SHARE conflicts with deleting the row and
 * FOR UPDATE only, not with updates of the site.
 */
export async function shareSites(
  tx: Executor,
  ...ids: (readonly string[] | SQLWrapper)[]
): Promise<Set<string>> {
  const sources = ids.filter((set) => !Array.isArray(set) || set.length > 0);
  if (!sources.length) return new Set();
  const rows = await tx
    .select({ id: schema.site.id })
    .from(schema.site)
    .where(or(...sources.map((set) => inArray(schema.site.id, set))))
    .orderBy(asc(schema.site.id))
    .for("key share");
  return new Set(rows.map((row) => row.id));
}

async function toSiteDto(db: Executor, row: SiteRow): Promise<Site> {
  const [dto] = await toSiteDtos(db, [row]);
  if (!dto) throw new Error("site not readable");
  return dto;
}

export async function getSite(db: Database, id: string): Promise<Site> {
  return toSiteDto(db, await findSite(db, id));
}

/**
 * Child rows inserted in one statement share now(); explicit, increasing
 * timestamps keep them in the order the user entered them.
 */
const ordered = (index: number, base = Date.now()) => new Date(base + index);

/** Every domain (name and form) belongs to exactly one site. */
async function assertDomainsFree(tx: Tx, domains: DomainRow[], exceptSiteId?: string) {
  await lockDomains(
    tx,
    domains.map((d) => d.name),
  );
  const taken = await tx
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(
      and(
        or(
          ...domains.map((d) =>
            and(eq(schema.siteDomain.name, d.name), eq(schema.siteDomain.kind, d.kind)),
          ),
        ),
        exceptSiteId ? ne(schema.siteDomain.siteId, exceptSiteId) : undefined,
      ),
    );
  if (taken.length) {
    const list = taken.map(formatDomain).join(", ");
    fail("DOMAIN_IN_USE", `domain already in use: ${list}`, { domains: list });
  }
}

/**
 * Resolves the credential of every S3 origin: a given secret creates or
 * rotates the site's credential for that access key (version + 1); without a
 * secret the stored credential of the same access key is kept. Credentials no
 * origin uses any more are deleted.
 */
async function syncCredentials(
  tx: Tx,
  siteId: string,
  origins: OriginInput[],
  masterKey: MasterKey,
): Promise<Map<string, string>> {
  const existing = await tx
    .select()
    .from(schema.originCredential)
    .where(eq(schema.originCredential.siteId, siteId));
  const byKey = new Map(existing.map((c) => [c.accessKeyId, c]));
  const used = new Map<string, string>();
  for (const o of origins) {
    if (!o.s3) continue;
    const { accessKeyId, secretAccessKey } = o.s3;
    const current = byKey.get(accessKeyId);
    if (secretAccessKey) {
      // The id is part of the envelope's AAD, so a new row gets its id first.
      const id = current?.id ?? randomUUID();
      const secretEnvelope = JSON.stringify(masterKey.seal(secretAccessKey, s3SecretBinding(id)));
      if (current) {
        const [row] = await tx
          .update(schema.originCredential)
          .set({ secretEnvelope, version: current.version + 1 })
          .where(eq(schema.originCredential.id, current.id))
          .returning();
        if (row) byKey.set(accessKeyId, row);
      } else {
        const [row] = await tx
          .insert(schema.originCredential)
          .values({ id, siteId, accessKeyId, secretEnvelope })
          .returning();
        if (row) byKey.set(accessKeyId, row);
      }
    } else if (!current) {
      fail("S3_SECRET_REQUIRED", `secret access key required for ${accessKeyId}`, {
        accessKeyId,
      });
    }
    const credential = byKey.get(accessKeyId);
    if (credential) used.set(accessKeyId, credential.id);
  }
  const unused = existing.filter((c) => !used.has(c.accessKeyId)).map((c) => c.id);
  if (unused.length) {
    await tx.delete(schema.originCredential).where(inArray(schema.originCredential.id, unused));
  }
  return used;
}

/**
 * Writes a pool's origins in the given order. An existing origin with the
 * same scheme, address and port keeps its id (and with it the passive health
 * state nodes report for it); the others are inserted or deleted.
 */
async function writeOrigins(
  tx: Tx,
  pool: { id: string; siteId: string },
  origins: OriginInput[],
  masterKey: MasterKey,
) {
  const credentials = await syncCredentials(tx, pool.siteId, origins, masterKey);
  const existing = await tx
    .select({
      id: schema.origin.id,
      address: schema.origin.address,
      port: schema.origin.port,
      scheme: schema.origin.scheme,
    })
    .from(schema.origin)
    .where(eq(schema.origin.poolId, pool.id))
    .orderBy(asc(schema.origin.createdAt));
  const base = Date.now();
  const kept = new Set<string>();
  for (const [i, o] of origins.entries()) {
    const values = {
      createdAt: ordered(i, base),
      poolId: pool.id,
      address: o.address,
      port: o.port,
      scheme: o.scheme,
      weight: o.weight,
      backup: o.backup,
      hostHeader: o.hostHeader,
      sni: o.sni,
      groupName: o.group,
      credentialId: o.s3 ? (credentials.get(o.s3.accessKeyId) ?? null) : null,
      s3Region: o.s3?.region ?? "",
      s3Bucket: o.s3?.bucket ?? "",
    };
    const match = existing.find(
      (e) =>
        !kept.has(e.id) && e.address === o.address && e.port === o.port && e.scheme === o.scheme,
    );
    if (match) {
      kept.add(match.id);
      await tx.update(schema.origin).set(values).where(eq(schema.origin.id, match.id));
    } else {
      await tx.insert(schema.origin).values(values);
    }
  }
  const removed = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (removed.length) await tx.delete(schema.origin).where(inArray(schema.origin.id, removed));
}

/** Pool settings whose omission in an update keeps the stored value. */
type KeptPoolSettings =
  | "activeHealthCheck"
  | "sessionAffinity"
  | "protocol"
  | "grpc"
  | "tries"
  | "statusRetry";

/** gRPC goes to the origins over HTTP/2 only. */
function assertGrpcOverHttp2(settings: Pick<OriginSettingsInput, "protocol" | "grpc">) {
  if (settings.grpc && settings.protocol !== "http2")
    fail("ORIGIN_GRPC_REQUIRES_HTTP2", "gRPC requires HTTP/2 towards the origins");
}

/**
 * Pool columns of the settings; health check, affinity, protocol, gRPC,
 * tries and status retries only when given (kept otherwise).
 */
function poolSettingsValues(
  settings: Omit<OriginSettingsInput, KeptPoolSettings> &
    Partial<Pick<OriginSettingsInput, KeptPoolSettings>>,
) {
  return {
    policy: settings.policy,
    tlsVerify: settings.tlsVerify,
    maxFails: settings.maxFails,
    recoverySeconds: settings.recoverySeconds,
    connectTimeoutMs: settings.connectTimeoutMs,
    sendTimeoutMs: settings.sendTimeoutMs,
    readTimeoutMs: settings.readTimeoutMs,
    keepalive: settings.keepalive,
    keepaliveIdleSeconds: settings.keepaliveIdleSeconds,
    keepaliveMaxRequests: settings.keepaliveMaxRequests,
    ...(settings.protocol ? { protocol: settings.protocol } : {}),
    ...(settings.grpc !== undefined ? { grpc: settings.grpc } : {}),
    ...(settings.activeHealthCheck ? { activeHealthCheck: settings.activeHealthCheck } : {}),
    ...(settings.sessionAffinity ? { sessionAffinity: settings.sessionAffinity } : {}),
    ...(settings.tries !== undefined ? { tries: settings.tries } : {}),
    ...(settings.statusRetry !== undefined ? { statusRetry: settings.statusRetry } : {}),
  };
}

/**
 * Site columns of the cache settings; keepCacheTag, xCache and the PURGE
 * method only when given (kept otherwise).
 */
function cacheSettingsValues(
  settings: Omit<CacheSettingsInput, KeptCacheSettings> &
    Partial<Pick<CacheSettingsInput, KeptCacheSettings>>,
) {
  return {
    cacheKey: settings.cacheKey,
    rangeSlice: settings.rangeSlice,
    ...(settings.keepCacheTag !== undefined ? { keepCacheTag: settings.keepCacheTag } : {}),
    ...(settings.xCache !== undefined ? { hideXCache: !settings.xCache } : {}),
    ...(settings.purgeMethod !== undefined ? { purgeMethod: settings.purgeMethod.enabled } : {}),
  };
}
type KeptCacheSettings = "keepCacheTag" | "xCache" | "purgeMethod";

/**
 * Stores a new PURGE key when given; turning the method on needs one
 * (PURGE_KEY_REQUIRED). The key never enters audit entries or responses.
 */
async function writePurgeKey(
  tx: Tx,
  masterKey: MasterKey,
  siteId: string,
  purge: CacheSettingsInput["purgeMethod"] | undefined,
): Promise<boolean> {
  if (!purge) return false;
  if (purge.key) await storeSiteSecret(tx, masterKey, siteId, PURGE_KEY, purge.key);
  else if (purge.enabled && !(await siteSecret(tx, siteId, PURGE_KEY)))
    fail("PURGE_KEY_REQUIRED", "the PURGE method needs a key");
  return purge.key !== undefined;
}

/** The cache settings as audited: the PURGE key only as "changed". */
function auditedCacheSettings(
  settings: Partial<Pick<CacheSettingsInput, "purgeMethod">> & Record<string, unknown>,
) {
  const { purgeMethod, ...rest } = settings;
  return purgeMethod
    ? { ...rest, purgeMethod: { enabled: purgeMethod.enabled, keyChanged: !!purgeMethod.key } }
    : rest;
}

/** Site columns of the content settings; an omitted rulesBodyLimit stays as it is. */
function contentSettingsValues(
  settings: Omit<ContentSettingsInput, "rulesBodyLimit"> & { rulesBodyLimit?: number },
) {
  const { name, force, uppercase } = settings.charset;
  return {
    charset: name === "off" ? {} : { name, force, uppercase },
    requestBodyLimit: settings.requestBodyLimit,
    ...(settings.rulesBodyLimit !== undefined ? { rulesBodyLimit: settings.rulesBodyLimit } : {}),
  };
}

/** Cache rule columns that make up a rule's content. */
const CACHE_RULE_FIELDS = [
  "priority",
  "expression",
  "listIds",
  "pathPrefixes",
  "paths",
  "extensions",
  "statusCodes",
  "minSizeBytes",
  "maxSizeBytes",
  "action",
  "edgeTtlSeconds",
  "originCacheControl",
  "staleWhileRevalidateSeconds",
  "staleIfErrorSeconds",
  "cacheAuthorized",
  "browserTtlSeconds",
  "cacheSetCookie",
] as const;

/**
 * Replaces a site's cache rules, with their condition as an expression (the
 * builder's expression of the structured lists when they have none) and
 * the IP lists it references; the structured columns stay empty.
 * Priorities are unique (an omitted one is the rule's position,
 * (index + 1) × 10), so rules apply in a fixed order; a rule saved
 * unchanged keeps its id, so saving the same rules again publishes nothing.
 */
async function replaceCacheRules(tx: Tx, site: { id: string }, rules: CacheRuleInput[]) {
  const priorities = new Set<number>();
  for (const [i, rule] of rules.entries()) {
    const priority = rule.priority ?? (i + 1) * 10;
    if (priorities.has(priority))
      fail("CACHE_RULE_PRIORITY_DUPLICATE", "cache rule priorities must be unique", { priority });
    priorities.add(priority);
  }
  const previous = await tx
    .delete(schema.cacheRule)
    .where(eq(schema.cacheRule.siteId, site.id))
    .returning();
  if (rules.length === 0) return;
  const expressions = rules.map(storedCacheExpression);
  const references = expressions.map((expression) => {
    try {
      return cacheConditionLists(expression);
    } catch (error) {
      return fail("RULE_INVALID", `invalid cache rule condition: ${(error as Error).message}`);
    }
  });
  const bindings = references.some((names) => names.length)
    ? listBindings(await availableLists(tx, true))
    : {};
  failUnknownLists(references.flat().filter((name) => !bindings[name]));
  const listIds = references.map((names) => names.map((name) => bindings[name] as string));
  const values = rules.map((r, i) => ({
    priority: r.priority ?? (i + 1) * 10,
    expression: expressions[i] ?? "true",
    listIds: listIds[i] ?? [],
    pathPrefixes: [],
    paths: [],
    extensions: [],
    statusCodes: r.statusCodes,
    minSizeBytes: r.minSizeBytes,
    maxSizeBytes: r.maxSizeBytes,
    action: r.action,
    edgeTtlSeconds: r.edgeTtlSeconds,
    originCacheControl: r.originCacheControl,
    staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
    staleIfErrorSeconds: r.staleIfErrorSeconds,
    cacheAuthorized: r.cacheAuthorized,
    browserTtlSeconds: r.browserTtlSeconds,
    cacheSetCookie: r.cacheSetCookie,
  }));
  const content = (rule: Partial<Record<(typeof CACHE_RULE_FIELDS)[number], unknown>>) =>
    JSON.stringify(CACHE_RULE_FIELDS.map((field) => rule[field]));
  const ids = new Map<string, string[]>();
  for (const row of previous) ids.set(content(row), [...(ids.get(content(row)) ?? []), row.id]);
  await tx.insert(schema.cacheRule).values(
    values.map((rule, i) => {
      const id = ids.get(content(rule))?.shift();
      return { ...(id ? { id } : {}), createdAt: ordered(i), siteId: site.id, ...rule };
    }),
  );
}

/** Refuses origins without a group that a rule of the site still chooses. */
async function assertRuleGroups(tx: Tx, siteId: string, origins: OriginInput[]) {
  const groups = new Set(origins.map((origin) => origin.group));
  const rules = await tx
    .select({ name: schema.edgeRule.name, action: schema.edgeRule.action })
    .from(schema.edgeRule)
    .where(eq(schema.edgeRule.siteId, siteId));
  for (const rule of rules) {
    const group = actionOriginGroup(rule.action);
    if (group && !groups.has(group))
      fail("RULE_INVALID", `origin group ${group} is used by rule ${rule.name}`);
  }
}

/** The site's origin pool (the oldest one; sites have exactly one). */
async function sitePool(tx: Tx, siteId: string) {
  let [pool] = await tx
    .select()
    .from(schema.originPool)
    .where(eq(schema.originPool.siteId, siteId))
    .orderBy(asc(schema.originPool.createdAt))
    .limit(1);
  if (!pool) [pool] = await tx.insert(schema.originPool).values({ siteId }).returning();
  if (!pool) throw new Error("origin pool missing");
  return pool;
}

/**
 * Publishes the site's cluster after a change to the site and audits the
 * change with the new revision number. The site's stored rules must compile
 * (RULE_INVALID; a deleted site has none).
 */
async function publishSiteChange(
  tx: Tx,
  actor: Actor,
  site: Pick<SiteRow, "id" | "name" | "clusterId">,
  change: { reason: RevisionReasonCode; action: AuditAction; metadata?: Record<string, unknown> },
): Promise<Revision> {
  const { row } = await publishRevision(tx, {
    clusterId: site.clusterId,
    reason: { code: change.reason, params: { site: site.name } },
    actor,
    site: site.id,
  });
  await recordAudit(tx, actor, {
    action: change.action,
    targetType: "site",
    targetId: site.id,
    targetName: site.name,
    metadata: { ...change.metadata, revision: row.revision },
  });
  return toRevisionDto(row);
}

/**
 * Creates a site with its domains, origin pool and cache rules, then publishes
 * a new revision for the site's cluster in the same transaction. Without an
 * explicit cluster the site lands on the default (oldest) cluster.
 */
export async function createSite(
  db: Database,
  input: SiteCreate,
  ctx: { actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision }> {
  const domains = normalizeDomains(input.domains);
  // Without a name the site is called after its first domain.
  const name = input.name ?? (input.domains[0] ?? "").slice(0, 100);
  return db.transaction(async (tx) => {
    const clusterId = input.clusterId ?? (await defaultClusterId(tx));
    const [clusterRow] = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    if (!clusterRow) fail("CLUSTER_NOT_FOUND", "cluster not found");
    assertGrpcOverHttp2(input.originSettings);
    const ports = input.ports ?? { http: [80], https: [443] };
    await assertSitePorts(tx, { clusterId, certificateId: null }, ports);
    await assertDomainsFree(tx, domains);
    for (const origin of input.origins) assertHostHeader(origin.hostHeader);
    await assertOriginsAllowed(tx, input.origins);
    const cnamePrefix = await newCnamePrefix(tx);

    const [siteRow] = await tx
      .insert(schema.site)
      .values({
        clusterId,
        name,
        cnamePrefix,
        websocket: input.originSettings.websocket,
        httpPorts: ports.http,
        httpsPorts: ports.https,
        ...cacheSettingsValues(input.cacheSettings),
        ...contentSettingsValues(input.contentSettings),
      })
      .returning();
    if (!siteRow) throw new Error("site insert failed");
    await writePurgeKey(tx, ctx.masterKey, siteRow.id, input.cacheSettings.purgeMethod);
    await tx
      .insert(schema.siteDomain)
      .values(domains.map((d, i) => ({ siteId: siteRow.id, createdAt: ordered(i), ...d })));
    const [pool] = await tx
      .insert(schema.originPool)
      .values({ siteId: siteRow.id, ...poolSettingsValues(input.originSettings) })
      .returning();
    if (!pool) throw new Error("origin pool insert failed");
    await writeOrigins(tx, pool, input.origins, ctx.masterKey);
    await replaceCacheRules(tx, siteRow, input.cacheRules);
    const revision = await publishSiteChange(tx, ctx.actor, siteRow, {
      reason: "site_created",
      action: "site.create",
      metadata: {
        name,
        domains: domains.map(formatDomain),
        ...(input.cacheSettings.purgeMethod.enabled ? { purgeMethod: true } : {}),
      },
    });
    return { site: await toSiteDto(tx, siteRow), revision };
  });
}

/**
 * Updates a site's name, domains, origins and/or cache rules. Every save
 * publishes a new revision (unless the compiled configuration is unchanged,
 * in which case the current revision is returned). New domains the site's
 * ACME certificate does not cover extend it (coverSiteDomains); the result
 * then names the certificate being reissued.
 */
export async function updateSite(
  db: Database,
  input: SiteUpdate,
  ctx: { actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision; certificateReissue?: { id: string; name: string } }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, input.id, true);
    const changed: string[] = [];
    let certificateReissue: { id: string; name: string } | undefined;
    let tlsOptions = row.tlsSettings;
    if (input.name !== undefined && input.name !== row.name) {
      await tx.update(schema.site).set({ name: input.name }).where(eq(schema.site.id, row.id));
      changed.push("name");
    }
    if (input.domains) {
      const domains = normalizeDomains(input.domains);
      await assertDomainsFree(tx, domains, row.id);
      if (row.certificateId)
        certificateReissue = await coverSiteDomains(tx, row.certificateId, domains, {
          actor: ctx.actor,
          site: { id: row.id, name: input.name ?? row.name },
        });
      await tx.delete(schema.siteDomain).where(eq(schema.siteDomain.siteId, row.id));
      await tx
        .insert(schema.siteDomain)
        .values(domains.map((d, i) => ({ siteId: row.id, createdAt: ordered(i), ...d })));
      changed.push("domains");
      // The HTTPS redirect excludes only domains the site has: nodes refuse others.
      const names = new Set(domains.filter(namesHosts).map(formatDomain));
      const excluded = tlsSettings.parse({
        ...tlsOptions,
        certificateId: row.certificateId,
      }).redirectExcludedDomains;
      if (excluded.some((name) => !names.has(name))) {
        tlsOptions = {
          ...tlsOptions,
          redirectExcludedDomains: excluded.filter((name) => names.has(name)),
        };
        await tx
          .update(schema.site)
          .set({ tlsSettings: tlsOptions })
          .where(eq(schema.site.id, row.id));
      }
    }
    if (input.origins) {
      for (const origin of input.origins) assertHostHeader(origin.hostHeader);
      await assertOriginsAllowed(tx, input.origins);
      await assertRuleGroups(tx, row.id, input.origins);
      const pool = await sitePool(tx, row.id);
      await writeOrigins(tx, pool, input.origins, ctx.masterKey);
      changed.push("origins");
    }
    if (input.originSettings) {
      const pool = await sitePool(tx, row.id);
      assertGrpcOverHttp2({
        protocol: input.originSettings.protocol ?? (pool.protocol === "http2" ? "http2" : "http1"),
        grpc: input.originSettings.grpc ?? pool.grpc,
      });
      await tx
        .update(schema.originPool)
        .set(poolSettingsValues(input.originSettings))
        .where(eq(schema.originPool.id, pool.id));
      await tx
        .update(schema.site)
        .set({ websocket: input.originSettings.websocket })
        .where(eq(schema.site.id, row.id));
      changed.push("originSettings");
    }
    if (input.cacheSettings) {
      await writePurgeKey(tx, ctx.masterKey, row.id, input.cacheSettings.purgeMethod);
      await tx
        .update(schema.site)
        .set(cacheSettingsValues(input.cacheSettings))
        .where(eq(schema.site.id, row.id));
      changed.push("cacheSettings");
    }
    if (input.contentSettings) {
      await tx
        .update(schema.site)
        .set(contentSettingsValues(input.contentSettings))
        .where(eq(schema.site.id, row.id));
      changed.push("contentSettings");
    }
    if (input.cacheRules) {
      await replaceCacheRules(tx, row, input.cacheRules);
      changed.push("cacheRules");
    }
    if (input.ports) {
      const tls = tlsSettings.parse({ ...tlsOptions, certificateId: row.certificateId });
      await assertSitePorts(tx, row, input.ports, { tls });
      const before = portsOf(row);
      if (JSON.stringify(before) !== JSON.stringify(input.ports)) {
        await tx
          .update(schema.site)
          .set({ httpPorts: input.ports.http, httpsPorts: input.ports.https })
          .where(eq(schema.site.id, row.id));
        changed.push("ports");
      }
    }
    // Touch updated_at even when only child rows changed.
    const [updated] = await tx
      .update(schema.site)
      .set({ updatedAt: new Date() })
      .where(eq(schema.site.id, row.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const revision = await publishSiteChange(tx, ctx.actor, updated, {
      reason: "site_updated",
      action: "site.update",
      metadata: {
        changed,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.domains ? { domains: normalizeDomains(input.domains).map(formatDomain) } : {}),
        ...(input.origins
          ? { origins: input.origins.map((o) => `${o.scheme}://${o.address}:${o.port}`) }
          : {}),
        ...(input.cacheRules ? { cacheRules: input.cacheRules.length } : {}),
        ...(input.originSettings ? { originSettings: input.originSettings } : {}),
        ...(input.cacheSettings
          ? { cacheSettings: auditedCacheSettings(input.cacheSettings) }
          : {}),
        ...(input.contentSettings ? { contentSettings: input.contentSettings } : {}),
        ...(input.ports ? { ports: input.ports } : {}),
      },
    });
    return {
      site: await toSiteDto(tx, updated),
      revision,
      ...(certificateReissue ? { certificateReissue } : {}),
    };
  });
}

export async function deleteSite(
  db: Database,
  id: string,
  ctx: { actor: Actor },
): Promise<{ revision: Revision }> {
  return db.transaction(async (tx) => {
    // Its statistics go with the site: no ingestion or rollup may be in
    // flight, and the usage of windows not computed yet is computed first.
    await lockStats(tx, "exclusive");
    const row = await findSite(tx, id);
    await flushSiteUsage(tx, row.id);
    await tx.delete(schema.site).where(eq(schema.site.id, row.id));
    // The site drops out of alert subscriptions; one left without sites goes.
    const member = schema.alertSubscriptionSite;
    await tx
      .delete(schema.alertSubscription)
      .where(
        and(
          eq(schema.alertSubscription.allSites, false),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(member)
              .where(eq(member.subscriptionId, schema.alertSubscription.id)),
          ),
        ),
      );
    const revision = await publishSiteChange(tx, ctx.actor, row, {
      reason: "site_deleted",
      action: "site.delete",
      metadata: { name: row.name },
    });
    return { revision };
  });
}

/**
 * Turns a site on or off. Unchanged state returns the current site and
 * revision without a new revision or audit entry; a change publishes the
 * cluster and writes the audit entry in the same transaction.
 */
export async function setSiteEnabled(
  db: Database,
  input: { id: string; enabled: boolean; expectedUpdatedAt?: string },
  ctx: { actor: Actor },
): Promise<{ site: Site; revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, input.id, true);
    if (row.enabled === input.enabled) {
      const latest = await latestRevision(tx, row.clusterId);
      if (!latest) throw new Error("cluster has no revision");
      return { site: await toSiteDto(tx, row), revision: toRevisionDto(latest) };
    }
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const [updated] = await tx
      .update(schema.site)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(schema.site.id, row.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const revision = await publishSiteChange(tx, ctx.actor, updated, {
      reason: input.enabled ? "site_enabled" : "site_disabled",
      action: input.enabled ? "site.enable" : "site.disable",
    });
    return { site: await toSiteDto(tx, updated), revision };
  });
}

export async function countSites(db: Database): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.site);
  return row?.n ?? 0;
}

/** The user's starred sites, most recently starred first. */
export async function starredSites(db: Database, userId: string): Promise<StarredSite[]> {
  const rows = await db
    .select({ id: schema.site.id, name: schema.site.name })
    .from(schema.siteStar)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteStar.siteId))
    .where(eq(schema.siteStar.userId, userId))
    .orderBy(desc(schema.siteStar.createdAt), asc(schema.site.name));
  if (rows.length === 0) return [];
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(
      inArray(
        schema.siteDomain.siteId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
  return rows.map((r) => ({
    ...r,
    domains: domains.filter((d) => d.siteId === r.id).map(formatDomain),
  }));
}

/** Stars or un-stars a site for the user (a personal preference, not audited). */
export async function setSiteStarred(
  db: Database,
  input: { userId: string; siteId: string; starred: boolean },
): Promise<void> {
  const row = await findSite(db, input.siteId);
  if (input.starred) {
    await db
      .insert(schema.siteStar)
      .values({ userId: input.userId, siteId: row.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.siteStar)
      .where(and(eq(schema.siteStar.userId, input.userId), eq(schema.siteStar.siteId, row.id)));
  }
}
