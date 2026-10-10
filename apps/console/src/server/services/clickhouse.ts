import type { LogEntry } from "@edgeweir/contract";
import type { Env } from "../lib/env";
import type { LogFilter } from "./access-logs";
import { DIMENSION_COLUMNS } from "./stats-dims";

/** access_log columns of ADR-0041 (ClickHouse types and defaults). */
const LOG_COLUMNS = [
  ["user_agent", "String DEFAULT ''"],
  ["referer", "String DEFAULT ''"],
  ["http_version", "LowCardinality(String) DEFAULT ''"],
  ["scheme", "LowCardinality(String) DEFAULT ''"],
  ["country", "LowCardinality(String) DEFAULT ''"],
  ["asn", "UInt32 DEFAULT 0"],
  ["as_name", "String DEFAULT ''"],
  ["upstream_addr", "String DEFAULT ''"],
  ["upstream_status", "UInt16 DEFAULT 0"],
  ["upstream_ms", "UInt32 DEFAULT 0"],
  ["request_bytes", "UInt64 DEFAULT 0"],
  ["content_type", "LowCardinality(String) DEFAULT ''"],
  ["tls_version", "LowCardinality(String) DEFAULT ''"],
  ["block_reason", "LowCardinality(String) DEFAULT ''"],
  ["block_rule_id", "String DEFAULT ''"],
  ["query", "String DEFAULT ''"],
  ["headers", "Map(String, String)"],
  ["peer_ip", "String DEFAULT ''"],
] as const;

