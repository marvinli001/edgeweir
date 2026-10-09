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
#   charset    cache HITs of a site that adds a charset (site-content-v1: gbk,
#              forced over the origin's utf-8); checks that the warmed response
#              carries charset=gbk.
#   tls        cache HITs over HTTPS, a new TLS connection per request that never
#              offers a session: a full handshake each (scripts/bench-tls.mjs,
#              not oha, whose rustls resumes sessions itself). BENCH_TLS_VERSION=1.2
#              caps the protocol at TLS 1.2 (default 1.3).
#   tls-resume the same, each connection offering the previous one's session
#              (session ID or ticket); fails when fewer than 90% are resumed.
#              BENCH_TLS_NETWORK=<docker network> runs the client in a Node.js
#              container on that network (BENCH_URL then names the node's
#              container, e.g. https://<project>-g11-bench-new/bench-cache.txt),
#              which keeps the host's port forwarding out of the measurement.
#   url-auth   cache HITs of a site behind a signed URL rule of kind A
#              (access-auth-v1): every request carries a valid signature, which
#              the node checks and removes before the cache lookup; the script
#              signs BENCH_URL with BENCH_URL_AUTH_KEY and checks that the
#              unsigned URL is refused (403) and the signed one is a HIT.
#              Defaults to the new node of scripts/bench-g12-nodes.mjs; its
#              new.cache.bench.g12.test with BENCH_SCENARIO=cache is the baseline.
#   access     cache HITs of a site with every part of access control on
#              (access-control-v1): site lists, geo, CORS with credentials,
#              hotlink, user agent rules and security headers; every request
#              sends the Origin, Referer and User-Agent that pass them, and
#              the script checks that the warmed HIT carries the echoed
#              Access-Control-Allow-Origin and X-Content-Type-Options.
#              Defaults to the new node of scripts/bench-g13-nodes.mjs; its
#              new.cache.bench.g13.test with BENCH_SCENARIO=cache is the baseline.
#   body       cache HITs of a site whose rules read the request body
#              (rules-body-v1: form_value, json_value and the file names, after a
#              method check); GETs read no body. Defaults to the new node of
#              scripts/bench-g14-nodes.mjs; its new.cache.bench.g14.test with
#              BENCH_SCENARIO=cache is the baseline (and base.cache.bench.g14.test
#              on its base node, the node before G14).
#   post       POSTs of BENCH_BODY (a form, about 200 bytes by default) to
#              BENCH_URL on the same node's new.cache.bench.g14.test, a site whose
#              rules read no body; answered by the origin, no HIT check.
#   body-post  the same POSTs to body.bench.g14.test, whose rules read and parse
#              each body (the cost of reading request bodies; post is its
#              baseline).
# pass and challenge default to ua-bench.test, which scripts/e2e-g2.mjs leaves
# behind (whoami, cache rule on /, Under Attack js); headers to
# hdr-bench.g8.test, which scripts/e2e-g8.mjs leaves behind; charset to
# charset-bench.g15.test, which scripts/e2e-g15.mjs leaves behind; proxy and
# proxy-plain to proxy-bench.g9.test, which scripts/e2e-g9.mjs sets up; tls and
# tls-resume to the nodes scripts/bench-g11-nodes.mjs starts (BENCH_URL and
# BENCH_HOST of the node to measure, BENCH_NODE_CONTAINER for its memory). The
# full e2e removes it (and at its end the default cluster's node, which
# e2e-g9.mjs needs): run e2e-g9.mjs on its own on a stack whose full e2e
# stopped before the node lifecycle step, then bench.
set -euo pipefail
OHA_BIN="${OHA_BIN:-oha}"
BENCH_SCENARIO="${BENCH_SCENARIO:-cache}"
if [[ "$BENCH_SCENARIO" != tls* ]]; then
  command -v "$OHA_BIN" >/dev/null || { echo 'Install oha or set OHA_BIN to its verified binary.' >&2; exit 1; }
