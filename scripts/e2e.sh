#!/usr/bin/env bash
# End-to-end test against compose.e2e.yml:
#   Phase 0: enroll a node with a one-time token -> mTLS -> create site demo.test
#   via the public API -> node applies the new revision -> X-Cache MISS then HIT
#   -> console API shows the node online with its revision -> Playwright smoke.
#   MVP M1: setup needs the setup token from the console log (Playwright) ->
#   second organization and member, member-only console, site editing, clusters,
#   node groups, audit log and English (Playwright) -> the node keeps serving the
#   edited site -> disabled nodes are refused, deleted nodes stay revoked.
#   MVP M2: URL / prefix / whole-site purge and prefetch as node tasks, query
#   ignoring and sorting in cache keys, Range requests from slice cache,
#   WebSocket through the node, origin certificate verification, S3 SigV4
#   origins, failover to the backup origin and back, origin health in the
#   console; Playwright submits purges and reads the per-node results.
#
# Usage:
#   docker compose -f compose.e2e.yml up -d --build
#   bash scripts/e2e.sh [--up] [--down] [--skip-ui]
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f compose.e2e.yml)
CONSOLE="http://localhost:${E2E_CONSOLE_PORT:-13000}"
NODE_HTTP="http://localhost:${E2E_NODE_PORT:-18080}"
ADMIN_EMAIL="admin@e2e.test"
ADMIN_PASSWORD="e2e-admin-password-123"
STATE_DIR=".e2e"
UP=false
DOWN=false
SKIP_UI=false
for arg in "$@"; do
  case "$arg" in
    --up) UP=true ;;
    --down) DOWN=true ;;
    --skip-ui) SKIP_UI=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2
  echo "--- console logs (tail) ---" >&2
  "${COMPOSE[@]}" logs --tail 60 console >&2 || true
  echo "--- node logs (tail) ---" >&2
  "${COMPOSE[@]}" logs --tail 80 node >&2 || true
  exit 1
}
need() { command -v "$1" >/dev/null || fail "missing required tool: $1"; }
need curl
need jq
need docker

mkdir -p "$STATE_DIR"
COOKIES="$STATE_DIR/cookies.txt"
rm -f "$COOKIES"

if $UP; then
  step "docker compose -f compose.e2e.yml up -d --build"
  "${COMPOSE[@]}" up -d --build
fi
if $DOWN; then
  trap '"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true' EXIT
fi

# api METHOD PATH [JSON] -> body on stdout; fails on non-2xx.
api() {
  local method="$1" path="$2" body="${3:-}" out status
  out="$(mktemp)"
  status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$CONSOLE/api/v1$path" \
    -H 'content-type: application/json' ${API_KEY:+-H "x-api-key: $API_KEY"} \
    ${body:+--data "$body"})"
  if [[ "$status" != 2* ]]; then
    echo "HTTP $status $method $path: $(cat "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

wait_for() { # wait_for SECONDS DESCRIPTION COMMAND...
  local timeout="$1" what="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || fail "timed out after ${timeout}s waiting for: $what"
    sleep 1
  done
}

step "wait for the console"
wait_for 180 "console /healthz" curl -fsS "$CONSOLE/healthz"
pass "console healthy: $(curl -fsS "$CONSOLE/healthz")"

step "first-run setup needs the one-time setup token from the console log"
[[ "$(api GET /system/status | jq -r .initialized)" == "false" ]] ||
  fail "the e2e environment is not fresh (console already initialized); reset it with: docker compose -f compose.e2e.yml down -v && docker compose -f compose.e2e.yml up -d --build"
setup_token() {
  "${COMPOSE[@]}" logs console 2>/dev/null | grep -o '"setupToken":"ews_[A-Za-z0-9_-]*"' | tail -n1 | cut -d'"' -f4
}
wait_for 30 "setup token in the console log" test -n "$(setup_token)"
SETUP_TOKEN="$(setup_token)"
pass "console log shows setup token ${SETUP_TOKEN:0:8}… ($("${COMPOSE[@]}" logs console 2>/dev/null | grep -c '"setupToken"') log line(s))"
REFUSED="$(curl -sS -w ' %{http_code}' -X POST "$CONSOLE/api/v1/system/setup" -H 'content-type: application/json' \
  --data "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
    '{setupToken:"ews_wrong", name:"Intruder", email:$e, password:$p, organizationName:"X"}')")"
