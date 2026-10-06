#!/usr/bin/env bash
# Local compose.e2e benchmark of the edge node. Set BENCH_BASELINE to a previous JSON result.
# BENCH_SCENARIO:
#   cache      (default) cache HITs of demo.test.
#   pass       an Under Attack site, every request with a valid pass: the script
#              solves the site's challenge first (cookie302, js or pow) with the
#              User-Agent oha sends, then expects 200 and X-Cache HIT as for cache.
#   challenge  the same site without a pass: every answer is the challenge (403
#              page, 302 for cookie302); no HIT check.
#   headers    cache HITs of a site whose rules compute header values (rules-v3):
#              request headers from http.request.id and ip.geoip.country, two
#              Link lines added with append, X-Cache-Status from
#              http.response.cache_status and a User-Agent wildcard; checks that
#              the warmed response carries X-Cache-Status: HIT and two Link lines.
#   proxy      cache HITs of proxy-bench.g9.test on the edge node of cluster
#              g9-proxy through g9-lb, which sends PROXY protocol v2 (the
#              cluster's client IP: PROXY protocol).
#   proxy-plain the same node through the same balancer hop without the header
#              (the cluster's client IP: direct), the baseline of proxy.
# pass and challenge default to ua-bench.test, which scripts/e2e-g2.mjs leaves
# behind (whoami, cache rule on /, Under Attack js); headers to
# hdr-bench.g8.test, which scripts/e2e-g8.mjs leaves behind; proxy and
# proxy-plain to proxy-bench.g9.test, which scripts/e2e-g9.mjs sets up (run
# it again after the full e2e, which cleans it up).
set -euo pipefail
OHA_BIN="${OHA_BIN:-oha}"
command -v "$OHA_BIN" >/dev/null || { echo 'Install oha or set OHA_BIN to its verified binary.' >&2; exit 1; }
BENCH_SCENARIO="${BENCH_SCENARIO:-cache}"
case "$BENCH_SCENARIO" in
  cache) DEFAULT_HOST=demo.test ;;
  pass | challenge) DEFAULT_HOST=ua-bench.test ;;
  headers) DEFAULT_HOST=hdr-bench.g8.test ;;
  proxy) DEFAULT_HOST=proxy-bench.g9.test DEFAULT_URL="http://127.0.0.1:${E2E_G9_LB_PORT:-18990}/bench-cache.txt" ;;
  proxy-plain) DEFAULT_HOST=proxy-bench.g9.test DEFAULT_URL="http://127.0.0.1:${E2E_G9_LB_PLAIN_PORT:-18991}/bench-cache.txt" ;;
  *) echo "BENCH_SCENARIO must be cache, pass, challenge, headers, proxy or proxy-plain, not $BENCH_SCENARIO" >&2; exit 2 ;;
esac
BENCH_URL="${BENCH_URL:-${DEFAULT_URL:-http://127.0.0.1:${E2E_NODE_PORT:-18080}/bench-cache.txt}}"
BENCH_HOST="${BENCH_HOST:-$DEFAULT_HOST}"
BENCH_USER_AGENT="${BENCH_USER_AGENT:-edgeweir-bench}"
BENCH_REQUESTS="${BENCH_REQUESTS:-100000}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-32}"
BENCH_OUTPUT="${BENCH_OUTPUT:-.e2e/bench.json}"
mkdir -p "$(dirname "$BENCH_OUTPUT")"
OHA_HEADERS=(-H "Host: $BENCH_HOST")
CURL_HEADERS=(-H "Host: $BENCH_HOST")
EXPECT_STATUS=200
if [[ "$BENCH_SCENARIO" == pass || "$BENCH_SCENARIO" == challenge ]]; then
  OHA_HEADERS+=(-H "User-Agent: $BENCH_USER_AGENT")
  CURL_HEADERS+=(-A "$BENCH_USER_AGENT")
  CHALLENGE="$(curl -sS -D - -o /dev/null "${CURL_HEADERS[@]}" "$BENCH_URL" | tr -d '\r')"
  EXPECT_STATUS="$(printf '%s\n' "$CHALLENGE" | awk 'NR == 1 { print $2 }')"
  TYPE="$(printf '%s\n' "$CHALLENGE" | awk -F': ' 'tolower($1) == "x-edgeweir-challenge" { print $2 }')"
  if [[ -z "$TYPE" || ! "$EXPECT_STATUS" =~ ^(302|403)$ ]]; then
    echo "Refusing to benchmark: $BENCH_HOST answers $EXPECT_STATUS without a challenge (is Under Attack on?)." >&2
    exit 1
  fi
