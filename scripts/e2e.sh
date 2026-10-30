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
#   SSH install (ADR-0066): the console scans a systemd + sshd container's
#   host key, refuses a wrong one, names a wrong sudo password and installs
#   the latest signed release from GitHub as a sudo user; nothing secret is
#   left on the host, in the console's logs or in its database.
#   WebSocket entry (scripts/e2e-wss.mjs, profile wss): the node channel URL
#   wss://wss.e2e.test saved in the system settings opens the console's
#   WebSocket entry behind wss-proxy, nginx terminating TLS with a test CA's
#   certificate (the /node-channel location of docs/deploy/networking.md);
#   node-wss trusts that CA, enrolls through the proxy, stays online with
#   heartbeats for more than 30 seconds and applies and serves revisions;
#   the URL in effect before is saved again.
#   Node channel URL (scripts/e2e-channel.mjs, profile channel, ADR-0046):
#   node-channel enrolls with https://channel-old.e2e.test:8443 (a layer-4
#   relay to the console) and follows the URL saved in the system settings:
#   to https://channel.e2e.test:8443 (the core node too) without a restart,
#   staying online once the relay is gone and after a restart; the old name
#   leaves the certificate; an unreachable URL is reported and not taken;
#   https -> wss://wss.e2e.test -> https, then the WebSocket entry closes;
#   `edgeweir-node set-server` brings a lost node back with its identity.
#   Node logs (scripts/e2e-node-logs.mjs, ADR-0050): the core node reports
#   node-logs-v1 and its agent's and supervisor's events; a site whose
#   origin does not resolve: the Lua warning reaches the node's logs within
#   60 s with the query string removed, the secret nowhere in the API or the
#   database; retention (1 day, 1,000 per node) deletes backdated rows and
#   rows over the limit at the console's start; Playwright
#   e2e/node-logs.spec.ts.
#   Node diagnostics (scripts/e2e-diagnostics.mjs, ADR-0053): the core node
#   reports its clock offset (within 2 s, not skewed); `edgeweir-node
#   diagnose` passes every check; `edgeweir-node pprof` writes heap and CPU
#   profiles from the agent's diagnostics socket.
#   Node extensions (scripts/e2e-extensions.mjs, ADR-0071): the node's CLI
#   signs the example hello-header with a fresh key; untrusted keys and
#   changed signatures or bytes are refused; installed, enabled and on for
#   one site the node loads it (header, deny verdict, endpoint, asset); a
#   throwing hook fails open or closed (503); the kill switch; off,
#   uninstalled, and the node deletes the package. Publishes revisions and
#   reloads nginx, and the kill switch is a platform setting: in the chain.
#   Version 1.1 (scripts/e2e-extensions-v11.mjs) with the real Precursor and
#   edge-compute packages when E2E_PRECURSOR_PACKAGE, E2E_EDGE_COMPUTE_PACKAGE
#   and E2E_EDGE_COMPUTE_BUILD name them (edgeweir-cloud, private): console
#   secret and its rotation, a sidecar as its own user with per-site data,
#   the origin socket, fallthrough, fail closed and restarts.
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
#   refused; a greylist entry rate-limits (429 ip-greylisted) or challenges
#   the client, a ban of the address wins; the cluster's kernel connection
#   limits drop a third concurrent connection and new connections over the
#   rate; Playwright e2e/g1.spec.ts.
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
#   Core gaps G5 (scripts/e2e-g5.mjs): both nodes report rules-v2; dynamic
#   redirects (regex_replace, wildcard_replace over full_uri, query edits, an
#   invalid target failing closed) and rewrites; bulk redirects updated
#   without an nginx reload; origin rules (group, Host, port) and a config
#   read timeout; expression cache rules with a browser TTL; compression
#   rules and config gzip=false without cache bypass; Under Attack, WebSocket
#   and log sampling per rule; Playwright e2e/g5.spec.ts.
#   DNS (scripts/e2e-dns.mjs, after G5): two clusters bound to two provider
#   accounts and domains publish cluster-level records; an offline node
#   leaves only its cluster's records and returns; one account down does not
#   stop the other cluster; manual mode writes nothing and exports a BIND
#   zone file; DNS-01 credentials of the Custom HTTP provider (signed
#   webhook) list their zone and test the connection; Playwright
#   e2e/dns.spec.ts.
#   Core gaps G6 (scripts/e2e-g6.mjs, after DNS): two probe containers
#   (profile probes, regions east and north) enroll with one-time tokens and
#   probe every scheduling address x listener port; both nodes send host
#   metrics; all.<domain> answers per resolution line on the test provider;
#   the edge moves to its backup address when most probers lose the primary
#   and back; a rule scoped to region east removes the edge when only
#   probe-a loses it (the backup line group takes over; DNS revision reason
#   scheduling, system audit, alert) and recovers; a node probes with its own
#   certificate; Playwright e2e/g6.spec.ts.
#   Core gaps G7 (scripts/e2e-g7.mjs, test origins l4-origin-a/b): both nodes
#   report l4-v1; TCP and UDP port pools (overlap, outside-pool and UDP PROXY
#   refusals); TCP and UDP echo through both nodes; a long TCP connection keeps
#   echoing across the reload that a new port causes; PROXY protocol v1/v2 to
#   the origin and an accepting listener; an origin change without a reload;
#   an IP block list and a connection limit; statistics and the app's CNAME;
#   Playwright e2e/g7.spec.ts.
#   HTTP/2 and gRPC (scripts/e2e-h2.mjs, test origin h2-origin, after G7):
#   both nodes report origin-http2-v1; gRPC without HTTP/2 is refused; a
#   site with HTTP/2 and gRPC reaches an h2c-only origin through both nodes
#   (the origin sees HTTP/2 and the client's Host); gRPC over h2c through
#   both nodes: unary, bidirectional streaming and error trailers; an update
#   without the protocol keeps it; back on HTTP/1.1 the nodes no longer reach
#   the h2c-only origin; Playwright e2e/h2.spec.ts.
#   PROXY protocol to origins and gRPC health checks (scripts/e2e-pp.mjs,
#   test origin h2-origin, after HTTP/2): both nodes report
#   origin-proxy-protocol-v1 and active-health-grpc-v1; PROXY protocol v2
#   and v1 through both nodes carry the client and the node, one origin
#   connection per client connection; without it the origin refuses (502);
#   HTTP/2 and gRPC to an origin that reads PROXY protocol first; a
#   grpc.health.v1 check through PROXY protocol marks the origin down on
#   NOT_SERVING (grpc_not_serving) and back on SERVING; Playwright
#   e2e/pp.spec.ts.
#   Site parity G8 (scripts/e2e-g8.mjs, after HTTP/2): both nodes report
#   rules-v3; the origin sees X-Client-Country = ip.geoip.country and X-Req =
#   http.request.id, a header whose computed value is invalid is skipped (and
#   logged by IDs), two Link lines added with append, the cache status as a
#   response header, a User-Agent wildcard; a Cookie block whose page fills
#   {{time}} and {{path}}; a redirect to http.request.uri.args["next"] (an
#   invalid one fails closed) and a 303 with a computed query parameter; a
#   node from before G8 (edgeweir-node:pre-g8) keeps its last-known-good
#   revision while a change needs rules-v3 and catches up once it is undone;
#   Site parity G9 (scripts/e2e-g9.mjs, after G8): extra listener ports 8081
#   and 9443, sites bound to ports (404 elsewhere, the handshake refused on
#   an HTTPS port the site does not use), a 308 to :9443 with an excluded
#   domain, a layer-4 port range and TLS termination (openssl s_client), a
#   reload with an open layer-4 connection, a PROXY protocol v2 balancer
#   (g9-lb) in front of cluster g9-proxy (ip.src, a ban and X-Real-IP are
#   the client) and the trusted header mode; Playwright e2e/g9.spec.ts;
#   leaves hdr-bench.g8.test for BENCH_SCENARIO=headers in scripts/bench.sh;
#   Playwright e2e/g8.spec.ts.
#   Site parity G15 (scripts/e2e-g15.mjs, after G8): both nodes report
#   site-content-v1 and cache-zone-v1; the cluster's cache zone size reaches
#   nginx.conf (keys_zone derived), a node's own size overrides it there only,
#   both nodes report their usage; Set-Cookie of a cached response only with
#   the fetched response; utm_* left out of the cache key; charset GBK on text
#   only; body limit 413 by Content-Length, lifted by a config rule, chunked
#   uploads unchecked; gzip level 9 and the largest compressed length; PURGE
#   with the key (202, a purge_method task both nodes run), a wrong key 403,
#   429 over the rate; 4xx/5xx class pages, a 404 redirect with placeholders,
#   a 405 page, a status replaced by 200; X-Cache off per site; maintenance
#   (503, Retry-After, allowed address and path, ACME passes, audited, never
#   cached); origin tries and status retries; an S3 origin with the MinIO
#   preset; leaves charset-bench.g15.test for BENCH_SCENARIO=charset in
#   scripts/bench.sh; Playwright e2e/g15.spec.ts.
#   Site parity G10 (scripts/e2e-g10.mjs, after G15): both nodes report
#   domains-v2 and unknown-host-v1; `.a.test` any-depth subdomains (not the
#   apex), the exact name and a one-label wildcard winning over the suffix, a
#   pattern domain matching the whole host, an internationalized domain stored
#   and requested as Punycode; unknown hosts closed (curl: empty reply, 444);
#   unknown hosts, node IP access and HTTPS without SNI handed to the default
#   site, unknown SNI with its certificate; scan protection banning on request
#   N+1 at platform scope, listed and lifted; a new site's 8-character CNAME
#   prefix, the old name kept in the DNS zone after regenerating, a custom
#   prefix and conflicts; Playwright e2e/g10.spec.ts.
#   Site parity G11 (scripts/e2e-g11.mjs, after G10): both nodes report
#   multi-certificate-v1 and client-cert-v1; union coverage of a site's
#   certificates, SNI picking exact over wildcard names and an RSA-only
#   client the RSA certificate (openssl s_client); client certificates
#   required (403 client-cert-required, X-Client-* to the origin, the
#   visitor's own stripped) and optional with tls.client.* rules; TLS 1.2
#   session IDs and tickets and TLS 1.3 tickets reused, tickets on the other
#   node too, never with another site's SNI; no early data; Pebble from the
#   system settings issuing an RSA 2048 certificate, its ACME account
#   listed; Playwright e2e/g11.spec.ts.
#   Site parity G12 (scripts/e2e-g12.mjs, after G11): both nodes report
#   access-auth-v1; Basic (401 with the challenge, 200 with credentials,
#   cache hits still checked, password changes); signed URLs A-D signed by
#   the console (valid, expired, wrong, the signature removed before the
#   cache, two signatures one cached object); forward authentication with
#   the g12-auth service (allow, 401 passed on, login redirect, copied
#   headers, cached answers, 503 when unavailable or slow, allowed when the
#   rule says so); failures counted; Playwright e2e/g12.spec.ts.
#   Site parity G13 (scripts/e2e-g13.mjs, after G12): both nodes report
#   access-control-v1; site block and allow lists (the allow list skipping
#   geo); geo denial with the test MMDB (country, subdivision, allow only);
#   hotlink (denied, allowed, own domain, empty, unparseable, cached
#   objects, the 302 placeholder); user agents (allow first); CORS
#   preflights answered at the edge (204, echoed Origin with credentials,
#   Vary: Origin; 403 for other origins) and headers on cache hits;
#   WebSocket origins; security headers on cache hits without Server and
#   X-Powered-By; the IP check; encoded path exemptions (an exempt %2F path
#   out of a user agent scope, cached apart from /, ..%2F and paths outside
#   the prefix still in it); Playwright e2e/g13.spec.ts.
#   Site parity G14 (scripts/e2e-g14.mjs, after G13): both nodes report
#   waf-v2, rules-body-v1 and challenge-v2; the ban action (403 ip-banned,
#   shared, source rule in the ban list, lifted); custom responses, error
#   page responses, closed connections and access log lines from log rules;
#   CRS skipped, turned off or set to detect by rules and excluded by path
#   and by target (normalized paths); JSON, form and multipart fields and
#   truncated bodies; rate limit bans; verified crawlers on node-g14 with the
#   g14-dns test resolver (profile g14); challenge page texts; challenge
#   failure bans; Playwright e2e/g14.spec.ts.
#   Site parity G16 (scripts/e2e-g16.mjs, after G14): both nodes report
#   access-logs-v2, stats-dims-v1 and origin-stats-v1; access log lines carry User-Agent,
#   Referer, HTTP version, scheme, country and network, the query string and
#   a chosen header, request bytes, content type and the origin; blocked and
#   rate limited requests of a site that samples nothing are logged with
#   their reason and rule; every new filter; log retention moves the
#   PostgreSQL partitions; edgeweir-node accesslog prints live requests;
#   statistics dimensions and each origin's fetches (origin-stats-v1)
#   appear; Playwright e2e/g16.spec.ts.
#   Site parity G17 (scripts/e2e-g17.mjs, after G16): sites tagged in one
#   batch and filtered by tag (any, all); the preview of copying rules, cache
#   rules and the cache key to two sites and one without the origin group the
#   rules choose; the copy (the third fails with ORIGIN_GROUP_UNKNOWN and
#   keeps its settings, the others are audited); both nodes serving the
#   copied rules (block, origin group, response header) and cache settings
#   (cached, the query left out of the key); a clone serving the same; two
#   sites turned off in one revision (503 site-disabled) and on again;
#   Playwright e2e/g17.spec.ts.
#   Site parity G18 (scripts/e2e-g18.mjs, after G17): both nodes report
#   image-convert-v1; Accept image/webp and image/avif get the variant (MISS,
#   then the same variant HIT), */*, navigations and no Accept the JPEG,
#   all with Vary: Accept, the origin answering once per class and node; a
#   path without an extension and a PNG converted, a picture over the pixel
#   limit served and cached as JPEG; AVIF off serves the WebP variant; the
#   saved bytes reach imageConvert.savings; off again, the cached JPEG;
#   Playwright e2e/g18.spec.ts.
#   AI crawl control (scripts/e2e-ai-crawl.mjs, ADR-0070, after core): the
#   core node reports ai-crawlers-v1; a spoofed GPTBot is only tagged, then
#   blocked (403 ai-crawler-blocked) while robots.txt stays readable with the
#   managed text before the origin's file; ClaudeBot gets 402 crawler-price
#   and 400 StrongAuthRequired with a price; a spoofed PerplexityBot is blocked
#   as an impersonator (402 with the site's text); the overview and the
#   access log filter count the claims; Playwright e2e/ai-crawl.spec.ts.
#   Login IP allow list (scripts/e2e-allowlist.mjs, ADR-0047): the console
#   sees the host through the port mapping (a private address, the proxy
#   hint); a list without it is refused; client-a saves only its own address
#   with an AccessKey; the host's sign-in (right or wrong password) and its
#   session cookie on /rpc and get-session get LOGIN_IP_NOT_ALLOWED while the
#   AccessKey, sign-out and the demo account still work and the refusals are
#   logged; client-a signs in; `recover.js --clear-login-allowlist` lets the
#   host sign in again and signs the old session out; Playwright
#   e2e/allowlist.spec.ts (the card, the sign-in page's reason).
#   Tiered cache (scripts/e2e-tiers.mjs, ADR-0073): three nodes in cluster
#   tiers across regions tier-east and tier-west; the smart topology picks the
#   upper tier by the measured round trip time and a fallback in the other
#   region; one origin fetch for a URL requested through all three nodes; the
#   tier listener refuses a client without a node certificate; a URL purge
#   reaches every tier; stopped upper tiers fall back to the next one and then
#   to the origin; latency injected with nftables moves the upper tier;
#   --skip-ui only (no browser spec).
#   Usage protection (scripts/e2e-usage-guard.mjs, after M6): four sites of
#   the upgrade cluster with daily guards and tiny limits; warning and limit
#   alerts at a webhook; maintenance on at both nodes after the request that
#   crosses the limit (audited by the system, revision reason
#   usage_limit_reached), a site disabled and enabled again by a higher
#   limit, a bandwidth alert without an action; a manual restore that the
#   next evaluation leaves alone; Playwright e2e/usage-guard.spec.ts.
#   Origin protection G19 (scripts/e2e-g19.mjs, after G18): both nodes report
#   origin-mtls-v1 and origin-ca-v1; without the authorities sites refuse
#   client certificates and the Origin CA, then both are created and Origin
#   CA certificates issued (a generated key, a CSR); with the cluster's
#   client certificate the nodes reach an origin that requires one over
#   HTTP/1.1, HTTP/2 and gRPC, without it the origin refuses them even after
#   the keep-alive pool held a connection with it, the active checks agree;
#   trusting the Origin CA alone the nodes reach its certificates and refuse
#   the test CA's, on the system store they refuse the Origin CA's, a system
#   store site is unaffected; a revoked certificate fails on both nodes and
#   in the active checks; rotating the Origin CA, nodes and active checks
#   accept either CA's certificates until the first one is retired; rotating
#   the origin client CA, nodes switch certificates only when it is
#   activated; Playwright e2e/g19.spec.ts.
#   Development mode (section dev-mode, after core): dev-mode.test behind
#   whoami, cached for an hour: MISS then HIT; on, every request BYPASSes to
#   the origin (whoami echoes the request's own id); off early, the kept
#   object HITs again and a path requested while on MISSes (nothing was
#   stored); on again with the console paused, the node bypasses until the
#   deadline (EDGEWEIR_E2E_DEVELOPMENT_MODE_SECONDS, 60 s here) and HITs with
#   the kept body after it without a new configuration; unpaused, the
#   console publishes development_mode_expired and audits the expiry as the
#   system; Playwright e2e/dev-mode.spec.ts (card, time left, badge).
#   Challenge providers G20 (scripts/e2e-g20.mjs, after G19, mock
#   g20-captcha in profile g20): both nodes report challenge-v3; headless
#   Chromium without automation signals passes the managed challenge of an
#   Under Attack site without interaction (s=0, a level-3 pass), which also
#   satisfies managed_challenge and js_challenge rules; automation
#   User-Agents (curl/, python-requests) or none, the signal s=1 at verify
#   and a fifth managed page without a pass get the built-in image captcha;
#   a site's own Turnstile provider (fake secret) is verified by the agent at
#   the mock (EDGEWEIR_CHALLENGE_VERIFY_ENDPOINTS): a failed answer of the
#   /24 makes a browser interactive, bad and another host name fail, good
#   passes at level 4 (the mock sees the secret, the token and the client),
#   alt=builtin asks nobody; the mock answering 500 and a refused secret
#   (invalid-input-secret) serve the built-in captcha and mark the provider
#   down for 60 s; outcomes per kind reach the statistics; no UI spec.
#
# Usage:
#   docker compose -f compose.e2e.yml up -d --build
#   bash scripts/e2e.sh [--up] [--down] [--skip-ui] [--only SECTION,... | --from SECTION] [--serial] [--list] [--plan]
# The run is a chain of sections (--list prints them with what each needs).
# A few sections run in a parallel lane beside a stretch of the chain (LANES;
# --serial runs everything in turn); a lane's output follows when it ends.
# --only runs the named sections, --from a section and all after it. On a
# fresh stack the core section and the sections they need run first; on a
# stack where an earlier run got past the core section, the run continues
# there (.e2e/run.env, .e2e/run.done) and runs a needed section again only
# when it has not passed on that stack. A section that passed is not
# guaranteed to pass a second time on the same stack. --plan prints the
# sections a run would take on the stack and stops. The time of every
# section and part (checks, ui, cleanup, ...) is printed at the end and kept
# in .e2e/timings.tsv; output lines of the scripts and Playwright carry the
# seconds since their part started.
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
# A fresh systemd + sshd host the console installs a node on over SSH (section ssh-install).
SSH_CONTAINER="${COMPOSE_PROJECT_NAME:-edgeweir-e2e}-sshd"
UP=false
DOWN=false
SKIP_UI=false
ONLY=""
FROM=""
LIST=false
PLAN_ONLY=false
SERIAL=false
while (($#)); do
  case "$1" in
    --up) UP=true ;;
    --down) DOWN=true ;;
    --skip-ui) SKIP_UI=true ;;
    --only) ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --from) FROM="${2:-}"; shift ;;
    --from=*) FROM="${1#*=}" ;;
    --list) LIST=true ;;
    --plan) PLAN_ONLY=true ;;
    --serial) SERIAL=true ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Sections in run order, each with the sections whose state it reads