[[ "$REFUSED" == *'"code":"SETUP_TOKEN_INVALID"'*' 403' ]] || fail "setup without the token must be refused, got: $REFUSED"
pass "setup with a wrong token refused: $REFUSED"

if ! $SKIP_UI; then
  step "Playwright: setup wizard with the setup token (platform admin + default organization + default cluster)"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_SETUP_TOKEN="$SETUP_TOKEN" pnpm --filter @edgeweir/console run test:e2e e2e/setup.spec.ts \
    || fail "Playwright setup failed"
else
  api POST /system/setup "$(jq -nc --arg t "$SETUP_TOKEN" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
    '{setupToken:$t, name:"E2E Admin", email:$e, password:$p, organizationName:"E2E Org"}')" >/dev/null
fi
[[ "$(api GET /system/status | jq -r .initialized)" == "true" ]] || fail "setup did not complete"
pass "setup completed with the setup token"

step "sign in and create an API AccessKey"
curl -fsS -c "$COOKIES" -o /dev/null "$CONSOLE/api/auth/sign-in/email" \
  -H 'content-type: application/json' -H "origin: $CONSOLE" \
  --data "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" \
  || fail "sign-in failed"
API_KEY="$(curl -fsS -b "$COOKIES" "$CONSOLE/api/auth/api-key/create" \
  -H 'content-type: application/json' -H "origin: $CONSOLE" --data '{"name":"e2e"}' | jq -r .key)"
[[ "$API_KEY" == ewk_* ]] || fail "no API key returned"
export API_KEY
pass "API key ${API_KEY:0:10}… (the public API /api/v1 only accepts x-api-key)"

CLUSTER="$(api GET /clusters | jq -c '.[0]')"
CLUSTER_ID="$(jq -r .id <<<"$CLUSTER")"
[[ -n "$CLUSTER_ID" && "$CLUSTER_ID" != null ]] || fail "no cluster"
pass "cluster $(jq -r .name <<<"$CLUSTER") ($CLUSTER_ID), latest revision #$(jq -r .latestRevision.revision <<<"$CLUSTER")"

step "node enrollment with a one-time token"
TOKEN_JSON="$(api POST /enrollment-tokens "$(jq -nc --arg c "$CLUSTER_ID" '{clusterId:$c,nodeName:"edge-e2e-1",ttlMinutes:15}')")"
TOKEN="$(jq -r .token <<<"$TOKEN_JSON")"
CA_SHA256="$(jq -r .caSha256 <<<"$TOKEN_JSON")"
SERVER_URL="$(jq -r .serverUrl <<<"$TOKEN_JSON")"
echo "install command (as shown in the console):"
jq -r .installCommand <<<"$TOKEN_JSON" | sed -E 's/(--token )[^ ]+/\1<redacted>/'

if "${COMPOSE[@]}" exec -T node edgeweir-node enroll --server "$SERVER_URL" --token "$TOKEN" \
  --ca-sha256 "$(printf '0%.0s' {1..64})" --state-dir /tmp/pin-mismatch >"$STATE_DIR/pin.log" 2>&1; then
  fail "enrollment with a wrong CA fingerprint must be refused"
fi
pass "wrong CA fingerprint refused before the token is sent: $(tail -n1 "$STATE_DIR/pin.log")"

"${COMPOSE[@]}" exec -T node edgeweir-node enroll --server "$SERVER_URL" --token "$TOKEN" \
  --ca-sha256 "$CA_SHA256" >"$STATE_DIR/enroll.log" 2>&1 || { cat "$STATE_DIR/enroll.log"; fail "enroll failed"; }
pass "node enrolled with the one-time token: $(tail -n1 "$STATE_DIR/enroll.log")"

if "${COMPOSE[@]}" exec -T node edgeweir-node enroll --server "$SERVER_URL" --token "$TOKEN" \
  --ca-sha256 "$CA_SHA256" --state-dir /tmp/second-enroll >"$STATE_DIR/reuse.log" 2>&1; then
  fail "a used enrollment token must not work twice"
fi
pass "token reuse refused: $(tail -n1 "$STATE_DIR/reuse.log")"

NO_CERT="$("${COMPOSE[@]}" exec -T console node -e '
  const https = require("node:https");
  const req = https.request("https://console:8443/edgeweir.node.v1.NodeService/GetConfig",
    { method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json" } },
    (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => console.log(res.statusCode, b)); });
  req.end("{}");')"
