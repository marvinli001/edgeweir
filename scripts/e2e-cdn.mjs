// A CDN in front of the console (standalone: `node scripts/e2e-cdn.mjs` on a
// Docker host from an installed checkout; nothing to build). The console runs
// from the source tree with this Node.js, behind cdn-proxy (docker/e2e/
// cdn-proxy): cdn.e2e.test:443 proxies the web port with WebSocket, :8443
// terminates TLS in front of the node channel, as a CDN that proxies both
// does. EDGEWEIR_PUBLIC_URL is https://cdn.e2e.test and EDGEWEIR_NODE_API_URL
// https://cdn.e2e.test:8443. Nodes are clean Debian containers that run
// install.sh (the released, signed edgeweir-node) and trust the CDN's test CA.
//   a. node-1 enrolls with a direct URL saved in the system settings
//      (https://console:8443) and comes online
//   b. with the setting cleared the environment's URL is in effect: the
//      console's check reports a certificate mismatch and the WebSocket entry
//      at wss://cdn.e2e.test as working, checked through the CDN while the
//      entry stays closed (GET /node-channel through the CDN: 404); node-1's
//      own check of that URL fails and it stays where it is
//   c. switching to the candidate (what the notice's action saves) opens the
//      entry (426) and is audited; node-1 moves to it through the CDN
//   d. node-2 runs the install command (wss://cdn.e2e.test) through the CDN:
//      install.sh sees the entry, the node enrolls inside the WebSocket and
//      both stay online with heartbeats for more than 30 seconds
//   e. the CDN logged the upgrades (the check's carried its token)
// Environment: E2E_CDN_PROJECT (ew-cdn), E2E_CDN_SUBNET (172.28.243.0/24),
// E2E_CDN_CONSOLE_PORT (13400), E2E_CDN_NODE_VERSION (latest). --keep leaves
// the stack running; --down removes it only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rpc } from "./e2e-auth.mjs";
import { pass, waitFor } from "./e2e-lib.mjs";

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = process.env.E2E_CDN_PROJECT || "ew-cdn";
const SUBNET = process.env.E2E_CDN_SUBNET || "172.28.243.0/24";
const PORT = process.env.E2E_CDN_CONSOLE_PORT || "13400";
const NODE_VERSION = process.env.E2E_CDN_NODE_VERSION || "";
const base = `http://127.0.0.1:${PORT}`;
// The images compose.e2e.yml and scripts/e2e.sh pin.
const POSTGRES = "postgres:18.6-alpine";
const OPENRESTY =
  "openresty/openresty:1.31.1.1-bookworm@sha256:8005b87dcb25df5e202e71dcc4b8a2c20a4845a75302b2bb6ee816b5392883e4";
const DEBIAN =
  "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";
const CDN = "cdn.e2e.test";
const ENV_URL = `https://${CDN}:8443`;
const DIRECT = "https://console:8443";
const WSS = `wss://${CDN}`;
const ADMIN = { email: "admin@cdn.e2e.test", password: "e2e-cdn-admin-password" };
const CLUSTER = "cdn-e2e";

const docker = async (...args) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
const quiet = (...args) => docker(...args).catch(() => "");
/** A container's log, stdout and stderr (the console logs to stderr). */
const logs = async (service, ...args) => {
  const { stdout, stderr } = await execute("docker", ["logs", ...args, name(service)], {
    maxBuffer: 16 * 1024 * 1024,
  }).catch(() => ({ stdout: "", stderr: "" }));
  return stdout + stderr;
};
const name = (service) => `${P}-${service}`;
const sh = (service, script, env = []) =>
  docker("exec", ...env.flatMap((e) => ["-e", e]), name(service), "bash", "-ec", script);

async function down() {
  for (const service of ["node-2", "node-1", "console", "cdn", "postgres"])
    await quiet("rm", "-fv", name(service));
  await quiet("network", "rm", P);
  await quiet("volume", "rm", name("ca"));
}

