#!/usr/bin/env bash
# End-to-end test against compose.e2e.yml:
#   Phase 0: enroll a node with a one-time token -> mTLS -> create site demo.test
#   via the public API -> node applies the new revision -> X-Cache MISS then HIT
#   -> console API shows the node online with its revision -> Playwright smoke.
#   MVP M1: setup needs the setup token from the console log (Playwright) ->
#   site editing, clusters, node groups, audit log and English (Playwright) ->
#   the node keeps serving the edited site -> disabled nodes are refused,
#   deleted nodes stay revoked.
#   Analytics: the node's per-minute stats reach the console API, and the
#   overview and site analytics show them (Playwright).
#   MVP M2: URL / prefix / whole-site purge and prefetch as node tasks, query
#   ignoring and sorting in cache keys, Range requests from slice cache,
#   WebSocket through the node, origin certificate verification, S3 SigV4
#   origins, failover to the backup origin and back, origin health in the
#   console; Playwright submits purges and reads the per-node results.
#   Wrap-up (dev-docs/audits/2026-09-25-wrapup.md): better-auth's admin and
#   api-key endpoints are closed and API keys never become sessions (CP-C1);
#   origins on special-purpose addresses are refused by the console and, for
#   DNS answers, by the node, and CDN-Loop stops loops (N-H2); HTTPS origins
#   are verified against their name with the trusted CA (N-H4); the origin
#   sees 1 MiB slices (CP-M2); S3 origins never receive the client's x-amz-*
#   headers (N-L); install.sh installs goreleaser snapshot packages in a clean
#   Debian container and enrolls the node (N-H1, --no-start: no systemd).
#   Core gaps P0 (scripts/e2e-p0.mjs): Idempotency-Key, service accounts with
#   scopes disabling a site, usage and its completeness watermark,
#   configuration canary with automatic promotion and rollback, DNS mass
#   removal protection; Playwright e2e/p0.spec.ts.
#   Core gaps G1 (scripts/e2e-g1.mjs): the nodes report bans-v1 and
#   kernel-ban-v1; bans and unbans reach a client container within 5 s (p95);
#   a site ban answers 403 ip-banned to one client on one site only; a
#   platform ban drops the client in nftables (TCP connect times out) while
#   the control client is served, and the unban lets it back; short
#   prefixes, protected addresses and bans over the platform limit are
#   refused; Playwright e2e/g1.spec.ts.
#   Core gaps G2 (scripts/e2e-g2.mjs): headless Chromium passes the js and
#   pow challenges of an Under Attack site; its pass works on the other node
#   from the same /24 and User-Agent only (client-c on the isolated network
#   is challenged), forged passes and POST without a pass are refused,
#   /.edgeweir/ never reaches the origin; allow and challenge rules, platform
#   Under Attack; CC escalates only the attacked path and bans a client over
#   its rate (auto ban and events in the console); JA4 from the sampled logs
#   in block, challenge and rate limit rules; leaves ua-bench.test for
#   BENCH_SCENARIO=pass|challenge in scripts/bench.sh; Playwright
#   e2e/g2.spec.ts.
#   Core gaps G3: the install step builds the edgeweir-openresty packages
#   for the Docker architecture when ../edgeweir-node/out/openresty lacks
#   them, checks `goreleaser check`, the packages' contents (nginx, lualib,
#   NOTICE, SBOMs, the ModSecurity module and the CRS), `nginx -V` of the
#   installed OpenResty, the CRS loading in it and the installed node's
#   brotli-v1, zstd-v1 and modsecurity-v1. scripts/e2e-g3.mjs: the nodes'
#   custom build; Brotli, Zstandard and gzip negotiated by q-value from one
#   cached identity object (curl --compressed decodes each), no second
#   compression of an encoded origin response; OWASP CRS detect (logged,
#   served) and block (403 waf-blocked, cache hits included), excluded rules,
#   top rules; old nodes (pre-G3 image) and a node without ModSecurity make
#   the features unavailable until they leave (a change that requires them
#   anyway waits for the old node); Playwright e2e/g3.spec.ts with an old
#   node in a cluster of its own.
#   Core gaps G4 (scripts/e2e-g4.mjs, test origins g4-origin-a/b): both nodes
#   report the G4 features; Cache-Tag hidden unless kept, purges by tag
#   (case-insensitive, only tagged objects MISS on every node, every Range
#   slice included) and by Host; an expired object served STALE while the
#   origin is down is never served after a purge of its tag; desktop and
#   mobile prefetch, sitemap urlset and gzip sitemapindex prefetch (same-site,
#   capped); active health checks take a failing origin out of rotation on
#   both nodes and back (and keep an origin outside the address policy down),
#   session affinity pins, replaces tampered cookies and fails over; site
#   error pages for 403 (rule, IP list), 429, 502, 503, 504 and intercepted
#   origin errors with escaped placeholders, no-store and request ids (also in
#   the sampled logs); platform pages for unknown hosts and disabled sites;
#   Playwright e2e/g4.spec.ts.
#
# Usage:
#   docker compose -f compose.e2e.yml up -d --build
#   bash scripts/e2e.sh [--up] [--down] [--skip-ui]
# Needs curl, jq, docker, node, and for the install step goreleaser, syft and
# Go (it builds snapshot packages in $EDGEWEIR_NODE_CONTEXT, ../edgeweir-node
# by default, with the edgeweir-openresty packages of `make
# openresty-packages`, built here for the Docker architecture when missing).
# E2E_SUBNET / E2E_ISOLATED_SUBNET must match compose.e2e.yml.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f compose.e2e.yml)
CONSOLE="http://localhost:${E2E_CONSOLE_PORT:-13000}"
NODE_HTTP="http://localhost:${E2E_NODE_PORT:-18080}"
ADMIN_EMAIL="admin@e2e.test"
ADMIN_PASSWORD="e2e-admin-password-123"
STATE_DIR=".e2e"
E2E_SUBNET="${E2E_SUBNET:-172.28.213.0/24}"
E2E_ISOLATED_SUBNET="${E2E_ISOLATED_SUBNET:-172.28.214.0/24}"
NODE_CONTEXT="${EDGEWEIR_NODE_CONTEXT:-../edgeweir-node}"
# Clean machine for install.sh (a throwaway container on the e2e network).
INSTALL_IMAGE="${E2E_INSTALL_IMAGE:-debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251}"
INSTALL_CONTAINER="${COMPOSE_PROJECT_NAME:-edgeweir-e2e}-install"
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
need node

mkdir -p "$STATE_DIR"
COOKIES="$STATE_DIR/cookies.txt"
rm -f "$COOKIES"

if $UP; then
  step "docker compose -f compose.e2e.yml up -d --build"
  "${COMPOSE[@]}" up -d --build
fi
cleanup() {
  docker rm -f "$INSTALL_CONTAINER" >/dev/null 2>&1 || true
  # Containers scripts/e2e-g3.mjs starts next to the stack (old nodes, curl).
  docker ps -aq --filter "label=dev.edgeweir.e2e-g3=${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" | xargs docker rm -f >/dev/null 2>&1 || true
  # Every profile: the upgrade peer and ClickHouse keep their state otherwise.
  if $DOWN; then "${COMPOSE[@]}" --profile '*' down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

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

# api_status METHOD PATH [JSON] -> "STATUS BODY", whatever the status.
api_status() {
  local method="$1" path="$2" body="${3:-}" out status
  out="$(mktemp)"
  status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$CONSOLE/api/v1$path" \
    -H 'content-type: application/json' ${API_KEY:+-H "x-api-key: $API_KEY"} \
    ${body:+--data "$body"})"
  printf '%s %s' "$status" "$(cat "$out")"
  rm -f "$out"
}

# auth_post PATH JSON [curl args...] -> "STATUS BODY" of POST /api/auth/PATH.
auth_post() {
  local path="$1" body="$2" out status
  shift 2
  out="$(mktemp)"
  status="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$CONSOLE/api/auth$path" \
    -H 'content-type: application/json' -H "origin: $CONSOLE" "$@" --data "$body")"
  printf '%s %s' "$status" "$(cat "$out")"
  rm -f "$out"
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

# The Docker network of the e2e project (the console is only on the default one).
e2e_network() {
  docker inspect "$("${COMPOSE[@]}" ps -q console)" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}'
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
  fail "the e2e environment is not fresh (console already initialized); reset it with: docker compose -f compose.e2e.yml --profile '*' down -v && docker compose -f compose.e2e.yml up -d --build"
setup_token() {
  "${COMPOSE[@]}" logs console 2>/dev/null | grep -o '"setupToken":"ews_[A-Za-z0-9_-]*"' | tail -n1 | cut -d'"' -f4
}
wait_for 30 "setup token in the console log" test -n "$(setup_token)"
SETUP_TOKEN="$(setup_token)"
pass "console log shows setup token ${SETUP_TOKEN:0:8}… ($("${COMPOSE[@]}" logs console 2>/dev/null | grep -c '"setupToken"') log line(s))"
REFUSED="$(curl -sS -w ' %{http_code}' -X POST "$CONSOLE/api/v1/system/setup" -H 'content-type: application/json' \
  --data "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
    '{setupToken:"ews_wrong", name:"Intruder", email:$e, password:$p}')")"