fi
case "$BENCH_SCENARIO" in
  cache) DEFAULT_HOST=demo.test ;;
  pass | challenge) DEFAULT_HOST=ua-bench.test ;;
  headers) DEFAULT_HOST=hdr-bench.g8.test ;;
  proxy) DEFAULT_HOST=proxy-bench.g9.test DEFAULT_URL="http://127.0.0.1:${E2E_G9_LB_PORT:-18990}/bench-cache.txt" ;;
  proxy-plain) DEFAULT_HOST=proxy-bench.g9.test DEFAULT_URL="http://127.0.0.1:${E2E_G9_LB_PLAIN_PORT:-18991}/bench-cache.txt" ;;
  charset) DEFAULT_HOST=charset-bench.g15.test ;;
  tls | tls-resume) DEFAULT_HOST=new.tls-bench.g11.test DEFAULT_URL="https://127.0.0.1:${E2E_G11_BENCH_NEW_PORT:-18944}/bench-cache.txt" ;;
  url-auth) DEFAULT_HOST=url.bench.g12.test DEFAULT_URL="http://127.0.0.1:${E2E_G12_BENCH_NEW_PORT:-18948}/bench-cache.txt" ;;
  access) DEFAULT_HOST=access.bench.g13.test DEFAULT_URL="http://127.0.0.1:${E2E_G13_BENCH_NEW_PORT:-18950}/bench-cache.txt" ;;
  body) DEFAULT_HOST=body.bench.g14.test DEFAULT_URL="http://127.0.0.1:${E2E_G14_BENCH_NEW_PORT:-18952}/bench-cache.txt" ;;
  post) DEFAULT_HOST=new.cache.bench.g14.test DEFAULT_URL="http://127.0.0.1:${E2E_G14_BENCH_NEW_PORT:-18952}/form" ;;
  body-post) DEFAULT_HOST=body.bench.g14.test DEFAULT_URL="http://127.0.0.1:${E2E_G14_BENCH_NEW_PORT:-18952}/form" ;;
  *) echo "BENCH_SCENARIO must be cache, pass, challenge, headers, proxy, proxy-plain, charset, tls, tls-resume, url-auth, access, body, post or body-post, not $BENCH_SCENARIO" >&2; exit 2 ;;
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
if [[ "$BENCH_SCENARIO" == url-auth ]]; then
  # Kind A: path?sign=ts-rand-md5(path@ts@rand@key), valid for the rule's day.
  URL_PATH="/${BENCH_URL#*://*/}"
  URL_PATH="${URL_PATH%%\?*}"
  TS="$(date +%s)"
  SIGN="$(printf '%s@%s@bench@%s' "$URL_PATH" "$TS" "${BENCH_URL_AUTH_KEY:-g12-bench-key-0123456789}" | openssl md5 | awk '{print $NF}')"
  UNSIGNED="$(curl -s -o /dev/null -w '%{http_code}' "${CURL_HEADERS[@]}" "$BENCH_URL")"
  if [[ "$UNSIGNED" != 403 ]]; then
    echo "Refusing to benchmark: $BENCH_HOST answers $UNSIGNED without a signature, not 403." >&2
    exit 1
  fi
  BENCH_URL="$BENCH_URL?sign=$TS-bench-$SIGN"
fi
if [[ "$BENCH_SCENARIO" == access ]]; then
  BENCH_ORIGIN="${BENCH_ORIGIN:-https://app.bench.g13.test}"
  OHA_HEADERS+=(-H "Origin: $BENCH_ORIGIN" -H "Referer: $BENCH_ORIGIN/page" -H "User-Agent: $BENCH_USER_AGENT")
  CURL_HEADERS+=(-H "Origin: $BENCH_ORIGIN" -H "Referer: $BENCH_ORIGIN/page" -A "$BENCH_USER_AGENT")
