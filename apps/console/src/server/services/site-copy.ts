import { randomUUID } from "node:crypto";
import {
  bulkRedirectSourceParts,
  type ErrorPage,
  forbiddenOriginRange,
  forwardUrlHost,
  type ImageConvertSettings,
  type Revision,
  SITE_COPY_LIST_PARTS,
  type SiteCloneInput,
  type SiteCopyChange,
  type SiteCopyError,
  type SiteCopyInput,
  type SiteCopyPart,
  type SiteCopyPreview,
  type SiteCopyResult,
  type SitePorts,
  type TlsSettings,
  tlsSettings,
  WAF_DEFAULTS,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type AuthSecret, openAuthSecret, sealAuthSecret } from "../lib/access-auth-secrets";
import { readAccessControl } from "../lib/access-control";
import { readCacheKey } from "../lib/cache-key";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { readImageConvert } from "../lib/image-convert";
import { readActiveHealthCheck, readSessionAffinity } from "../lib/pool-settings";
import { formatDomain, normalizeDomains } from "../lib/site-domains";
import { PURGE_KEY, siteSecretBinding, storeSiteSecret } from "../lib/site-secrets";
import { checkSiteLists } from "./access-control";
import { type Actor, recordAudit } from "./audit";
import { formattedSiteDomains } from "./auth-rules";
import { servesHost } from "./bulk-redirects";
import { newCnamePrefix } from "./cname-prefixes";
import { loadOriginAllowList } from "./config-input";
import { loadSiteErrorPages, storedStatus } from "./error-pages";
import { assertOriginsAllowed } from "./origin-allow-list";
import { type Executor, publishRevision, type Tx, toRevisionDto } from "./revisions";
import { actionOriginGroup, siteOriginGroups } from "./rules";
import { assertSitePorts, portsOf } from "./site-ports";
import { siteTagRefs } from "./site-tags";
import {
  assertDomainsFree,
  CACHE_RULE_FIELDS,
  findSite,
  s3SecretBinding,
  setNewSiteTags,
  shareSites,
  sitePool,
  toSiteDto,
} from "./sites";

type SiteRow = typeof schema.site.$inferSelect;
interface CopyContext {
  masterKey: MasterKey;
  /** Planning for a new site (cloneSite): settings that need a certificate are turned off. */
  clone?: boolean;
}

/**
 * A part of a site's settings (ADR-0042): how it is read, planned onto a
 * target and written there.
 */
interface Part<V> {
  /** The part as the site stores it, defaults filled in: equal values mean equal settings. */
  read(db: Executor, site: SiteRow, ctx: CopyContext): Promise<V>;
  /**
   * What the target would store of the source's value: the value checked
   * against what the target has (failing with the reason), adjusted where
   * the target decides (no certificate). Absent: the value itself.
   */
  plan?(tx: Tx, target: SiteRow, value: V, ctx: CopyContext): Promise<V>;
  write(tx: Tx, target: SiteRow, value: V, ctx: CopyContext): Promise<void>;
  /** List parts: the number of items. */
  count?(value: V): number;
}
const part = <V>(definition: Part<V>) => definition as Part<unknown>;

/** JSON with sorted object keys: equal settings give equal text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Child rows inserted in one statement share now(): increasing timestamps keep their order. */
const ordered = (index: number, base: number) => new Date(base + index);

/** A newer `*_updated_at` than the stored one, so that editors holding the old one get a 409. */
const bumped = (previous: Date | null) =>
  new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));

/** Share-locks the IP lists the settings use until the transaction ends; all must exist. */
async function shareLists(tx: Tx, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return;
  const rows = await tx
    .select({ id: schema.ipList.id })
    .from(schema.ipList)
    .where(inArray(schema.ipList.id, wanted))
    .orderBy(asc(schema.ipList.id))
    .for("share");
  if (rows.length !== wanted.length) fail("IP_LIST_NOT_FOUND", "IP list not found");
}

/** The site's stored HTTPS settings (its first certificate; the others do not matter here). */
function tlsOf(site: Pick<SiteRow, "tlsSettings" | "certificateId">): TlsSettings {
  return tlsSettings.parse({ ...site.tlsSettings, certificateId: site.certificateId });
}