[[ "$REFUSED" == *'"code":"SETUP_TOKEN_INVALID"'*' 403' ]] || fail "setup without the token must be refused, got: $REFUSED"
pass "setup with a wrong token refused: $REFUSED"

if ! $SKIP_UI; then
  step "Playwright: setup wizard with the setup token (the operator account + default cluster)"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_SETUP_TOKEN="$SETUP_TOKEN" pnpm --filter @edgeweir/console run test:e2e e2e/setup.spec.ts \
    || fail "Playwright setup failed"
else
  api POST /system/setup "$(jq -nc --arg t "$SETUP_TOKEN" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
    '{setupToken:$t, name:"E2E Admin", email:$e, password:$p}')" >/dev/null
fi
[[ "$(api GET /system/status | jq -r .initialized)" == "true" ]] || fail "setup did not complete"
pass "setup completed with the setup token"

step "sign in and create an API AccessKey"
curl -fsS -c "$COOKIES" -o /dev/null "$CONSOLE/api/auth/sign-in/email" \
  -H 'content-type: application/json' -H "origin: $CONSOLE" \
  --data "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" \
  || fail "sign-in failed"
# rpc PATH JSON -> the procedure's output, as the web UI calls it (session cookie + CSRF header).
rpc() {
  curl -fsS -b "$COOKIES" -X POST "$CONSOLE/rpc/$1" -H 'content-type: application/json' \
    -H 'x-csrf-token: orpc' --data "$(jq -nc --argjson input "$2" '{json: $input}')" | jq -c .json
}
API_KEY="$(rpc accessKeys/create '{"name":"e2e"}' | jq -r .key)"
[[ "$API_KEY" == ewk_* ]] || fail "no API key returned"
export API_KEY
pass "API key ${API_KEY:0:10}… (the public API /api/v1 only accepts x-api-key)"

CLUSTER="$(api GET /clusters | jq -c '.[0]')"
CLUSTER_ID="$(jq -r .id <<<"$CLUSTER")"
[[ -n "$CLUSTER_ID" && "$CLUSTER_ID" != null ]] || fail "no cluster"
pass "cluster $(jq -r .name <<<"$CLUSTER") ($CLUSTER_ID), latest revision #$(jq -r .latestRevision.revision <<<"$CLUSTER")"

step "CP-C1: better-auth's admin and api-key endpoints are closed, even for the signed-in operator"
ME="$(api GET /me)"
ADMIN_ID="$(jq -r .user.id <<<"$ME")"
[[ "$(jq -r .user.email <<<"$ME")" == "$ADMIN_EMAIL" && "$(jq -r .serviceAccount <<<"$ME")" == null ]] ||
  fail "the AccessKey should act as the operator: $ME"
SESSION_USER="$(curl -fsS -b "$COOKIES" "$CONSOLE/api/auth/get-session" | jq -r .user.id)"
[[ "$SESSION_USER" == "$ADMIN_ID" ]] || fail "the operator's session cookie must be valid for these checks (got user '$SESSION_USER')"
NOT_FOUND='404 {"error":"not found"}'
closed() { # closed PATH JSON: POST with the operator's session must be refused by the route allow list
  local got
  got="$(auth_post "$1" "$2" -b "$COOKIES")"
  echo "POST /api/auth$1 (operator session) -> $got"
  [[ "$got" == "$NOT_FOUND" ]] || fail "POST /api/auth$1 must be refused, got: $got"
}
closed /admin/impersonate-user "$(jq -nc --arg u "$ADMIN_ID" '{userId: $u}')"
closed /admin/set-user-password "$(jq -nc --arg u "$ADMIN_ID" '{userId: $u, newPassword: "e2e-hijacked-password-1"}')"
closed /admin/set-role "$(jq -nc --arg u "$ADMIN_ID" '{userId: $u, role: "user"}')"
closed /admin/create-user '{"email":"intruder@e2e.test","password":"e2e-intruder-password-1","name":"Intruder","role":"admin"}'
closed /admin/ban-user "$(jq -nc --arg u "$ADMIN_ID" '{userId: $u}')"
closed /admin/remove-user "$(jq -nc --arg u "$ADMIN_ID" '{userId: $u}')"
closed /sign-up/email '{"email":"intruder@e2e.test","password":"e2e-intruder-password-1","name":"Intruder"}'
closed /api-key/create '{"name":"minted-with-a-session"}'
closed /api-key/delete '{"keyId":"x"}'
KEY_LIST="$(curl -sS -w ' %{http_code}' -b "$COOKIES" "$CONSOLE/api/auth/api-key/list")"
[[ "$KEY_LIST" == '{"error":"not found"} 404' ]] || fail "GET /api/auth/api-key/list must be refused, got: $KEY_LIST"
ACCOUNTS="$("${COMPOSE[@]}" exec -T postgres psql -U edgeweir -d edgeweir -At -c 'select count(*) from "user"')"
[[ "$ACCOUNTS" == 1 ]] || fail "admin/create-user or sign-up created an account: $ACCOUNTS accounts"
[[ "$(api GET /me | jq -r .user.id)" == "$ADMIN_ID" ]] || fail "the operator changed"
curl -fsS -o /dev/null "$CONSOLE/api/auth/sign-in/email" -H 'content-type: application/json' -H "origin: $CONSOLE" \
  --data "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" ||
  fail "the operator can no longer sign in with the original password (set-user-password / ban-user went through?)"
pass "admin/*, sign-up and api-key/* answer 404 to the operator's session; no account was created, the operator's password is unchanged"

