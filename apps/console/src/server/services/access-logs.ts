import { isIP } from "node:net";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  BLOCK_REASONS,
  HTTP_VERSIONS,
  LOG_RETENTION_DEFAULTS,
  type LogEntry,
  type LogQuery,
  type LogRetention,
  type LogSettingsInput,
  logRetention,
  normalizeCidr,
  TLS_VERSIONS,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import type { AccessLog } from "@edgeweir/proto";
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Env } from "../lib/env";
import { lockLogPartition, lockLogPartitions, tryLockNodeLogs } from "../lib/locks";
import type { Actor } from "./audit";
import { recordAudit } from "./audit";
import { applyClickHouseRetention, insertClickHouseLogs, queryClickHouseLogs } from "./clickhouse";
import { type Executor, publishRevision } from "./revisions";
import { defineSetting } from "./settings";
import { findSite } from "./sites";

const DAY = 86400000;
/** a_b_c: protocol, version, SNI, counts and ALPN, then two truncated SHA-256 hashes. */
const JA4_RE = /^[a-z][a-z0-9]{2}[di][0-9]{4}[a-zA-Z0-9]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CRS rule ids kept per log entry (nodes send at most 16). */
const MAX_WAF_RULE_IDS = 16;
/** Log rules that wrote a line whatever the sample rate (waf-v2). */
const MAX_LOG_RULE_IDS = 8;
/** Request ids as nodes answer them (X-Request-Id); anything else is stored empty. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CACHE_STATUSES = new Set([
  "HIT",
  "MISS",
  "BYPASS",
  "EXPIRED",
  "STALE",
  "UPDATING",
  "REVALIDATED",
]);
const REASONS: ReadonlySet<string> = new Set(BLOCK_REASONS);
const HTTP: ReadonlySet<string> = new Set(HTTP_VERSIONS);
const TLS: ReadonlySet<string> = new Set(TLS_VERSIONS);
/** Origin addresses as nodes report them: "192.0.2.1:443", "[2001:db8::1]:443", "unix:/path". */
const UPSTREAM_RE = /^[A-Za-z0-9._:[\]/@-]{1,128}$/;
const MEDIA_TYPE_RE = /^[a-z0-9!#$&^_.+-]{1,63}\/[a-z0-9!#$&^_.+-]{1,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const clean = (v: string, n: number) => v.replace(/\p{Cc}/gu, "").slice(0, n);

/** System setting: days access logs are kept, per storage (ADR-0041 §5). */
const retentionSetting = defineSetting({
  key: "log_retention",
  schema: logRetention,
  defaults: { ...LOG_RETENTION_DEFAULTS },
  auditAction: "system.log_retention_update",
});
export const getLogRetention = retentionSetting.read;
/** Days the given storage keeps logs. */
export async function retentionDays(db: Executor, storage: Env["EDGEWEIR_ANALYTICS"]) {
  const r = await getLogRetention(db);
  return storage === "clickhouse" ? r.clickhouseDays : r.postgresDays;
}
/** The setting with the storage in use (settings.logRetention). */
export async function logRetentionSetting(app: AppContext) {
  return { ...(await getLogRetention(app.db)), storage: app.env.EDGEWEIR_ANALYTICS };
}
export async function setLogRetention(app: AppContext, actor: Actor, input: LogRetention) {
  const saved = await app.db.transaction((tx) => retentionSetting.write(tx, actor, input));
  if (app.env.EDGEWEIR_ANALYTICS === "clickhouse") await syncClickHouseRetention(app.env, saved);
  return { ...saved, storage: app.env.EDGEWEIR_ANALYTICS };
}
/** The ClickHouse TTL this process applied last, per environment. */
const appliedTtl = new WeakMap<Env, number>();
async function syncClickHouseRetention(env: Env, retention: LogRetention) {
  if (appliedTtl.get(env) === retention.clickhouseDays) return;
  await applyClickHouseRetention(env, retention.clickhouseDays);
  appliedTtl.set(env, retention.clickhouseDays);
}

/** The first moment kept: today (UTC) and the `days - 1` days before it. */
export const logCutoff = (now = Date.now(), days: number = LOG_RETENTION_DEFAULTS.postgresDays) =>
  Math.floor(now / DAY) * DAY - (days - 1) * DAY;
async function partition(tx: Executor, day: number) {
  const from = new Date(day).toISOString(),
    to = new Date(day + DAY).toISOString();
  const name = `access_log_${from.slice(0, 10).replaceAll("-", "")}`;
  // All identifiers and bounds come exclusively from bounded, validated UTC dates.
  await lockLogPartition(tx, name);
  await tx.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF access_log FOR VALUES FROM ('${from}') TO ('${to}')`,
    ),
  );
}
/**
 * Keeps PostgreSQL's daily partitions within the retention setting (and, with
 * ClickHouse storage and `env`, the access_log TTL), every minute.
 */
export async function maintainLogs(db: Database, now = Date.now(), env?: Env) {
  const retention = await getLogRetention(db);
  const cutoffMs = logCutoff(now, retention.postgresDays);
  await db.transaction(async (tx) => {
    await lockLogPartitions(tx);
    for (let d = cutoffMs; d <= Math.floor(now / DAY) * DAY + DAY; d += DAY) await partition(tx, d);
    const rows = await tx.execute<{ relname: string }>(
      sql`select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='access_log'::regclass`,
    );
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10).replaceAll("-", "");
    for (const row of rows.rows)
      if (/^access_log_\d{8}$/.test(row.relname) && row.relname.slice(-8) < cutoff)
        await tx.execute(sql.raw(`DROP TABLE "${row.relname}"`));
  });
  if (env?.EDGEWEIR_ANALYTICS === "clickhouse") await syncClickHouseRetention(env, retention);
}

interface SiteLogPolicy {
  ja4: boolean;
  query: boolean;
  headers: ReadonlySet<string>;
  peer: boolean;
}

export async function ingestLogs(
  app: AppContext,
  node: { id: string; clusterId: string },
  sequence: bigint,
  logs: AccessLog[],
  now = Date.now(),
) {
  if (sequence < 1n || sequence > 9223372036854775807n || logs.length > 1000)
    throw new ConnectError("invalid log batch", Code.InvalidArgument);
  const cutoff = logCutoff(now, await retentionDays(app.db, app.env.EDGEWEIR_ANALYTICS));
  const ids = [...new Set(logs.map((l) => l.siteId).filter((id) => uuid.test(id)))];
  const sites = ids.length
    ? await app.db
        .select({
          id: schema.site.id,
          logJa4: schema.siteProtection.logJa4,
          logQuery: schema.site.logQuery,
          logHeaders: schema.site.logHeaders,
          logPeer: schema.site.logPeer,
        })
        .from(schema.site)
        .leftJoin(schema.siteProtection, eq(schema.siteProtection.siteId, schema.site.id))
        .where(
          and(
            inArray(schema.site.id, ids),
            eq(schema.site.clusterId, node.clusterId),
            // The site samples, logs blocked requests (access-logs-v2), or an
            // enabled site or platform rule samples some of its requests
            // (config action logSampleRate, rules-v2) or writes lines whatever
            // the sample rate (log action accessLog, waf-v2).
            sql`(${schema.site.logSampleRate} > 0 or ${schema.site.logBlocked} or exists (
              select 1 from ${schema.edgeRule}
              where (${schema.edgeRule.siteId} = ${schema.site.id} or ${schema.edgeRule.siteId} is null)
                and ${schema.edgeRule.enabled}
                and ((${schema.edgeRule.action}->>'kind' = 'config'
                    and (${schema.edgeRule.action}->>'logSampleRate')::int > 0)
                  or (${schema.edgeRule.action}->>'kind' = 'log'
                    and (${schema.edgeRule.action}->>'accessLog')::boolean))))`,
          ),
        )
    : [];
  // JA4 and the optional fields are kept only while the site records them (current privacy policy).
  const policies = new Map<string, SiteLogPolicy>(
    sites.map((s) => [
      s.id,
      {
        ja4: s.logJa4 === true,
        query: s.logQuery,
        headers: new Set(s.logHeaders),
        peer: s.logPeer,
      },
    ]),
  );
  const entries: LogEntry[] = logs.flatMap((l, index) => {
    const policy = policies.get(l.siteId);
    const time = l.time ? timestampDate(l.time).getTime() : NaN,
      bytes = Number(l.bytesSent);
    if (
      !policy ||
      !Number.isFinite(time) ||
      time < cutoff ||
      time > now + 300000 ||
      !isIP(l.clientIp) ||
      !/^[A-Z_-]{1,32}$/.test(l.method) ||
      l.status < 100 ||
      l.status > 599 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      l.sampleRate < 1 ||
      l.sampleRate > 10000 ||
      l.durationMs > 86400000
    )
      return [];
    const requestBytes = Number(l.requestBytes);
    const upstream = l.upstreamStatus >= 100 && l.upstreamStatus <= 599;
    const contentType = l.contentType.toLowerCase();
    const headers: Record<string, string> = {};
    if (policy.headers.size)
      for (const [name, value] of Object.entries(l.headers)) {
        const key = name.toLowerCase();
        if (policy.headers.has(key) && Object.keys(headers).length < 8)
          headers[key] = clean(value, 512);
      }
    return [
      {
        id: `${node.id}/${sequence}/${index}`,
        nodeId: node.id,
        siteId: l.siteId,
        time: new Date(time).toISOString(),
        clientIp: l.clientIp,
        method: l.method,
        host: clean(l.host, 253),
        path: clean(l.path.split(/[?#]/, 1)[0] ?? "", 2048),
        status: l.status,
        bytesSent: bytes,
        durationMs: l.durationMs,
        cacheStatus: CACHE_STATUSES.has(l.cacheStatus) ? l.cacheStatus : "",
        sampleRate: l.sampleRate,
        ja4: policy.ja4 && JA4_RE.test(l.ja4) ? l.ja4 : "",
        wafRuleIds: [...new Set(l.wafRuleIds.filter((id) => id > 0))]
          .sort((a, b) => a - b)
          .slice(0, MAX_WAF_RULE_IDS),
        wafBlocked: l.wafBlocked,
        requestId: REQUEST_ID_RE.test(l.requestId) ? l.requestId : "",
        ruleIds: [
          ...new Set(l.ruleIds.filter((id) => uuid.test(id)).map((id) => id.toLowerCase())),
        ].slice(0, MAX_LOG_RULE_IDS),
        userAgent: clean(l.userAgent, 512),
        referer: clean(l.referer.split(/[?#]/, 1)[0] ?? "", 1024),
        httpVersion: HTTP.has(l.httpVersion) ? l.httpVersion : "",
        scheme: l.scheme === "http" || l.scheme === "https" ? l.scheme : "",
        country: COUNTRY_RE.test(l.country) ? l.country : "",
        asn: l.asn,
        asName: l.asn ? clean(l.asName, 128) : "",
        upstreamAddr: upstream && UPSTREAM_RE.test(l.upstreamAddr) ? l.upstreamAddr : "",
        upstreamStatus: upstream ? l.upstreamStatus : 0,
        upstreamMs: upstream && l.upstreamMs <= 86400000 ? l.upstreamMs : 0,
        requestBytes: Number.isSafeInteger(requestBytes) && requestBytes >= 0 ? requestBytes : 0,
        contentType: MEDIA_TYPE_RE.test(contentType) ? contentType : "",
        tlsVersion: TLS.has(l.tlsVersion) ? l.tlsVersion : "",
        blockReason: REASONS.has(l.blockReason) ? l.blockReason : "",
        blockRuleId:
          REASONS.has(l.blockReason) && uuid.test(l.blockRuleId) ? l.blockRuleId.toLowerCase() : "",
        query: policy.query ? clean(l.query, 2048) : "",
        headers,
        peerIp: policy.peer && isIP(l.peerIp) && l.peerIp !== l.clientIp ? l.peerIp : "",
      },
    ];
  });
  return app.db.transaction(async (tx) => {
    if (!(await tryLockNodeLogs(tx, node.id)))
      throw new ConnectError("log batch already in progress", Code.ResourceExhausted);
    const cursor = schema.nodeLogCursor;
    await tx.insert(cursor).values({ nodeId: node.id }).onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(cursor)
      .where(eq(cursor.nodeId, node.id))
      .for("update");
    if (!current) throw new Error("missing log cursor");
    if (sequence <= current.sequence) return 0;
    if (app.env.EDGEWEIR_ANALYTICS === "clickhouse") {
      // Immutable IDs + ReplacingMergeTree/FINAL cover a lost PG commit after a CH write.
      await insertClickHouseLogs(app.env, entries);
    } else if (entries.length) {
      for (const d of [
        ...new Set(entries.map((e) => Math.floor(Date.parse(e.time) / DAY) * DAY)),
      ].sort())
        await partition(tx, d);
      await tx
        .insert(schema.accessLog)
        .values(entries.map((e) => ({ ...e, time: new Date(e.time) })))
        .onConflictDoNothing();
    }
    await tx.update(cursor).set({ sequence }).where(eq(cursor.nodeId, node.id));
    return entries.length;
  });
}
export async function logSettings(app: AppContext, siteId: string) {
  const site = await findSite(app.db, siteId);
  return {
    sampleRate: site.logSampleRate,
    storage: app.env.EDGEWEIR_ANALYTICS,
    retentionDays: await retentionDays(app.db, app.env.EDGEWEIR_ANALYTICS),
    logBlocked: site.logBlocked,
    logQuery: site.logQuery,
    logHeaders: site.logHeaders,
    logPeer: site.logPeer,
  };
}
export async function configureLogs(app: AppContext, actor: Actor, input: LogSettingsInput) {
  return app.db.transaction(async (tx) => {
    const site = await findSite(tx, input.siteId, true);
    const before = {
      sampleRate: site.logSampleRate,
      logBlocked: site.logBlocked,
      logQuery: site.logQuery,
      logHeaders: site.logHeaders,
      logPeer: site.logPeer,
    };
    const after = {
      sampleRate: input.sampleRate ?? before.sampleRate,
      logBlocked: input.logBlocked ?? before.logBlocked,
      logQuery: input.logQuery ?? before.logQuery,
      logHeaders: input.logHeaders ?? before.logHeaders,
      logPeer: input.logPeer ?? before.logPeer,
    };
    // Only what changed is recorded (the sample rate as before when it is all that changed).
    const changed = Object.fromEntries(
      Object.entries(after).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(before[key as keyof typeof before]),
      ),
    );
    await tx
      .update(schema.site)
      .set({
        logSampleRate: after.sampleRate,
        logBlocked: after.logBlocked,
        logQuery: after.logQuery,
        logHeaders: after.logHeaders,
        logPeer: after.logPeer,
        updatedAt: new Date(),
      })
      .where(eq(schema.site.id, site.id));
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_updated", params: { site: site.name } },
      actor,
    });
    await recordAudit(tx, actor, {
      action: "site.logs_configure",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: Object.keys(changed).length ? changed : { sampleRate: after.sampleRate },
    });
    return { ok: true as const };
  });
}

/** A validated query: time bounds in milliseconds, filters normalized ("" / 0 when unset). */
export interface LogFilter {
  siteId: string;
  from: number;
  to: number;
  status: number | undefined;
  ip: string;
  path: string;
  requestId: string;
  host: string;
  method: string;
  /** 1-5, 0 for any. */
  statusClass: number;
  cacheStatus: string;
  /** A reason, "any" or "". */
  blockReason: string;
  country: string;
  asn: number;
  /** Lowercase, for case-insensitive containment. */
  ua: string;
  referer: string;
  minDuration: number;
  /** Canonical CIDR or "". */
  cidr: string;
  limit: number;
}

function toFilter(input: LogQuery, from: number, to: number): LogFilter {
  return {
    siteId: input.siteId,
    from,
    to,
    status: input.status,
    ip: input.ip,
    path: input.path,
    requestId: input.requestId ?? "",
    host: (input.host ?? "").toLowerCase(),
    method: (input.method ?? "").toUpperCase(),
    statusClass: input.statusClass ? Number(input.statusClass[0]) : 0,
    cacheStatus: input.cacheStatus ?? "",
    blockReason: input.blockReason ?? "",
    country: (input.country ?? "").toUpperCase(),
    asn: input.asn ?? 0,
    ua: (input.ua ?? "").toLowerCase(),
    referer: (input.referer ?? "").toLowerCase(),
    minDuration: input.minDuration ?? 0,
    cidr: input.cidr ? (normalizeCidr(input.cidr) ?? "") : "",
    limit: input.limit,
  };
}

function postgresWhere(f: LogFilter): SQL | undefined {
  const t = schema.accessLog;
  return and(
    eq(t.siteId, f.siteId),
    gte(t.time, new Date(f.from)),
    lt(t.time, new Date(f.to)),
    f.status ? eq(t.status, f.status) : undefined,
    f.ip ? eq(t.clientIp, f.ip) : undefined,
    f.path ? sql`starts_with(${t.path}, ${f.path})` : undefined,
    f.requestId ? eq(t.requestId, f.requestId) : undefined,
    f.host ? sql`lower(${t.host}) = ${f.host}` : undefined,
    f.method ? eq(t.method, f.method) : undefined,
    f.statusClass ? sql`${t.status} / 100 = ${f.statusClass}` : undefined,
    f.cacheStatus ? eq(t.cacheStatus, f.cacheStatus) : undefined,
    f.blockReason === "any"
      ? sql`${t.blockReason} <> ''`
      : f.blockReason
        ? eq(t.blockReason, f.blockReason)
        : undefined,
    f.country ? eq(t.country, f.country) : undefined,
    f.asn ? eq(t.asn, f.asn) : undefined,
    f.ua ? sql`strpos(lower(${t.userAgent}), ${f.ua}) > 0` : undefined,
    f.referer ? sql`strpos(lower(${t.referer}), ${f.referer}) > 0` : undefined,
    f.minDuration ? gte(t.durationMs, f.minDuration) : undefined,
    // Stored client addresses are validated IPs.
    f.cidr ? sql`${t.clientIp}::inet <<= ${f.cidr}::cidr` : undefined,
  );
}

export async function queryLogs(app: AppContext, input: LogQuery) {
  await findSite(app.db, input.siteId);
  const days = await retentionDays(app.db, app.env.EDGEWEIR_ANALYTICS);
  const from = Math.max(Date.parse(input.from), logCutoff(Date.now(), days)),
    to = Math.min(Date.parse(input.to), Date.now() + 300000);
  if (from >= to) return { entries: [], truncated: false };
  const filter = toFilter(input, from, to);
  const entries: LogEntry[] =
    app.env.EDGEWEIR_ANALYTICS === "clickhouse"
      ? await queryClickHouseLogs(app.env, filter)
      : (
          await app.db
            .select()
            .from(schema.accessLog)
            .where(postgresWhere(filter))
            .orderBy(desc(schema.accessLog.time), desc(schema.accessLog.id))
            .limit(filter.limit + 1)
        ).map((e) => ({ ...e, time: e.time.toISOString() }));
  return { entries: entries.slice(0, input.limit), truncated: entries.length > input.limit };
}
export function logsCsv(entries: LogEntry[]) {
  const fields = [
    "time",
    "clientIp",
    "method",
    "host",
    "path",
    "status",
    "bytesSent",
    "durationMs",
    "cacheStatus",
    "sampleRate",
    "nodeId",
    "requestId",
    "ja4",
    "wafRuleIds",
    "wafBlocked",
    "ruleIds",
    "userAgent",
    "referer",
    "httpVersion",
    "scheme",
    "country",
    "asn",
    "asName",
    "upstreamAddr",
    "upstreamStatus",
    "upstreamMs",
    "requestBytes",
    "contentType",
    "tlsVersion",
    "blockReason",
    "blockRuleId",
    "query",
    "headers",
    "peerIp",
  ] as const;
  const cell = (value: unknown) => {
    let text = Array.isArray(value)
      ? value.join(" ")
      : value !== null && typeof value === "object"
        ? Object.entries(value)
            .map(([name, v]) => `${name}: ${v}`)
            .join("; ")
        : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [fields.join(","), ...entries.map((e) => fields.map((f) => cell(e[f])).join(","))].join(
    "\r\n",
  );
}
