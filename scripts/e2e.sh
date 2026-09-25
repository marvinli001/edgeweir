#!/usr/bin/env bash
# End-to-end test of the Phase 0 loop against compose.e2e.yml:
#   enroll a node with a one-time token -> mTLS -> create site demo.test via the
#   public API -> node applies the new revision -> X-Cache MISS then HIT ->
#   console API shows the node online with its revision -> Playwright smoke.
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

step "first-run setup (platform admin + default organization + default cluster)"
if [[ "$(api GET /system/status | jq -r .initialized)" == "false" ]]; then
  api POST /system/setup "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
    '{name:"E2E Admin", email:$e, password:$p, organizationName:"E2E Org"}')" >/dev/null
  pass "setup completed"
else
  fail "the e2e environment is not fresh (console already initialized); reset it with: docker compose -f compose.e2e.yml down -v && docker compose -f compose.e2e.yml up -d --build"
fi

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
    E2E_EXPECT_REVISION="$REVISION" pnpm --filter @edgeweir/console run test:e2e \
    || fail "Playwright smoke test failed"
  pass "Playwright smoke passed"
fi

printf '\n\033[1;32mE2E OK\033[0m\n'
