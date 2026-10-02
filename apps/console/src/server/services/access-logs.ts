import { isIP } from "node:net";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LogEntry, LogQuery } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import type { AccessLog } from "@edgeweir/proto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { lockLogPartition, lockLogPartitions, tryLockNodeLogs } from "../lib/locks";
import type { Actor } from "./audit";
import { recordAudit } from "./audit";
import { insertClickHouseLogs, queryClickHouseLogs } from "./clickhouse";
import { type Executor, publishRevision } from "./revisions";
import { findSite } from "./sites";

const DAY = 86400000;
/** a_b_c: protocol, version, SNI, counts and ALPN, then two truncated SHA-256 hashes. */
const JA4_RE = /^[a-z][a-z0-9]{2}[di][0-9]{4}[a-zA-Z0-9]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CRS rule ids kept per log entry (nodes send at most 16). */
const MAX_WAF_RULE_IDS = 16;
/** Request ids as nodes answer them (X-Request-Id); anything else is stored empty. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const logCutoff = (now = Date.now()) => Math.floor(now / DAY) * DAY - 6 * DAY;
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
export async function maintainLogs(db: Database, now = Date.now()) {
  await db.transaction(async (tx) => {
    await lockLogPartitions(tx);
    for (let d = logCutoff(now); d <= Math.floor(now / DAY) * DAY + DAY; d += DAY)
      await partition(tx, d);
    const rows = await tx.execute<{ relname: string }>(
      sql`select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='access_log'::regclass`,
    );
    const cutoff = new Date(logCutoff(now)).toISOString().slice(0, 10).replaceAll("-", "");
    for (const row of rows.rows)
      if (/^access_log_\d{8}$/.test(row.relname) && row.relname.slice(-8) < cutoff)
        await tx.execute(sql.raw(`DROP TABLE "${row.relname}"`));
  });
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
  const ids = [...new Set(logs.map((l) => l.siteId).filter((id) => uuid.test(id)))];
  const sites = ids.length
    ? await app.db
        .select({ id: schema.site.id, logJa4: schema.siteProtection.logJa4 })
        .from(schema.site)
        .leftJoin(schema.siteProtection, eq(schema.siteProtection.siteId, schema.site.id))
        .where(
          and(
            inArray(schema.site.id, ids),
            eq(schema.site.clusterId, node.clusterId),
            // The site samples, or an enabled site or platform rule samples some
            // of its requests (config action logSampleRate, rules-v2).
            sql`(${schema.site.logSampleRate} > 0 or exists (
              select 1 from ${schema.edgeRule}
              where (${schema.edgeRule.siteId} = ${schema.site.id} or ${schema.edgeRule.siteId} is null)
                and ${schema.edgeRule.enabled}
                and ${schema.edgeRule.action}->>'kind' = 'config'
                and (${schema.edgeRule.action}->>'logSampleRate')::int > 0))`,
          ),
        )
    : [];
  const allowed = new Set(sites.map((s) => s.id));
  // JA4 is kept only while the site records it (current privacy policy).
  const ja4Sites = new Set(sites.filter((s) => s.logJa4).map((s) => s.id));
  const entries: LogEntry[] = logs.flatMap((l, index) => {
    const time = l.time ? timestampDate(l.time).getTime() : NaN,
      bytes = Number(l.bytesSent);
    if (
      !allowed.has(l.siteId) ||
      !Number.isFinite(time) ||
      time < logCutoff(now) ||
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
    const clean = (v: string, n: number) => v.replace(/\p{Cc}/gu, "").slice(0, n);
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
        cacheStatus: [
          "HIT",
          "MISS",
          "BYPASS",
          "EXPIRED",
          "STALE",
          "UPDATING",
          "REVALIDATED",
        ].includes(l.cacheStatus)
          ? l.cacheStatus
          : "",
        sampleRate: l.sampleRate,
        ja4: ja4Sites.has(l.siteId) && JA4_RE.test(l.ja4) ? l.ja4 : "",
        wafRuleIds: [...new Set(l.wafRuleIds.filter((id) => id > 0))]
          .sort((a, b) => a - b)
          .slice(0, MAX_WAF_RULE_IDS),
        wafBlocked: l.wafBlocked,
        requestId: REQUEST_ID_RE.test(l.requestId) ? l.requestId : "",
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
  return { sampleRate: site.logSampleRate, storage: app.env.EDGEWEIR_ANALYTICS };
}
export async function configureLogs(
  app: AppContext,
  actor: Actor,
  input: { siteId: string; sampleRate: number },
) {
  return app.db.transaction(async (tx) => {
    const site = await findSite(tx, input.siteId, true);
    await tx
      .update(schema.site)
      .set({ logSampleRate: input.sampleRate, updatedAt: new Date() })
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
      metadata: { sampleRate: input.sampleRate },
    });
    return { ok: true as const };
  });
}
export async function queryLogs(app: AppContext, input: LogQuery) {
  await findSite(app.db, input.siteId);
  const from = Math.max(Date.parse(input.from), logCutoff()),
    to = Math.min(Date.parse(input.to), Date.now() + 300000);
  if (from >= to) return { entries: [], truncated: false };
  const bounded = { ...input, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  const entries: LogEntry[] =
    app.env.EDGEWEIR_ANALYTICS === "clickhouse"
      ? await queryClickHouseLogs(app.env, bounded)
      : (
          await app.db
            .select()
            .from(schema.accessLog)
            .where(
              and(
                eq(schema.accessLog.siteId, input.siteId),
                gte(schema.accessLog.time, new Date(from)),
                lt(schema.accessLog.time, new Date(to)),
                input.status ? eq(schema.accessLog.status, input.status) : undefined,
                input.ip ? eq(schema.accessLog.clientIp, input.ip) : undefined,
                input.path ? sql`starts_with(${schema.accessLog.path}, ${input.path})` : undefined,
                input.requestId ? eq(schema.accessLog.requestId, input.requestId) : undefined,
              ),
            )
            .orderBy(desc(schema.accessLog.time), desc(schema.accessLog.id))
            .limit(input.limit + 1)
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
  ] as const;
  const cell = (value: unknown) => {
    let text = Array.isArray(value) ? value.join(" ") : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [fields.join(","), ...entries.map((e) => fields.map((f) => cell(e[f])).join(","))].join(
    "\r\n",
  );
}