# (.e2e/*-state.json, or clusters and nodes they create). Every section needs
# core, which only runs on a fresh stack.
SECTIONS=(
  "core:" "m1:" "analytics:" "m2:" "install:" "ssh-install:" "wss:" "channel:" "node-logs:" "diagnostics:" "extensions:" "m3:" "m4:" "m5:" "m6-logs:m5" "m6-upgrades:m5"
  "p0:m5 m6-upgrades" "g1:p0 m5 m6-upgrades" "g2:m3 m6-upgrades" "g3:m6-upgrades" "g4:m6-upgrades"
  "g5:m6-upgrades" "dns:m5 m6-upgrades" "g6:dns m5 m6-upgrades" "g7:m6-upgrades" "h2:m6-upgrades"
  "pp:m6-upgrades"
  "g8:m6-upgrades" "g9:m6-upgrades" "g15:m6-upgrades" "g10:dns m5 m6-upgrades" "g11:m6-upgrades"
  "g12:m6-upgrades" "g13:m6-upgrades" "g14:m6-upgrades" "g16:m6-upgrades" "g17:m6-upgrades"
  "g18:m6-upgrades" "g19:m6-upgrades" "g20:m6-upgrades" "probe-sources:" "usage-guard:m6-upgrades" "dev-mode:" "ai-crawl:" "tiers:" "allowlist:" "lifecycle:"
)
# Parallel lanes, "FIRST..LAST:SECTION ...": the SECTIONs run in a second
# lane while the chain runs FIRST to LAST, and the chain waits for the lane
# before the section after LAST. A lane holds sections that share no state
# with that stretch (checked section by section, 2026-10-23): their own sites,
# clusters and audit targets, no bans or IP lists, no node restarts, no
# platform settings, and waits that tolerate other revisions ("at least").
# Kept in the chain, with the reason:
#   core, m1, m2, m5, g17, g19 and the restore step of m6-logs assert exact
#     revision numbers or that no revision was published;
#   m3, m4, g5 and g7 assert that nginx did not reload, which any change of
#     nginx.conf elsewhere breaks (h2's gRPC site, g9's ports, g15's cache zone);
#   node-logs restarts the console and stops the core node, dev-mode pauses
#     the console, m5, p0 and dns
#     stop nodes, lifecycle deletes the core node, m6-upgrades upgrades both
#     nodes, g6 blocks the edge node's ports, channel and wss move every node
#     to other channel URLs;
#   m4 blocks every site (0.0.0.0/0), g1 and g2 clear every ban and count
#     them, g10's scan protection and g13's IP check need client-b alone,
#     allowlist locks the host out of the console;
#   g2 turns on platform Under Attack, g3 adds old nodes to the default
#     cluster, g4 resets platform error pages, g16 changes log retention and
#     uses client-b (g10), g18 counts origin requests that g15's cache zone
#     reload repeats;
#   g20 fails challenges from the host's /24 (that of client-a and client-b),
#     counts managed pages of that network and leaves its provider marked
#     down on the core node for 60 s.
# install only adds its own cluster and fills the download mirror nobody
# else reads at that time, ssh-install adds its own cluster and host; h2, g8 (own cluster), g12 and usage-guard keep to
# their own sites. Each lane runs Playwright with its own session (E2E_LANE).
LANES=(
  "m3..m4:install ssh-install"
  "g9..g14:h2 g8 g12 usage-guard"
)
section_names() { local s; for s in "${SECTIONS[@]}"; do printf '%s\n' "${s%%:*}"; done; }
section_deps() { local s; for s in "${SECTIONS[@]}"; do [[ "${s%%:*}" != "$1" ]] || { printf '%s\n' "${s#*:}"; return; }; done; }
if $LIST; then
  for s in "${SECTIONS[@]}"; do printf '%-12s %s\n' "${s%%:*}" "${s#*:}"; done
  exit 0