fi
# solve_pass prints the __ew_pass cookie the node gives after its challenge.
solve_pass() {
  BENCH_URL="$BENCH_URL" BENCH_HOST="$BENCH_HOST" BENCH_USER_AGENT="$BENCH_USER_AGENT" node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import http from 'node:http';
const url = new URL(process.env.BENCH_URL);
const send = (method, path, body) => new Promise((resolve, reject) => {
  const headers = { host: process.env.BENCH_HOST, 'user-agent': process.env.BENCH_USER_AGENT };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const req = http.request({ hostname: url.hostname, port: url.port || 80, path, method, headers, agent: false }, (res) => {
    let text = '';
    res.on('data', (d) => (text += d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});
const passOf = (r) => [r.headers['set-cookie'] ?? []].flat().map((c) => c.split(';')[0]).find((c) => c.startsWith('__ew_pass='));
const path = url.pathname + url.search;
const page = await send('GET', path);
let found = passOf(page);
if (!found) {
  const token = /name="t" value="([^"]+)"/.exec(page.text)?.[1];
  if (!token) throw new Error(`no challenge token (${page.status})`);
  let answer = createHash('sha256').update(token).digest('hex');
  if (page.headers['x-edgeweir-challenge'] === 'pow') {
    const bits = Number(/data-d="(\d+)"/.exec(page.text)?.[1]);
    const zeros = (digest) => { let n = 0; for (const byte of digest) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; } return n; };
    let n = 0;
    while (zeros(createHash('sha256').update(`${token}:${n}`).digest()) < bits) n++;
    answer = String(n);
  }
  const verified = await send('POST', '/.edgeweir/challenge/verify', new URLSearchParams({ t: token, a: answer, r: path }).toString());
  found = passOf(verified);
  if (!found) throw new Error(`verify answered ${verified.status} without a pass`);
}
console.log(found);
JS
}
if [[ "$BENCH_SCENARIO" == pass ]]; then
  # The pass is bound to the address the node sees and to the User-Agent, both the same for oha.
  PASS="$(solve_pass)"
  OHA_HEADERS+=(-H "Cookie: $PASS")
  CURL_HEADERS+=(-H "Cookie: $PASS")
  EXPECT_STATUS=200
fi
if [[ "$BENCH_SCENARIO" != challenge ]]; then
  for _ in 1 2; do curl -fsS "${CURL_HEADERS[@]}" "$BENCH_URL" -o /dev/null; done
  HEADERS="$(curl -fsS -D - -o /dev/null "${CURL_HEADERS[@]}" "$BENCH_URL")"
  if ! printf '%s\n' "$HEADERS" | tr -d '\r' | rg -qi '^x-cache: HIT$'; then
    echo 'Refusing to benchmark: the warmed response is not a cache HIT.' >&2
    exit 1
  fi
  if [[ "$BENCH_SCENARIO" == headers ]]; then
    if ! printf '%s\n' "$HEADERS" | tr -d '\r' | grep -qi '^x-cache-status: HIT$' ||
      [[ "$(printf '%s\n' "$HEADERS" | tr -d '\r' | grep -ci '^link: ')" != 2 ]]; then
      echo "Refusing to benchmark: $BENCH_HOST does not compute its header values (X-Cache-Status, two Link lines)." >&2
      exit 1
    fi
  fi
fi
"$OHA_BIN" --no-tui --output-format json -n "$BENCH_REQUESTS" -c "$BENCH_CONCURRENCY" -t 10s "${OHA_HEADERS[@]}" "$BENCH_URL" > "$BENCH_OUTPUT"
NODE_CONTAINER="$(docker compose -f compose.e2e.yml ps -q node)"
# The proxy scenarios measure the edge node of cluster g9-proxy.
if [[ "$BENCH_SCENARIO" == proxy* ]]; then
  NODE_CONTAINER="$(docker inspect -f '{{.Id}}' "${COMPOSE_PROJECT_NAME:-edgeweir-e2e}-g9-edge")"
fi
MEMORY="$(docker stats --no-stream --format '{{.MemUsage}}' "$NODE_CONTAINER")"
RSS_KIB="$(docker exec "$NODE_CONTAINER" sh -c 'awk "/^VmRSS:/ { sum += \$2 } END { print sum }" /proc/[0-9]*/status 2>/dev/null')"
export BENCH_OUTPUT BENCH_BASELINE="${BENCH_BASELINE:-}" MEMORY RSS_KIB BENCH_REQUESTS BENCH_CONCURRENCY BENCH_SCENARIO EXPECT_STATUS
node --input-type=module <<'JS'
import fs from 'node:fs';
const current=JSON.parse(fs.readFileSync(process.env.BENCH_OUTPUT,'utf8'));
const summary={recordedAt:new Date().toISOString(),scenario:process.env.BENCH_SCENARIO,requests:Number(process.env.BENCH_REQUESTS),concurrency:Number(process.env.BENCH_CONCURRENCY),qps:current.summary.requestsPerSec*current.summary.successRate,p50Ms:current.latencyPercentiles.p50===null?null:current.latencyPercentiles.p50*1000,p99Ms:current.latencyPercentiles.p99===null?null:current.latencyPercentiles.p99*1000,successRate:current.summary.successRate,nodeRssMiB:Number(process.env.RSS_KIB)>0?Number(process.env.RSS_KIB)/1024:null,containerMemory:process.env.MEMORY};
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
if(summary.successRate!==1||Object.keys(current.statusCodeDistribution).some(code=>code!==process.env.EXPECT_STATUS))process.exitCode=1;
JS