fi
BENCH_BODY="${BENCH_BODY:-user=bench&email=bench%40example.test&comment=$(printf 'x%.0s' $(seq 1 150))}"
if [[ "$BENCH_SCENARIO" == post || "$BENCH_SCENARIO" == body-post ]]; then
  OHA_HEADERS+=(-m POST -T application/x-www-form-urlencoded -d "$BENCH_BODY")
  ANSWER="$(curl -s -o /dev/null -w '%{http_code}' "${CURL_HEADERS[@]}" -X POST \
    -H 'Content-Type: application/x-www-form-urlencoded' --data "$BENCH_BODY" "$BENCH_URL")"
  if [[ "$ANSWER" != 200 ]]; then
    echo "Refusing to benchmark: POST to $BENCH_HOST answers $ANSWER, not 200." >&2
    exit 1
  fi
  if [[ "$BENCH_SCENARIO" == body-post ]] &&
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "${CURL_HEADERS[@]}" -X POST \
      -H 'Content-Type: application/x-www-form-urlencoded' --data 'user=admin' "$BENCH_URL")" != 403 ]]; then
    echo "Refusing to benchmark: $BENCH_HOST does not read the body (user=admin must be 403)." >&2
    exit 1
  fi
fi
if [[ "$BENCH_SCENARIO" != challenge && "$BENCH_SCENARIO" != tls* && "$BENCH_SCENARIO" != post && "$BENCH_SCENARIO" != body-post ]]; then
  for _ in 1 2; do curl -fsS "${CURL_HEADERS[@]}" "$BENCH_URL" -o /dev/null; done
  HEADERS="$(curl -fsS -D - -o /dev/null "${CURL_HEADERS[@]}" "$BENCH_URL")"
  if ! printf '%s\n' "$HEADERS" | tr -d '\r' | grep -qi '^x-cache: HIT$'; then
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
  if [[ "$BENCH_SCENARIO" == access ]] &&
    { ! printf '%s\n' "$HEADERS" | tr -d '\r' | grep -qi "^access-control-allow-origin: $BENCH_ORIGIN$" ||
      ! printf '%s\n' "$HEADERS" | tr -d '\r' | grep -qi '^x-content-type-options: nosniff$'; }; then
    echo "Refusing to benchmark: $BENCH_HOST does not apply its access control (CORS, security headers)." >&2
    exit 1
  fi
  if [[ "$BENCH_SCENARIO" == charset ]] &&
    ! printf '%s\n' "$HEADERS" | tr -d '\r' | grep -qi '^content-type: .*; charset=gbk$'; then
    echo "Refusing to benchmark: $BENCH_HOST does not add charset=gbk." >&2
    exit 1
  fi
fi
if [[ "$BENCH_SCENARIO" == tls* && -n "${BENCH_TLS_NETWORK:-}" ]]; then
  # The image of the e2e clients (compose.e2e.yml client-a).
  docker run --rm --network "$BENCH_TLS_NETWORK" -v "$PWD/scripts:/scripts:ro" \
    -v "$(cd "$(dirname "$BENCH_OUTPUT")" && pwd):/out" \
    -e BENCH_URL="$BENCH_URL" -e BENCH_HOST="$BENCH_HOST" -e BENCH_SCENARIO="$BENCH_SCENARIO" \
    -e BENCH_REQUESTS="$BENCH_REQUESTS" -e BENCH_CONCURRENCY="$BENCH_CONCURRENCY" \
    -e BENCH_TLS_VERSION="${BENCH_TLS_VERSION:-}" -e BENCH_OUTPUT="/out/$(basename "$BENCH_OUTPUT")" \
    node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
    node /scripts/bench-tls.mjs
elif [[ "$BENCH_SCENARIO" == tls* ]]; then
  # Warms the cache, refuses a site that does not answer a HIT, and checks resumption.
  BENCH_URL="$BENCH_URL" BENCH_HOST="$BENCH_HOST" BENCH_SCENARIO="$BENCH_SCENARIO" \
    BENCH_REQUESTS="$BENCH_REQUESTS" BENCH_CONCURRENCY="$BENCH_CONCURRENCY" BENCH_OUTPUT="$BENCH_OUTPUT" \
    node scripts/bench-tls.mjs
else
  "$OHA_BIN" --no-tui --output-format json -n "$BENCH_REQUESTS" -c "$BENCH_CONCURRENCY" -t 10s "${OHA_HEADERS[@]}" "$BENCH_URL" > "$BENCH_OUTPUT"
fi
NODE_CONTAINER="${BENCH_NODE_CONTAINER:-$(docker compose -f compose.e2e.yml ps -q node)}"
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