[[ "$NO_CERT" == 401* && "$NO_CERT" == *unauthenticated* ]] || fail "node channel must reject calls without a client certificate, got: $NO_CERT"
pass "node channel without client certificate: $NO_CERT"

node_json() { api GET "/nodes?clusterId=$CLUSTER_ID" | jq -c '.[] | select(.name == "edge-e2e-1")'; }
node_online() { [[ "$(node_json | jq -r .online)" == "true" ]]; }
wait_for 60 "node online (heartbeat over mTLS)" node_online
NODE="$(node_json)"
pass "node online over mTLS: id=$(jq -r .id <<<"$NODE") cert=$(jq -r '.certFingerprint[0:16]' <<<"$NODE")… applied=#$(jq -r .appliedRevision <<<"$NODE")"
"${COMPOSE[@]}" logs node 2>&1 | grep -i "mtls" | tail -n 2 || true

step "create site demo.test through the public API"
SITE="$(api POST /sites "$(jq -nc --arg c "$CLUSTER_ID" '{
  name: "demo", clusterId: $c, domains: ["demo.test"],
  origins: [{address: "whoami", port: 80, scheme: "http"}],
  cacheRules: [{pathPrefixes: ["/"], edgeTtlSeconds: 300, originCacheControl: "override"}]
}')")"
REVISION="$(jq -r .revision.revision <<<"$SITE")"
CONTENT_HASH="$(jq -r .revision.contentHash <<<"$SITE")"
pass "site $(jq -r .site.id <<<"$SITE") created, published revision #$REVISION (${CONTENT_HASH:0:16}…)"

node_applied() {
  local n
  n="$(node_json)"
  [[ "$(jq -r .appliedRevision <<<"$n")" == "$REVISION" &&
    "$(jq -r .applyState <<<"$n")" == "applied" &&
    "$(jq -r .appliedContentHash <<<"$n")" == "$CONTENT_HASH" ]]
}
wait_for 60 "node applies revision #$REVISION" node_applied
pass "node applied revision #$REVISION with matching content hash (console and node agree on the IR hash)"

step "cache: first request MISS, second HIT"
wait_for 30 "demo.test routed by the node" curl -fsS -o /dev/null -H 'Host: demo.test' "$NODE_HTTP/e2e-route-probe"
URL_PATH="/e2e/$(date +%s)-$RANDOM"
FIRST="$(curl -sS -D - -o "$STATE_DIR/first.body" -H 'Host: demo.test' "$NODE_HTTP$URL_PATH")"
SECOND="$(curl -sS -D - -o "$STATE_DIR/second.body" -H 'Host: demo.test' "$NODE_HTTP$URL_PATH")"
grep -q "^GET $URL_PATH " "$STATE_DIR/first.body" || fail "response body did not come from the whoami origin"
X1="$(grep -i '^x-cache:' <<<"$FIRST" | tr -d '\r' | awk '{print $2}')"
X2="$(grep -i '^x-cache:' <<<"$SECOND" | tr -d '\r' | awk '{print $2}')"
echo "curl -H 'Host: demo.test' $NODE_HTTP$URL_PATH  ->  X-Cache: $X1"
echo "curl -H 'Host: demo.test' $NODE_HTTP$URL_PATH  ->  X-Cache: $X2"
[[ "$X1" == "MISS" ]] || fail "first request expected X-Cache: MISS, got '$X1'"
[[ "$X2" == "HIT" ]] || fail "second request expected X-Cache: HIT, got '$X2'"
cmp -s "$STATE_DIR/first.body" "$STATE_DIR/second.body" || fail "cached body differs from origin body"
pass "X-Cache MISS then HIT, identical body from origin whoami"

UNKNOWN="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: unknown.test' "$NODE_HTTP/")"
[[ "$UNKNOWN" == "404" ]] || fail "unknown host should be 404, got $UNKNOWN"
pass "unknown host answered 404"