async function up() {
  await down();
  await docker("network", "create", "--subnet", SUBNET, P);
  await docker("volume", "create", name("ca"));
  const net = (alias) => ["--network", P, "--network-alias", alias];
  await docker(
    "run",
    "-d",
    "--name",
    name("postgres"),
    ...net("postgres"),
    "-e",
    "POSTGRES_USER=edgeweir",
    "-e",
    "POSTGRES_PASSWORD=e2e-only-password",
    "-e",
    "POSTGRES_DB=edgeweir",
    POSTGRES,
  );
  // The CDN's certificate from a test CA; consoles and nodes trust that CA like a public one.
  await docker(
    "run",
    "-d",
    "--name",
    name("cdn"),
    ...net(CDN),
    "-v",
    `${name("ca")}:/shared`,
    "-v",
    `${ROOT}/docker/e2e/cdn-proxy/nginx.conf:/etc/e2e/cdn-proxy.conf:ro`,
    "--entrypoint",
    "/bin/sh",
    OPENRESTY,
    "-c",
    `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Edgeweir e2e CDN CA' \
       -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
       -keyout /tmp/ca.key -out /tmp/ca.crt 2>/dev/null &&
     openssl req -new -newkey rsa:2048 -nodes -subj /CN=${CDN} -keyout /tmp/cdn.key -out /tmp/cdn.csr 2>/dev/null &&
     printf 'basicConstraints=CA:FALSE\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\nsubjectAltName=DNS:${CDN}\\n' > /tmp/cdn.ext &&
     openssl x509 -req -in /tmp/cdn.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial -days 2 \
       -extfile /tmp/cdn.ext -out /tmp/cdn.crt 2>/dev/null &&
     cp /tmp/ca.crt /shared/cdn-ca.pem.tmp && mv /shared/cdn-ca.pem.tmp /shared/cdn-ca.pem &&
     exec openresty -g 'daemon off;' -c /etc/e2e/cdn-proxy.conf`,
  );
  await waitFor(
    "the CDN's CA",
    async () =>
      (
        await quiet("exec", name("cdn"), "sh", "-c", "test -s /shared/cdn-ca.pem && echo y")
      ).trim() === "y",
    60,
  );
  await waitFor(
    "postgres",
    async () =>
      (await quiet("exec", name("postgres"), "pg_isready", "-U", "edgeweir")).includes("accepting"),
    60,
  );
  // This Node.js (a glibc build) runs the console's source in a Debian container.
  const nodeHome = resolve(dirname(process.execPath), "..");
  await docker(
    "run",
    "-d",
    "--name",
    name("console"),
    ...net("console"),
    "-p",
    `127.0.0.1:${PORT}:3000`,
    "-v",
    `${ROOT}:/src:ro`,
    "-v",
    `${nodeHome}:/opt/node:ro`,
    "-v",
    `${name("ca")}:/shared:ro`,
    "--tmpfs",
    "/tmp",
    "-w",
    "/src/apps/console",
    "-e",
    "ROLE=all",
    "-e",
    "DATABASE_URL=postgres://edgeweir:e2e-only-password@postgres:5432/edgeweir",
    "-e",
    "EDGEWEIR_MASTER_KEY=ZTJlLW9ubHktbWFzdGVyLWtleS1kby1ub3QtcmV1c2UhIQ==",
    "-e",
    "BETTER_AUTH_SECRET=e2e-only-better-auth-secret-do-not-reuse",
    "-e",
    `EDGEWEIR_PUBLIC_URL=https://${CDN}`,
    "-e",
    `EDGEWEIR_NODE_API_URL=${ENV_URL}`,
    "-e",
    "EDGEWEIR_WEB_DIST=/src/apps/console",
    "-e",
    "EDGEWEIR_E2E_TICK_SECONDS=5",
    "-e",
    "EDGEWEIR_E2E_HEARTBEAT_SECONDS=5",
    "-e",
    `EDGEWEIR_OUTBOUND_ALLOW_CIDRS=${SUBNET}`,
    // The CDN's CA, as a public CA would be: the console's check reaches its own public address.
    "-e",
    "NODE_EXTRA_CA_CERTS=/shared/cdn-ca.pem",
    "-e",
    "LOG_LEVEL=debug",
    DEBIAN,
    "/opt/node/bin/node",
    "--import",
    "tsx",
    "src/server/main.ts",
  );
  const setupToken = await waitFor(
    "the setup token in the console log",
    async () => (await logs("console")).match(/"setupToken":"(ews_[\w-]+)"/)?.[1],
    120,
    1000,
    async () => (await logs("console", "--tail", "5")).trim(),
  );
  // The token is logged before the web port listens.
  await waitFor(
    "the console's /healthz",
    async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok,
    60,
  );
  const setup = await fetch(`${base}/api/v1/system/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupToken, name: "CDN e2e", ...ADMIN }),
  });
  assert.equal(setup.status, 200, await setup.text());
  pass(`stack ${P}: console behind ${CDN} (443 and 8443 terminate TLS), set up`);
}

/** A clean Debian host that trusts the CDN's CA, with curl. */
async function host(service) {
  await docker(
    "run",
    "-d",
    "--name",
    name(service),
    "--network",
    P,
    "--hostname",
    `edge-${service}`,
    "--cap-add",
    "NET_ADMIN",
    "-v",
    `${name("ca")}:/shared:ro`,
    DEBIAN,
    "sleep",
    "infinity",
  );
  await sh(
    service,
    `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
     cp /shared/cdn-ca.pem /usr/local/share/ca-certificates/cdn-e2e.crt && update-ca-certificates >/dev/null`,
  );
}

/**
 * The console's install command as it is shown (fetching install.sh through the CDN), as root
 * and without systemd; then the node's service command in the background.
 */
async function install(service, token) {
  const version = NODE_VERSION ? ` --version ${NODE_VERSION}` : "";
  // The command shown, with root instead of sudo.
  assert.ok(
    token.installCommand.includes(
      `curl -fsSL https://${CDN}/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server ${token.serverUrl} --ca-sha256 ${token.caSha256}`,
    ),
    token.installCommand,
  );
  const log = await sh(
    service,
    `set -o pipefail
     curl -fsSL https://${CDN}/install.sh | bash -s -- --server "$SERVER" --ca-sha256 "$CA"${version} --no-start 2>&1`,
    [`EDGEWEIR_TOKEN=${token.token}`, `SERVER=${token.serverUrl}`, `CA=${token.caSha256}`],
  );
  await sh(
    service,
    `set -a; . /etc/default/edgeweir-node 2>/dev/null || true; set +a
     export EDGEWEIR_NGINX_BIN=/usr/lib/edgeweir-openresty/nginx/sbin/nginx EDGEWEIR_LUA_DIR=/usr/share/edgeweir-node/lua
     nohup edgeweir-node supervise --manage-nginx >/var/log/edgeweir-node.log 2>&1 &`,
  );
  return log;
}

