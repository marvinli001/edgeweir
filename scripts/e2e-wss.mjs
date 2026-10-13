// The node channel's WebSocket entry behind a TLS-terminating reverse proxy
// (profile wss): wss-proxy is nginx with the /node-channel location of
// docs/deploy/networking.md and a certificate for wss.e2e.test from a test
// CA; node-wss trusts that CA next to the system roots (SSL_CERT_DIR).
//   a. the wss:// URL saved in the system settings opens the entry: through
//      the proxy GET /node-channel answers 426, the node channel certificate
//      names wss.e2e.test and install commands carry the URL
//   b. node-wss enrolls with wss://wss.e2e.test (the node channel's own TLS,
//      pinned to the console's CA, inside the WebSocket) and comes online
//      over mTLS from the proxy's address
//   c. it applies the revision of its cluster, stays online for more than
//      30 seconds with heartbeats arriving, then applies and serves a
//      revision published after that
//   d. the proxy logged the WebSocket upgrades with the subprotocol
// `node scripts/e2e-wss.mjs --cleanup` deletes the node, its site and its
// cluster and saves the node channel URL that was in effect before again.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "wss"];
const run = async (args, env) =>
  (await execute("docker", args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/wss-state.json";
const PROXY_HOST = "wss.e2e.test";
const URL_WSS = `wss://${PROXY_HOST}`;
const CLUSTER = "wss-e2e";
const NODE = "edge-wss";
const SITE = { name: "wss-site", domain: "wss-site.e2e.test", added: "www.wss-site.e2e.test" };

async function waitFor(label, fn, seconds = 120, interval = 1000) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label}`);
}

/** The operator with an AccessKey created over the console's RPC. */
async function operator(email, password) {
  const response = await waitFor(`sign in ${email}`, async () => {
    const r = await signInResponse(base, email, password);
    return r.status === 200 ? r : null;
  });
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const key = await rpc(base, cookie, "accessKeys/create", { name: "wss-e2e" });
  const raw = async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": key.key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const ok = async (method, path, body) => {
    const result = await raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  ok.raw = raw;
  return ok;
}

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};
const containerIp = async (service) => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const entry = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert.ok(entry, `${service} is not on the default network`);
  return entry[1].IPAddress;
};
/** `sh -c script` in the proxy container; stdout. */
const inProxy = async (script) => run(["exec", await containerId("wss-proxy"), "sh", "-c", script]);

/** Runs `node -e script args…` in a service; resolves its stdout. */
async function nodeIn(service, script, args) {
  const id = await containerId(service);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", id, "node", "-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(out).toString("utf8"))
        : reject(new Error(`${service}: ${Buffer.concat(err).toString("utf8")}`)),
    );
  });
}
// GET <path> over HTTP/1.1 with a Host: "<status> <body>".
const HTTP = `
const http = require("node:http");
const [address, host, path] = process.argv.slice(1);
http.get({ host: address, port: 80, path, headers: { host } }, (res) => {
  let body = "";
  res.on("data", (d) => (body += d));
  res.on("end", () => process.stdout.write(res.statusCode + " " + body.trim()));
}).on("error", (e) => process.stdout.write("error " + e.message));`;

const a = await operator("admin@e2e.test", "e2e-admin-password-123");

async function cleanup() {
  const cluster = (await a("GET", "/clusters")).find((c) => c.name === CLUSTER);
  if (cluster) {
    for (const node of await a("GET", `/nodes?clusterId=${cluster.id}`))
      await a("DELETE", `/nodes/${node.id}`);
    for (const site of (await a("GET", `/sites?search=${SITE.name}&pageSize=100`)).items)
      if (site.clusterId === cluster.id) await a("DELETE", `/sites/${site.id}`);
    await a("DELETE", `/clusters/${cluster.id}`);
  }
  let previous = "";
  try {
    previous = JSON.parse(await readFile(STATE, "utf8")).previousUrl;
  } catch {}
  const restored = await a("PUT", "/settings/node-channel", { url: previous });
  assert.equal(restored.url, previous);
  await rm(STATE, { force: true });
  pass(
    `wss cleanup: ${NODE}, ${SITE.name} and ${CLUSTER} removed; node channel URL ${restored.effectiveUrl} (${restored.source}) again`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

// -------------------------------------------- a. the URL opens the entry
// What a run left behind (an interrupted one) goes first; its saved URL stays the one to restore.
const before = await a("GET", "/settings/node-channel");
let state = { previousUrl: before.url };
try {
  state = JSON.parse(await readFile(STATE, "utf8"));
} catch {}
await writeFile(STATE, JSON.stringify(state));
if ((await a("GET", "/clusters")).some((c) => c.name === CLUSTER)) await cleanup();
await writeFile(STATE, JSON.stringify(state));

// The checks; afterwards, also when one failed, the URL in effect before is saved again: later
// sections enroll their nodes with it.
async function checks() {
  const saved = await a("PUT", "/settings/node-channel", { url: URL_WSS });
  assert.deepEqual(saved, { url: URL_WSS, effectiveUrl: URL_WSS, source: "setting" });
  // The proxy's own certificate checks out against the test CA; behind it the console's entry.
  const upgradeRequired = await inProxy(
    `printf 'GET /node-channel HTTP/1.1\\r\\nHost: ${PROXY_HOST}\\r\\nConnection: close\\r\\n\\r\\n' |
   openssl s_client -quiet -connect ${PROXY_HOST}:443 -servername ${PROXY_HOST} -verify_hostname ${PROXY_HOST} \
     -CAfile /shared/wss-ca.pem -verify_return_error 2>/dev/null | head -n 1`,
  );
  assert.match(upgradeRequired, /^HTTP\/1\.1 426 /, upgradeRequired);
  // The node checks the node channel certificate against the URL's host name.
  const names = await waitFor(`the node channel certificate names ${PROXY_HOST}`, async () => {
    const out = await inProxy(
      `openssl s_client -connect console:8443 -servername ${PROXY_HOST} </dev/null 2>/dev/null |
     openssl x509 -noout -ext subjectAltName 2>/dev/null`,
    );
    return out.includes(`DNS:${PROXY_HOST}`) ? out.replace(/\s+/g, " ").trim() : null;
  });
  const cluster = await a("POST", "/clusters", { name: CLUSTER });
  const { site, revision: siteRevision } = await a("POST", "/sites", {
    name: SITE.name,
    clusterId: cluster.id,
    domains: [SITE.domain],
    origins: [{ address: "whoami" }],
  });
  const token = await a("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: NODE,
    ttlMinutes: 15,
  });
  assert.equal(token.serverUrl, URL_WSS);
  assert.ok(
    token.installCommand.includes(`--server ${URL_WSS} --ca-sha256 ${token.caSha256}`),
    token.installCommand,
  );
  pass(
    `${URL_WSS} saved: GET /node-channel through the proxy -> ${upgradeRequired.trim()}; node channel certificate ${names}; install commands carry ${URL_WSS}`,
  );

  // -------------------------------------------- b. enrollment through the proxy
  const enroll = await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      await containerId("node-wss"),
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  const proxyIp = await containerIp("wss-proxy");
  let node;
  await waitFor(
    `${NODE} online`,
    async () => {
      node = (await a("GET", `/nodes?clusterId=${cluster.id}`)).find((n) => n.name === NODE);
      return node?.online;
    },
    120,
  );
  assert.equal(node.remoteAddress, proxyIp, `${NODE} connects from ${node.remoteAddress}`);
  assert.ok(node.certFingerprint, "no client certificate");
  const nodeLog = await run([...compose, "logs", "node-wss"]);
  assert.match(nodeLog, /switched to mTLS channel/, "the agent did not switch to mTLS");
  pass(
    `${NODE} enrolled with ${URL_WSS} (${`${enroll.stdout}\n${enroll.stderr}`.trim().split("\n").pop()}), online over mTLS from the proxy ${proxyIp}`,
  );

  // -------------------------------------------- c. revisions and heartbeats
  const applied = (revision) =>
    waitFor(`${NODE} applies #${revision.revision}`, async () => {
      const n = await a("GET", `/nodes/${node.id}`);
      return n.applyState === "applied" &&
        n.appliedRevision === revision.revision &&
        n.appliedContentHash === revision.contentHash
        ? n
        : null;
    });
  const first = (await a("GET", `/clusters/${cluster.id}`)).latestRevision;
  assert.ok(first.revision >= siteRevision.revision);
  await applied(first);
  const onlineSince = Date.now();
  const firstBeat = (await a("GET", `/nodes/${node.id}`)).lastSeenAt;
  const beats = new Set([firstBeat]);
  const held = await waitFor(
    `${NODE} online with heartbeats for more than 30 seconds`,
    async () => {
      const n = await a("GET", `/nodes/${node.id}`);
      assert.ok(n.online, `${NODE} went offline: ${JSON.stringify(n)}`);
      beats.add(n.lastSeenAt);
      return Date.now() - onlineSince > 30_000 &&
        Date.parse(n.lastSeenAt) - Date.parse(firstBeat) >= 30_000
        ? n
        : null;
    },
    120,
    2000,
  );
  assert.ok(beats.size >= 3, `heartbeats: ${[...beats].join(", ")}`);
  const { revision: second } = await a("PATCH", `/sites/${site.id}`, {
    domains: [SITE.domain, SITE.added],
  });
  assert.ok(second.revision > first.revision);
  await applied(second);
  const nodeIp = await containerIp("node-wss");
  const served = await waitFor(`${NODE} serves ${SITE.added}`, async () => {
    const out = await nodeIn("client-a", HTTP, [nodeIp, SITE.added, "/wss-e2e"]);
    return out.startsWith("200 ") ? out : null;
  });
  assert.match(served, /^200 [\s\S]*GET \/wss-e2e /, served);
  pass(
    `${NODE} applied #${first.revision}, stayed online ${Math.round((Date.now() - onlineSince) / 1000)} s with heartbeats ${[...beats].map((t) => t.slice(11, 19)).join(", ")} (last ${held.lastSeenAt.slice(11, 19)}), then applied #${second.revision} and served ${SITE.added}`,
  );

  // -------------------------------------------- d. the proxy's log
  const upgrades = (await run([...compose, "logs", "--no-log-prefix", "wss-proxy"]))
    .split("\n")
    .filter((l) => l.startsWith("GET /node-channel 101 "));
  assert.ok(upgrades.length >= 1, "the proxy logged no WebSocket upgrade");
  assert.ok(
    upgrades.every((l) => l.endsWith('protocol="edgeweir-node-channel"')),
    upgrades.join("\n"),
  );
  pass(`the proxy upgraded ${upgrades.length} connection(s) to WebSocket (edgeweir-node-channel)`);
}
try {
  await checks();
} finally {
  await a("PUT", "/settings/node-channel", { url: state.previousUrl });
}
console.log("WSS E2E OK");