step "console API shows the node online with its revision"
api GET "/nodes?clusterId=$CLUSTER_ID" | jq '.[] | {name, online, status, appliedRevision, applyState, appliedContentHash, lastSeenAt, agentVersion, engine, engineVersion, ipAddresses}'
CLUSTER="$(api GET "/clusters/$CLUSTER_ID")"
[[ "$(jq -r .latestRevision.revision <<<"$CLUSTER")" == "$REVISION" ]] || fail "cluster latest revision mismatch"
[[ "$(jq -r .onlineNodeCount <<<"$CLUSTER")" -ge 1 ]] || fail "cluster reports no online node"
pass "cluster latest revision #$REVISION, $(jq -r .onlineNodeCount <<<"$CLUSTER")/$(jq -r .nodeCount <<<"$CLUSTER") nodes online"

if ! $SKIP_UI; then
  step "Playwright smoke: login -> admin clusters & nodes -> console sites"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_EXPECT_REVISION="$REVISION" pnpm --filter @edgeweir/console run test:e2e e2e/smoke.spec.ts \
    || fail "Playwright smoke test failed"
  pass "Playwright smoke passed"

  step "Playwright M1: organizations, members, site editing, clusters, node groups, audit, English"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/m1.spec.ts \
    || fail "Playwright M1 test failed"
  pass "Playwright M1 passed"

  step "the node serves the site the tenant member edited in the UI"
  NODE="$(node_json)"
  CLUSTER="$(api GET "/clusters/$CLUSTER_ID")"
  [[ "$(jq -r .nodeGroupName <<<"$NODE")" == "group-a" && "$(jq -r .regionName <<<"$NODE")" == "华东" ]] ||
    fail "node should be in node group group-a (华东): $(jq -c '{nodeGroupName, regionName}' <<<"$NODE")"
  LATEST="$(jq -r .latestRevision.revision <<<"$CLUSTER")"
  node_synced() { [[ "$(node_json | jq -r '.online and .applyState == "applied"')" == "true" && "$(node_json | jq -r .appliedRevision)" == "$LATEST" ]]; }
  wait_for 60 "node online on revision #$LATEST after the move" node_synced
  pass "node $(jq -r .name <<<"$NODE") in group-a (华东), online, applied #$LATEST = cluster latest #$LATEST"
  TENANT_SITE="$(api GET "/sites?search=tenant-site" | jq -c '.items[0]')"
  [[ "$(jq -r '.domains | join(",")' <<<"$TENANT_SITE")" == "tenant.test,www.tenant.test" &&
    "$(jq -r '.origins[0].address' <<<"$TENANT_SITE")" == "whoami" &&
    "$(jq -r .organizationName <<<"$TENANT_SITE")" == "Tenant Org" ]] ||
    fail "tenant site not as edited in the UI: $TENANT_SITE"
  wait_for 30 "www.tenant.test routed to the edited origin" \
    curl -fsS -o /dev/null -H 'Host: www.tenant.test' "$NODE_HTTP/e2e-tenant-probe"
  BODY="$(curl -fsS -H 'Host: www.tenant.test' "$NODE_HTTP/e2e-tenant")"
  grep -q "^GET /e2e-tenant " <<<"$BODY" || fail "www.tenant.test did not reach whoami: $BODY"
  pass "curl -H 'Host: www.tenant.test' -> whoami (domain and origin edited by the tenant member)"
fi