/** tls_settings keys of each part; the certificates and the excluded domains stay the target's. */
export const COMPRESSION_KEYS = [
  "brotli",
  "brotliLevel",
  "brotliMinLength",
  "brotliTypes",
  "zstd",
  "zstdLevel",
  "zstdMinLength",
  "zstdTypes",
  "gzip",
  "gzipMinLength",
  "gzipTypes",
  "gzipLevel",
  "compressMaxLength",
] as const satisfies readonly (keyof TlsSettings)[];
export const HTTPS_KEYS = [
  "forceHttps",
  "hstsMaxAge",
  "hstsIncludeSubdomains",
  "hstsPreload",
  "minimumVersion",
  "cipherProfile",
  "http2",
  "http3",
  "ocspStapling",
  "redirectStatus",
  "redirectPort",
  "clientCertificate",
] as const satisfies readonly (keyof TlsSettings)[];
/** tls_settings keys no part copies. */
export const TLS_KEPT_KEYS = [
  "certificateId",
  "additionalCertificateIds",
  "redirectExcludedDomains",
] as const satisfies readonly (keyof TlsSettings)[];

const pick = <T extends object, K extends keyof T>(value: T, keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;

/** Merges options into the site's stored tls_settings (read anew: another part may have written). */
async function writeTlsOptions(tx: Tx, siteId: string, options: Partial<TlsSettings>) {
  const [row] = await tx
    .select({ tlsSettings: schema.site.tlsSettings })
    .from(schema.site)
    .where(eq(schema.site.id, siteId));
  await tx
    .update(schema.site)
    .set({ tlsSettings: { ...(row?.tlsSettings ?? {}), ...options } })
    .where(eq(schema.site.id, siteId));
}

type CacheRuleValue = Pick<
  typeof schema.cacheRule.$inferSelect,
  (typeof CACHE_RULE_FIELDS)[number]
>;
type CompressionValue = Pick<TlsSettings, (typeof COMPRESSION_KEYS)[number]>;
type HttpsValue = Pick<TlsSettings, (typeof HTTPS_KEYS)[number]>;
interface RuleValue {
  name: string;
  phase: string;
  expression: string;
  enabled: boolean;
  action: Record<string, unknown>;
  listIds: string[];
}
interface BulkRedirectValue {
  source: string;
  target: string;
  statusCode: number;
  preserveQuery: boolean;
}
interface AuthRuleValue {
  kind: string;
  enabled: boolean;
  scope: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** In memory only: never returned, logged or audited. */
  secret: AuthSecret | null;
}

const WAF_COLUMNS = {
  mode: WAF_DEFAULTS.mode as string,
  paranoiaLevel: WAF_DEFAULTS.paranoiaLevel as number,
  anomalyThreshold: WAF_DEFAULTS.anomalyThreshold as number,
  exclusions: [] as unknown[],
  requestBodyLimit: WAF_DEFAULTS.requestBodyLimit as number,
};
type WafValue = typeof WAF_COLUMNS;

/** site_protection columns of the CC and challenge part (logJa4 is the logs part's). */
const PROTECTION_COLUMNS = {
  underAttack: false,
  underAttackChallenge: "js",
  passTtlSeconds: 1800,
  powDifficulty: 16,
  powHighDifficulty: 20,
  cc: null as Record<string, unknown> | null,
  allowVerifiedBots: false,
  challengeText: {} as Record<string, unknown>,
  failureBanEnabled: false,
  failureThreshold: 10,
  failureBanSeconds: 600,
};
type ProtectionValue = typeof PROTECTION_COLUMNS;

/** A row's values of the columns, the defaults where it has no row. */
function columnsOf<T extends Record<string, unknown>>(
  defaults: T,
  row: Record<string, unknown> | undefined,
): T {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, row?.[key] ?? value]),
  ) as T;
}

async function protectionRow(db: Executor, siteId: string) {
  const [row] = await db
    .select()
    .from(schema.siteProtection)
    .where(eq(schema.siteProtection.siteId, siteId));
  return row;
}

async function upsertProtection(
  tx: Tx,
  siteId: string,
  columns: Partial<ProtectionValue> & { logJa4?: boolean },
) {
  const values = columns as Omit<typeof schema.siteProtection.$inferInsert, "siteId">;
  await tx
    .insert(schema.siteProtection)
    .values({ siteId, ...values })
    .onConflictDoUpdate({
      target: schema.siteProtection.siteId,
      set: { ...values, updatedAt: new Date() },
    });
}