step "CP-C1: an x-api-key alone never becomes a better-auth session"
KEY_SESSION="$(curl -sS -H "x-api-key: $API_KEY" "$CONSOLE/api/auth/get-session")"
echo "GET /api/auth/get-session (x-api-key only) -> $KEY_SESSION"
[[ "$KEY_SESSION" == "null" ]] || fail "an API key must not yield a session on /api/auth, got: $KEY_SESSION"
KEY_CREATE="$(auth_post /api-key/create '{"name":"minted-with-a-key"}' -H "x-api-key: $API_KEY")"
echo "POST /api/auth/api-key/create (x-api-key only) -> $KEY_CREATE"
[[ "$KEY_CREATE" == "$NOT_FOUND" ]] || fail "creating an API key with only an API key must be refused, got: $KEY_CREATE"
KEY_MINT="$(api_status POST /access-keys '{"name":"minted-with-a-key"}')"
echo "POST /api/v1/access-keys (x-api-key) -> $KEY_MINT"
[[ "${KEY_MINT%% *}" == 403 && "$(jq -r .code <<<"${KEY_MINT#* }")" == ACCESS_KEY_SESSION_REQUIRED ]] ||
  fail "an AccessKey must not mint AccessKeys, got: $KEY_MINT"
[[ "$(rpc accessKeys/list '{}' | jq -c '[.[] | .name]')" == '["e2e"]' ]] ||
  fail "the operator should still have exactly the e2e key: $(rpc accessKeys/list '{}')"
KEY_RPC="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/rpc/account/me" -H "x-api-key: $API_KEY" \
  -H 'x-csrf-token: orpc' -H 'content-type: application/json' --data '{}')"
[[ "$KEY_RPC" == 401 ]] || fail "/rpc must not accept an API key, got HTTP $KEY_RPC"
pass "get-session with only x-api-key -> null; api-key/create -> 404, /api/v1/access-keys -> 403 (no key minted); /rpc with only x-api-key -> 401"

step "N-H2: origin allow list = the e2e Docker network only (the special-purpose defaults stay)"
NETWORK="$(e2e_network)"
SUBNETS="$(docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
[[ " $SUBNETS" == *" $E2E_SUBNET "* ]] || fail "network $NETWORK has subnets '$SUBNETS', expected E2E_SUBNET=$E2E_SUBNET (compose.e2e.yml)"
[[ "$(api GET /settings/origin-allow-list | jq -c .cidrs)" == "[]" ]] ||
  fail "a fresh console must not allow any special-purpose range"
REV_BEFORE="$(api GET "/clusters/$CLUSTER_ID" | jq -r .latestRevision.revision)"
ALLOW="$(api PUT /settings/origin-allow-list "$(jq -nc --arg s "$E2E_SUBNET" '{cidrs: [$s]}')")"
[[ "$(jq -c .cidrs <<<"$ALLOW")" == "[\"$E2E_SUBNET\"]" ]] || fail "unexpected allow list: $ALLOW"
REV_AFTER="$(api GET "/clusters/$CLUSTER_ID" | jq -r .latestRevision.revision)"
((REV_AFTER > REV_BEFORE)) || fail "changing the allow list must publish a revision (#$REV_BEFORE -> #$REV_AFTER)"
pass "allow list $(jq -c .cidrs <<<"$ALLOW") (network $NETWORK), revision #$REV_BEFORE -> #$REV_AFTER; the isolated network $E2E_ISOLATED_SUBNET stays refused"

step "node enrollment with a one-time token"
TOKEN_JSON="$(api POST /enrollment-tokens "$(jq -nc --arg c "$CLUSTER_ID" '{clusterId:$c,nodeName:"edge-e2e-1",ttlMinutes:15}')")"
TOKEN="$(jq -r .token <<<"$TOKEN_JSON")"
CA_SHA256="$(jq -r .caSha256 <<<"$TOKEN_JSON")"
SERVER_URL="$(jq -r .serverUrl <<<"$TOKEN_JSON")"
INSTALL_COMMAND="$(jq -r .installCommand <<<"$TOKEN_JSON")"
echo "install command (as shown in the console):"
sed -E "s/(EDGEWEIR_TOKEN=')[^']+/\1<redacted>/" <<<"$INSTALL_COMMAND"
[[ "$INSTALL_COMMAND" == "export EDGEWEIR_TOKEN='$TOKEN'"$'\n'*"/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server $SERVER_URL --ca-sha256 $CA_SHA256" &&
  "$INSTALL_COMMAND" != *--token* ]] ||
  fail "the install command must pass the token through EDGEWEIR_TOKEN, never as an argument"

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
"${COMPOSE[@]}" logs node >"$STATE_DIR/node.log" 2>&1
grep -q "switched to mTLS channel" "$STATE_DIR/node.log" || fail "the agent did not log the switch to the mTLS channel"
grep -i "switched to mTLS channel" "$STATE_DIR/node.log" | tail -n 1 | cut -c1-200

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
  step "Playwright smoke: login -> clusters & nodes -> sites"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_EXPECT_REVISION="$REVISION" pnpm --filter @edgeweir/console run test:e2e e2e/smoke.spec.ts \
    || fail "Playwright smoke test failed"
  pass "Playwright smoke passed"

  step "Playwright M1: site editing, clusters, node groups, audit, English"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/m1.spec.ts \
    || fail "Playwright M1 test failed"
  pass "Playwright M1 passed"

  step "the node serves the site edited in the UI"
  NODE="$(node_json)"
  CLUSTER="$(api GET "/clusters/$CLUSTER_ID")"
  [[ "$(jq -r .nodeGroupName <<<"$NODE")" == "group-a" && "$(jq -r .regionName <<<"$NODE")" == "华东" ]] ||
    fail "node should be in node group group-a (华东): $(jq -c '{nodeGroupName, regionName}' <<<"$NODE")"
  LATEST="$(jq -r .latestRevision.revision <<<"$CLUSTER")"
  node_synced() { [[ "$(node_json | jq -r '.online and .applyState == "applied"')" == "true" && "$(node_json | jq -r .appliedRevision)" == "$LATEST" ]]; }
  wait_for 60 "node online on revision #$LATEST after the move" node_synced
  pass "node $(jq -r .name <<<"$NODE") in group-a (华东), online, applied #$LATEST = cluster latest #$LATEST"
  EDITED_SITE="$(api GET "/sites?search=edited-site" | jq -c '.items[0]')"
  [[ "$(jq -r '.domains | join(",")' <<<"$EDITED_SITE")" == "edited.test,www.edited.test" &&
    "$(jq -r '.origins[0].address' <<<"$EDITED_SITE")" == "whoami" ]] ||
    fail "site not as edited in the UI: $EDITED_SITE"
  wait_for 30 "www.edited.test routed to the edited origin" \
    curl -fsS -o /dev/null -H 'Host: www.edited.test' "$NODE_HTTP/e2e-edited-probe"
  BODY="$(curl -fsS -H 'Host: www.edited.test' "$NODE_HTTP/e2e-edited")"
  grep -q "^GET /e2e-edited " <<<"$BODY" || fail "www.edited.test did not reach whoami: $BODY"
  pass "curl -H 'Host: www.edited.test' -> whoami (domain and origin edited in the UI)"
fi

step "analytics: the node's per-minute stats reach the console"
SITE_ID="$(jq -r .site.id <<<"$SITE")"
site_traffic() { api GET "/analytics/traffic?range=1h&siteId=$SITE_ID"; }
# The agent uploads completed minutes once a minute.
stats_arrived() { [[ "$(site_traffic | jq -r '.totals.requests >= 3 and .totals.cacheHits >= 1 and .totals.status2xx >= 3')" == "true" ]]; }
wait_for 180 "demo.test requests, cache hits and 2xx responses in the 1h analytics" stats_arrived
pass "demo.test in the last hour: $(site_traffic | jq -c '.totals | {requests, cacheHits, cacheMisses, status2xx, status4xx, bytesSent}')"
[[ "$(api GET "/analytics/top-nodes?range=1h" | jq -r '.[0].name')" == "edge-e2e-1" ]] || fail "top nodes should list edge-e2e-1"
pass "top nodes: $(api GET "/analytics/top-nodes?range=1h" | jq -c '[.[] | {name, parentName, requests}]')"

if ! $SKIP_UI; then
  step "Playwright analytics: overview lists and charts, stars, site analytics"
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/analytics.spec.ts \
    || fail "Playwright analytics test failed"
  pass "Playwright analytics passed"
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
# files:9443 has a certificate for "files" from the test CA the node trusts.
m2_site m2-tls-ca '{domains: ["tls-ca.m2.test"], origins: [{address: "files", port: 9443, scheme: "https"}], cacheRules: []}' >/dev/null
TLS_NAME_SITE="$(m2_site m2-tls-name '{domains: ["tls-name.m2.test"],
  origins: [{address: "files", port: 9443, scheme: "https", sni: "wrong.m2.test"}], cacheRules: []}')"
m2_site m2-s3 '{domains: ["s3.m2.test"], origins: [{address: "s3", port: 7070,
  s3: {region: "us-east-1", bucket: "media", accessKeyId: "e2e-access-key", secretAccessKey: "e2e-only-s3-secret-key"}}]}' >/dev/null
# An "S3 origin" that echoes the request: shows exactly what the node sends to object storage.
m2_site m2-s3-echo '{domains: ["s3-echo.m2.test"], origins: [{address: "whoami",
  s3: {region: "us-east-1", bucket: "media", accessKeyId: "e2e-access-key", secretAccessKey: "e2e-only-s3-secret-key"}}], cacheRules: []}' >/dev/null
m2_site m2-ws-off '{domains: ["wsoff.m2.test"], origins: [{address: "whoami"}], originSettings: {websocket: false}}' >/dev/null
m2_site m2-stale '{domains: ["stale.m2.test"], origins: [{address: "origin-primary"}],
  cacheRules: [{pathPrefixes: ["/"], edgeTtlSeconds: 1, staleIfErrorSeconds: 300}]}' >/dev/null
# N-H2: "hidden" resolves into the isolated network (outside the allow list);
# "node" is the edge node itself (inside it).
HIDDEN_SITE="$(m2_site m2-hidden '{domains: ["hidden.m2.test"], origins: [{address: "hidden"}], cacheRules: []}')"
m2_site m2-loop '{domains: ["loop.m2.test"], origins: [{address: "node"}], cacheRules: []}' >/dev/null
wait_node_latest
pass "14 M2 sites published and applied by the node"