/** Operator-controlled endpoint from the environment. Credentials stay in headers. */
export async function clickhouse(
  env: Env,
  query: string,
  params: Record<string, string> = {},
  data = "",
) {
  const url = new URL(env.EDGEWEIR_CLICKHOUSE_URL);
  url.searchParams.set("database", env.EDGEWEIR_CLICKHOUSE_DATABASE);
  url.searchParams.set("wait_end_of_query", "1");
  url.searchParams.set("max_execution_time", "10");
  url.searchParams.set("max_result_bytes", "16777216");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(`param_${key}`, value);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "X-ClickHouse-User": env.EDGEWEIR_CLICKHOUSE_USER,
      "X-ClickHouse-Key": env.EDGEWEIR_CLICKHOUSE_PASSWORD,
    },
    body: query + (data ? `\n${data}` : ""),
  });
  // Do not echo backend errors: queries can contain client IPs and private paths.
  if (!response.ok || response.headers.has("X-ClickHouse-Exception-Code")) {
    await response.body?.cancel();
    throw new Error(`ClickHouse request failed (${response.status})`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error("ClickHouse result exceeded limit");
      chunks.push(chunk);
    }
  return Buffer.concat(chunks).toString("utf8");
}
const ready = new WeakMap<Env, Promise<void>>();
export async function ensureClickHouse(env: Env) {
  if (env.EDGEWEIR_ANALYTICS !== "clickhouse") return;
  let job = ready.get(env);
  if (!job) {
    job = (async () => {
      await clickhouse(
        env,
        `CREATE TABLE IF NOT EXISTS access_log (
        time DateTime64(3, 'UTC'), id String, node_id UUID, site_id UUID,
        client_ip String, method LowCardinality(String), host String, path String,
        status UInt16, bytes_sent UInt64, duration_ms UInt32, cache_status LowCardinality(String), sample_rate UInt16,
        ja4 String DEFAULT '', waf_rule_ids Array(UInt32) DEFAULT [], waf_blocked Bool DEFAULT false,
        request_id String DEFAULT '', rule_ids Array(String) DEFAULT []
      ) ENGINE = ReplacingMergeTree ORDER BY (site_id, time, id)
        PARTITION BY toDate(time) TTL toDateTime(time) + INTERVAL 7 DAY`,
      );
      // Tables created before JA4 logging, CRS and request ids.
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS ja4 String DEFAULT ''",
      );
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS waf_rule_ids Array(UInt32) DEFAULT []",
      );
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS waf_blocked Bool DEFAULT false",
      );
      // Log rules that wrote a line whatever the sample rate (waf-v2).
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS rule_ids Array(String) DEFAULT []",
      );
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS request_id String DEFAULT ''",
      );
      await clickhouse(
        env,
        `CREATE TABLE IF NOT EXISTS minute_stats (
        minute DateTime('UTC'), node_id UUID, site_id UUID, revision UInt64,
        requests UInt64, bytes_sent UInt64, bytes_received UInt64, cache_hits UInt64, cache_misses UInt64,
        status_codes Map(String, UInt64), top_urls Map(String, UInt64), top_ips Map(String, UInt64),
        waf_rules Map(String, UInt64), logged_rules Map(String, UInt64), auth_failures UInt64
      ) ENGINE = ReplacingMergeTree(revision) ORDER BY (site_id, minute, node_id)
        PARTITION BY toDate(minute) TTL minute + INTERVAL 7 DAY`,
      );
      await clickhouse(
        env,
        "ALTER TABLE minute_stats ADD COLUMN IF NOT EXISTS waf_rules Map(String, UInt64)",
      );
      await clickhouse(
        env,
        "ALTER TABLE minute_stats ADD COLUMN IF NOT EXISTS logged_rules Map(String, UInt64)",
      );
      await clickhouse(
        env,
        "ALTER TABLE minute_stats ADD COLUMN IF NOT EXISTS auth_failures UInt64 DEFAULT 0",
      );
      // Bytes WebP / AVIF variants saved (image-convert-v1, ADR-0043).
      await clickhouse(
        env,
        "ALTER TABLE minute_stats ADD COLUMN IF NOT EXISTS image_bytes_saved UInt64 DEFAULT 0",
      );
      // Statistics dimensions (stats-dims-v1, ADR-0041).
      for (const column of DIMENSION_COLUMNS)
        await clickhouse(
          env,
          `ALTER TABLE minute_stats ADD COLUMN IF NOT EXISTS ${column} ${column.startsWith("challenges_") ? "UInt64 DEFAULT 0" : "Map(String, UInt64)"}`,
        );
      // Access log fields (ADR-0041 §1, §2).
      for (const [column, type] of LOG_COLUMNS)
        await clickhouse(env, `ALTER TABLE access_log ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    })();
    ready.set(env, job);
    job.catch(() => ready.delete(env));
  }
  return job;
}
export async function insertClickHouseLogs(env: Env, rows: LogEntry[]) {
  await ensureClickHouse(env);
  if (!rows.length) return;
  const data = rows
    .map((r) =>
      JSON.stringify({
        time: r.time.replace("T", " ").replace("Z", ""),
        id: r.id,
        node_id: r.nodeId,
        site_id: r.siteId,
        client_ip: r.clientIp,
        method: r.method,
        host: r.host,
        path: r.path,
        status: r.status,
        bytes_sent: r.bytesSent,
        duration_ms: r.durationMs,
        cache_status: r.cacheStatus,
        sample_rate: r.sampleRate,
        ja4: r.ja4,
        waf_rule_ids: r.wafRuleIds,
        waf_blocked: r.wafBlocked,
        request_id: r.requestId,
        rule_ids: r.ruleIds,
        user_agent: r.userAgent,
        referer: r.referer,
        http_version: r.httpVersion,
        scheme: r.scheme,
        country: r.country,
        asn: r.asn,
        as_name: r.asName,
        upstream_addr: r.upstreamAddr,
        upstream_status: r.upstreamStatus,
        upstream_ms: r.upstreamMs,
        request_bytes: r.requestBytes,
        content_type: r.contentType,
        tls_version: r.tlsVersion,
        block_reason: r.blockReason,
        block_rule_id: r.blockRuleId,
        query: r.query,
        headers: r.headers,
        peer_ip: r.peerIp,
      }),
    )
    .join("\n");
  await clickhouse(env, "INSERT INTO access_log FORMAT JSONEachRow", {}, data);
}
export async function queryClickHouseLogs(env: Env, input: LogFilter): Promise<LogEntry[]> {
  await ensureClickHouse(env);
  const output = await clickhouse(
    env,
    `SELECT id, formatDateTime(time, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS timeIso,
    toString(node_id) AS nodeId, toString(site_id) AS siteId, client_ip AS clientIp, method, host, path, status,
    toFloat64(bytes_sent) AS bytesSent, duration_ms AS durationMs, cache_status AS cacheStatus, sample_rate AS sampleRate, ja4,
    waf_rule_ids AS wafRuleIds, waf_blocked AS wafBlocked, request_id AS requestId, rule_ids AS ruleIds,
    user_agent AS userAgent, referer, http_version AS httpVersion, scheme, country, asn, as_name AS asName,
    upstream_addr AS upstreamAddr, upstream_status AS upstreamStatus, upstream_ms AS upstreamMs,
    toFloat64(request_bytes) AS requestBytes, content_type AS contentType, tls_version AS tlsVersion,
    block_reason AS blockReason, block_rule_id AS blockRuleId, query, headers, peer_ip AS peerIp
    FROM access_log FINAL WHERE site_id = {site:UUID}
      AND time >= fromUnixTimestamp64Milli({from:Int64}) AND time < fromUnixTimestamp64Milli({to:Int64})
      AND ({status:UInt16} = 0 OR status = {status:UInt16}) AND ({ip:String} = '' OR client_ip = {ip:String})
      AND ({requestId:String} = '' OR request_id = {requestId:String})
      AND startsWith(path, {path:String})
      AND ({host:String} = '' OR lower(host) = {host:String})
      AND ({method:String} = '' OR method = {method:String})
      AND ({statusClass:UInt8} = 0 OR intDiv(status, 100) = {statusClass:UInt8})
      AND ({cache:String} = '' OR cache_status = {cache:String})
      AND ({reason:String} = '' OR ({reason:String} = 'any' AND block_reason != '') OR block_reason = {reason:String})
      AND ({country:String} = '' OR country = {country:String})
      AND ({asn:UInt32} = 0 OR asn = {asn:UInt32})
      AND ({ua:String} = '' OR positionCaseInsensitiveUTF8(user_agent, {ua:String}) > 0)
      AND ({referer:String} = '' OR positionCaseInsensitiveUTF8(referer, {referer:String}) > 0)
      AND duration_ms >= {minDuration:UInt32}
      AND ({cidr:String} = '' OR isIPAddressInRange(client_ip, {cidr:String}))
      ORDER BY time DESC, id DESC LIMIT {limit:UInt32} FORMAT JSONEachRow`,
    {
      site: input.siteId,
      from: String(input.from),
      to: String(input.to),
      status: String(input.status ?? 0),
      ip: input.ip,
      path: input.path,
      requestId: input.requestId,
      host: input.host,
      method: input.method,
      statusClass: String(input.statusClass),
      cache: input.cacheStatus,
      reason: input.blockReason,
      country: input.country,
      asn: String(input.asn),
      ua: input.ua,
      referer: input.referer,
      minDuration: String(input.minDuration),
      cidr: input.cidr,
      limit: String(input.limit + 1),
    },
  );
  return output.trim()
    ? output
        .trim()
        .split("\n")
        .map((line) => {
          const { timeIso, ...rest } = JSON.parse(line);
          return { ...rest, time: new Date(timeIso).toISOString() } as LogEntry;
        })
    : [];
}

/** Keeps access logs for `days` (ADR-0041 §5); the console applies it once per value and process. */
export async function applyClickHouseRetention(env: Env, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("invalid retention");
  await ensureClickHouse(env);
  await clickhouse(
    env,
    `ALTER TABLE access_log MODIFY TTL toDateTime(time) + INTERVAL ${days} DAY`,
  );
}

/** Absolute snapshots, versioned by the same durable node sequence as Postgres. */
export async function mirrorMinuteStats(
  env: Env,
  tx: import("./revisions").Executor,
  nodeId: string,
  sequence: bigint,
  keys: { siteId: string; minute: string }[],
) {
  await ensureClickHouse(env);
  const { sql } = await import("drizzle-orm");
  const result = await tx.execute<Record<string, unknown>>(sql`
    select to_char(s.minute AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS minute,
      s.node_id, s.site_id, s.requests, s.bytes_sent, s.bytes_received, s.cache_hits, s.cache_misses,
      s.status_codes, s.top_urls, s.top_ips, s.waf_rules, s.logged_rules, s.auth_failures,
      s.image_bytes_saved, ${sql.raw(DIMENSION_COLUMNS.map((c) => `s.${c}`).join(", "))}
    from node_minute_stats s inner join (
      select distinct x."siteId", date_trunc('minute', x.minute::timestamptz, 'UTC') AS minute
      from jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) AS x("siteId" text, minute text)
    ) k ON s.site_id::text=k."siteId" AND s.minute=k.minute WHERE s.node_id=${nodeId}::uuid
  `);
  if (result.rows.length)
    await clickhouse(
      env,
      "INSERT INTO minute_stats FORMAT JSONEachRow",
      {},
      result.rows.map((row) => JSON.stringify({ ...row, revision: String(sequence) })).join("\n"),
    );
}