step "MVP M2: sites for origins and cache"
xcache() { # xcache HOST PATH [curl args...] -> value of X-Cache
  local host="$1" path="$2"
  shift 2
  curl -sS -o /dev/null -D - -H "Host: $host" "$@" "$NODE_HTTP$path" | tr -d '\r' |
    awk 'tolower($1) == "x-cache:" { print $2 }'
}
expect_cache() { # expect_cache WANT HOST PATH [curl args...]
  local want="$1" got
  shift
  got="$(xcache "$@")"
  echo "curl -H 'Host: $1' $NODE_HTTP$2 ${*:3} -> X-Cache: $got"
  [[ "$got" == "$want" ]] || fail "expected X-Cache: $want for $1$2, got '$got'"
}
cluster_latest() { api GET "/clusters/$CLUSTER_ID" | jq -r .latestRevision.revision; }
wait_node_latest() {
  local latest
  latest="$(cluster_latest)"
  node_on_latest() { [[ "$(node_json | jq -r '"\(.appliedRevision) \(.applyState)"')" == "$latest applied" ]]; }
  wait_for 60 "node applies revision #$latest" node_on_latest
  echo "node applied revision #$latest"
}
m2_site() { # m2_site NAME JQ-OBJECT -> site id (the object overrides the defaults)
  local body
  body="$(jq -nc --arg c "$CLUSTER_ID" --arg n "$1" \
    "{name: \$n, clusterId: \$c, cacheRules: [{pathPrefixes: [\"/\"], edgeTtlSeconds: 300}]} + $2")" ||
    fail "bad site definition for $1"
  api POST /sites "$body" | jq -r .site.id
}
cache_task() { # cache_task JSON -> final task JSON (waits until it finished)
  local id task
  id="$(api POST /cache-tasks "$1" | jq -r .id)"
  task_done() { [[ "$(api GET "/cache-tasks/$id" | jq -r .state)" =~ ^(succeeded|failed)$ ]]; }
  wait_for 60 "cache task $id finished on every node" task_done
  task="$(api GET "/cache-tasks/$id")"
  echo "task $(jq -c '{type, targets, state, nodes: [.nodes[] | {nodeName, state, succeeded, failed, message}]}' <<<"$task")"
  [[ "$(jq -r .state <<<"$task")" == "succeeded" ]] || fail "cache task did not succeed: $task"
}
CACHE_SITE="$(m2_site m2-cache '{domains: ["cache.m2.test"], origins: [{address: "whoami"}]}')"
m2_site m2-ignore '{domains: ["ignore.m2.test"], origins: [{address: "whoami"}], cacheSettings: {cacheKey: {query: "ignore"}}}' >/dev/null
m2_site m2-sort '{domains: ["sort.m2.test"], origins: [{address: "whoami"}], cacheSettings: {cacheKey: {sortQuery: true}}}' >/dev/null
m2_site m2-slice '{domains: ["slice.m2.test"], origins: [{address: "files"}], cacheSettings: {rangeSlice: true}}' >/dev/null
FAILOVER_SITE="$(m2_site m2-failover '{domains: ["failover.m2.test"], origins: [{address: "origin-primary"}, {address: "origin-backup", backup: true}],
  cacheRules: [], originSettings: {maxFails: 1, recoverySeconds: 5, connectTimeoutMs: 1000}}')"
TLS_SITE="$(m2_site m2-tls '{domains: ["tls.m2.test"], origins: [{address: "files", port: 443, scheme: "https"}], cacheRules: []}')"
m2_site m2-s3 '{domains: ["s3.m2.test"], origins: [{address: "s3", port: 7070,
  s3: {region: "us-east-1", bucket: "media", accessKeyId: "e2e-access-key", secretAccessKey: "e2e-only-s3-secret-key"}}]}' >/dev/null
m2_site m2-ws-off '{domains: ["wsoff.m2.test"], origins: [{address: "whoami"}], originSettings: {websocket: false}}' >/dev/null
wait_node_latest
pass "8 M2 sites published and applied by the node"

step "M2: URL purge makes the next request a MISS, other URLs stay cached"
U1="/m2/url-$RANDOM.js"
U2="/m2/other-$RANDOM.js"
expect_cache MISS cache.m2.test "$U1"
expect_cache HIT cache.m2.test "$U1"
expect_cache MISS cache.m2.test "$U2"
expect_cache HIT cache.m2.test "$U2"
cache_task "$(jq -nc --arg u "http://cache.m2.test$U1" '{type: "url", urls: [$u]}')"
expect_cache MISS cache.m2.test "$U1"
expect_cache HIT cache.m2.test "$U1"
expect_cache HIT cache.m2.test "$U2"
pass "URL purge: $U1 MISS after the purge, $U2 still HIT"

step "M2: prefix purge only affects the prefix"
expect_cache MISS cache.m2.test /pa/1.css
expect_cache HIT cache.m2.test /pa/1.css
expect_cache MISS cache.m2.test /pb/1.css
expect_cache HIT cache.m2.test /pb/1.css
cache_task '{"type": "prefix", "urls": ["http://cache.m2.test/pa/"]}'
expect_cache MISS cache.m2.test /pa/1.css
expect_cache HIT cache.m2.test /pb/1.css
pass "prefix purge of /pa/: /pa/1.css MISS, /pb/1.css HIT"