step "N-H2: origins on 127.0.0.1 and 169.254.169.254 are refused by the console, nothing is published"
LATEST_BEFORE="$(cluster_latest)"
forbidden() { # forbidden ADDRESS RANGE
  local got
  got="$(api_status POST /sites "$(jq -nc --arg c "$CLUSTER_ID" --arg a "$1" \
    '{name: "m2-forbidden", clusterId: $c, domains: ["forbidden.m2.test"], origins: [{address: $a}]}')")"
  echo "POST /sites origin $1 -> ${got:0:220}"
  [[ "${got%% *}" == 400 ]] || fail "origin $1 must be refused with 400, got: $got"
  [[ "$(jq -r '"\(.code) \(.data.address) \(.data.range)"' <<<"${got#* }")" == "ORIGIN_ADDRESS_FORBIDDEN $1 $2" ]] ||
    fail "origin $1 must be refused with ORIGIN_ADDRESS_FORBIDDEN ($2), got: $got"
}
forbidden 127.0.0.1 127.0.0.0/8
forbidden 169.254.169.254 169.254.0.0/16
forbidden 10.0.0.10 10.0.0.0/8
PATCHED="$(api_status PATCH "/sites/$CACHE_SITE" '{"origins": [{"address": "169.254.169.254"}]}')"
[[ "${PATCHED%% *}" == 400 && "$(jq -r .code <<<"${PATCHED#* }")" == ORIGIN_ADDRESS_FORBIDDEN ]] ||
  fail "changing an origin to 169.254.169.254 must be refused, got: $PATCHED"
[[ "$(api GET "/sites/$CACHE_SITE" | jq -r '[.origins[].address] | join(",")')" == "whoami" ]] ||
  fail "the refused change must leave the site's origins alone"
[[ "$(api GET '/sites?search=m2-forbidden' | jq '.items | length')" == 0 ]] || fail "a refused site was created"
[[ "$(cluster_latest)" == "$LATEST_BEFORE" ]] || fail "a refused origin published a revision (#$LATEST_BEFORE -> #$(cluster_latest))"
pass "127.0.0.1, 169.254.169.254 and 10.0.0.10 refused with ORIGIN_ADDRESS_FORBIDDEN (create and update); no site, still revision #$LATEST_BEFORE"

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

step "M2 / CP-M2: Range requests are served from the slice cache; the origin only sees 1 MiB slices"
docker_files() { "${COMPOSE[@]}" exec -T files sh -c "$1"; }
ORIGIN_BYTES="$(docker_files 'dd if=/srv/big.bin bs=1 skip=1048000 count=1000 2>/dev/null | sha256sum' | cut -d' ' -f1)"
docker_files ': > /tmp/access.log'
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
# The client range 1048000-1048999 spans slices 0 and 1: the origin must have
# been asked for exactly those two 1 MiB slices, never the client's range or the
# whole object, and nothing for the later HITs.
ORIGIN_RANGES="$(docker_files "grep ' /big.bin ' /tmp/access.log" || true)"
echo "files origin access log for /big.bin:"
echo "$ORIGIN_RANGES"
[[ "$ORIGIN_RANGES" == '80 GET /big.bin range="bytes=0-1048575" status=206'$'\n''80 GET /big.bin range="bytes=1048576-2097151" status=206' ]] ||
  fail "the origin should have received exactly the two slice-aligned ranges, got: $ORIGIN_RANGES"
pass "bytes 1048000-1048999: MISS then HIT with the origin's bytes; bytes 1048576-1048600 of the cached slice: HIT; the origin saw only bytes=0-1048575 and bytes=1048576-2097151"

step "M2: WebSocket through the node"
WS="$(node scripts/ws-echo.mjs localhost "${E2E_NODE_PORT:-18080}" cache.m2.test /echo hello-edgeweir)" || fail "WebSocket through the node failed: $WS"
echo "$WS"
[[ "$WS" == *"echo: hello-edgeweir"* ]] || fail "no echo over WebSocket: $WS"
WS_OFF="$(node scripts/ws-echo.mjs localhost "${E2E_NODE_PORT:-18080}" wsoff.m2.test /echo x 2>&1 || true)"
[[ "$WS_OFF" == *"handshake failed: HTTP/1.1 403"* ]] || fail "WebSocket should be refused when disabled: $WS_OFF"
pass "whoami /echo echoed over the node; the site with WebSocket off refused the upgrade (403)"

step "M2 / N-H4: HTTPS origins are verified against their name with the trusted CA, unless verification is off"
tls_get() { curl -sS -o "$STATE_DIR/tls.body" -w '%{http_code}' -H "Host: $1" "$NODE_HTTP/static/a.txt"; }
expect_tls() { # expect_tls HOST WANT-STATUS WHAT
  local got
  got="$(tls_get "$1")"
  echo "curl -H 'Host: $1' $NODE_HTTP/static/a.txt -> $got ($3)"
  [[ "$got" == "$2" ]] || fail "$3: expected HTTP $2 for $1, got $got: $(head -c 200 "$STATE_DIR/tls.body")"
  [[ "$2" != 200 || "$(cat "$STATE_DIR/tls.body")" == "static" ]] || fail "unexpected body over HTTPS: $(cat "$STATE_DIR/tls.body")"
}
# tls-ca and tls-name share files:9443: a connection verified for "files" must
# never be reused for "wrong.m2.test", and a failed one never poisons "files".
expect_tls tls-ca.m2.test 200 "trusted CA, name files matches"
expect_tls tls-name.m2.test 502 "trusted CA, name wrong.m2.test does not match"
expect_tls tls-ca.m2.test 200 "trusted CA, matching name after a mismatch"
expect_tls tls-name.m2.test 502 "wrong name after a verified connection"
expect_tls tls.m2.test 502 "self-signed certificate"
"${COMPOSE[@]}" logs node >"$STATE_DIR/node.log" 2>&1
grep -m1 "upstream SSL certificate verify error" "$STATE_DIR/node.log" | cut -c1-240 ||
  fail "the node did not log the self-signed origin's verification error"
grep -m1 -E 'upstream SSL certificate does not match .{0,2}wrong\.m2\.test' "$STATE_DIR/node.log" | cut -c1-240 ||
  fail "the node did not log the certificate name mismatch for wrong.m2.test"
tls_failed_in_console() {
  api GET "/sites/$TLS_NAME_SITE/origin-health" | jq -e '.[0].lastErrorCode == "tls_failed"' >/dev/null
}
wait_for 60 "console shows tls_failed for the name-mismatch origin" tls_failed_in_console
api GET "/sites/$TLS_NAME_SITE/origin-health" | jq -c '.[] | {downNodes, onlineNodes, lastErrorCode, lastError}'
api PATCH "/sites/$TLS_SITE" '{"originSettings": {"tlsVerify": false}}' >/dev/null
wait_node_latest
expect_tls tls.m2.test 200 "self-signed certificate, verification off"
pass "trusted CA + matching name 200; trusted CA + wrong name 502 (tls_failed in the console, no connection reuse either way); self-signed 502; verification off 200"

step "M2: S3-compatible origin with SigV4 signing"
S3_BODY="$(curl -fsS -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")" || fail "S3 origin request failed: $(curl -sS -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")"
[[ "$S3_BODY" == "hello from s3" ]] || fail "unexpected S3 body: $S3_BODY"
expect_cache HIT s3.m2.test /hello.txt
S3_POST="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Host: s3.m2.test' "$NODE_HTTP/hello.txt")"
[[ "$S3_POST" == "405" ]] || fail "POST to an S3 origin must be refused, got $S3_POST"
pass "signed GET returned the object (then cached); POST refused with 405"

step "N-L: S3 origins never receive the client's x-amz-* headers"
AMZ=(-H 'x-amz-security-token: e2e-forged-session-token' -H 'x-amz-server-side-encryption-customer-algorithm: AES256'
  -H 'x-amz-date: 20000101T000000Z' -H 'x-amz-content-sha256: e2e-forged-payload-hash' -H 'x-amz-request-payer: requester')
# A new cache key (the query string is not forwarded to object storage), so this goes to the origin.
S3_AMZ_H="$(curl -sS -D - -o "$STATE_DIR/s3amz.body" -H 'Host: s3.m2.test' "${AMZ[@]}" "$NODE_HTTP/hello.txt?e2e-amz=$RANDOM" | tr -d '\r')"
grep -iE '^(HTTP|x-cache)' <<<"$S3_AMZ_H"
grep -q '^HTTP/1.1 200' <<<"$S3_AMZ_H" && grep -qi '^x-cache: MISS' <<<"$S3_AMZ_H" &&
  [[ "$(cat "$STATE_DIR/s3amz.body")" == "hello from s3" ]] ||
  fail "a signed request with client x-amz-* headers must still succeed at the origin: $S3_AMZ_H $(cat "$STATE_DIR/s3amz.body")"
S3_ECHO="$(curl -fsS -H 'Host: s3-echo.m2.test' "${AMZ[@]}" "$NODE_HTTP/amz.txt" | tr -d '\r')" ||
  fail "the echoing S3 origin was not reachable"
grep -iE '^(GET|Authorization|X-Amz-)' <<<"$S3_ECHO" | cut -c1-160
grep -q '^GET /media/amz.txt ' <<<"$S3_ECHO" && grep -qi '^Authorization: AWS4-HMAC-SHA256 Credential=e2e-access-key/' <<<"$S3_ECHO" ||
  fail "the echoing origin did not receive a SigV4-signed path-style request: $S3_ECHO"
if grep -qiE '^X-Amz-(Security-Token|Server-Side-Encryption|Request-Payer)' <<<"$S3_ECHO" ||
  grep -qiE '^X-Amz-Date: 20000101T000000Z|^X-Amz-Content-Sha256: e2e-forged' <<<"$S3_ECHO"; then
  fail "client x-amz-* headers reached the S3 origin: $S3_ECHO"
fi
pass "with forged x-amz-* headers the signed GET still succeeded (MISS, 200); the origin saw only the node's own X-Amz-Date / X-Amz-Content-Sha256"

step "N-H2: a host name resolving outside the allow list is refused by the node (502, address_forbidden)"
HIDDEN_CODE="$(curl -sS -o "$STATE_DIR/hidden.body" -w '%{http_code}' -H 'Host: hidden.m2.test' "$NODE_HTTP/")"
echo "curl -H 'Host: hidden.m2.test' $NODE_HTTP/ -> $HIDDEN_CODE"
[[ "$HIDDEN_CODE" == 502 ]] || fail "origin resolving into $E2E_ISOLATED_SUBNET must be refused with 502, got $HIDDEN_CODE"
! grep -q '^Name: hidden' "$STATE_DIR/hidden.body" || fail "the hidden origin was reached"
HIDDEN_IP="$(docker inspect "$("${COMPOSE[@]}" ps -q hidden)" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
# The node reports the refused DNS answer through origin health (code + address).
hidden_forbidden() {
  api GET "/sites/$HIDDEN_SITE/origin-health" |
    jq -e --arg ip "$HIDDEN_IP" '.[0] | .lastErrorCode == "address_forbidden" and .lastErrorParams.address == $ip' >/dev/null
}
wait_for 60 "console shows address_forbidden ($HIDDEN_IP) for the hidden origin" hidden_forbidden
api GET "/sites/$HIDDEN_SITE/origin-health" | jq -c '.[] | {downNodes, onlineNodes, lastErrorCode, lastErrorParams, lastError}'
pass "hidden -> $HIDDEN_IP ($E2E_ISOLATED_SUBNET): 502 from the node, origin health address_forbidden in the console"

step "N-H2: CDN-Loop: the node appends its cdn-id and stops a site whose origin is the node itself (508)"
CDN_ID="edgeweir-$(printf '%s' "$(node_json | jq -r .id)" | sha256 | cut -c1-16)"
LOOP_ECHO="$(curl -fsS -H 'Host: cache.m2.test' -H 'CDN-Loop: other-cdn.example; v=1' "$NODE_HTTP/cdn-loop-$RANDOM" | tr -d '\r')"
grep -i '^Cdn-Loop:' <<<"$LOOP_ECHO"
grep -qix "Cdn-Loop: other-cdn.example; v=1, $CDN_ID" <<<"$LOOP_ECHO" ||
  fail "the origin did not receive CDN-Loop with this node's cdn-id ($CDN_ID) appended: $LOOP_ECHO"
LOOP_H="$(curl -sS --max-time 10 -D - -o /dev/null -H 'Host: loop.m2.test' "$NODE_HTTP/loop" | tr -d '\r')" ||
  fail "a request to a site whose origin is the node itself did not come back"
grep -iE '^(HTTP|x-edgeweir-error)' <<<"$LOOP_H"
grep -q '^HTTP/1.1 508' <<<"$LOOP_H" || fail "origin = the node itself must end in 508 Loop Detected: $LOOP_H"
SELF_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: cache.m2.test' -H "CDN-Loop: other-cdn.example, $CDN_ID" "$NODE_HTTP/looped-$RANDOM")"
[[ "$SELF_CODE" == 508 ]] || fail "a request already carrying this node's cdn-id must get 508, got $SELF_CODE"
pass "CDN-Loop forwarded as 'other-cdn.example; v=1, $CDN_ID'; origin = node -> 508; a request carrying $CDN_ID -> 508"

step "M2: failover to the backup origin and back"
origin_name() { curl -sS -H 'Host: failover.m2.test' "$NODE_HTTP/whoami" | awk '/^Name:/ { print $2 }'; }
[[ "$(origin_name)" == "primary" ]] || fail "failover site should be served by the primary"
echo "before: Name: $(origin_name)"
expect_cache MISS stale.m2.test /stale.txt
"${COMPOSE[@]}" stop origin-primary >/dev/null 2>&1
sleep 2 # the stale site's object (TTL 1 s) is now expired
STALE_H="$(curl -sS -D - -o "$STATE_DIR/stale.body" -H 'Host: stale.m2.test' "$NODE_HTTP/stale.txt" | tr -d '\r')"
grep -q '^HTTP/1.1 200' <<<"$STALE_H" && grep -qi '^x-cache: STALE' <<<"$STALE_H" && grep -q '^Name: primary' "$STATE_DIR/stale.body" ||
  fail "expired object must be served stale while its only origin is down: $STALE_H"
grep -iE '^(HTTP|x-cache)' <<<"$STALE_H"
pass "stale-if-error: expired object served (X-Cache: STALE) while its origin is down"
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

step "N-H1: the console's release mirror serves goreleaser snapshot packages, anything else is 404"
need goreleaser
need go
need syft
[[ -f "$NODE_CONTEXT/.goreleaser.yaml" ]] || fail "no edgeweir-node checkout at $NODE_CONTEXT (EDGEWEIR_NODE_CONTEXT)"
(cd "$NODE_CONTEXT" && goreleaser check) >"$STATE_DIR/goreleaser-check.log" 2>&1 ||
  { cat "$STATE_DIR/goreleaser-check.log" >&2; fail "goreleaser check failed in $NODE_CONTEXT"; }
pass "goreleaser check: $(tr -d '\033' <"$STATE_DIR/goreleaser-check.log" | sed -E 's/\[[0-9;]*m//g' | grep -iE 'valid|checked' | tail -n1 | sed -E 's/^[[:space:]•]*//')"
# The snapshot copies the edgeweir-openresty packages of `make
# openresty-packages` (out/openresty) into dist/; build them for the
# architecture of the install container when they are missing.
DOCKER_ARCH="$(docker version --format '{{.Server.Arch}}')"
OPENRESTY_VERSION="$(awk '$1 == "openresty" { print $2 }' "$NODE_CONTEXT/packaging/openresty/sources.lock")"
OPENRESTY_RELEASE="$(awk '$1 == "release:" { print $2 }' "$NODE_CONTEXT/packaging/openresty/nfpm/edgeweir-openresty.yaml")"
OPENRESTY_PKG="$OPENRESTY_VERSION-$OPENRESTY_RELEASE"
OPENRESTY_FILES=("edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.deb" "edgeweir-openresty-modsecurity_${OPENRESTY_PKG}_$DOCKER_ARCH.deb"
  "edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.sbom.json")
openresty_packages_built() { for f in "${OPENRESTY_FILES[@]}"; do [[ -f "$NODE_CONTEXT/out/openresty/$f" ]] || return 1; done; }
if ! openresty_packages_built; then
  echo "make openresty-packages ARCH=$DOCKER_ARCH (in $NODE_CONTEXT, log in $STATE_DIR/openresty-packages.log)"
  make -C "$NODE_CONTEXT" openresty-packages ARCH="$DOCKER_ARCH" >"$STATE_DIR/openresty-packages.log" 2>&1 ||
    { tail -n 40 "$STATE_DIR/openresty-packages.log" >&2; fail "building the edgeweir-openresty packages failed"; }
  openresty_packages_built || fail "make openresty-packages did not produce ${OPENRESTY_FILES[*]}"
fi
pass "edgeweir-openresty $OPENRESTY_PKG packages for $DOCKER_ARCH in $NODE_CONTEXT/out/openresty"
echo "goreleaser release --snapshot --clean (in $NODE_CONTEXT, log in $STATE_DIR/goreleaser.log)"
(cd "$NODE_CONTEXT" && goreleaser release --snapshot --clean) >"$STATE_DIR/goreleaser.log" 2>&1 ||
  { tail -n 40 "$STATE_DIR/goreleaser.log" >&2; fail "goreleaser snapshot build failed"; }
DIST="$(cd "$NODE_CONTEXT" && pwd)/dist"
NODE_VERSION="$(jq -r .version "$DIST/metadata.json")"
echo "snapshot $NODE_VERSION: $(awk '{ print $2 }' "$DIST/checksums.txt" | grep -v '\.sbom\.json$' | tr '\n' ' ')"
for f in "${OPENRESTY_FILES[@]}"; do
  grep -qE "^[0-9a-f]{64}  $f\$" "$DIST/checksums.txt" || fail "the snapshot's checksums.txt does not list $f"
  cmp -s "$DIST/$f" "$NODE_CONTEXT/out/openresty/$f" || fail "dist/$f differs from out/openresty/$f"
done
SPDX="$(jq -r '[.spdxVersion, ([.packages[].name] | unique | join(" "))] | join(" ")' "$DIST/edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.sbom.json")"
for component in openresty nginx LuaJIT openssl pcre2 zlib brotli ngx_brotli zstd zstd-nginx-module modsecurity modsecurity-nginx yajl libxml2 coreruleset; do
  [[ " $SPDX " == *" $component "* ]] || fail "the SPDX SBOM does not list $component: $SPDX"
done
pass "dist/ and checksums.txt carry ${OPENRESTY_FILES[*]}; the SBOM (${SPDX%% *}) lists OpenResty, nginx, LuaJIT, OpenSSL, PCRE2, zlib, Brotli, ngx_brotli, Zstandard, zstd-nginx-module, ModSecurity, ModSecurity-nginx, YAJL, libxml2 and the OWASP CRS"
MIRROR_VOLUME="$(docker inspect "$("${COMPOSE[@]}" ps -q console)" \
  --format '{{range .Mounts}}{{if eq .Destination "/srv/downloads"}}{{.Name}}{{end}}{{end}}')"
[[ -n "$MIRROR_VOLUME" ]] || fail "the console has no /srv/downloads volume (compose.e2e.yml)"
# Documented layout: edgeweir-node/latest and edgeweir-node/v<version>/<file>.
docker run --rm -v "$MIRROR_VOLUME:/mirror" -v "$DIST:/dist:ro" -e VERSION="$NODE_VERSION" "$INSTALL_IMAGE" sh -ec '
  dir="/mirror/edgeweir-node/v$VERSION"
  rm -rf /mirror/edgeweir-node
  mkdir -p "$dir"
  cp /dist/checksums.txt "$dir/"
  awk "{ print \$2 }" /dist/checksums.txt | while read -r f; do cp "/dist/$f" "$dir/"; done
  printf "%s\n" "$VERSION" >/mirror/edgeweir-node/latest
  chmod -R a+rX /mirror' || fail "could not fill the release mirror"
[[ "$(curl -fsS "$CONSOLE/downloads/edgeweir-node/latest")" == "$NODE_VERSION" ]] || fail "the mirror's latest is not $NODE_VERSION"
curl -fsS "$CONSOLE/downloads/edgeweir-node/v$NODE_VERSION/checksums.txt" | cmp -s - "$DIST/checksums.txt" ||
  fail "the mirror serves a different checksums.txt"
for missing in "/downloads/edgeweir-node/v9.9.9/checksums.txt" "/downloads/edgeweir-node/v$NODE_VERSION/missing.deb" \
  "/downloads/edgeweir-node/v$NODE_VERSION/..%2F..%2Flatest" "/downloads/edgeweir-node/v$NODE_VERSION" \
  "/downloads/other/latest" "/downloads/"; do
  got="$(curl -sS --path-as-is -o /dev/null -w '%{http_code} %{content_type}' "$CONSOLE$missing")"
  [[ "$got" == "404 application/json" ]] || fail "GET $missing must be a JSON 404 (never the SPA shell), got: $got"
done
pass "mirror: latest = $NODE_VERSION, checksums.txt identical to dist/; unknown versions, files and projects are JSON 404s"

step "N-H1: install.sh in a clean $INSTALL_IMAGE container (.deb from the mirror, --no-start: no systemd in Docker)"
INSTALL_CLUSTER="$(api POST /clusters '{"name": "install-e2e"}' | jq -r .id)"
INSTALL_TOKEN_JSON="$(api POST /enrollment-tokens "$(jq -nc --arg c "$INSTALL_CLUSTER" '{clusterId: $c, nodeName: "edge-install-1", ttlMinutes: 15}')")"
INSTALL_SERVER="$(jq -r .serverUrl <<<"$INSTALL_TOKEN_JSON")"
INSTALL_CA="$(jq -r .caSha256 <<<"$INSTALL_TOKEN_JSON")"
docker rm -f "$INSTALL_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$INSTALL_CONTAINER" --network "$NETWORK" "$INSTALL_IMAGE" sleep infinity >/dev/null ||
  fail "could not start the install container"
in_install() { docker exec "$INSTALL_CONTAINER" bash -ec "$@"; }
in_install 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null' ||
  fail "could not install curl in the install container"
# The token is never an argument (process list): --token is refused outright.
if in_install 'curl -fsSL http://console:3000/install.sh | bash -s -- --token ewt_x --server https://console:8443 --ca-sha256 '"$INSTALL_CA" \
  >"$STATE_DIR/install-token-arg.log" 2>&1; then
  fail "install.sh must refuse --token"
fi
grep -q -- "--token is not accepted" "$STATE_DIR/install-token-arg.log" || fail "install.sh --token: $(cat "$STATE_DIR/install-token-arg.log")"
# As the console's command, but as root without sudo and with the mirror on the e2e network.
EDGEWEIR_TOKEN="$(jq -r .token <<<"$INSTALL_TOKEN_JSON")" docker exec -e EDGEWEIR_TOKEN "$INSTALL_CONTAINER" bash -ec '
  set -o pipefail
  curl -fsSL http://console:3000/install.sh | bash -s -- --server "$1" --ca-sha256 "$2" \
    --mirror http://console:3000/downloads/edgeweir-node --mirror-only --allow-unsigned --no-start' \
  _ "$INSTALL_SERVER" "$INSTALL_CA" >"$STATE_DIR/install.log" 2>&1 ||
  { tail -n 60 "$STATE_DIR/install.log" >&2; fail "install.sh failed"; }
grep '\[edgeweir\]' "$STATE_DIR/install.log" | tr -d '\033' | sed -E 's/\[[0-9;]*m//g' || true
grep -q "installing edgeweir-node $NODE_VERSION (deb, " "$STATE_DIR/install.log" &&
  grep -qE "SHA-256 verified: edgeweir-node_.*_(amd64|arm64)\.deb" "$STATE_DIR/install.log" &&
  grep -qE "SHA-256 verified: edgeweir-openresty_.*_(amd64|arm64)\.deb" "$STATE_DIR/install.log" &&
  grep -qE "SHA-256 verified: edgeweir-openresty-modsecurity_.*_(amd64|arm64)\.deb" "$STATE_DIR/install.log" &&
  grep -q "done: installed and enrolled; --no-start given" "$STATE_DIR/install.log" ||
  fail "install.sh did not install the verified .deb packages and enroll"
LAYOUT="$(in_install '
  getent passwd edgeweir | cut -d: -f1,6,7
  stat -c "%U:%G %a %n" /usr/bin/edgeweir-node /usr/lib/systemd/system/edgeweir-node.service /etc/default/edgeweir-node \
    /usr/share/edgeweir-node/lua/edgeweir /var/lib/edgeweir-node /var/cache/edgeweir-node \
    /var/lib/edgeweir-node/node.key /var/lib/edgeweir-node/node.crt /var/lib/edgeweir-node/ca.crt /var/lib/edgeweir-node/identity.json
  find /usr/share/edgeweir-node/lua/edgeweir -name "*.lua" \( ! -perm 644 -o ! -user root \)
  dpkg-query -W -f "\${Package}: \${Status}\n" edgeweir-node edgeweir-openresty edgeweir-openresty-modsecurity
  edgeweir-node version')"
echo "$LAYOUT"
EXPECTED_LAYOUT="edgeweir:/var/lib/edgeweir-node:/usr/sbin/nologin
root:root 755 /usr/bin/edgeweir-node
root:root 644 /usr/lib/systemd/system/edgeweir-node.service
root:root 644 /etc/default/edgeweir-node
root:root 755 /usr/share/edgeweir-node/lua/edgeweir
edgeweir:edgeweir 700 /var/lib/edgeweir-node
edgeweir:edgeweir 750 /var/cache/edgeweir-node
edgeweir:edgeweir 600 /var/lib/edgeweir-node/node.key
edgeweir:edgeweir 644 /var/lib/edgeweir-node/node.crt
edgeweir:edgeweir 644 /var/lib/edgeweir-node/ca.crt
edgeweir:edgeweir 644 /var/lib/edgeweir-node/identity.json
edgeweir-node: install ok installed
edgeweir-openresty: install ok installed
edgeweir-openresty-modsecurity: install ok installed"
[[ "$LAYOUT" == "$EXPECTED_LAYOUT"$'\n'*"$NODE_VERSION"* ]] || fail "unexpected install layout (expected, then the version):
$EXPECTED_LAYOUT"
[[ "$(in_install 'ls /usr/share/edgeweir-node/lua/edgeweir/*.lua | wc -l')" -ge 10 ]] || fail "the Lua modules are missing"
IDENTITY="$(in_install 'cat /var/lib/edgeweir-node/identity.json')"
CERT_SHA="$(in_install 'openssl x509 -in /var/lib/edgeweir-node/node.crt -outform DER | sha256sum | cut -d" " -f1')"
INSTALLED_NODE="$(api GET "/nodes?clusterId=$INSTALL_CLUSTER" | jq -c '.[] | select(.name == "edge-install-1")')"
echo "console: $(jq -c '{id, name, clusterName, status, online, enrolledAt, certFingerprint}' <<<"$INSTALLED_NODE")"
[[ "$(jq -r .id <<<"$INSTALLED_NODE")" == "$(jq -r .node_id <<<"$IDENTITY")" &&
  "$(jq -r .cluster_id <<<"$IDENTITY")" == "$INSTALL_CLUSTER" &&
  "$(jq -r .ca_sha256 <<<"$IDENTITY")" == "$INSTALL_CA" &&
  "$(jq -r .certFingerprint <<<"$INSTALLED_NODE")" == "$CERT_SHA" &&
  "$(jq -r .status <<<"$INSTALLED_NODE")" == "active" &&
  "$(jq -r .enrolledAt <<<"$INSTALLED_NODE")" != null ]] ||
  fail "the console does not show the installed node with the identity on disk: $INSTALLED_NODE / $IDENTITY"
pass "install.sh: .deb $NODE_VERSION + edgeweir-openresty and its ModSecurity module installed, edgeweir system user, files and modes as packaged, enrolled as $(jq -r .id <<<"$INSTALLED_NODE") (certificate $CERT_SHA matches the console)"

step "G3: contents of the installed edgeweir-openresty packages and their nginx"
PACKAGES="$(in_install 'dpkg-query -W -f "\${Package} \${Version} \${Architecture} | \${Depends} | \${Recommends}\n" edgeweir-node edgeweir-openresty edgeweir-openresty-modsecurity')"
echo "$PACKAGES"
grep -qE "^edgeweir-node .* \| .*edgeweir-openresty \(>= [0-9.]+-[0-9]+\).* \| .*edgeweir-openresty-modsecurity" <<<"$PACKAGES" &&
  grep -qE "^edgeweir-openresty $OPENRESTY_PKG $DOCKER_ARCH \| libc6 \(>= 2\.34\)" <<<"$PACKAGES" &&
  grep -qE "^edgeweir-openresty-modsecurity $OPENRESTY_PKG $DOCKER_ARCH \| edgeweir-openresty \(= $OPENRESTY_PKG\)" <<<"$PACKAGES" ||
  fail "unexpected package versions or dependencies"
# The packages as shipped (dpkg -c): the slim image drops /usr/share/doc on install.
OPENRESTY_DEB="edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.deb"
MODSECURITY_DEB="edgeweir-openresty-modsecurity_${OPENRESTY_PKG}_$DOCKER_ARCH.deb"
in_install 'mkdir -p /tmp/g3-debs && cd /tmp/g3-debs && for f in "$@"; do curl -fsSO "http://console:3000/downloads/edgeweir-node/v$0/$f"; done' \
  "$NODE_VERSION" "$OPENRESTY_DEB" "$MODSECURITY_DEB" || fail "could not download the edgeweir-openresty packages from the mirror"
deb_list() { in_install 'dpkg -c "/tmp/g3-debs/$0" | awk "{ print \$6 }" | sed "s|^\./|/|"' "$1"; }
deb_file() { in_install 'dpkg-deb --fsys-tarfile "/tmp/g3-debs/$0" | tar -xO ".$1"' "$1" "$2"; }
OPENRESTY_LIST="$(deb_list "$OPENRESTY_DEB")"
MODSECURITY_LIST="$(deb_list "$MODSECURITY_DEB")"
listed() { # listed LIST PACKAGE PATH...
  local list="$1" package="$2" path
  shift 2
  for path in "$@"; do grep -qxF "$path" <<<"$list" || fail "$package does not contain $path"; done
}
listed "$OPENRESTY_LIST" edgeweir-openresty /usr/lib/edgeweir-openresty/nginx/sbin/nginx /usr/lib/edgeweir-openresty/bin/openresty \
  /usr/lib/edgeweir-openresty/bin/resty /usr/lib/edgeweir-openresty/luajit/bin/luajit /usr/lib/edgeweir-openresty/luajit/lib/libluajit-5.1.so.2 \
  /usr/lib/edgeweir-openresty/lualib/resty/core.lua /usr/lib/edgeweir-openresty/lualib/ngx/ssl.lua /usr/lib/edgeweir-openresty/lualib/cjson.so \
  /usr/share/doc/edgeweir-openresty/NOTICE /usr/share/doc/edgeweir-openresty/edgeweir-openresty.cdx.json /usr/share/doc/edgeweir-openresty/nginx-V.txt
listed "$MODSECURITY_LIST" edgeweir-openresty-modsecurity /usr/lib/edgeweir-openresty/modules/ngx_http_modsecurity_module.so \
  /usr/lib/edgeweir-openresty/lib/libmodsecurity.so.3 /usr/share/doc/edgeweir-openresty-modsecurity/NOTICE \
  /usr/share/edgeweir-openresty/crs/crs-setup.conf /usr/share/edgeweir-openresty/crs/LICENSE \
  /usr/share/edgeweir-openresty/crs/rules/REQUEST-941-APPLICATION-ATTACK-XSS.conf \
  /usr/share/edgeweir-openresty/crs/rules/REQUEST-949-BLOCKING-EVALUATION.conf /usr/share/edgeweir-openresty/modsecurity/unicode.mapping
if grep -q '^/usr/lib/edgeweir-openresty/modules/.' <<<"$OPENRESTY_LIST" || grep -q '^/usr/share/edgeweir-openresty/' <<<"$OPENRESTY_LIST"; then
  fail "edgeweir-openresty itself must not carry the ModSecurity module or the CRS"
fi
# Installed as listed (everything outside /usr/share/doc).
INSTALLED_LIST="$(in_install 'dpkg -L edgeweir-openresty edgeweir-openresty-modsecurity')"
MISSING="$(grep -v '^/usr/share/doc/' <<<"$OPENRESTY_LIST"$'\n'"$MODSECURITY_LIST" | sed 's|/$||' | grep -v '^$' |
  grep -vxF -f <(grep -v '^$' <<<"$INSTALLED_LIST") || true)"
[[ -z "$MISSING" ]] || fail "not installed: $MISSING"
CRS_RULES="$(grep -cE '^/usr/share/edgeweir-openresty/crs/rules/.+\.conf$' <<<"$MODSECURITY_LIST")"
((CRS_RULES >= 20)) || fail "only $CRS_RULES CRS rule files in the package"
NOTICE_HEADS="$(deb_file "$OPENRESTY_DEB" /usr/share/doc/edgeweir-openresty/NOTICE | grep -E '^[A-Za-z].* \((BSD|MIT|Apache|Zlib|ISC)[^)]*\): ')"
for component in "OpenResty" "nginx" "LuaJIT" "OpenSSL" "PCRE2" "zlib" "Brotli" "ngx_brotli" "Zstandard" "zstd-nginx-module" \
  "ModSecurity (libmodsecurity)" "ModSecurity-nginx" "YAJL" "libxml2" "OWASP CRS"; do
  grep -qF -- "$component " <<<"$NOTICE_HEADS" || fail "NOTICE lacks $component: $NOTICE_HEADS"
done
CDX="$(deb_file "$OPENRESTY_DEB" /usr/share/doc/edgeweir-openresty/edgeweir-openresty.cdx.json | jq -r '[.bomFormat, ([.components[].name] | unique | join(" "))] | join(" ")')"
for component in openresty nginx ngx_brotli zstd-nginx-module modsecurity modsecurity-nginx coreruleset; do
  [[ " $CDX " == *" $component "* ]] || fail "the CycloneDX SBOM lacks $component: $CDX"
done
NGINX_V="$(in_install '/usr/lib/edgeweir-openresty/nginx/sbin/nginx -V 2>&1')"
echo "$NGINX_V" | head -n 3
for want in "nginx version: openresty/$OPENRESTY_VERSION" "--prefix=/usr/lib/edgeweir-openresty/nginx" "/ngx_brotli" "/zstd-nginx-module-" \
  "--with-http_v3_module" "--with-http_v2_module" "--with-http_slice_module" "--with-compat" "--with-stream_ssl_preread_module"; do
  grep -qF -- "$want" <<<"$NGINX_V" || fail "nginx -V of the installed OpenResty lacks $want"
done
[[ "$NGINX_V" == "$(deb_file "$OPENRESTY_DEB" /usr/share/doc/edgeweir-openresty/nginx-V.txt)" ]] ||
  fail "nginx -V differs from /usr/share/doc/edgeweir-openresty/nginx-V.txt"
# The module loads into the installed nginx and the packaged CRS parses (nginx -t);
# a rule reusing the id of CRS rule 941100 is refused, so the CRS rules were read.
CRS_TEST="$(in_install '
  d="$(mktemp -d)"
  mkdir -p "$d/logs"
  crs() {
    printf "%s\n" "SecRuleEngine On" "Include /usr/share/edgeweir-openresty/crs/crs-setup.conf" \
      "Include /usr/share/edgeweir-openresty/crs/rules/*.conf" "$@" >"$d/crs.conf"
    /usr/lib/edgeweir-openresty/nginx/sbin/nginx -p "$d" -c "$d/nginx.conf" -t 2>&1 || true
  }
  printf "%s\n" "load_module /usr/lib/edgeweir-openresty/modules/ngx_http_modsecurity_module.so;" "error_log stderr notice;" \
    "pid $d/nginx.pid;" "events {}" "http { modsecurity on; modsecurity_rules_file $d/crs.conf; server { listen 127.0.0.1:8999; } }" >"$d/nginx.conf"
  crs
  echo ---
  crs "SecRule ARGS \"@rx edgeweir\" \"id:941100,phase:2,pass,nolog\""')"
echo "$CRS_TEST"
[[ "${CRS_TEST%%---*}" == *"test is successful"* && "${CRS_TEST#*---}" == *"Rule id: 941100 is duplicated"*"test failed"* ]] ||
  fail "the CRS does not load in the installed OpenResty"
pass "edgeweir-openresty $OPENRESTY_PKG (dpkg -c, all installed outside /usr/share/doc): nginx, LuaJIT, lualib, NOTICE (all 15 components), CycloneDX ($(cut -d' ' -f1 <<<"$CDX")) and nginx -V as built; -modsecurity: the module, libmodsecurity, $CRS_RULES CRS rule files, unicode.mapping; nginx -V shows /usr/lib/edgeweir-openresty, ngx_brotli, zstd-nginx-module and http_v3; the CRS loads in the installed nginx"

step "N-H1: the installed node runs as in its systemd unit (User=, Environment=, ExecStart=) and comes online"
# systemd is not available in the container: start ExecStart= as User= with the
# unit's Environment= and the RuntimeDirectory= systemd would create.
docker exec -d "$INSTALL_CONTAINER" bash -ec '
  unit=/usr/lib/systemd/system/edgeweir-node.service
  user="$(sed -n "s/^User=//p" "$unit")"
  mapfile -t envs < <(sed -n "s/^Environment=//p" "$unit")
  read -ra cmd < <(sed -n "s/^ExecStart=//p" "$unit")
  install -d -o "$user" -g "$user" -m 0750 /run/edgeweir-node
  exec runuser -u "$user" -- env "${envs[@]}" "${cmd[@]}" >/var/log/edgeweir-node.log 2>&1' ||
  fail "could not start the installed agent"
installed_online() {
  [[ "$(api GET "/nodes?clusterId=$INSTALL_CLUSTER" | jq -r '.[] | select(.name == "edge-install-1") | "\(.online) \(.agentVersion)"')" == "true $NODE_VERSION" ]]
}
ONLINE_DEADLINE=$((SECONDS + 90))
until installed_online; do
  if ((SECONDS >= ONLINE_DEADLINE)); then
    in_install 'tail -n 40 /var/log/edgeweir-node.log' >&2 || true
    fail "timed out after 90s waiting for the installed node to come online"
  fi
  sleep 1
done
# No ps in the slim image: the owner and command line of every agent / nginx
# process (runuser, root, is only the launcher).
PROCS="$(in_install 'for d in /proc/[0-9]*; do
    c="$(tr "\0" " " <"$d/cmdline" 2>/dev/null || true)"
    case "$c" in /usr/bin/edgeweir-node\ run*|/usr/bin/edgeweir-node\ supervise*|nginx:*) echo "$(stat -c %U "$d") ${c:0:100}" ;; esac
  done')"
echo "$PROCS"
grep -q '^edgeweir /usr/bin/edgeweir-node supervise --manage-nginx' <<<"$PROCS" && grep -q '^edgeweir /usr/bin/edgeweir-node run --manage-nginx' <<<"$PROCS" && grep -q '^edgeweir nginx: master process' <<<"$PROCS" &&
  grep -q '^edgeweir nginx: worker process' <<<"$PROCS" && ! grep -qv '^edgeweir ' <<<"$PROCS" ||
  fail "the agent and OpenResty must run as the edgeweir user: $PROCS"
api GET "/nodes?clusterId=$INSTALL_CLUSTER" | jq -c '.[] | {name, online, agentVersion, engine, engineVersion, os, arch, appliedRevision, applyState}'
INSTALLED_FEATURES="$(api GET "/nodes?clusterId=$INSTALL_CLUSTER" | jq -r '.[] | select(.name == "edge-install-1") | .supportedFeatures | join(" ")')"
for feature in brotli-v1 zstd-v1 modsecurity-v1; do
  [[ " $INSTALLED_FEATURES " == *" $feature "* ]] || fail "the installed node does not report $feature: $INSTALLED_FEATURES"
done
docker rm -f "$INSTALL_CONTAINER" >/dev/null 2>&1 || true
pass "the installed agent ($NODE_VERSION) runs as the edgeweir user, is online over mTLS and reports brotli-v1, zstd-v1 and modsecurity-v1 with the installed packages"

step "M3: ACME issuance, HTTPS, HTTP/2, HTTP/3, renewal and TLS policy"
node scripts/e2e-m3.mjs || fail "M3 protocol test failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    pnpm --filter @edgeweir/console test:e2e e2e/m3.spec.ts || fail "M3 browser test failed"
fi
pass "M3 certificate and protocol checks passed"

step "M4: rules, IP lists, rate limits, transformations and local GeoIP"
node scripts/e2e-m4.mjs || fail "M4 protocol test failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" pnpm --filter @edgeweir/console test:e2e e2e/m4.spec.ts || fail "M4 browser test failed"
fi
pass "M4 policy checks passed"

step "M5: DNS health reconciliation, statistics and notifications"
node scripts/e2e-m5.mjs || fail "M5 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/m5.spec.ts || fail "M5 browser test failed"
fi
pass "M5 DNS, statistics and alert checks passed"

step "M6: sampled logs, scoped API keys, optional ClickHouse and backup recovery"
node scripts/e2e-m6-logs.mjs || fail "M6 logs and AccessKey checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/m6-logs.spec.ts || fail "M6 logs browser test failed"
fi
docker compose -f compose.e2e.yml --profile analytics up -d --wait clickhouse
pnpm --filter @edgeweir/console exec tsx scripts/e2e-clickhouse.ts "http://localhost:${E2E_CLICKHOUSE_PORT:-19123}" || fail "ClickHouse integration failed"
node scripts/e2e-restore.mjs || fail "backup recovery failed"
pass "M6 log, AccessKey, ClickHouse and recovery checks passed"

step "M6: signed node upgrade, canary promotion and automatic rollback"
node scripts/e2e-upgrade-fixtures.mjs || fail "could not prepare signed upgrade fixtures"
docker compose -f compose.e2e.yml --profile upgrades up -d upgrade-files node-upgrade-peer
node scripts/e2e-m6-upgrades.mjs || fail "signed upgrade checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/m6-upgrades.spec.ts || fail "upgrade browser checks failed"
fi
pass "M6 signed upgrades and rollback passed"

step "P0: idempotency, service accounts, usage, configuration canary, DNS protection"
node scripts/e2e-p0.mjs || fail "P0 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/p0.spec.ts || fail "P0 browser checks failed"
fi
pass "P0 checks passed"

step "G1: dynamic bans: delivery latency, site bans at the edge, platform bans in nftables and limits"
node scripts/e2e-g1.mjs || fail "G1 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/g1.spec.ts || fail "G1 browser checks failed"
fi
pass "G1 checks passed"

step "G2: challenges in a browser, passes across nodes, Under Attack, tiered CC and JA4 rules"
node scripts/e2e-g2.mjs || fail "G2 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/g2.spec.ts || fail "G2 browser checks failed"
fi
pass "G2 checks passed"

step "G3: custom OpenResty build, Brotli / Zstandard negotiation, OWASP CRS and capability gating"
node scripts/e2e-g3.mjs || fail "G3 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/g3.spec.ts || fail "G3 browser checks failed"
fi
node scripts/e2e-g3.mjs --cleanup || fail "G3 cleanup failed"
pass "G3 checks passed"

step "G4: purge by Host and Cache-Tag, variant and sitemap prefetch, active health checks, session affinity, error pages"
node scripts/e2e-g4.mjs || fail "G4 end-to-end checks failed"
if ! $SKIP_UI; then
  E2E_BASE_URL="$CONSOLE" pnpm --filter @edgeweir/console test:e2e e2e/g4.spec.ts || fail "G4 browser checks failed"
fi
node scripts/e2e-g4.mjs --cleanup || fail "G4 cleanup failed"
pass "G4 checks passed"

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