/** Pool columns of the origin settings part (the origins stay the target's). */
const POOL_COLUMNS = [
  "policy",
  "tlsVerify",
  "maxFails",
  "recoverySeconds",
  "connectTimeoutMs",
  "sendTimeoutMs",
  "readTimeoutMs",
  "keepalive",
  "keepaliveIdleSeconds",
  "keepaliveMaxRequests",
  "protocol",
  "grpc",
  "activeHealthCheck",
  "sessionAffinity",
  "tries",
  "statusRetry",
] as const satisfies readonly (keyof typeof schema.originPool.$inferSelect)[];
type PoolValue = Pick<typeof schema.originPool.$inferSelect, (typeof POOL_COLUMNS)[number]> & {
  websocket: boolean;
};

/** The site's pool, or its defaults before it has one. */
async function poolOf(db: Executor, siteId: string) {
  const [pool] = await db
    .select()
    .from(schema.originPool)
    .where(eq(schema.originPool.siteId, siteId))
    .orderBy(asc(schema.originPool.createdAt))
    .limit(1);
  return pool;
}

export const COPY_PARTS: Record<SiteCopyPart, Part<unknown>> = {
  cacheRules: part<CacheRuleValue[]>({
    async read(db, site) {
      const rows = await db
        .select()
        .from(schema.cacheRule)
        .where(eq(schema.cacheRule.siteId, site.id))
        .orderBy(asc(schema.cacheRule.priority), asc(schema.cacheRule.createdAt));
      return rows.map((row) => pick(row, CACHE_RULE_FIELDS));
    },
    async plan(tx, _target, rules) {
      await shareLists(
        tx,
        rules.flatMap((rule) => rule.listIds),
      );
      return rules;
    },
    async write(tx, target, rules) {
      await tx.delete(schema.cacheRule).where(eq(schema.cacheRule.siteId, target.id));
      const base = Date.now();
      if (rules.length)
        await tx
          .insert(schema.cacheRule)
          .values(
            rules.map((rule, i) => ({ ...rule, siteId: target.id, createdAt: ordered(i, base) })),
          );
    },
    count: (rules) => rules.length,
  }),
  cacheKey: part<{ cacheKey: Record<string, unknown>; rangeSlice: boolean }>({
    async read(_db, site) {
      return { cacheKey: readCacheKey(site.cacheKey), rangeSlice: site.rangeSlice };
    },
    async write(tx, target, value) {
      await tx
        .update(schema.site)
        .set({ cacheKey: value.cacheKey, rangeSlice: value.rangeSlice })
        .where(eq(schema.site.id, target.id));
    },
  }),
  cacheTag: part<{ keepCacheTag: boolean }>({
    async read(_db, site) {
      return { keepCacheTag: site.keepCacheTag };
    },
    async write(tx, target, value) {
      await tx
        .update(schema.site)
        .set({ keepCacheTag: value.keepCacheTag })
        .where(eq(schema.site.id, target.id));
    },
  }),
  compression: part<CompressionValue>({
    async read(_db, site) {
      return pick(tlsOf(site), COMPRESSION_KEYS);
    },
    async write(tx, target, value) {
      await writeTlsOptions(tx, target.id, value);
    },
  }),
  https: part<HttpsValue>({
    async read(_db, site) {
      return pick(tlsOf(site), HTTPS_KEYS);
    },
    async plan(tx, target, value, ctx) {
      let next = value;
      if (!target.certificateId) {
        // As updateHttps: without a certificate the redirect goes to 443
        // and no client certificate is asked for.
        const needsCertificate =
          value.forceHttps || value.hstsMaxAge > 0 || value.clientCertificate.mode !== "off";
        if (needsCertificate && !ctx.clone)
          fail(
            "HTTPS_REQUIRES_CERTIFICATE",
            "the HTTPS redirect, HSTS and client certificates need a certificate",
          );
        next = {
          ...value,
          forceHttps: false,
          hstsMaxAge: 0,
          redirectPort: 443,
          clientCertificate: { ...value.clientCertificate, mode: "off" },
        };
      }
      if (next.clientCertificate.mode !== "off" && next.http3)
        fail("CLIENT_CERTIFICATE_HTTP3", "client certificates and HTTP/3 cannot be on together");
      await assertSitePorts(tx, target, portsOf(target), {
        checkPorts: false,
        tls: {
          redirectPort: next.redirectPort,
          redirectExcludedDomains: tlsOf(target).redirectExcludedDomains,
        },
      });
      return next;
    },
    async write(tx, target, value) {
      await writeTlsOptions(tx, target.id, value);
    },
  }),
  rules: part<{ rules: RuleValue[]; rulesBodyLimit: number }>({
    async read(db, site) {
      const rows = await db
        .select()
        .from(schema.edgeRule)
        .where(eq(schema.edgeRule.siteId, site.id))
        .orderBy(asc(schema.edgeRule.priority));
      return {
        rules: rows.map((row) => ({
          name: row.name,
          phase: row.phase,
          expression: row.expression,
          enabled: row.enabled,
          action: row.action,
          listIds: row.listIds,
        })),
        rulesBodyLimit: site.rulesBodyLimit,
      };
    },
    async plan(tx, target, value) {
      const groups = await siteOriginGroups(tx, target.id);
      for (const rule of value.rules) {
        const group = actionOriginGroup(rule.action);
        if (group && !groups.has(group))
          fail("ORIGIN_GROUP_UNKNOWN", `rule ${rule.name} chooses origin group ${group}`, {
            group,
            rule: rule.name,
          });
      }
      await shareLists(
        tx,
        value.rules.flatMap((rule) => rule.listIds),
      );
      return value;
    },
    async write(tx, target, value) {
      await tx.delete(schema.edgeRule).where(eq(schema.edgeRule.siteId, target.id));
      // Rule ids are unique platform-wide: copies get new ones.
      if (value.rules.length)
        await tx.insert(schema.edgeRule).values(
          value.rules.map((rule, priority) => ({
            ...rule,
            id: randomUUID(),
            siteId: target.id,
            priority,
          })),
        );
      await tx
        .update(schema.site)
        .set({ rulesBodyLimit: value.rulesBodyLimit })
        .where(eq(schema.site.id, target.id));
    },
    count: (value) => value.rules.length,
  }),
  bulkRedirects: part<BulkRedirectValue[]>({
    async read(db, site) {
      const rows = await db
        .select()
        .from(schema.bulkRedirect)
        .where(eq(schema.bulkRedirect.siteId, site.id))
        .orderBy(asc(schema.bulkRedirect.position));
      return rows.map((row) => pick(row, ["source", "target", "statusCode", "preserveQuery"]));
    },
    async plan(tx, target, redirects) {
      const domains = await tx
        .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
        .from(schema.siteDomain)
        .where(eq(schema.siteDomain.siteId, target.id));
      const unknown = [
        ...new Set(
          redirects
            .map((redirect) => bulkRedirectSourceParts(redirect.source)?.host ?? "")
            .filter((host) => host !== "" && !servesHost(domains, host)),
        ),
      ];
      if (unknown.length) {
        const hosts = unknown.slice(0, 5).join(", ");
        fail("BULK_REDIRECT_HOST_UNKNOWN", `the site does not serve ${hosts}`, { hosts });
      }
      return redirects;
    },
    async write(tx, target, redirects) {
      await tx.delete(schema.bulkRedirect).where(eq(schema.bulkRedirect.siteId, target.id));
      const rows = redirects.map((redirect, position) => ({
        ...redirect,
        siteId: target.id,
        position,
      }));
      for (let i = 0; i < rows.length; i += 1000)
        await tx.insert(schema.bulkRedirect).values(rows.slice(i, i + 1000));
    },
    count: (redirects) => redirects.length,
  }),
  errorPages: part<{ pages: ErrorPage[]; interceptOriginErrors: boolean }>({
    async read(db, site) {
      return {
        pages: (await loadSiteErrorPages(db, [site.id])).get(site.id) ?? [],
        interceptOriginErrors: site.interceptOriginErrors,
      };
    },
    async write(tx, target, value) {
      const updatedAt = bumped(target.errorPagesUpdatedAt);
      await tx.delete(schema.siteErrorPage).where(eq(schema.siteErrorPage.siteId, target.id));
      if (value.pages.length)
        await tx.insert(schema.siteErrorPage).values(
          value.pages.map((page) => ({
            ...page,
            siteId: target.id,
            status: storedStatus(page.status),
            updatedAt,
          })),
        );
      await tx
        .update(schema.site)
        .set({ interceptOriginErrors: value.interceptOriginErrors, errorPagesUpdatedAt: updatedAt })
        .where(eq(schema.site.id, target.id));
    },
    count: (value) => value.pages.length,
  }),
  waf: part<WafValue>({
    async read(db, site) {
      const [row] = await db
        .select()
        .from(schema.siteWaf)
        .where(eq(schema.siteWaf.siteId, site.id));
      return columnsOf(WAF_COLUMNS, row);
    },
    async write(tx, target, value) {
      const values = value as Omit<typeof schema.siteWaf.$inferInsert, "siteId">;
      await tx
        .insert(schema.siteWaf)
        .values({ siteId: target.id, ...values })
        .onConflictDoUpdate({
          target: schema.siteWaf.siteId,
          set: { ...values, updatedAt: new Date() },
        });
    },
  }),
  protection: part<ProtectionValue>({
    async read(db, site) {
      return columnsOf(PROTECTION_COLUMNS, await protectionRow(db, site.id));
    },
    async write(tx, target, value) {
      await upsertProtection(tx, target.id, value);
    },
  }),
  accessControl: part<ReturnType<typeof readAccessControl>>({
    async read(_db, site) {
      return readAccessControl(site);
    },
    async plan(tx, _target, value) {
      await checkSiteLists(tx, value.siteLists);
      await shareLists(tx, [...value.siteLists.blockListIds, ...value.siteLists.allowListIds]);
      return value;
    },
    async write(tx, target, value) {
      const { siteLists, ...stored } = value;
      await tx
        .update(schema.site)
        .set({
          accessControl: stored,
          blockListIds: siteLists.blockListIds,
          allowListIds: siteLists.allowListIds,
          accessControlUpdatedAt: bumped(target.accessControlUpdatedAt),
        })
        .where(eq(schema.site.id, target.id));
    },
  }),
  authRules: part<AuthRuleValue[]>({
    async read(db, site, ctx) {
      const rows = await db
        .select()
        .from(schema.siteAuthRule)
        .where(eq(schema.siteAuthRule.siteId, site.id))
        .orderBy(asc(schema.siteAuthRule.position));
      return rows.map((row) => ({
        kind: row.kind,
        enabled: row.enabled,
        scope: row.scope,
        settings: row.settings,
        secret: openAuthSecret(ctx.masterKey, row.id, row.secretEnvelope),
      }));
    },
    async plan(tx, target, rules) {
      const domains = new Set(await formattedSiteDomains(tx, target.id));
      const allowed = await loadOriginAllowList(tx);
      for (const rule of rules) {
        const scoped = Array.isArray(rule.scope.domains) ? (rule.scope.domains as string[]) : [];
        for (const domain of scoped)
          if (!domains.has(domain))
            fail("AUTH_DOMAIN_UNKNOWN", `${domain} is not a domain of the site`, { domain });
        const url = rule.kind === "forward" ? rule.settings.url : undefined;
        if (typeof url === "string") {
          const host = forwardUrlHost(url);
          const range = forbiddenOriginRange(host, allowed);
          if (range)
            fail(
              "ORIGIN_ADDRESS_FORBIDDEN",
              `authentication service address ${host} is in the special-purpose range ${range}, which the platform does not allow`,
              { address: host, range },
            );
        }
      }
      return rules;
    },
    async write(tx, target, rules, ctx) {
      await tx.delete(schema.siteAuthRule).where(eq(schema.siteAuthRule.siteId, target.id));
      // Secrets are sealed anew: the envelope is bound to the (new) rule id.
      const rows = rules.map((rule, position) => {
        const id = randomUUID();
        return {
          id,
          siteId: target.id,
          position,
          kind: rule.kind,
          enabled: rule.enabled,
          scope: rule.scope,
          settings: rule.settings,
          secretEnvelope: rule.secret ? sealAuthSecret(ctx.masterKey, id, rule.secret) : null,
          secretVersion: rule.secret ? 1 : 0,
        };
      });
      if (rows.length) await tx.insert(schema.siteAuthRule).values(rows);
      await tx
        .update(schema.site)
        .set({ authUpdatedAt: bumped(target.authUpdatedAt) })
        .where(eq(schema.site.id, target.id));
    },
    count: (rules) => rules.length,
  }),
  originSettings: part<PoolValue>({
    async read(db, site) {
      const pool = await poolOf(db, site.id);
      const defaults = {
        policy: "weighted_random",
        tlsVerify: true,
        maxFails: 3,
        recoverySeconds: 30,
        connectTimeoutMs: 10_000,
        sendTimeoutMs: 60_000,
        readTimeoutMs: 60_000,
        keepalive: true,
        keepaliveIdleSeconds: 60,
        keepaliveMaxRequests: 1000,
        protocol: "http1",
        grpc: false,
        activeHealthCheck: {},
        sessionAffinity: {},
        tries: 3,
        statusRetry: true,
      } satisfies Omit<PoolValue, "websocket">;
      const value = pool ? pick(pool, POOL_COLUMNS) : defaults;
      return {
        ...value,
        activeHealthCheck: readActiveHealthCheck(value.activeHealthCheck),
        sessionAffinity: readSessionAffinity(value.sessionAffinity),
        websocket: site.websocket,
      };
    },
    async write(tx, target, value) {
      const { websocket, ...columns } = value;
      const pool = await sitePool(tx, target.id);
      await tx.update(schema.originPool).set(columns).where(eq(schema.originPool.id, pool.id));
      await tx.update(schema.site).set({ websocket }).where(eq(schema.site.id, target.id));
    },
  }),
  logs: part<{
    sampleRate: number;
    logBlocked: boolean;
    logQuery: boolean;
    logHeaders: string[];
    logPeer: boolean;
    logJa4: boolean;
  }>({
    async read(db, site) {
      return {
        sampleRate: site.logSampleRate,
        logBlocked: site.logBlocked,
        logQuery: site.logQuery,
        logHeaders: site.logHeaders,
        logPeer: site.logPeer,
        logJa4: (await protectionRow(db, site.id))?.logJa4 ?? false,
      };
    },
    async write(tx, target, value) {
      const { sampleRate, logJa4, ...columns } = value;
      await tx
        .update(schema.site)
        .set({ logSampleRate: sampleRate, ...columns })
        .where(eq(schema.site.id, target.id));
      await upsertProtection(tx, target.id, { logJa4 });
    },
  }),
  imageConvert: part<ImageConvertSettings>({
    async read(_db, site) {
      return readImageConvert(site.imageConvert);
    },
    async write(tx, target, value) {
      await tx
        .update(schema.site)
        .set({ imageConvert: value })
        .where(eq(schema.site.id, target.id));
    },
  }),
};