step "M2: prefetch loads a URL into the cache, whole-site purge empties it"
PF="/m2/prefetched-$RANDOM.txt"
cache_task "$(jq -nc --arg u "http://cache.m2.test$PF" '{type: "prefetch", urls: [$u]}')"
expect_cache HIT cache.m2.test "$PF"
cache_task "$(jq -nc --arg s "$CACHE_SITE" '{type: "site", siteIds: [$s]}')"
expect_cache MISS cache.m2.test "$PF"
expect_cache MISS cache.m2.test /pb/1.css
pass "prefetched URL was a HIT on the first client request; whole-site purge made everything MISS"

step "M2: cache keys ignore or sort query parameters"
Q="/m2/q-$RANDOM"
expect_cache MISS ignore.m2.test "$Q?a=1"
expect_cache HIT ignore.m2.test "$Q?a=2"
expect_cache MISS sort.m2.test "$Q?a=1&b=2"
expect_cache HIT sort.m2.test "$Q?b=2&a=1"
expect_cache MISS sort.m2.test "$Q?a=1&b=3"
pass "ignored query: ?a=1 and ?a=2 share one object; sorted query: ?a=1&b=2 and ?b=2&a=1 share one object"

step "M2: Range requests are served from the slice cache"
docker_files() { "${COMPOSE[@]}" exec -T files sh -c "$1"; }
ORIGIN_BYTES="$(docker_files 'dd if=/srv/big.bin bs=1 skip=1048000 count=1000 2>/dev/null | sha256sum' | cut -d' ' -f1)"
range() { curl -sS -o "$STATE_DIR/range.bin" -D "$STATE_DIR/range.h" -H 'Host: slice.m2.test' -r "$1" "$NODE_HTTP/big.bin"; }
range 1048000-1048999
grep -qi '^x-cache: MISS' "$STATE_DIR/range.h" && grep -qi '^content-range: bytes 1048000-1048999/3145728' "$STATE_DIR/range.h" ||
  fail "first range request: $(cat "$STATE_DIR/range.h")"
range 1048000-1048999
grep -qi '^x-cache: HIT' "$STATE_DIR/range.h" || fail "repeated range request not a HIT: $(cat "$STATE_DIR/range.h")"
[[ "$(sha256sum "$STATE_DIR/range.bin" 2>/dev/null || shasum -a 256 "$STATE_DIR/range.bin")" == "$ORIGIN_BYTES"* ]] ||
  fail "range body differs from the origin"
range 1048576-1048600
grep -qi '^x-cache: HIT' "$STATE_DIR/range.h" || fail "another range in a cached slice not a HIT: $(cat "$STATE_DIR/range.h")"
grep -iE '^(HTTP|x-cache|content-range|content-length)' "$STATE_DIR/range.h" | tr -d '\r'
pass "bytes 1048000-1048999: MISS then HIT with the origin's bytes; bytes 1048576-1048600 of the cached slice: HIT"

step "M2: WebSocket through the node"
WS="$(node scripts/ws-echo.mjs localhost "${E2E_NODE_PORT:-18080}" cache.m2.test /echo hello-edgeweir)" || fail "WebSocket through the node failed: $WS"
echo "$WS"
[[ "$WS" == *"echo: hello-edgeweir"* ]] || fail "no echo over WebSocket: $WS"
WS_OFF="$(node scripts/ws-echo.mjs localhost "${E2E_NODE_PORT:-18080}" wsoff.m2.test /echo x 2>&1 || true)"
[[ "$WS_OFF" == *"handshake failed: HTTP/1.1 403"* ]] || fail "WebSocket should be refused when disabled: $WS_OFF"
pass "whoami /echo echoed over the node; the site with WebSocket off refused the upgrade (403)"

step "M2: HTTPS origins are verified unless verification is turned off"
TLS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: tls.m2.test' "$NODE_HTTP/static/a.txt")"
[[ "$TLS_CODE" == "502" ]] || fail "self-signed origin certificate must fail verification, got $TLS_CODE"
"${COMPOSE[@]}" logs --since 60s node 2>&1 | grep -m1 "upstream SSL certificate verify error" | cut -c1-200 || true
api PATCH "/sites/$TLS_SITE" '{"originSettings": {"tlsVerify": false}}' >/dev/null
wait_node_latest
TLS_BODY="$(curl -fsS -H 'Host: tls.m2.test' "$NODE_HTTP/static/a.txt")" || fail "origin without verification unreachable"
[[ "$TLS_BODY" == "static" ]] || fail "unexpected body over HTTPS: $TLS_BODY"
pass "verification on: 502 for the self-signed origin; verification off: 200 over HTTPS"

