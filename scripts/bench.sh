#!/usr/bin/env bash
# Local compose.e2e cache-hit baseline. Set BENCH_BASELINE to a previous JSON result.
set -euo pipefail
OHA_BIN="${OHA_BIN:-oha}"
command -v "$OHA_BIN" >/dev/null || { echo 'Install oha or set OHA_BIN to its verified binary.' >&2; exit 1; }
BENCH_URL="${BENCH_URL:-http://127.0.0.1:${E2E_NODE_PORT:-18080}/bench-cache.txt}"
BENCH_HOST="${BENCH_HOST:-demo.test}"
BENCH_REQUESTS="${BENCH_REQUESTS:-100000}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-32}"
BENCH_OUTPUT="${BENCH_OUTPUT:-.e2e/bench.json}"
mkdir -p "$(dirname "$BENCH_OUTPUT")"
for _ in 1 2; do curl -fsS -H "Host: $BENCH_HOST" "$BENCH_URL" -o /dev/null; done
HEADERS="$(curl -fsS -D - -o /dev/null -H "Host: $BENCH_HOST" "$BENCH_URL")"
if ! printf '%s\n' "$HEADERS" | tr -d '\r' | rg -qi '^x-cache: HIT$'; then
  echo 'Refusing to benchmark: the warmed response is not a cache HIT.' >&2
  exit 1
fi
"$OHA_BIN" --no-tui --output-format json -n "$BENCH_REQUESTS" -c "$BENCH_CONCURRENCY" -t 10s -H "Host: $BENCH_HOST" "$BENCH_URL" > "$BENCH_OUTPUT"
NODE_CONTAINER="$(docker compose -f compose.e2e.yml ps -q node)"
MEMORY="$(docker stats --no-stream --format '{{.MemUsage}}' "$NODE_CONTAINER")"
RSS_KIB="$(docker exec "$NODE_CONTAINER" sh -c 'awk "/^VmRSS:/ { sum += \$2 } END { print sum }" /proc/[0-9]*/status 2>/dev/null')"
export BENCH_OUTPUT BENCH_BASELINE="${BENCH_BASELINE:-}" MEMORY RSS_KIB BENCH_REQUESTS BENCH_CONCURRENCY
node --input-type=module <<'JS'
import fs from 'node:fs';
const current=JSON.parse(fs.readFileSync(process.env.BENCH_OUTPUT,'utf8'));
const summary={recordedAt:new Date().toISOString(),requests:Number(process.env.BENCH_REQUESTS),concurrency:Number(process.env.BENCH_CONCURRENCY),qps:current.summary.requestsPerSec*current.summary.successRate,p50Ms:current.latencyPercentiles.p50===null?null:current.latencyPercentiles.p50*1000,p99Ms:current.latencyPercentiles.p99===null?null:current.latencyPercentiles.p99*1000,successRate:current.summary.successRate,nodeRssMiB:Number(process.env.RSS_KIB)>0?Number(process.env.RSS_KIB)/1024:null,containerMemory:process.env.MEMORY};
if(process.env.BENCH_BASELINE){
  const before=JSON.parse(fs.readFileSync(process.env.BENCH_BASELINE,'utf8'));
  const change=(current,previous)=>Number.isFinite(current)&&Number.isFinite(previous)&&previous>0?(current/previous-1)*100:null;
  summary.qpsChangePercent=change(summary.qps,before.qps);
  summary.p50ChangePercent=change(summary.p50Ms,before.p50Ms);
  summary.p99ChangePercent=change(summary.p99Ms,before.p99Ms);
  summary.rssChangePercent=change(summary.nodeRssMiB,before.nodeRssMiB);
  summary.regressions=[
    ...(summary.qpsChangePercent!==null&&summary.qpsChangePercent < -20?['qps']:[]),
    ...(summary.p50ChangePercent!==null&&summary.p50ChangePercent > 20?['p50']:[]),
    ...(summary.p99ChangePercent!==null&&summary.p99ChangePercent > 20?['p99']:[]),
    ...(summary.rssChangePercent!==null&&summary.rssChangePercent > 20?['rss']:[]),
  ];
  summary.regressionOver20Percent=summary.regressions.length>0;
}
fs.writeFileSync(process.env.BENCH_OUTPUT.endsWith('.json')?process.env.BENCH_OUTPUT.replace(/\.json$/,'.summary.json'):process.env.BENCH_OUTPUT+'.summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
if(summary.successRate!==1||Object.keys(current.statusCodeDistribution).some(code=>code!=='200'))process.exitCode=1;
JS