/** How a part changes: item counts for lists, the number of changed settings otherwise. */
function changeOf(part: SiteCopyPart, before: unknown, after: unknown): SiteCopyChange {
  const changed = stableJson(before) !== stableJson(after);
  const definition = COPY_PARTS[part];
  if (SITE_COPY_LIST_PARTS.includes(part) && definition.count)
    return {
      part,
      changed,
      before: definition.count(before),
      after: definition.count(after),
      fields: null,
    };
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return {
    part,
    changed,
    before: null,
    after: null,
    fields: keys.filter((key) => stableJson(a[key]) !== stableJson(b[key])).length,
  };
}

/** The parts of the source's settings (secrets of access authentication in memory). */
async function readSource(
  db: Executor,
  source: SiteRow,
  parts: readonly SiteCopyPart[],
  ctx: CopyContext,
): Promise<Map<SiteCopyPart, unknown>> {
  const values = new Map<SiteCopyPart, unknown>();
  for (const name of parts) values.set(name, await COPY_PARTS[name].read(db, source, ctx));
  return values;
}

/**
 * Plans and writes the parts onto a site: each part is read anew (an
 * earlier part may have written the same row), planned and written when it
 * differs. Returns how each part changes.
 */
async function applyParts(
  tx: Tx,
  siteId: string,
  values: Map<SiteCopyPart, unknown>,
  ctx: CopyContext,
): Promise<SiteCopyChange[]> {
  const changes: SiteCopyChange[] = [];
  for (const [name, value] of values) {
    const definition = COPY_PARTS[name];
    const row = await findSite(tx, siteId);
    const before = await definition.read(tx, row, ctx);
    const next = definition.plan ? await definition.plan(tx, row, value, ctx) : value;
    const change = changeOf(name, before, next);
    if (change.changed) await definition.write(tx, row, next, ctx);
    changes.push(change);
  }
  return changes;
}