step "M2: S3-compatible origin with SigV4 signing"
S3_BODY="$(curl -fsS -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")" || fail "S3 origin request failed: $(curl -sS -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")"
[[ "$S3_BODY" == "hello from s3" ]] || fail "unexpected S3 body: $S3_BODY"
expect_cache HIT s3.m2.test /hello.txt
S3_POST="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")"
[[ "$S3_POST" == "405" ]] || fail "POST to an S3 origin must be refused, got $S3_POST"
pass "signed GET returned the object (then cached); POST refused with 405"

step "M2: failover to the backup origin and back"
origin_name() { curl -sS -H 'Host: failover.m2.test' "$NODE_HTTP/whoami" | awk '/^Name:/ { print $2 }'; }
[[ "$(origin_name)" == "primary" ]] || fail "failover site should be served by the primary"
echo "before: Name: $(origin_name)"
"${COMPOSE[@]}" stop origin-primary >/dev/null 2>&1
served_by_backup() { [[ "$(origin_name)" == "backup" ]]; }
wait_for 30 "requests served by the backup" served_by_backup
echo "primary stopped: Name: $(origin_name)"
primary_down_in_console() {
  api GET "/sites/$FAILOVER_SITE/origin-health" | jq -e 'map(select(.downNodes > 0)) | length == 1' >/dev/null
}
wait_for 60 "console shows the primary origin down" primary_down_in_console
api GET "/sites/$FAILOVER_SITE/origin-health" | jq -c '.[] | {originId, downNodes, onlineNodes, lastError}'
"${COMPOSE[@]}" start origin-primary >/dev/null 2>&1
served_by_primary() { [[ "$(origin_name)" == "primary" ]]; }
wait_for 60 "requests back on the primary" served_by_primary
echo "primary started: Name: $(origin_name)"
pass "primary down -> backup, console shows the primary down, primary back -> primary"

if ! $SKIP_UI; then
  step "Playwright M2: submit purges and read the per-node results"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/m2.spec.ts \
    || fail "Playwright M2 test failed"
  pass "Playwright M2 passed"
fi

step "node lifecycle: disable refuses the node, enable restores it, delete revokes its certificate"
NODE_ID="$(node_json | jq -r .id)"
api POST "/nodes/$NODE_ID/disable" >/dev/null
node_refused() { "${COMPOSE[@]}" logs --since 90s node 2>&1 | grep -qi "rejected this node's credentials"; }
wait_for 60 "agent reports the console refusing the disabled node" node_refused
pass "disabled node refused: $("${COMPOSE[@]}" logs --since 90s node 2>&1 | grep -i "rejected this node's credentials" | tail -n1 | cut -c1-160)"
api POST "/nodes/$NODE_ID/enable" >/dev/null
node_heartbeat_after() { [[ "$(api GET "/nodes/$NODE_ID" | jq -r .lastSeenAt)" > "$1" ]]; }
ENABLED_AT="$(date -u +%Y-%m-%dT%H:%M:%S)"
wait_for 60 "node heartbeat after enable" node_heartbeat_after "$ENABLED_AT"
pass "enabled node reconnected: $(api GET "/nodes/$NODE_ID" | jq -c '{status, online, lastSeenAt}')"
DELETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
api DELETE "/nodes/$NODE_ID" >/dev/null
node_revoked() { "${COMPOSE[@]}" logs --since "$DELETED_AT" node 2>&1 | grep -qi "rejected this node's credentials"; }
wait_for 60 "agent refused after deletion" node_revoked
[[ "$(api GET "/audit-logs?action=node.delete" | jq -r '.items[0] | "\(.actorName)|\(.targetName)"')" == "E2E Admin|edge-e2e-1" ]] ||
  fail "node.delete audit entry lacks names"
pass "deleted node revoked and refused: $("${COMPOSE[@]}" logs --since "$DELETED_AT" node 2>&1 | grep -i "rejected this node's credentials" | tail -n1 | cut -c1-160)"
curl -fsS -o /dev/null -H 'Host: demo.test' "$NODE_HTTP/after-revoke" || fail "node must keep serving last-known-good config"
pass "node keeps serving its last-known-good configuration after being refused"

printf '\n\033[1;32mE2E OK\033[0m\n'