if (process.argv.includes("--down")) {
  await down();
  process.exit(0);
}

let session;
try {
  await up();
  // Signed in at the console's port with the public origin (better-auth checks it), as through the CDN.
  session = await waitFor(
    "sign in",
    async () => {
      const response = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `https://${CDN}` },
        body: JSON.stringify(ADMIN),
      });
      if (response.status !== 200) {
        console.error(`sign in: HTTP ${response.status} ${await response.text()}`);
        return null;
      }
      const cookie = response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      return rpc(base, cookie, "accessKeys/create", { name: "cdn-e2e", scope: "write" });
    },
    60,
    5000,
  );
} catch (error) {
  await down();
  throw error;
}
const raw = async (method, path, body) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": session.key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
};
const a = async (method, path, body) => {
  const result = await raw(method, path, body);
  assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
  return result.json;
};
/** GET /node-channel through the CDN, as install.sh asks: the status. */
const entryStatus = async () =>
  (
    await sh("node-1", `curl -s -o /dev/null -w '%{http_code}' https://${CDN}/node-channel || true`)
  ).trim();
const cdnLog = async () => (await logs("cdn")).split("\n");

try {
  // ------------------------------------------ a. node-1 on a direct URL
  const cluster = await a("POST", "/clusters", { name: CLUSTER });
  await a("PUT", "/settings/node-channel", { url: DIRECT });
  await host("node-1");
  const token1 = await a("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: "edge-1",
    ttlMinutes: 15,
  });
  assert.equal(token1.serverUrl, DIRECT);
  const log1 = await install("node-1", token1);
  assert.match(log1, /node channel reachable and presents the pinned CA \(console:8443\)/, log1);
  const nodes = () => a("GET", `/nodes?clusterId=${cluster.id}`);
  const node = async (nodeName) => (await nodes()).find((n) => n.name === nodeName);
  await waitFor("edge-1 online", async () => (await node("edge-1"))?.online, 180);
  pass(`edge-1 installed with ${DIRECT} (${log1.trim().split("\n").pop()}) and online`);

  // ------------------------------------------ b. the environment's URL through the CDN
  const cleared = await a("PUT", "/settings/node-channel", { url: "" });
  assert.deepEqual([cleared.effectiveUrl, cleared.source], [ENV_URL, "environment"]);
  const checks = async () =>
    (await cdnLog()).filter((l) => l.startsWith("GET /node-channel 101 ") && l.endsWith("check=1"));
  const before = (await checks()).length;
  const check = await a("GET", "/settings/node-channel-check");
  assert.deepEqual(
    { url: check.url, result: check.result, candidate: check.candidate },
    { url: ENV_URL, result: "mismatch", candidate: { url: WSS, result: "ok" } },
  );
  // The CDN logs a WebSocket once it is closed.
  const checked = await waitFor(
    "the CDN's log of the check",
    async () => {
      const lines = await checks();
      return lines.length > before ? lines.slice(before) : null;
    },
    30,
  );
  assert.equal(await entryStatus(), "404", "the check must not open the entry");
  // node-1 is told the URL in effect, checks it, sees the CDN's certificate and stays.
  const stayed = await waitFor(
    "edge-1 reports the failed check of the CDN's URL",
    async () => {
      const n = await node("edge-1");
      return n?.online && n.channel?.error?.url === ENV_URL && n.channel.url === DIRECT ? n : null;
    },
    120,
  );
  pass(
    `${ENV_URL}: mismatch; ${WSS} ok through the CDN (${checked.join(" | ")}) while the entry stays closed (404); edge-1 stays on ${DIRECT} (${stayed.channel.error.code})`,
  );

  // ------------------------------------------ c. the switch
  const switched = await a("PUT", "/settings/node-channel", { url: check.candidate.url });
  assert.deepEqual([switched.effectiveUrl, switched.source], [WSS, "setting"]);
  assert.equal(switched.webSocket.open, true);
  const audit = await a("GET", "/audit-logs?action=system.node_channel_update&limit=5");
  const entry = (audit.items ?? audit).find((e) => e.metadata?.after === WSS);
  assert.ok(entry, `no audit entry for ${WSS}: ${JSON.stringify(audit)}`);
  assert.equal(await entryStatus(), "426");
  const after = await a("GET", "/settings/node-channel-check");
  assert.deepEqual([after.url, after.candidate], [WSS, null]);
  const moved = await waitFor(
    `edge-1 on ${WSS}`,
    async () => {
      const n = await node("edge-1");
      return n?.online &&
        n.channel?.url === WSS &&
        n.channel.observedWebSocket &&
        !n.channel.onFallback
        ? n
        : null;
    },
    180,
  );
  pass(
    `switched to ${WSS} (audited, GET /node-channel 426, check ${after.result}); edge-1 moved to it through the CDN (fallback ${moved.channel.fallbackUrl})`,
  );

  // ------------------------------------------ d. a fresh install through the CDN
  await host("node-2");
  const token2 = await a("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: "edge-2",
    ttlMinutes: 15,
  });
  assert.equal(token2.serverUrl, WSS);
  assert.ok(token2.installCommand.includes(`--server ${WSS} `), token2.installCommand);
  const log2 = await install("node-2", token2);
  assert.match(
    log2,
    /node channel WebSocket entry reachable \(https:\/\/cdn\.e2e\.test\/node-channel\)/,
    log2,
  );
  const cdnIp = JSON.parse(await docker("inspect", name("cdn")))[0].NetworkSettings.Networks[P]
    .IPAddress;
  const two = await waitFor(
    "edge-2 online through the CDN",
    async () => {
      const n = await node("edge-2");
      return n?.online ? n : null;
    },
    180,
  );
  assert.equal(two.remoteAddress, cdnIp, `edge-2 connects from ${two.remoteAddress}`);
  const since = Date.now();
  const first = two.lastSeenAt;
  const beats = new Set([first]);
  await waitFor(
    "both online with heartbeats for more than 30 seconds",
    async () => {
      const all = await nodes();
      for (const n of all)
        assert.ok(n.online, `${n.name} went offline: ${JSON.stringify(n.channel)}`);
      const n2 = all.find((n) => n.name === "edge-2");
      beats.add(n2.lastSeenAt);
      return Date.now() - since > 30_000 && Date.parse(n2.lastSeenAt) - Date.parse(first) >= 30_000;
    },
    120,
    2000,
  );
  assert.ok(beats.size >= 3, `heartbeats: ${[...beats].join(", ")}`);
  pass(
    `edge-2 installed with ${WSS} (${log2.trim().split("\n").pop()}), online from the CDN ${cdnIp}; both online ${Math.round((Date.now() - since) / 1000)} s with heartbeats ${[...beats].map((t) => t.slice(11, 19)).join(", ")}`,
  );

  // ------------------------------------------ e. the CDN's log
  const upgrades = (await cdnLog()).filter((l) => l.startsWith("GET /node-channel 101 "));
  assert.ok(
    upgrades.every((l) => l.includes('protocol="edgeweir-node-channel"')),
    upgrades.join("\n"),
  );
  pass(
    `the CDN upgraded ${upgrades.length} WebSocket(s) (edgeweir-node-channel), ${upgrades.filter((l) => l.endsWith("check=1")).length} of them the console's checks`,
  );
  console.log("CDN E2E OK");
} catch (error) {
  for (const service of ["console", "cdn"])
    console.error(`--- ${service}\n${(await logs(service, "--tail", "40")).trim()}`);
  for (const service of ["node-1", "node-2"])
    console.error(
      `--- ${service}\n${(await quiet("exec", name(service), "tail", "-n", "40", "/var/log/edgeweir-node.log")).trim()}`,
    );
  throw error;
} finally {
  if (!process.argv.includes("--keep")) {
    await down();
  }
}