/** Thrown to roll a dry run back with its result. */
class DryRun<T> {
  constructor(readonly result: T) {}
}

/** An API error as a result entry; anything else is logged and reported as internal. */
function copyError(error: unknown): SiteCopyError {
  if (error instanceof ORPCError) {
    const data: Record<string, string | number> = {};
    for (const [key, value] of Object.entries((error.data ?? {}) as Record<string, unknown>))
      if (typeof value === "string" || typeof value === "number") data[key] = value;
    return { code: error.code, message: error.message, data };
  }
  console.error("site settings copy failed", error);
  return { code: "INTERNAL_SERVER_ERROR", message: "internal error", data: {} };
}

interface TargetOutcome {
  id: string;
  name: string;
  changes: SiteCopyChange[];
  revision: Revision | null;
  error: SiteCopyError | null;
}

/**
 * Copies the parts onto one target in its own transaction: written,
 * published (reason site_settings_copied) and audited
 * (site.settings_copied), or with `dryRun` the same rolled back.
 */
async function copyToTarget(
  db: Database,
  source: Pick<SiteRow, "id" | "name">,
  targetId: string,
  values: Map<SiteCopyPart, unknown>,
  ctx: CopyContext & { actor: Actor; dryRun: boolean },
): Promise<TargetOutcome> {
  let name = "";
  try {
    return await db.transaction(async (tx) => {
      const target = await findSite(tx, targetId, true);
      name = target.name;
      const changes = await applyParts(tx, target.id, values, ctx);
      const changed = changes.filter((change) => change.changed).map((change) => change.part);
      if (changed.length)
        await tx
          .update(schema.site)
          .set({ updatedAt: new Date() })
          .where(eq(schema.site.id, target.id));
      const { row } = await publishRevision(tx, {
        clusterId: target.clusterId,
        reason: {
          code: "site_settings_copied",
          params: { site: target.name, source: source.name },
        },
        actor: ctx.actor,
        site: target.id,
      });
      await recordAudit(tx, ctx.actor, {
        action: "site.settings_copied",
        targetType: "site",
        targetId: target.id,
        targetName: target.name,
        metadata: {
          source: { id: source.id, name: source.name },
          parts: [...values.keys()],
          changed,
          revision: row.revision,
        },
      });
      const outcome = { id: target.id, name, changes, revision: toRevisionDto(row), error: null };
      if (ctx.dryRun) throw new DryRun(outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.result as TargetOutcome;
    if (!name) {
      const [row] = await db
        .select({ name: schema.site.name })
        .from(schema.site)
        .where(eq(schema.site.id, targetId));
      name = row?.name ?? "";
    }
    return { id: targetId, name, changes: [], revision: null, error: copyError(error) };
  }
}

async function copyOutcomes(
  db: Database,
  input: SiteCopyInput,
  ctx: { masterKey: MasterKey; actor: Actor; dryRun: boolean },
) {
  const source = await findSite(db, input.id);
  const values = await readSource(db, source, input.parts, ctx);
  const outcomes: TargetOutcome[] = [];
  for (const targetId of input.targetIds)
    outcomes.push(await copyToTarget(db, source, targetId, values, ctx));
  return { source, outcomes };
}

/** What copying would change on each target, and where it would fail: a dry run. */
export async function previewSiteCopy(
  db: Database,
  input: SiteCopyInput,
  ctx: { masterKey: MasterKey; actor: Actor },
): Promise<SiteCopyPreview> {
  const { source, outcomes } = await copyOutcomes(db, input, { ...ctx, dryRun: true });
  return {
    source: { id: source.id, name: source.name },
    targets: outcomes.map(({ id, name, changes, error }) => ({ id, name, changes, error })),
  };
}

/** Copies the parts to each target, one transaction each; a failed target keeps its settings. */
export async function copySiteSettings(
  db: Database,
  input: SiteCopyInput,
  ctx: { masterKey: MasterKey; actor: Actor },
): Promise<SiteCopyResult> {
  const { outcomes } = await copyOutcomes(db, input, { ...ctx, dryRun: false });
  return {
    targets: outcomes.map(({ id, name, changes, revision, error }) => ({
      id,
      name,
      ok: error === null,
      changed: changes.filter((change) => change.changed).map((change) => change.part),
      revision,
      error,
    })),
  };
}

/**
 * The listener ports of a clone, which has no certificate: the source's
 * HTTP ports (80 when it had none) and 443 when the source served it.
 */
export function clonePorts(source: SitePorts): SitePorts {
  return {
    http: source.http.length ? source.http : [80],
    https: source.https.includes(443) ? [443] : [],
  };
}

/** Site columns a clone takes from its source besides the parts. */
const cloneColumns = (source: SiteRow) => ({
  clusterId: source.clusterId,
  hideXCache: source.hideXCache,
  purgeMethod: source.purgeMethod,
  maintenance: source.maintenance,
  maintenanceUpdatedAt: source.maintenanceUpdatedAt ? new Date() : null,
  charset: source.charset,
  requestBodyLimit: source.requestBodyLimit,
});

/**
 * Copies the source's origins (with their S3 credentials, sealed anew for
 * the clone's credential rows) into the clone's pool, in order.
 */
async function cloneOrigins(tx: Tx, source: SiteRow, cloneId: string, masterKey: MasterKey) {
  const sourcePool = await poolOf(tx, source.id);
  const pool = await sitePool(tx, cloneId);
  if (!sourcePool) return;
  const credentials = await tx
    .select()
    .from(schema.originCredential)
    .where(eq(schema.originCredential.siteId, source.id));
  const credentialIds = new Map<string, string>();
  for (const credential of credentials) {
    const id = randomUUID();
    const secret = masterKey.open(
      JSON.parse(credential.secretEnvelope),
      s3SecretBinding(credential.id),
    );
    await tx.insert(schema.originCredential).values({
      id,
      siteId: cloneId,
      accessKeyId: credential.accessKeyId,
      secretEnvelope: JSON.stringify(masterKey.seal(secret, s3SecretBinding(id))),
    });
    credentialIds.set(credential.id, id);
  }
  const origins = await tx
    .select()
    .from(schema.origin)
    .where(eq(schema.origin.poolId, sourcePool.id))
    .orderBy(asc(schema.origin.createdAt), asc(schema.origin.id));
  // As creating a site: the allow list may have narrowed since the source's origins were saved.
  await assertOriginsAllowed(tx, origins);
  const base = Date.now();
  if (origins.length)
    await tx.insert(schema.origin).values(
      origins.map(({ id: _id, poolId: _pool, credentialId, createdAt: _at, ...origin }, i) => ({
        ...origin,
        poolId: pool.id,
        credentialId: credentialId ? (credentialIds.get(credentialId) ?? null) : null,
        createdAt: ordered(i, base),
      })),
    );
}

/** The source's PURGE key, sealed anew for the clone. */
async function clonePurgeKey(tx: Tx, source: SiteRow, cloneId: string, masterKey: MasterKey) {
  const [secret] = await tx
    .select()
    .from(schema.siteSecret)
    .where(and(eq(schema.siteSecret.siteId, source.id), eq(schema.siteSecret.kind, PURGE_KEY)));
  if (!secret) return;
  const value = masterKey
    .open(JSON.parse(secret.secretEnvelope), siteSecretBinding(secret.id))
    .toString("utf8");
  await storeSiteSecret(tx, masterKey, cloneId, PURGE_KEY, value);
}

/**
 * Creates a site in the source's cluster with its own name and domains and
 * everything else of the source: every copy part, its origins, PURGE key,
 * content and maintenance settings and tags. Certificates name the
 * source's domains and stay behind; so do the settings that need one
 * (the HTTPS redirect, HSTS, client certificates, HTTPS ports other than
 * 443) and the domains the redirect leaves alone. Settings naming the
 * source's domains (access authentication scopes, bulk redirect hosts) fail
 * with the reason.
 */
export async function cloneSite(
  db: Database,
  input: SiteCloneInput,
  ctx: { masterKey: MasterKey; actor: Actor },
) {
  const domains = normalizeDomains(input.domains);
  const name = input.name ?? (input.domains[0] ?? "").slice(0, 100);
  return db.transaction(async (tx) => {
    // The source stays until the clone is written.
    if (!(await shareSites(tx, [input.id])).has(input.id)) fail("SITE_NOT_FOUND", "site not found");
    const source = await findSite(tx, input.id);
    await assertDomainsFree(tx, domains);
    const ports = clonePorts(portsOf(source));
    await assertSitePorts(tx, { clusterId: source.clusterId, certificateId: null }, ports);
    const [row] = await tx
      .insert(schema.site)
      .values({
        ...cloneColumns(source),
        name,
        cnamePrefix: await newCnamePrefix(tx),
        httpPorts: ports.http,
        httpsPorts: ports.https,
      })
      .returning();
    if (!row) throw new Error("site insert failed");
    await tx
      .insert(schema.siteDomain)
      .values(domains.map((d, i) => ({ siteId: row.id, createdAt: ordered(i, Date.now()), ...d })));
    await cloneOrigins(tx, source, row.id, ctx.masterKey);
    await clonePurgeKey(tx, source, row.id, ctx.masterKey);
    const copy = { masterKey: ctx.masterKey, clone: true };
    const values = await readSource(tx, source, Object.keys(COPY_PARTS) as SiteCopyPart[], copy);
    await applyParts(tx, row.id, values, copy);
    const tags =
      input.tags ?? ((await siteTagRefs(tx, [source.id])).get(source.id) ?? []).map((t) => t.name);
    if (tags.length) await setNewSiteTags(tx, ctx.actor, row.id, tags);
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "site_cloned", params: { site: name, source: source.name } },
      actor: ctx.actor,
      site: row.id,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.clone",
      targetType: "site",
      targetId: row.id,
      targetName: name,
      metadata: {
        source: { id: source.id, name: source.name },
        name,
        domains: domains.map(formatDomain),
        ...(tags.length ? { tags } : {}),
        revision: revision.revision,
      },
    });
    return {
      site: await toSiteDto(tx, await findSite(tx, row.id)),
      revision: toRevisionDto(revision),
    };
  });
}
