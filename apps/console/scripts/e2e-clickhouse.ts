// Explicit integration check against a disposable ClickHouse instance.
// pnpm --filter @edgeweir/console exec tsx scripts/e2e-clickhouse.ts http://localhost:38123
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type Database, defaultMigrationsFolder, schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { AppContext } from "../src/server/lib/context";
import { loadEnv } from "../src/server/lib/env";
import { ingestLogs, queryLogs, setLogRetention } from "../src/server/services/access-logs";
import {
  clickhouse,
  insertClickHouseLogs,
  mirrorMinuteStats,
} from "../src/server/services/clickhouse";
import { ingestStatsBatch } from "../src/server/services/stats";

const endpoint = process.argv[2];
assert.ok(endpoint, "pass the disposable ClickHouse HTTP endpoint");
const client = new PGlite();
const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Database;
await migrate(db as never, {
  migrationsFolder: defaultMigrationsFolder,
  migrationsSchema: "drizzle",
});
const env = loadEnv({
  DATABASE_URL: "postgres://unused",
  EDGEWEIR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  BETTER_AUTH_SECRET: "e2e-only-not-a-secret".repeat(2),
  EDGEWEIR_ANALYTICS: "clickhouse",
  EDGEWEIR_CLICKHOUSE_URL: endpoint,
  EDGEWEIR_CLICKHOUSE_PASSWORD:
    process.env.EDGEWEIR_CLICKHOUSE_PASSWORD ?? "e2e-clickhouse-password",
});
const app = { db, env } as AppContext;
try {
  const [cluster] = await db.insert(schema.cluster).values({ name: "ch-e2e" }).returning();
  assert.ok(cluster);
  const [node] = await db
    .insert(schema.node)
    .values({ name: "ch-e2e", clusterId: cluster.id })
    .returning();
  assert.ok(node);
  const [site] = await db
    .insert(schema.site)
    .values({ name: "ch-e2e", clusterId: cluster.id, logSampleRate: 10000, cnamePrefix: "ch-e2e" })
    .returning();
  assert.ok(site);
  const at = new Date(Date.now() - 1000);
  const record = create(AccessLogSchema, {
    time: timestampFromDate(at),
    siteId: site.id,
    clientIp: "2001:db8::1",
    method: "GET",
    host: "test.example",
    path: "/private?token=redacted",
    status: 403,
    bytesSent: 50n,
    durationMs: 5,
    sampleRate: 10000,
    // ADR-0041 fields.
    userAgent: "Mozilla/5.0 Firefox/131",
    referer: "https://ref.example/page",
    httpVersion: "2",
    scheme: "https",
    country: "NL",
    asn: 1136,
    asName: "KPN B.V.",
    requestBytes: 300n,
    contentType: "text/html",
    tlsVersion: "1.3",
    blockReason: "region",
  });
  assert.equal(await ingestLogs(app, node, 1n, [record]), 1);
  assert.equal(await ingestLogs(app, node, 1n, [record]), 0);
  const input = {
    siteId: site.id,
    from: new Date(at.getTime() - 60000).toISOString(),
    to: new Date(at.getTime() + 60000).toISOString(),
    ip: "",
    path: "/private",
    status: 403,
    limit: 100,
  };
  let result = await queryLogs(app, input);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.path, "/private");
  await insertClickHouseLogs(env, result.entries); // Simulate CH commit + lost PG acknowledgement.
  result = await queryLogs(app, input);
  assert.equal(result.entries.length, 1);
  assert.equal((await queryLogs(app, { ...input, status: 200 })).entries.length, 0);
  assert.equal(result.entries[0]?.country, "NL");
  assert.equal(result.entries[0]?.asn, 1136);
  assert.equal(result.entries[0]?.requestBytes, 300);
  assert.equal(result.entries[0]?.blockReason, "region");
  // The G16 filters on ClickHouse (positionCaseInsensitiveUTF8, isIPAddressInRange).
  for (const [filter, count] of [
    [{ blockReason: "any" }, 1],
    [{ blockReason: "rule" }, 0],
    [{ country: "NL", asn: 1136 }, 1],
    [{ ua: "FIREFOX" }, 1],
    [{ referer: "ref.example" }, 1],
    [{ statusClass: "4xx" }, 1],
    [{ statusClass: "2xx" }, 0],
    [{ cidr: "2001:db8::/32" }, 1],
    [{ cidr: "192.0.2.0/24" }, 0],
    [{ minDuration: 6 }, 0],
    [{ host: "TEST.example", method: "get" }, 1],
    [{ cacheStatus: "HIT" }, 0],
  ] as const)
    assert.equal(
      (await queryLogs(app, { ...input, ...filter })).entries.length,
      count,
      JSON.stringify(filter),
    );
  assert.equal((await db.select().from(schema.accessLog)).length, 0);
  const minute = new Date(Math.floor(at.getTime() / 60000) * 60000);
  const bucket = {
    siteId: site.id,
    minute,
    requests: 9,
    bytesSent: 90,
    bytesReceived: 10,
    cacheHits: 8,
    cacheMisses: 1,
    statusCodes: { "200": 9 },
    dimensions: {
      countries: [{ country: "NL", requests: 9, bytesSent: 90 }],
      asns: [{ asn: 1136, name: "KPN B.V.", requests: 9 }],
      browsers: { firefox: 9 },
      blockReasons: { region: 1 },
      challengesIssued: 2,
    },
  };
  const mirror = (tx: import("../src/server/services/revisions").Executor) =>
    mirrorMinuteStats(env, tx, node.id, 1n, [{ siteId: site.id, minute: minute.toISOString() }]);
  await ingestStatsBatch(db, node, 1n, [bucket], undefined, mirror);
  await ingestStatsBatch(db, node, 1n, [bucket], undefined, mirror);
  const stats = await clickhouse(
    env,
    "SELECT requests FROM minute_stats FINAL WHERE site_id={site:UUID} FORMAT JSONEachRow",
    { site: site.id },
  );
  assert.equal(Number(JSON.parse(stats.trim()).requests), 9);
  const dims = JSON.parse(
    (
      await clickhouse(
        env,
        "SELECT country_requests, asns, browsers, block_reasons, challenges_issued FROM minute_stats FINAL WHERE site_id={site:UUID} FORMAT JSONEachRow",
        { site: site.id },
      )
    ).trim(),
  );
  assert.equal(Number(dims.country_requests.NL), 9);
  assert.equal(Number(dims.asns["1136"]), 9);
  assert.equal(Number(dims.block_reasons.region), 1);
  assert.equal(Number(dims.challenges_issued), 2);
  // Retention: the access_log TTL follows the setting (ADR-0041 §5).
  await setLogRetention(
    app,
    { type: "user", id: "ch-e2e" },
    { postgresDays: 7, clickhouseDays: 30 },
  );
  const ddl = await clickhouse(env, "SHOW CREATE TABLE access_log FORMAT TSVRaw");
  assert.match(ddl, /TTL toDateTime\(time\) \+ toIntervalDay\(30\)/);
  console.log(
    "ClickHouse E2E OK: raw logs, privacy, FINAL retry dedup, G16 fields and filters, sequenced minute stats with dimensions, retention TTL",
  );
} finally {
  await client.close();
}