fi
[[ -z "$ONLY" || -z "$FROM" ]] || { echo "--only and --from cannot be combined" >&2; exit 2; }
for s in ${ONLY//,/ } $FROM; do
  section_names | grep -qx -- "$s" || { echo "unknown section: $s (bash scripts/e2e.sh --list)" >&2; exit 2; }
done

RUN_STARTED=$SECONDS
TIMINGS=() # "SECONDS<TAB>SECTION<TAB>PART"
CURRENT_SECTION=""
SECTION_STARTED=0
LANE_PID="" # the parallel lane running now (start_lane)
clock() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }
step() { printf '\n\033[1;34m==> %s\033[0m \033[2m(%s, +%s)\033[0m\n' "$*" "$(date +%H:%M:%S)" "$(clock $((SECONDS - RUN_STARTED)))"; }
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
TIMINGS_FILE="$STATE_DIR/timings.tsv"
RUN_ENV="$STATE_DIR/run.env"   # the stack's run: API key, cluster and site from the core section
RUN_DONE="$STATE_DIR/run.done" # the sections that passed on that stack

if $UP; then
  step "docker compose -f compose.e2e.yml up -d --build"
  "${COMPOSE[@]}" up -d --build
fi
cleanup() {
  if [[ -n "$LANE_PID" ]]; then
    echo "waiting for the parallel lane ($LANE_SECTIONS) to end" >&2
    finish_lane --no-fail
  fi
  docker rm -f "$INSTALL_CONTAINER" >/dev/null 2>&1 || true
  # Containers scripts/e2e-g3.mjs and e2e-g8.mjs start next to the stack (old nodes, curl).
  docker ps -aq --filter "label=dev.edgeweir.e2e-g3=${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" | xargs docker rm -f >/dev/null 2>&1 || true
  docker ps -aq --filter "label=dev.edgeweir.e2e-g8=${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" | xargs docker rm -f >/dev/null 2>&1 || true
  # ... and the PROXY protocol cluster's node of e2e-g9.mjs.
  docker ps -aq --filter "label=dev.edgeweir.e2e-g9=${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" | xargs docker rm -f >/dev/null 2>&1 || true
  # ... and the three nodes of e2e-tiers.mjs.
  docker ps -aq --filter "label=dev.edgeweir.e2e-tiers=${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" | xargs docker rm -f >/dev/null 2>&1 || true
  report_timings
  # Every profile: the upgrade peer and ClickHouse keep their state otherwise.
  if $DOWN; then "${COMPOSE[@]}" --profile '*' down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# part LABEL COMMAND...: runs COMMAND with every output line prefixed by the
# seconds since the part started, and records the part's time.
part() {
  local label="$1" started=$SECONDS status=0
  shift
  "$@" 2>&1 | stamp "$started" || status=$?
  TIMINGS+=("$((SECONDS - started))"$'\t'"$CURRENT_SECTION"$'\t'"$label")
  return "$status"
}
stamp() { # stamp STARTED: prefixes stdin lines with +SECONDS since STARTED
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do printf '\033[2m%6s\033[0m %s\n' "+$((SECONDS - $1))s" "$line"; done
}
# story NAME [--cleanup]: scripts/e2e-NAME.mjs, e2e/NAME.spec.ts unless
# --skip-ui and, with --cleanup, the script's own cleanup, each a timed part.
story() {
  local name="$1"
  part checks node "scripts/e2e-$name.mjs" || fail "$name end-to-end checks failed"
  if ! $SKIP_UI; then
    part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      pnpm --filter @edgeweir/console run test:e2e "e2e/$name.spec.ts" || fail "$name browser checks failed"
  fi
  if [[ "${2:-}" == --cleanup ]]; then
    part cleanup node "scripts/e2e-$name.mjs" --cleanup || fail "$name cleanup failed"
  fi
}
# The time of every section (slowest first) and of its parts, also in $TIMINGS_FILE.
report_timings() {
  if [[ -n "$CURRENT_SECTION" ]]; then
    TIMINGS+=("$((SECONDS - SECTION_STARTED))"$'\t'"$CURRENT_SECTION"$'\t'"unfinished")
    CURRENT_SECTION=""
  fi
  ((${#TIMINGS[@]})) || return 0
  printf '%s\n' "${TIMINGS[@]}" >"$TIMINGS_FILE"
  printf '\n\033[1;34m==> timings, slowest first (%s)\033[0m\n' "$TIMINGS_FILE"
  awk -F'\t' '
    function clock(s) { return sprintf("%d:%02d", s / 60, s % 60) }
    $3 == "total" || $3 == "unfinished" { total[$2] = $1; if ($3 == "unfinished") note[$2] = "  (unfinished)"; next }
    { if (!(($2, $3) in sum)) labels[$2] = labels[$2] " " $3; sum[$2, $3] += $1 }
    END {
      for (s in total) {
        n = split(labels[s], l, " "); parts = ""
        for (i = 1; i <= n; i++) parts = parts sprintf("  %s %s", l[i], clock(sum[s, l[i]]))
        printf "%d\t%7s  %-12s%s%s\n", total[s], clock(total[s]), s, parts, note[s]
      }
    }
  ' "$TIMINGS_FILE" | sort -t$'\t' -k1,1nr | cut -f2-
  printf '%7s  run\n' "$(clock $((SECONDS - RUN_STARTED)))"
  TIMINGS=()
}
# run_section NAME: section_NAME as one timed section, recorded in $RUN_DONE once it passed.
run_section() {
  CURRENT_SECTION="$1"
  SECTION_STARTED=$SECONDS
  "section_${1//-/_}"
  TIMINGS+=("$((SECONDS - SECTION_STARTED))"$'\t'"$1"$'\t'"total")
  CURRENT_SECTION=""
  echo "$1" >>"$RUN_DONE"
}

# start_lane NAME SECTION...: the SECTIONs in turn in the background, their
# output in $STATE_DIR/lane-NAME.log and their timings in lane-NAME.tsv;
# finish_lane waits for it, prints its output and fails when it failed
# (with --no-fail, as the run ends anyway).
start_lane() {
  LANE_NAME="$1"
  shift
  LANE_SECTIONS="$*"
  LANE_STARTED=$SECONDS
  LANE_LOG="$STATE_DIR/lane-$LANE_NAME.log"
  LANE_TIMINGS="$STATE_DIR/lane-$LANE_NAME.tsv"
  step "parallel lane: $LANE_SECTIONS (output in $LANE_LOG until it ends)"
  rm -f "$LANE_TIMINGS"
  (
    export E2E_LANE="$LANE_NAME"
    TIMINGS=()
    lane_exit() {
      if [[ -n "$CURRENT_SECTION" ]]; then
        TIMINGS+=("$((SECONDS - SECTION_STARTED))"$'\t'"$CURRENT_SECTION"$'\t'"unfinished")
      fi
      ((${#TIMINGS[@]} == 0)) || printf '%s\n' "${TIMINGS[@]}" >"$LANE_TIMINGS"
    }
    trap lane_exit EXIT
    for s in $LANE_SECTIONS; do run_section "$s"; done
  ) >"$LANE_LOG" 2>&1 &
  LANE_PID=$!
}
finish_lane() {
  [[ -n "$LANE_PID" ]] || return 0
  local status=0 line
  wait "$LANE_PID" || status=$?
  LANE_PID=""
  step "parallel lane: $LANE_SECTIONS ended after $(clock $((SECONDS - LANE_STARTED))) (exit $status); its output:"
  cat "$LANE_LOG"
  if [[ -f "$LANE_TIMINGS" ]]; then
    while IFS= read -r line; do TIMINGS+=("$line"); done <"$LANE_TIMINGS"
  fi
  TIMINGS+=("$((SECONDS - LANE_STARTED))"$'\t'"lane:${LANE_SECTIONS// /,}"$'\t'"total")
  ((status == 0)) || [[ "${1:-}" == --no-fail ]] || fail "parallel lane failed: $LANE_SECTIONS (output above)"
}

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

node_json() { api GET "/nodes?clusterId=$CLUSTER_ID" | jq -c '.[] | select(.name == "edge-e2e-1")'; }

# ---------------------------------------------------------------- section core
section_core() {
step "first-run setup needs the one-time setup token from the console log"
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
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
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

step "certificate authority: Pebble as the custom ACME directory of the system settings"
# No EDGEWEIR_ACME_DIRECTORY / EDGEWEIR_ACME_CA_FILE in compose.e2e.yml: the console reads the
# directory with the CA certificate of Pebble's listener before saving it.
ACME_SETTING="$(api PUT /settings/acme-directory "$(jq -nc --rawfile ca docker/e2e/pebble/test-only.crt \
  '{url:"https://pebble:14000/dir", caPem:$ca}')")"
[[ "$(jq -r '.source + " " + .caSource' <<<"$ACME_SETTING")" == "setting setting" ]] \
  || fail "Pebble directory not saved: $ACME_SETTING"
pass "Pebble directory saved in the system settings ($(jq -r .effectiveUrl <<<"$ACME_SETTING"))"

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
SITE_ID="$(jq -r .site.id <<<"$SITE")"
REVISION="$(jq -r .revision.revision <<<"$SITE")"
CONTENT_HASH="$(jq -r .revision.contentHash <<<"$SITE")"
pass "site $SITE_ID created, published revision #$REVISION (${CONTENT_HASH:0:16}…)"

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
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_EXPECT_REVISION="$REVISION" pnpm --filter @edgeweir/console run test:e2e e2e/smoke.spec.ts \
    || fail "Playwright smoke test failed"
  pass "Playwright smoke passed"
fi

# For --from / --only on this stack later on.
printf 'RUN_PROJECT=%q\nRUN_CONSOLE=%q\nAPI_KEY=%q\nCLUSTER_ID=%q\nSITE_ID=%q\n' \
  "${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" "$CONSOLE" "$API_KEY" "$CLUSTER_ID" "$SITE_ID" >"$RUN_ENV"

step "P0 usage traffic now: its 5-minute window is complete when the p0 section checks it"
part usage-traffic env E2E_API_KEY="$API_KEY" E2E_SITE_ID="$SITE_ID" node scripts/e2e-p0.mjs --usage-traffic ||
  fail "P0 usage traffic failed"
}

# ------------------------------------------------------------------ section m1
section_m1() {
if ! $SKIP_UI; then
  step "Playwright M1: site editing, clusters, node groups, audit, English"
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
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
}

# ----------------------------------------------------------- section analytics
section_analytics() {
step "analytics: the node's per-minute stats reach the console"
site_traffic() { api GET "/analytics/traffic?range=1h&siteId=$SITE_ID"; }
# The agent uploads completed minutes once a minute.
stats_arrived() { [[ "$(site_traffic | jq -r '.totals.requests >= 3 and .totals.cacheHits >= 1 and .totals.status2xx >= 3')" == "true" ]]; }
wait_for 180 "demo.test requests, cache hits and 2xx responses in the 1h analytics" stats_arrived
pass "demo.test in the last hour: $(site_traffic | jq -c '.totals | {requests, cacheHits, cacheMisses, status2xx, status4xx, bytesSent}')"
[[ "$(api GET "/analytics/top-nodes?range=1h" | jq -r '.[0].name')" == "edge-e2e-1" ]] || fail "top nodes should list edge-e2e-1"
pass "top nodes: $(api GET "/analytics/top-nodes?range=1h" | jq -c '[.[] | {name, parentName, requests}]')"

if ! $SKIP_UI; then
  step "Playwright analytics: overview lists and charts, stars, site analytics"
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/analytics.spec.ts \
    || fail "Playwright analytics test failed"
  pass "Playwright analytics passed"
fi
}

# ------------------------------------------------------------------ section m2
section_m2() {
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
    "{name: \$n, clusterId: \$c, cacheRules: [{pathPrefixes: [\"/\"], edgeTtlSeconds: 300, originCacheControl: \"override\"}]} + $2")" ||
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
  cacheRules: [{pathPrefixes: ["/"], edgeTtlSeconds: 1, staleIfErrorSeconds: 300, originCacheControl: "override"}]}' >/dev/null
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
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    E2E_NODE_NAME="edge-e2e-1" pnpm --filter @edgeweir/console run test:e2e e2e/m2.spec.ts \
    || fail "Playwright M2 test failed"
  pass "Playwright M2 passed"
fi
}

# ------------------------------------------------------------- section install
section_install() {
step "N-H1: the console's release mirror serves goreleaser snapshot packages, anything else is 404"
need goreleaser
need go
need syft
[[ -f "$NODE_CONTEXT/.goreleaser.yaml" ]] || fail "no edgeweir-node checkout at $NODE_CONTEXT (EDGEWEIR_NODE_CONTEXT)"
(cd "$NODE_CONTEXT" && goreleaser check) >"$STATE_DIR/goreleaser-check.log" 2>&1 ||
  { cat "$STATE_DIR/goreleaser-check.log" >&2; fail "goreleaser check failed in $NODE_CONTEXT"; }
pass "goreleaser check: $(tr -d '\033' <"$STATE_DIR/goreleaser-check.log" | sed -E 's/\[[0-9;]*m//g' | grep -iE 'valid|checked' | tail -n1 | sed -E 's/^[[:space:]•]*//')"
# The snapshot copies the edgeweir-openresty packages of `make
# openresty-packages` (out/openresty) into dist/; when they are missing for
# the architecture of the install container they come from the cache of
# scripts/e2e-cache.mjs (by the git tree of packaging/openresty), or are
# built and cached.
DOCKER_ARCH="$(docker version --format '{{.Server.Arch}}')"
OPENRESTY_VERSION="$(awk '$1 == "openresty" { print $2 }' "$NODE_CONTEXT/packaging/openresty/sources.lock")"
OPENRESTY_RELEASE="$(awk '$1 == "release:" { print $2 }' "$NODE_CONTEXT/packaging/openresty/nfpm/edgeweir-openresty.yaml")"
OPENRESTY_PKG="$OPENRESTY_VERSION-$OPENRESTY_RELEASE"
OPENRESTY_FILES=("edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.deb" "edgeweir-openresty-modsecurity_${OPENRESTY_PKG}_$DOCKER_ARCH.deb"
  "edgeweir-openresty_${OPENRESTY_PKG}_$DOCKER_ARCH.sbom.json")
RPM_ARCH="$([[ "$DOCKER_ARCH" == arm64 ]] && echo aarch64 || echo x86_64)"
OPENRESTY_CACHED=("${OPENRESTY_FILES[@]}" "edgeweir-openresty-$OPENRESTY_PKG.$RPM_ARCH.rpm"
  "edgeweir-openresty-modsecurity-$OPENRESTY_PKG.$RPM_ARCH.rpm")
openresty_packages_built() { for f in "${OPENRESTY_FILES[@]}"; do [[ -f "$NODE_CONTEXT/out/openresty/$f" ]] || return 1; done; }
if ! openresty_packages_built &&
  ! node scripts/e2e-cache.mjs openresty restore "$NODE_CONTEXT" "$DOCKER_ARCH" "${OPENRESTY_CACHED[@]}"; then
  echo "make openresty-packages ARCH=$DOCKER_ARCH (in $NODE_CONTEXT, log in $STATE_DIR/openresty-packages.log)"
  part openresty-packages make -C "$NODE_CONTEXT" openresty-packages ARCH="$DOCKER_ARCH" >"$STATE_DIR/openresty-packages.log" 2>&1 ||
    { tail -n 40 "$STATE_DIR/openresty-packages.log" >&2; fail "building the edgeweir-openresty packages failed"; }
  openresty_packages_built || fail "make openresty-packages did not produce ${OPENRESTY_FILES[*]}"
  node scripts/e2e-cache.mjs openresty save "$NODE_CONTEXT" "$DOCKER_ARCH" "${OPENRESTY_CACHED[@]}" ||
    echo "not cached: packaging/openresty has uncommitted changes in $NODE_CONTEXT"
fi
pass "edgeweir-openresty $OPENRESTY_PKG packages for $DOCKER_ARCH in $NODE_CONTEXT/out/openresty"
echo "goreleaser release --snapshot --clean (in $NODE_CONTEXT, log in $STATE_DIR/goreleaser.log)"
part goreleaser sh -c 'cd "$1" && goreleaser release --snapshot --clean' _ "$NODE_CONTEXT" >"$STATE_DIR/goreleaser.log" 2>&1 ||
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
grep -q "node channel reachable and presents the pinned CA (console:8443)" "$STATE_DIR/install.log" &&
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
}

# --------------------------------------------------------- section ssh-install
# One-shot SSH install (ADR-0066) on a fresh systemd + sshd container: the
# console scans the host key, refuses a wrong one, names a wrong sudo password,
# then retries that host with the right one and installs the latest signed
# edgeweir-node release (GitHub, full cosign verification; the console's
# mirror is tried first and has no such version) as a sudo user with a
# password. With the stack's own edgeweir-node build on the host (when it is
# 1.7.0 or later: enroll --if-not-enrolled, decommission-v1, ADR-0067) a new
# run on the enrolled host keeps its node, and a decommission retires it
# without SSH. Needs github.com and api.github.com.
section_ssh_install() {
step "SSH install: a fresh systemd + sshd host with a sudo user"
local version image password fingerprint cluster run result node_id deadline got
version="$(curl -fsSL https://api.github.com/repos/marvinli001/edgeweir-node/releases/latest | jq -r .tag_name)" ||
  fail "could not read the latest edgeweir-node release from GitHub"
version="${version#v}"
image="edgeweir-e2e-sshd:${E2E_TAG:-local}"
docker build -q -t "$image" - >/dev/null <<EOF || fail "could not build the sshd host image"
FROM $INSTALL_IMAGE
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv openssh-server sudo curl ca-certificates socat >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash deploy \
 && echo 'deploy ALL=(ALL) ALL' >/etc/sudoers.d/deploy && chmod 0440 /etc/sudoers.d/deploy
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
EOF
docker rm -f "$SSH_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$SSH_CONTAINER" --hostname edge-ssh --network "$NETWORK" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock "$image" >/dev/null || fail "could not start the sshd host"
in_ssh() { docker exec "$SSH_CONTAINER" bash -ec "$@"; }
deadline=$((SECONDS + 60))
until [[ "$(docker exec "$SSH_CONTAINER" systemctl is-active ssh 2>/dev/null)" == active ]]; do
  ((SECONDS < deadline)) || fail "sshd did not start in the host container"
  sleep 1
done
password="e2e-$(openssl rand -hex 12)"
printf 'deploy:%s\n' "$password" | docker exec -i "$SSH_CONTAINER" chpasswd || fail "could not set the deploy password"
# The console's URL as nodes see it is localhost:$port here (EDGEWEIR_PUBLIC_URL): the host
# forwards it to the console on the e2e network.
docker exec -d "$SSH_CONTAINER" socat "TCP-LISTEN:${E2E_CONSOLE_PORT:-13000},bind=127.0.0.1,fork,reuseaddr" TCP:console:3000
fingerprint="$(in_ssh 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d" " -f2')"
[[ "$fingerprint" == SHA256:* ]] || fail "no ed25519 host key in the sshd host: $fingerprint"
pass "host $SSH_CONTAINER: sshd up, deploy may sudo with its password, host key $fingerprint; installing edgeweir-node $version"

step "SSH install: the console reads the host key and never trusts another one"
result="$(api POST /ssh-installs/host-keys "$(jq -nc --arg h "$SSH_CONTAINER" '{hosts: [{host: $h, port: 22}, {host: "no-such-host.invalid"}]}')")" ||
  fail "scanHostKeys failed"
echo "$result" | jq -c '.hosts[]'
[[ "$(jq -r '.hosts[0].fingerprint' <<<"$result")" == "$fingerprint" && "$(jq -r '.hosts[0].algorithm' <<<"$result")" == ssh-ed25519 &&
  "$(jq -r '.hosts[1].error' <<<"$result")" == unreachable ]] || fail "unexpected host key scan: $result"
cluster="$(api POST /clusters '{"name": "ssh-install-e2e"}' | jq -r .id)"
ssh_body() { # ssh_body FINGERPRINT SUDO_PASSWORD
  jq -nc --arg c "$cluster" --arg h "$SSH_CONTAINER" --arg f "$1" --arg p "$password" --arg s "$2" --arg v "$version" \
    '{clusterId: $c, credential: {username: "deploy", password: $p, sudoPassword: $s},
      hosts: [{host: $h, nodeName: "edge-ssh-1", hostKeyFingerprint: $f}],
      options: {version: $v}, timeoutMinutes: 15}'
}
ssh_wait() { # ssh_wait RUN_ID SECONDS -> the ended run
  local id="$1" until_s=$((SECONDS + $2)) out
  while :; do
    out="$(api GET "/ssh-installs/$id")" || fail "GET /ssh-installs/$id failed"
    [[ "$(jq -r .state <<<"$out")" == running ]] || { echo "$out"; return; }
    ((SECONDS < until_s)) || fail "the SSH install did not end in $2 s: $(jq -c '.hosts[0] | {state, error}' <<<"$out")"
    sleep 2
  done
}
# A key of the right shape that is not this host's.
run="$(api POST /ssh-installs "$(ssh_body "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" "$password")" | jq -r .id)" ||
  fail "start failed"
result="$(ssh_wait "$run" 60)"
[[ "$(jq -r '.hosts[0].error' <<<"$result")" == host_key_mismatch && "$(jq -r '.hosts[0].presentedFingerprint' <<<"$result")" == "$fingerprint" ]] ||
  fail "a wrong host key must stop the install: $(jq -c '.hosts[0]' <<<"$result")"
[[ "$(in_ssh 'journalctl -u ssh --no-pager | grep -c "Accepted password for deploy" || true')" == 0 ]] ||
  fail "the console signed in although the host key did not match"
pass "scan: $fingerprint (ssh-ed25519), unknown host unreachable; a wrong pinned key fails with host_key_mismatch before signing in"

step "SSH install: a wrong sudo password is named; credentials never ride along with an Idempotency-Key"
run="$(api POST /ssh-installs "$(ssh_body "$fingerprint" "not-the-password")" | jq -r .id)" || fail "start failed"
result="$(ssh_wait "$run" 120)"
[[ "$(jq -r '.hosts[0].error' <<<"$result")" == sudo_password_wrong ]] ||
  fail "expected sudo_password_wrong: $(jq -c '.hosts[0] | {state, error, exitCode, output}' <<<"$result")"
got="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/api/v1/ssh-installs" -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" -H 'idempotency-key: ssh-e2e' --data "$(ssh_body "$fingerprint" "$password")")"
[[ "$got" == 400 ]] || fail "an Idempotency-Key with SSH credentials must be refused, got HTTP $got"
pass "wrong sudo password: sudo_password_wrong; Idempotency-Key with credentials: 400"

step "SSH install: the host retried as deploy (sudo -S) installs the node, which enrolls and comes online under systemd"
api POST "/ssh-installs/$run/retry" "$(jq -nc --arg p "$password" '{credential: {username: "deploy", password: $p, sudoPassword: $p}}')" >/dev/null ||
  fail "retry failed"
result="$(ssh_wait "$run" 900)"
echo "$result" | jq -c '.hosts[0] | {state, error, exitCode, nodeId, attempts}'
[[ "$(jq -r '.hosts[0].state' <<<"$result")" == succeeded && "$(jq -r '.hosts[0].attempts' <<<"$result")" == 2 ]] ||
  fail "the SSH install failed: $(jq -r '.hosts[0] | "\(.error) (exit \(.exitCode))\n\(.output)"' <<<"$result")"
node_id="$(jq -r '.hosts[0].nodeId' <<<"$result")"
jq -r '.hosts[0].output' <<<"$result" | grep '\[edgeweir\]' | tail -n 6 || true
deadline=$((SECONDS + 120))
until [[ "$(api GET "/nodes/$node_id" | jq -r '"\(.online) \(.agentVersion) \(.name)"')" == "true $version edge-ssh-1" ]]; do
  ((SECONDS < deadline)) || fail "the node installed over SSH did not come online: $(api GET "/nodes/$node_id" | jq -c '{online, agentVersion, name}')"
  sleep 2
done
[[ "$(in_ssh 'systemctl is-active edgeweir-node')" == active && "$(in_ssh 'systemctl is-enabled edgeweir-node')" == enabled ]] ||
  fail "edgeweir-node is not an enabled, active systemd service"
grep -q "cosign signature verified (release workflow, tag v$version)" <<<"$(jq -r '.hosts[0].output' <<<"$result")" ||
  fail "install.sh did not report the verified release signature"
pass "node $node_id ($version) installed over SSH, online, edgeweir-node enabled and active; install.sh verified the release's cosign signature"

step "SSH install: no credential or token left on the host, in the console's logs or in its database"
leaks="$(in_ssh '
  p="$1"
  journalctl --no-pager | grep -cF -- "$p" || true
  journalctl --no-pager | grep -cE "ewt_[A-Za-z0-9_-]{20,}" || true
  grep -rlE "ewt_[A-Za-z0-9_-]{20,}" /var/log /tmp /home/deploy 2>/dev/null | wc -l
  find /tmp -maxdepth 1 -name "tmp.*" -user deploy | wc -l
  grep -lsa EDGEWEIR_TOKEN /proc/[0-9]*/environ | wc -l
' _ "$password" | tr '\n' ' ')"
[[ "$leaks" == "0 0 0 0 0 " ]] ||
  fail "credentials or tokens left on the host (password in journal, token in journal, token files, temp dirs, environments): $leaks"
journalctl_sudo="$(in_ssh 'journalctl --no-pager _COMM=sudo | grep "COMMAND=" | tail -n 1')"
echo "sudo log: ${journalctl_sudo:0:200}"
[[ "$journalctl_sudo" == *"/install.sh --token-file /tmp/tmp."*"/token --server https://console:8443"* && "$journalctl_sudo" != *ewt_* ]] || fail "sudo did not log the install.sh command line, or logged a token"
console_hits="$("${COMPOSE[@]}" logs console 2>&1 | grep -cF -- "$password" || true)"
db_hits="$("${COMPOSE[@]}" exec -T postgres pg_dump -U edgeweir -d edgeweir --data-only | grep -cF -- "$password" || true)"
[[ "$console_hits" == 0 && "$db_hits" == 0 ]] || fail "the SSH password reached the console's logs ($console_hits) or database ($db_hits)"
audit="$(api GET "/audit-logs?action=ssh_install.host&limit=5" | jq -c --arg h "$SSH_CONTAINER" '[.items[] | .metadata | select(.host == $h) | .outcome]')"
[[ "$audit" == '["succeeded","failed","failed"]' ]] || fail "unexpected ssh_install.host audit entries: $audit"
pass "host: no password or token in the journal, files, temp dirs or process environments; sudo logged only the install.sh command; console logs and pg_dump: no password; audit: succeeded, failed, failed"

step "SSH install: with edgeweir-node 1.7.0 a new run keeps the enrolled host's node; decommission retires it without SSH"
# The stack's own edgeweir-node build (EDGEWEIR_NODE_CONTEXT) on the host, or E2E_SSH_NODE_BINARY, with the
# unit of EDGEWEIR_NODE_CONTEXT.
local binary="$STATE_DIR/edgeweir-node-ssh" cid nodes_before
if [[ -n "${E2E_SSH_NODE_BINARY:-}" ]]; then
  cp "$E2E_SSH_NODE_BINARY" "$binary"
else
  cid="$(docker create "edgeweir-node:${E2E_TAG:-e2e}")" || fail "no edgeweir-node image of the stack"
  docker cp "$cid:/usr/local/bin/edgeweir-node" "$binary" >/dev/null && docker rm "$cid" >/dev/null ||
    fail "could not copy edgeweir-node out of the stack's image"
fi
docker cp "$binary" "$SSH_CONTAINER:/tmp/edgeweir-node-new" >/dev/null
if ! in_ssh '/tmp/edgeweir-node-new enroll -h 2>&1 | grep -q -- -if-not-enrolled'; then
  echo "skipped: the stack's edgeweir-node has no enroll --if-not-enrolled (edgeweir-node 1.7.0 and later)"
else
  # The 1.7.0 package's unit as well (RestartPreventExitStatus=2 3, SuccessExitStatus=3): with the
  # installed release's unit a decommissioned node is restarted.
  docker cp "$NODE_CONTEXT/packaging/systemd/edgeweir-node.service" "$SSH_CONTAINER:/usr/lib/systemd/system/edgeweir-node.service" >/dev/null ||
    fail "no packaging/systemd/edgeweir-node.service in $NODE_CONTEXT"
  in_ssh 'install -m 0755 /tmp/edgeweir-node-new /usr/bin/edgeweir-node && systemctl daemon-reload && systemctl restart edgeweir-node'
  deadline=$((SECONDS + 120))
  until api GET "/nodes/$node_id" | jq -e '.online and (.supportedFeatures | index("decommission-v1"))' >/dev/null; do
    ((SECONDS < deadline)) || fail "the node did not come back with decommission-v1: $(api GET "/nodes/$node_id" | jq -c '{online, agentVersion}')"
    sleep 2
  done
  nodes_before="$(api GET "/nodes?clusterId=$cluster" | jq length)"
  run="$(api POST /ssh-installs "$(ssh_body "$fingerprint" "$password")" | jq -r .id)" || fail "start failed"
  result="$(ssh_wait "$run" 300)"
  echo "$result" | jq -c '.hosts[0] | {state, error, exitCode, nodeId, step}'
  [[ "$(jq -r '.hosts[0].state' <<<"$result")" == succeeded && "$(jq -r '.hosts[0].nodeId' <<<"$result")" == "$node_id" ]] ||
    fail "a new run on the enrolled host must confirm its node: $(jq -c '.hosts[0] | {state, error, nodeId, output}' <<<"$result")"
  [[ "$(api GET "/nodes?clusterId=$cluster" | jq length)" == "$nodes_before" ]] || fail "the new run added a node"
  pass "the enrolled host confirmed its node $node_id (enroll --if-not-enrolled); no second node"

  [[ "$(api POST "/nodes/$node_id/decommission" | jq -r '.decommissionRequestedAt != null')" == true ]] ||
    fail "decommission request failed"
  deadline=$((SECONDS + 120))
  while api GET "/nodes/$node_id" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || fail "the node was not decommissioned: $(api GET "/nodes/$node_id" | jq -c '{online, decommissionRequestedAt, decommissionError}')"
    sleep 2
  done
  in_ssh 'test ! -e /var/lib/edgeweir-node/identity.json' || fail "the decommissioned node kept its identity"
  sleep 3
  # A decommissioned node exits 3; the unit ends inactive and is not restarted.
  state="$(in_ssh 'systemctl is-active edgeweir-node || true')"
  [[ "$state" == inactive ]] || fail "edgeweir-node is $state after its decommission (expected inactive)"
  [[ "$(api GET "/audit-logs?action=node.delete&limit=5" | jq -r --arg n "$node_id" '[.items[] | select(.targetId == $n) | .metadata.decommissioned] | first')" == true ]] ||
    fail "no node.delete audit entry for the decommission"
  pass "decommissioned without SSH: node $node_id deleted, its identity gone from the host, edgeweir-node stopped"
fi
docker rm -f "$SSH_CONTAINER" >/dev/null 2>&1 || true
}

# ----------------------------------------------------------------- section wss
section_wss() {
step "WebSocket entry: a node enrolls with wss:// through a TLS-terminating proxy, stays online and applies revisions"
# A new node state each time: the cleanup deletes the node from the console.
"${COMPOSE[@]}" --profile wss rm -sfv node-wss wss-proxy >/dev/null 2>&1 || true
# The proxy writes its test CA at start; node-wss reads it from the same volume.
wss_up() {
  "${COMPOSE[@]}" --profile wss up -d --no-deps --wait wss-proxy && "${COMPOSE[@]}" --profile wss up -d --no-deps node-wss
}
part wss-up wss_up || fail "could not start wss-proxy and node-wss"
part checks node scripts/e2e-wss.mjs || fail "wss end-to-end checks failed"
part cleanup node scripts/e2e-wss.mjs --cleanup || fail "wss cleanup failed"
"${COMPOSE[@]}" --profile wss rm -sfv node-wss wss-proxy >/dev/null 2>&1 || true
pass "WebSocket entry checks passed"
}

# ------------------------------------------------------------- section channel
section_channel() {
step "Node channel URL: enrolled nodes follow it (https and wss), stay online without the old address, set-server recovers a lost node"
# A new node state each time: the cleanup deletes the node from the console.
"${COMPOSE[@]}" --profile channel rm -sfv node-channel channel-relay wss-proxy >/dev/null 2>&1 || true
docker volume rm -f "${COMPOSE_PROJECT_NAME:-edgeweir-e2e}_node-channel-state" >/dev/null 2>&1 || true
channel_up() {
  "${COMPOSE[@]}" --profile channel up -d --no-deps --wait wss-proxy channel-relay &&
    "${COMPOSE[@]}" --profile channel up -d --no-deps node-channel
}
part channel-up channel_up || fail "could not start channel-relay and node-channel"
part checks node scripts/e2e-channel.mjs || fail "channel end-to-end checks failed"
part cleanup node scripts/e2e-channel.mjs --cleanup || fail "channel cleanup failed"
pass "Node channel URL checks passed"
}

# ----------------------------------------------------------- section node-logs
section_node_logs() {
step "Node logs: the node's warnings and events reach its logs tab without secrets; retention prunes them"
story node-logs --cleanup
pass "Node log checks passed"
}

# --------------------------------------------------------- section diagnostics
section_diagnostics() {
step "Node diagnostics: clock offset in the heartbeats, edgeweir-node diagnose and pprof"
part checks node scripts/e2e-diagnostics.mjs || fail "diagnostics end-to-end checks failed"
pass "Node diagnostics checks passed"
}

# ---------------------------------------------------------- section extensions
section_extensions() {
step "Node extensions: sign, trust, install, load, per-site, failure modes, kill switch, removal"
part checks node scripts/e2e-extensions.mjs || fail "extensions end-to-end checks failed"
part checks node scripts/e2e-extensions-v11.mjs || fail "extensions 1.1 end-to-end checks failed"
pass "Node extension checks passed"
}

# ------------------------------------- sections m3 ... g20 (scripts/e2e-*.mjs)
section_m3() {
step "M3: ACME issuance, HTTPS, HTTP/2, HTTP/3, renewal and TLS policy"
story m3
pass "M3 certificate and protocol checks passed"
}

section_m4() {
step "M4: rules, IP lists, rate limits, transformations and local GeoIP"
story m4
pass "M4 policy checks passed"
}

section_m5() {
step "M5: DNS health reconciliation, statistics and notifications"
story m5
pass "M5 DNS, statistics and alert checks passed"
}

section_m6_logs() {
step "M6: sampled logs, scoped API keys, optional ClickHouse and backup recovery"
story m6-logs
part clickhouse-up "${COMPOSE[@]}" --profile analytics up -d --wait clickhouse || fail "ClickHouse did not start"
part clickhouse pnpm --filter @edgeweir/console exec tsx scripts/e2e-clickhouse.ts "http://localhost:${E2E_CLICKHOUSE_PORT:-19123}" || fail "ClickHouse integration failed"
part restore node scripts/e2e-restore.mjs || fail "backup recovery failed"
pass "M6 log, AccessKey, ClickHouse and recovery checks passed"
}

section_m6_upgrades() {
step "M6: signed node upgrade, canary promotion and automatic rollback"
part fixtures node scripts/e2e-upgrade-fixtures.mjs || fail "could not prepare signed upgrade fixtures"
part peer-up "${COMPOSE[@]}" --profile upgrades up -d upgrade-files node-upgrade-peer || fail "could not start the upgrade peer"
story m6-upgrades
pass "M6 signed upgrades and rollback passed"
}

section_p0() {
step "P0: idempotency, service accounts, usage, configuration canary, DNS protection"
story p0
pass "P0 checks passed"
}

section_g1() {
step "G1: dynamic bans: delivery latency, site bans at the edge, platform bans in nftables and limits"
story g1
pass "G1 checks passed"
}

section_g2() {
step "G2: challenges in a browser, passes across nodes, Under Attack, tiered CC and JA4 rules"
story g2
pass "G2 checks passed"
}

section_g3() {
step "G3: custom OpenResty build, Brotli / Zstandard negotiation, OWASP CRS and capability gating"
story g3 --cleanup
pass "G3 checks passed"
}

section_g4() {
step "G4: purge by Host and Cache-Tag, variant and sitemap prefetch, active health checks, session affinity, error pages"
story g4 --cleanup
pass "G4 checks passed"
}

section_g5() {
step "G5: rule engine extensions: functions, dynamic and bulk redirects, origin, cache and compression rules, config overrides"
story g5 --cleanup
pass "G5 checks passed"
}

section_dns() {
step "DNS: cluster bindings on two accounts, offline removal, provider outage, manual zone file, Custom HTTP credentials"
part node-dns-up "${COMPOSE[@]}" --profile dns up -d node-dns || fail "could not start node-dns"
story dns
pass "DNS checks passed"
}

section_g6() {
step "G6: regional probes, node metrics, resolution lines, backup IPs, backup line groups and scheduling rules"
story g6 --cleanup
pass "G6 checks passed"
}

section_g7() {
step "G7: layer-4 forwarding: port pools, TCP and UDP echo, a long connection across a reload, PROXY protocol, hot upstreams, limits, statistics"
story g7 --cleanup
pass "G7 checks passed"
}

section_h2() {
step "HTTP/2 and gRPC to origins: h2c origin, gRPC unary, bidirectional streaming and trailers through both nodes"
story h2 --cleanup
pass "HTTP/2 and gRPC checks passed"
}

section_pp() {
step "PROXY protocol to origins and gRPC health checks: v1 and v2 through both nodes, per-client connections, HTTP/2 and gRPC over PROXY protocol, grpc.health.v1 down and up"
story pp --cleanup
pass "PROXY protocol and gRPC health checks passed"
}

section_g8() {
step "G8: expression fields, functions and wildcards, header values and query parameters, response header lines, 303, error page placeholders, a node without rules-v3"
story g8 --cleanup
pass "G8 checks passed"
}

section_g9() {
step "G9: listener ports, site ports, SNI on an extra HTTPS port, HTTPS redirect options, layer-4 range and TLS, reload with an open connection, PROXY protocol v2 balancer, trusted proxy header"
story g9 --cleanup
pass "G9 checks passed"
}

section_g15() {
step "G15: cache zone sizes and usage, Set-Cookie caching, excluded parameters, charset, body limits, gzip level, PURGE, error page classes and redirects, X-Cache, maintenance, origin tries, S3 with MinIO"
story g15 --cleanup
pass "G15 checks passed"
}

section_g10() {
step "G10: suffix, wildcard, pattern and internationalized domains, unknown hosts closed or handed to the default site, node IP access, default certificate, scan protection, CNAME prefixes"
story g10 --cleanup
pass "G10 checks passed"
}

section_g11() {
step "G11: several certificates by SNI and key type, client certificates, TLS session resumption across nodes and sites, Pebble as the custom ACME directory"
story g11 --cleanup
pass "G11 checks passed"
}

section_g12() {
step "G12: Basic, signed URLs A-D and forward authentication before the rules and the cache"
story g12 --cleanup
pass "G12 checks passed"
}

section_g13() {
step "G13: site lists, geo, CORS, hotlink, user agents, WebSocket origins and security headers at the edge"
story g13 --cleanup
pass "G13 checks passed"
}

section_g14() {
step "G14: WAF actions, request body fields, CRS by path, verified crawlers and challenge additions"
story g14 --cleanup
pass "G14 checks passed"
}

section_g16() {
step "G16: access log fields, options, filters and retention, live view on the node, statistics dimensions"
story g16 --cleanup
pass "G16 checks passed"
}

section_g17() {
step "G17: site tags, batch operations, copying settings to other sites and cloning"
story g17 --cleanup
pass "G17 checks passed"
}

section_g18() {
step "G18: WebP / AVIF variants by Accept, cached once each, limits, savings"
story g18 --cleanup
pass "G18 checks passed"
}

section_g19() {
step "G19: origin protection: client certificates to origins and the Origin CA"
story g19 --cleanup
pass "G19 checks passed"
}

section_probe_sources() {
step "Probe sources: a generic webhook and a simulated UptimeRobot drive nodes out of DNS and back; failing and stale sources remove nothing"
story probe-sources --cleanup
pass "probe source checks passed"
}

section_g20() {
step "G20: managed challenge, escalation to the interactive challenge, a Turnstile provider at a mock, fallback to the built-in captcha"
part captcha-up "${COMPOSE[@]}" --profile g20 up -d --wait g20-captcha || fail "could not start g20-captcha"
part checks node scripts/e2e-g20.mjs || fail "g20 end-to-end checks failed"
part cleanup node scripts/e2e-g20.mjs --cleanup || fail "g20 cleanup failed"
"${COMPOSE[@]}" --profile g20 rm -sf g20-captcha >/dev/null 2>&1 || true
pass "G20 checks passed"
}

section_usage_guard() {
step "usage protection: warning and limit alerts, maintenance and disabling at both nodes, a higher limit, a manual restore"
story usage-guard --cleanup
pass "usage protection checks passed"
}

# ----------------------------------------------------------- section dev-mode
section_dev_mode() {
step "development mode: a cached object HIT, BYPASS to the origin while on, off early, then expiry on the node's own clock with the console paused"
DM_HOST="dev-mode.test"
# dm_get PATH -> "X-CACHE RESPONSE-ID BODY-ID": the body is whoami's echo of the request,
# so BODY-ID is the X-Request-Id of the request that reached the origin.
dm_get() {
  local out
  out="$(curl -sS -D - -H "Host: $DM_HOST" "$NODE_HTTP$1" | tr -d '\r')"
  printf '%s %s %s\n' \
    "$(awk 'tolower($1) == "x-cache:" { print $2; exit }' <<<"$out")" \
    "$(awk 'tolower($1) == "x-request-id:" { print $2; exit }' <<<"$out")" \
    "$(awk 'tolower($1) == "x-request-id:" { n++ } n == 2 { print $2; exit }' <<<"$out")"
}
dm_latest() { api GET "/clusters/$CLUSTER_ID" | jq -r .latestRevision.revision; }
dm_node_latest() {
  local latest
  latest="$(dm_latest)"
  dm_on_latest() { [[ "$(node_json | jq -r '"\(.appliedRevision) \(.applyState)"')" == "$latest applied" ]]; }
  wait_for 60 "node applies revision #$latest" dm_on_latest
}
dm_reason() { api GET "/clusters/$CLUSTER_ID/revisions" | jq -r 'max_by(.revision).reasonCode'; }
OLD_DM="$(api GET "/sites?search=$DM_HOST" | jq -r '.items[0].id // empty')"
[[ -z "$OLD_DM" ]] || api DELETE "/sites/$OLD_DM" >/dev/null
DM_SITE="$(api POST /sites "$(jq -nc --arg c "$CLUSTER_ID" --arg h "$DM_HOST" '{name: "dev-mode", clusterId: $c,
  domains: [$h], origins: [{address: "whoami"}],
  cacheRules: [{pathPrefixes: ["/"], edgeTtlSeconds: 3600, originCacheControl: "override"}]}')" | jq -r .site.id)"
dm_node_latest
[[ "$(node_json | jq -r '.supportedFeatures | index("development-mode-v1") != null')" == "true" ]] ||
  fail "the node does not report development-mode-v1: $(node_json | jq -c .supportedFeatures)"

read -r C1 R1 B1 <<<"$(dm_get /dm/object)"
read -r C2 R2 B2 <<<"$(dm_get /dm/object)"
echo "first: X-Cache $C1 (origin saw $B1), second: X-Cache $C2, request $R2, cached body from $B2"
[[ "$C1" == MISS && "$B1" == "$R1" ]] || fail "first request should be a MISS answered by the origin: $C1 $R1 $B1"
[[ "$C2" == HIT && "$B2" == "$B1" && "$R2" != "$B2" ]] || fail "second request should be a HIT with the first body: $C2 $R2 $B2"
pass "cached object: MISS, then HIT with the body the origin sent for $B1"

step "development mode on: every request goes to the origin, nothing is stored"
DM_ON="$(api PUT "/sites/$DM_SITE/development-mode" '{"enabled":true}')"
DM_UNTIL="$(jq -r .until <<<"$DM_ON")"
[[ "$DM_UNTIL" != null ]] || fail "development mode did not turn on: $DM_ON"
[[ "$(dm_reason)" == development_mode_on ]] || fail "latest revision should be development_mode_on, is $(dm_reason)"
dm_node_latest
[[ "$(api GET "/sites/$DM_SITE" | jq -r .developmentModeUntil)" == "$DM_UNTIL" ]] || fail "site does not carry developmentModeUntil"
for path in /dm/object /dm/object /dm/new /dm/new; do
  read -r C R B <<<"$(dm_get "$path")"
  echo "$path: X-Cache $C, request $R, origin saw $B"
  [[ "$C" == BYPASS && "$B" == "$R" ]] || fail "$path should bypass the cache to the origin while on: $C $R $B"
done
pass "on until $DM_UNTIL: BYPASS to the origin for the cached object and a new path (each request reached whoami)"

step "development mode off early: the cache answers again with what it kept"
api PUT "/sites/$DM_SITE/development-mode" '{"enabled":false}' >/dev/null
[[ "$(dm_reason)" == development_mode_off ]] || fail "latest revision should be development_mode_off, is $(dm_reason)"
dm_node_latest
read -r C R B <<<"$(dm_get /dm/object)"
[[ "$C" == HIT && "$B" == "$B1" ]] || fail "/dm/object should be a HIT with the body kept from before: $C $R $B"
read -r C R B <<<"$(dm_get /dm/new)"
[[ "$C" == MISS ]] || fail "/dm/new was not stored while on, so it should MISS now: $C $R $B"
[[ "$(api GET "/audit-logs?action=site.development_mode_off" | jq -r --arg id "$DM_SITE" \
  '[.items[] | select(.targetId == $id)][0] | "\(.actorType)|\(.actorName)"')" == "api_key|E2E Admin" ]] ||
  fail "turning it off is not audited as the operator (their API key)"
pass "off: /dm/object HIT with the kept body from $B1, /dm/new MISS (nothing stored while on), audited"

step "expiry with the console paused: the node resumes caching at the deadline on its own"
DM_ON="$(api PUT "/sites/$DM_SITE/development-mode" '{"enabled":true}')"
DM_UNTIL="$(jq -r .until <<<"$DM_ON")"
dm_node_latest
read -r C R B <<<"$(dm_get /dm/object)"
[[ "$C" == BYPASS ]] || fail "/dm/object should bypass while on again: $C"
DM_END="$(date -d "$DM_UNTIL" +%s 2>/dev/null || node -e 'console.log(Math.floor(Date.parse(process.argv[1]) / 1000))' "$DM_UNTIL")"
# While the console is paused nothing may fail: the check returns its finding and the
# console is unpaused before any fail.
dm_while_paused() {
  local now c r b
  while now="$(date +%s)"; ((now < DM_END - 2)); do
    [[ "$(dm_get /dm/object | cut -d' ' -f1)" == BYPASS ]] || { DM_FINDING="the node stopped bypassing $((DM_END - now)) s before the deadline"; return 1; }
    sleep 2
  done
  while now="$(date +%s)"; ((now < DM_END + 15)); do
    read -r c r b <<<"$(dm_get /dm/object)"
    if [[ "$c" == HIT ]]; then
      [[ "$b" == "$B1" ]] || { DM_FINDING="the HIT after expiry carries $b, not the kept body $B1"; return 1; }
      DM_FINDING="HIT with the kept body $((now - DM_END)) s after the deadline"
      return 0
    fi
    sleep 1
  done
  DM_FINDING="still $c 15 s after the deadline"
  return 1
}
"${COMPOSE[@]}" pause console >/dev/null
echo "console paused; development mode ends at $DM_UNTIL ($((DM_END - $(date +%s))) s)"
DM_OK=true
dm_while_paused || DM_OK=false
"${COMPOSE[@]}" unpause console >/dev/null
$DM_OK || fail "console paused: $DM_FINDING"
pass "console paused: BYPASS until $DM_UNTIL, then $DM_FINDING, without a new configuration"

step "the console turns the expired development mode off, publishes and audits it as the system"
dm_expired() { [[ "$(api GET "/sites/$DM_SITE/development-mode" | jq -r .until)" == null && "$(dm_reason)" == development_mode_expired ]]; }
wait_for 90 "expiry revision after the console is back" dm_expired
dm_node_latest
[[ "$(api GET "/audit-logs?action=site.development_mode_expire" | jq -r --arg id "$DM_SITE" \
  '[.items[] | select(.targetId == $id)][0] | "\(.actorType) \(.metadata.until)"')" == "system $DM_UNTIL" ]] ||
  fail "expiry is not audited as the system with its deadline"
[[ "$(dm_get /dm/object | cut -d' ' -f1)" == HIT ]] || fail "/dm/object should stay a HIT after the expiry revision"
[[ "$(api GET "/sites/$DM_SITE" | jq -r .developmentModeUntil)" == null ]] || fail "site still carries developmentModeUntil"
pass "expired: revision development_mode_expired applied, audit site.development_mode_expire by the system, still HIT"
mkdir -p .e2e && jq -nc --arg id "$DM_SITE" '{siteId: $id}' >.e2e/dev-mode-state.json
if ! $SKIP_UI; then
  part ui env E2E_BASE_URL="$CONSOLE" E2E_ADMIN_EMAIL="$ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    pnpm --filter @edgeweir/console run test:e2e e2e/dev-mode.spec.ts || fail "development mode browser checks failed"
fi
api DELETE "/sites/$DM_SITE" >/dev/null
pass "development mode checks passed"
}

# ----------------------------------------------------------- section ai-crawl
section_ai_crawl() {
step "AI crawl control: a spoofed GPTBot unverified, block, managed robots.txt, pay per crawl 402, impersonators, the overview"
story ai-crawl --cleanup
pass "AI crawl control checks passed"
}

# ----------------------------------------------------------- section tiers
section_tiers() {
step "Tiered cache: smart upper tier by latency, one origin fetch for three nodes, mTLS between tiers, purges on every tier, fallback, latency moves the upper tier"
part checks node scripts/e2e-tiers.mjs || fail "tiers end-to-end checks failed"
part cleanup node scripts/e2e-tiers.mjs --cleanup || fail "tiers cleanup failed"
pass "Tiered cache checks passed"
}

# ----------------------------------------------------------- section allowlist
section_allowlist() {
step "Login IP allow list: sign-in and sessions only from the list, AccessKeys and the demo account not limited, recover.js clears it"
story allowlist --cleanup
pass "Login IP allow list checks passed"
}

# ----------------------------------------------------------- section lifecycle
section_lifecycle() {
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
}

# ------------------------------------------------------------------------ run
step "wait for the console"
wait_for 180 "console /healthz" curl -fsS "$CONSOLE/healthz"
pass "console healthy: $(curl -fsS "$CONSOLE/healthz")"

DONE=" "
if [[ "$(api GET /system/status | jq -r .initialized)" == "false" ]]; then
  FRESH=true
elif [[ -z "$ONLY$FROM" ]]; then
  fail "the e2e environment is not fresh (console already initialized); reset it with: docker compose -f compose.e2e.yml --profile '*' down -v && docker compose -f compose.e2e.yml up -d --build, or continue its run with --from or --only"
else
  FRESH=false
  [[ -f "$RUN_ENV" ]] || fail "the console is initialized, but no run on it got past the core section ($RUN_ENV); reset the stack"
  # shellcheck source=/dev/null
  source "$RUN_ENV"
  [[ "$RUN_PROJECT" == "${COMPOSE_PROJECT_NAME:-edgeweir-e2e}" && "$RUN_CONSOLE" == "$CONSOLE" ]] ||
    fail "$RUN_ENV is the run of $RUN_PROJECT at $RUN_CONSOLE; use that project's variables or reset this stack"
  export API_KEY
  api GET "/clusters/$CLUSTER_ID" >/dev/null || fail "$RUN_ENV is not the run of this stack (unknown API key or cluster); reset the stack"
  [[ ! -f "$RUN_DONE" ]] || DONE=" $(tr '\n' ' ' <"$RUN_DONE")"
  [[ "$DONE" != *" lifecycle "* ]] || fail "the lifecycle section deleted this stack's node; reset the stack"
fi
if [[ -n "$ONLY" ]]; then
  TARGETS="${ONLY//,/ }"
else
  TARGETS="$(section_names | awk -v from="${FROM:-core}" '$0 == from { on = 1 } on' | tr '\n' ' ')"
fi
WANT=" "
want() { # want SECTION [target]: SECTION and the sections it needs that have not passed on this stack
  local dep
  [[ "$WANT" != *" $1 "* ]] || return 0
  [[ -n "${2:-}" || "$DONE" != *" $1 "* ]] || return 0
  for dep in $(section_deps "$1"); do want "$dep"; done
  WANT+="$1 "
}
if $FRESH; then want core target; fi
for s in $TARGETS; do
  [[ "$s" != core ]] || $FRESH || fail "the core section needs a fresh stack"
  want "$s" target
done
PLAN=()
for s in $(section_names); do [[ "$WANT" != *" $s "* ]] || PLAN+=("$s"); done
# The chain without the lanes' sections, and where each lane starts and ends:
# a lane runs when its sections and at least one section of its stretch are
# planned, otherwise its sections stay in the chain.
CHAIN=" ${PLAN[*]} "
LANE_PLAN=() # "START END SECTION..."
if ! $SERIAL; then
  for lane in "${LANES[@]}"; do
    window="${lane%%:*}" first="${lane%%..*}" last="${window#*..}" on=false start="" end="" members=""
    for s in $(section_names); do
      [[ "$s" != "$first" ]] || on=true
      if $on && [[ "$CHAIN" == *" $s "* && " ${lane#*:} " != *" $s "* ]]; then
        start="${start:-$s}"
        end="$s"
      fi
      [[ "$s" != "$last" ]] || on=false
    done
    for s in ${lane#*:}; do [[ "$CHAIN" != *" $s "* ]] || members+=" $s"; done
    [[ -n "$start" && -n "$members" ]] || continue
    LANE_PLAN+=("$start $end$members")
    for s in $members; do CHAIN="${CHAIN/ $s / }"; done
  done
fi
$FRESH || echo "continuing the run on this stack; passed before:${DONE% }"
echo "sections: ${PLAN[*]}"
for lane in ${LANE_PLAN[@]+"${LANE_PLAN[@]}"}; do
  read -r start end members <<<"$lane"
  echo "parallel: $members beside $start..$end"
done
! $PLAN_ONLY || exit 0
if $FRESH; then rm -f "$RUN_ENV" "$RUN_DONE" "$STATE_DIR/p0-usage.json"; fi
NETWORK="$(e2e_network)"

for s in $CHAIN; do
  for lane in ${LANE_PLAN[@]+"${LANE_PLAN[@]}"}; do
    read -r start end members <<<"$lane"
    # shellcheck disable=SC2086
    [[ "$s" != "$start" ]] || start_lane "$start" $members
  done
  run_section "$s"
  for lane in ${LANE_PLAN[@]+"${LANE_PLAN[@]}"}; do
    read -r start end members <<<"$lane"
    [[ "$s" != "$end" ]] || finish_lane
  done
done

report_timings
if [[ -z "$ONLY$FROM" ]]; then
  printf '\n\033[1;32mE2E OK\033[0m\n'
else
  printf '\n\033[1;32mSECTIONS OK\033[0m %s\n' "${PLAN[*]}"
fi
