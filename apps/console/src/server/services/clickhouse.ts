import type { LogEntry, LogQuery } from "@edgeweir/contract";
import type { Env } from "../lib/env";

/** Operator-controlled endpoint, never a tenant URL. Credentials stay in headers. */
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
        ja4 String DEFAULT ''
      ) ENGINE = ReplacingMergeTree ORDER BY (site_id, time, id)
        PARTITION BY toDate(time) TTL toDateTime(time) + INTERVAL 7 DAY`,
      );
      // Tables created before JA4 logging.
      await clickhouse(
        env,
        "ALTER TABLE access_log ADD COLUMN IF NOT EXISTS ja4 String DEFAULT ''",
      );
      await clickhouse(
        env,
        `CREATE TABLE IF NOT EXISTS minute_stats (
        minute DateTime('UTC'), node_id UUID, site_id UUID, revision UInt64,
        requests UInt64, bytes_sent UInt64, bytes_received UInt64, cache_hits UInt64, cache_misses UInt64,
        status_codes Map(String, UInt64), top_urls Map(String, UInt64), top_ips Map(String, UInt64)
      ) ENGINE = ReplacingMergeTree(revision) ORDER BY (site_id, minute, node_id)
        PARTITION BY toDate(minute) TTL minute + INTERVAL 7 DAY`,
      );
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
      }),
    )
    .join("\n");
  await clickhouse(env, "INSERT INTO access_log FORMAT JSONEachRow", {}, data);
}
export async function queryClickHouseLogs(env: Env, input: LogQuery): Promise<LogEntry[]> {
  await ensureClickHouse(env);
  const output = await clickhouse(
    env,
    `SELECT id, formatDateTime(time, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS timeIso,
    toString(node_id) AS nodeId, toString(site_id) AS siteId, client_ip AS clientIp, method, host, path, status,
    toFloat64(bytes_sent) AS bytesSent, duration_ms AS durationMs, cache_status AS cacheStatus, sample_rate AS sampleRate, ja4
    FROM access_log FINAL WHERE site_id = {site:UUID}
      AND time >= fromUnixTimestamp64Milli({from:Int64}) AND time < fromUnixTimestamp64Milli({to:Int64})
      AND ({status:UInt16} = 0 OR status = {status:UInt16}) AND ({ip:String} = '' OR client_ip = {ip:String})
      AND startsWith(path, {path:String}) ORDER BY time DESC, id DESC LIMIT {limit:UInt32} FORMAT JSONEachRow`,
    {
      site: input.siteId,
      from: String(Date.parse(input.from)),
      to: String(Date.parse(input.to)),
      status: String(input.status ?? 0),
      ip: input.ip,
      path: input.path,
      limit: String(input.limit + 1),
    },
  );
  return output.trim()
    ? output
        .trim()
        .split("\n")
        .map((line) =>
          (() => {
            const row = JSON.parse(line);
            const { timeIso, ...rest } = row;
            return { ...rest, time: new Date(timeIso).toISOString() } as LogEntry;
          })(),
        )
    : [];
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
      s.status_codes, s.top_urls, s.top_ips
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
