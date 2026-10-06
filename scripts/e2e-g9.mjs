// Site parity G9 end to end (listener ports, client address, HTTPS redirect
// options, layer-4 additions), after G8. `node` and `node-upgrade-peer` serve
// the default cluster; client-a and client-b reach them by name.
//   a. both nodes report edge-ports-v1, client-ip-v1 and l4-v2
//   b. the default cluster listens on 8081 (HTTP) and 9443 (HTTPS) besides 80
//      and 443: ports.g9.test (bound to 8081 and 9443) answers there and is
//      an unknown host (404) on 80; other.g9.test (80 and 443) is unknown on
//      8081; on 9443 the TLS handshake follows the SNI: ports.g9.test gets
//      its certificate, other.g9.test (bound to 443 only) is refused
//   c. force HTTPS with 308 to :9443, a domain excluded from it
//   d. a layer-4 port range (two ports echo) and a TCP application that
//      terminates TLS (openssl s_client echoes through it; a foreign SNI is
//      refused)
//   e. a new listener port (a reload) keeps an open layer-4 connection
//   f. cluster g9-proxy behind g9-lb, a load balancer sending PROXY protocol
//      v2: the rule field ip.src, a ban and the origin's X-Real-IP are the
//      real client (client-a), ip.peer and X-Forwarded-For the balancer; a
//      connection without the header is refused
//   g. the trusted header mode: X-Forwarded-For counts from a trusted peer
//      (client-b) only; an untrusted one (client-a) keeps its own address
// The G9 sites, applications, cluster g9-proxy and its node stay for
// apps/console/e2e/g9.spec.ts (.e2e/g9-state.json); `node scripts/e2e-g9.mjs
// --cleanup` removes them and the extra listener ports, except the bench
// site proxy-bench.g9.test (BENCH_SCENARIO=proxy in scripts/bench.sh).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g9-state.json";
const NODE_IMAGE = `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`;

const HOST_PORTS = "ports.g9.test";
const HOST_OTHER = "other.g9.test";
const HOST_KEEP = "keep.g9.test";
const HOST_PROXY = "proxy.g9.test";
const HOST_BENCH = "proxy-bench.g9.test";
const HOST_TLS = "l4tls.g9.test";
const HOSTS = [HOST_PORTS, HOST_OTHER, HOST_KEEP, HOST_PROXY];
const NODES = ["node", "node-upgrade-peer"];
const PROXY_CLUSTER = "g9-proxy";
const L4_POOL = { protocol: "tcp", from: 25000, to: 25020 };

async function waitFor(label, fn, seconds = 180, interval = 1000, detail = () => "") {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  const why = detail();
  throw new Error(`timeout: ${label}${why ? ` (last: ${why})` : ""}`);
}

async function call(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function createKey(cookie) {
  return (await rpc(base, cookie, "accessKeys/create", { name: "g9-e2e" })).key;
}

async function actor(email, password) {
  const response = await waitFor(
    `sign in ${email}`,
    async () => {
      const r = await signInResponse(base, email, password);
      return r.status === 200 ? r : null;
    },
    60,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const user = { cookie, key: await createKey(cookie) };
  let calls = 0;
  user.raw = async (method, path, body) => {
    if (++calls % 500 === 0) user.key = await createKey(user.cookie);
    return call(user.key, method, path, body);
  };
  user.ok = async (method, path, body) => {
    const result = await user.raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  return user;
}

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};
const project = JSON.parse(await run(["inspect", await containerId("node")]))[0].Config.Labels[
  "com.docker.compose.project"
];
/** Containers started here carry this label; scripts/e2e.sh removes them on exit. */
const LABEL = `dev.edgeweir.e2e-g9=${project}`;
const EDGE_CONTAINER = `${project}-g9-edge`;

/** Runs `node -e script` in a compose service with `input` on stdin; resolves stdout. */
async function nodeIn(service, script, input) {
  const id = await containerId(service);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", id, "node", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(input ?? "");
  });
}

/** Sequential HTTP(S) requests from a client, with the raw header lines. */
const REQUESTS = `
const http = require("node:http");
const https = require("node:https");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      const lib = r.tls ? https : http;
      const req = lib.request({ host: r.target, port: r.port ?? (r.tls ? 443 : 80), path: r.path ?? "/",
        method: r.method ?? "GET", headers, agent: false, timeout: 20000,
        servername: r.tls ? r.servername ?? r.host : undefined, rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
          cert: r.tls ? res.socket.getPeerCertificate?.()?.subject?.CN ?? "" : "" }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message, headers: {}, rawHeaders: [], body: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list, client = "client-a") =>
  list.length ? JSON.parse(await nodeIn(client, REQUESTS, JSON.stringify(list))) : [];
const request = async (r, client) => (await requests([r], client))[0];
/** The value of a request header the whoami origin echoed ("" without one). */
const echoed = (r, name) =>
  r.body
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}: `))
    ?.slice(name.length + 2) ?? "";
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"} ${r.headers.location ?? ""}${r.error ? ` ${r.error}` : ""}`;

/** One TCP exchange from a client: sends each line, reads one line per line sent. */
const TCP = `
const net = require("node:net");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const { host, port, lines } = JSON.parse(input);
  const socket = net.connect({ host, port });
  const got = [];
  let buffer = "";
  socket.setTimeout(10000, () => { socket.destroy(); process.stdout.write(JSON.stringify({ got, error: "timeout" })); });
  socket.on("connect", () => socket.write(lines[0] + "\\n"));
  socket.on("data", (d) => {
    buffer += d;
    while (buffer.includes("\\n")) {
      const i = buffer.indexOf("\\n");
      got.push(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (got.length < lines.length) socket.write(lines[got.length] + "\\n");
      else { socket.end(); process.stdout.write(JSON.stringify({ got })); }
    }
  });
  socket.on("error", (e) => process.stdout.write(JSON.stringify({ got, error: e.code })));
});`;
const tcp = async (host, port, lines, client = "client-a") =>
  JSON.parse(await nodeIn(client, TCP, JSON.stringify({ host, port, lines })));

/**
 * A TCP connection held open by client-a: says NAME, then waits for a line
 * on stdin before saying it again on the same connection.
 */
const LONG = `
const net = require("node:net");
const [host, port] = process.argv.slice(1);
const socket = net.connect({ host, port: Number(port) });
let n = 0;
socket.on("connect", () => socket.write("NAME\\n"));
socket.on("data", (d) => {
  process.stdout.write(\`reply \${++n} \${d.toString().trim()}\\n\`);
  if (n === 2) socket.end();
});
socket.on("close", () => { process.stdout.write("closed\\n"); process.exit(0); });
socket.on("error", (e) => { process.stdout.write(\`error \${e.code}\\n\`); process.exit(0); });
process.stdin.on("data", () => socket.write("again\\n"));`;

async function removeContainers() {
  const ids = (await run(["ps", "-aq", "--filter", `label=${LABEL}`])).split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  return ids.length;
}

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
const everyNode = (label, check, ids = [edgeId, peerId], seconds = 120) =>
  waitFor(
    label,
    async () => {
      lastNodes = await Promise.all(ids.map(nodeById));
      return lastNodes.every(check) ? lastNodes : null;
    },
    seconds,
    1000,
    () =>
      JSON.stringify(
        lastNodes.map((n) => ({
          name: n.name,
          online: n.online,
          applied: n.appliedRevision,
          state: n.applyState,
          message: n.applyMessage,
        })),
      ),
  );
const latestRevision = async (id = clusterId) =>
  (await admin.ok("GET", `/clusters/${id}`)).latestRevision.revision;
async function synced(label = "nodes on the latest revision", id = clusterId, ids) {
  const latest = await latestRevision(id);
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
    ids,
  );
  return latest;
}
const findSite = async (domain) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(domain)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(domain),
  );

async function cleanup() {
  const removedContainers = await removeContainers();
  let removed = 0;
  for (const host of HOSTS) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  for (const app of await admin.ok("GET", `/l4-apps?clusterId=${clusterId}`))
    if (app.name.startsWith("g9-")) await admin.ok("DELETE", `/l4-apps/${app.id}`);
  const proxy = (await admin.ok("GET", "/clusters")).find((c) => c.name === PROXY_CLUSTER);
  if (proxy) {
    for (const site of (await admin.ok("GET", `/sites?clusterId=${proxy.id}&pageSize=100`)).items)
      await admin.ok("DELETE", `/sites/${site.id}`);
    for (const node of await admin.ok("GET", `/nodes?clusterId=${proxy.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${proxy.id}`);
  }
  await admin.ok("PUT", `/clusters/${clusterId}/listen-ports`, { httpPorts: [], httpsPorts: [] });
  const pools = (await admin.ok("GET", `/clusters/${clusterId}/port-pools`)).pools.filter(
    (p) => !(p.from === L4_POOL.from && p.to === L4_POOL.to),
  );
  await admin.ok("PUT", `/clusters/${clusterId}/port-pools`, { pools });
  for (const cert of await admin.ok("GET", "/certificates"))
    if (cert.name.startsWith("g9-")) await admin.raw("DELETE", `/certificates/${cert.id}`);
  pass(
    `G9 cleanup: ${removed} site(s), cluster ${proxy ? PROXY_CLUSTER : "(none)"}, extra ports and ${removedContainers} container(s) removed`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

async function createSite(name, domains, extra = {}, cluster = clusterId) {
  for (const domain of domains) {
    const old = await findSite(domain);
    if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  }
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains,
    origins: [{ address: "whoami" }],
    clusterId: cluster,
    ...extra,
  });
  return site;
}

/** A self-signed certificate for the G9 names (host openssl). */
async function certificate() {
  const dir = await mkdtemp(join(tmpdir(), "g9-"));
  const names = [HOST_PORTS, HOST_OTHER, HOST_KEEP, HOST_TLS].map((n) => `DNS:${n}`).join(",");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-days",
    "7",
    "-subj",
    `/CN=${HOST_PORTS}`,
    "-addext",
    `subjectAltName=${names}`,
  ]);
  const pem = {
    chainPem: await readFile(join(dir, "cert.pem"), "utf8"),
    privateKeyPem: await readFile(join(dir, "key.pem"), "utf8"),
  };
  await rm(dir, { recursive: true, force: true });
  return pem;
}

let finished = false;
try {
  await removeContainers();
  // -------------------------------------------------------------- a. features
  await everyNode("both nodes report edge-ports-v1, client-ip-v1 and l4-v2", (n) =>
    ["edge-ports-v1", "client-ip-v1", "l4-v2"].every((f) => n.supportedFeatures.includes(f)),
  );
  pass("a. both nodes report edge-ports-v1, client-ip-v1 and l4-v2");

  // -------------------------------------------------------------- b. ports
  const cert = await admin.ok("POST", "/certificates", {
    name: "g9-ports",
    ...(await certificate()),
  });
  await admin.ok("PUT", `/clusters/${clusterId}/listen-ports`, {
    httpPorts: [8081],
    httpsPorts: [9443],
  });
  const ports = await createSite("g9-ports", [HOST_PORTS, HOST_KEEP]);
  await admin.ok("PUT", `/sites/${ports.id}/https`, { settings: { certificateId: cert.id } });
  await admin.ok("PATCH", `/sites/${ports.id}`, { ports: { http: [8081], https: [9443] } });
  const other = await createSite("g9-other", [HOST_OTHER]);
  await admin.ok("PUT", `/sites/${other.id}/https`, { settings: { certificateId: cert.id } });
  await synced("ports published");
  for (const target of NODES) {
    const [onPort, on80, otherOnPort, other80, tlsPort, tlsOther, tls443] = await requests([
      { target, port: 8081, host: HOST_PORTS, path: "/p" },
      { target, port: 80, host: HOST_PORTS, path: "/p" },
      { target, port: 8081, host: HOST_OTHER, path: "/p" },
      { target, port: 80, host: HOST_OTHER, path: "/p" },
      { target, port: 9443, host: HOST_PORTS, path: "/p", tls: true },
      { target, port: 9443, host: HOST_OTHER, path: "/p", tls: true },
      { target, port: 443, host: HOST_OTHER, path: "/p", tls: true },
    ]);
    assert.equal(onPort.status, 200, `${target} ${HOST_PORTS}:8081 ${summary(onPort)}`);
    assert.equal(on80.status, 404, `${target} ${HOST_PORTS}:80 ${summary(on80)}`);
    assert.equal(on80.headers["x-edgeweir-error"], "unknown-host");
    assert.equal(otherOnPort.status, 404, `${target} ${HOST_OTHER}:8081 ${summary(otherOnPort)}`);
    assert.equal(other80.status, 200, `${target} ${HOST_OTHER}:80 ${summary(other80)}`);
    assert.equal(tlsPort.status, 200, `${target} https ${HOST_PORTS}:9443 ${summary(tlsPort)}`);
    assert.equal(tlsPort.cert, HOST_PORTS);
    assert.equal(tlsOther.status, 0, `${target} https ${HOST_OTHER}:9443 ${summary(tlsOther)}`);
    assert.equal(tls443.status, 200, `${target} https ${HOST_OTHER}:443 ${summary(tls443)}`);
  }
  pass(
    `b. ${HOST_PORTS} on 8081 and 9443 (404 on 80), ${HOST_OTHER} unknown on 8081 and its handshake refused on 9443 (served on 80 and 443), on both nodes`,
  );

  // -------------------------------------------------------------- c. redirect
  await admin.ok("PUT", `/sites/${ports.id}/https`, {
    settings: {
      certificateId: cert.id,
      forceHttps: true,
      redirectStatus: 308,
      redirectPort: 9443,
      redirectExcludedDomains: [HOST_KEEP],
    },
  });
  await synced("redirect published");
  for (const target of NODES) {
    const [redirect, kept] = await requests([
      { target, port: 8081, host: HOST_PORTS, path: "/x?y=1" },
      { target, port: 8081, host: HOST_KEEP, path: "/x" },
    ]);
    assert.equal(redirect.status, 308, `${target} ${summary(redirect)}`);
    assert.equal(redirect.headers.location, `https://${HOST_PORTS}:9443/x?y=1`);
    assert.equal(kept.status, 200, `${target} excluded ${summary(kept)}`);
  }
  pass(`c. force HTTPS: 308 to https://${HOST_PORTS}:9443/x?y=1, ${HOST_KEEP} excluded`);

  // -------------------------------------------------------------- d. layer 4
  const pools = (await admin.ok("GET", `/clusters/${clusterId}/port-pools`)).pools;
  if (!pools.some((p) => p.from === L4_POOL.from && p.to === L4_POOL.to))
    await admin.ok("PUT", `/clusters/${clusterId}/port-pools`, { pools: [...pools, L4_POOL] });
  for (const app of await admin.ok("GET", `/l4-apps?clusterId=${clusterId}`))
    if (app.name.startsWith("g9-")) await admin.ok("DELETE", `/l4-apps/${app.id}`);
  const range = await admin.ok("POST", "/l4-apps", {
    clusterId,
    name: "g9-range",
    protocol: "tcp",
    port: 25000,
    portEnd: 25001,
    origins: [{ address: "l4-origin-a", port: 7000 }],
  });
  const tlsApp = await admin.ok("POST", "/l4-apps", {
    clusterId,
    name: "g9-tls",
    protocol: "tcp",
    port: 25010,
    certificateId: cert.id,
    origins: [{ address: "l4-origin-b", port: 7000 }],
  });
  await synced("layer-4 range and TLS published");
  for (const target of NODES)
    for (const port of [25000, 25001]) {
      const r = await tcp(target, port, ["NAME", "ping"]);
      assert.deepEqual(r.got, ["l4-origin-a", "ping"], `${target}:${port} ${JSON.stringify(r)}`);
    }
  const peer = await containerId("node-upgrade-peer");
  const sClient = async (servername) => {
    try {
      return await run([
        "exec",
        peer,
        "sh",
        "-c",
        `(echo NAME; sleep 2) | openssl s_client -quiet -connect node:25010 -servername ${servername} 2>/dev/null`,
      ]);
    } catch (error) {
      return `error ${error.code ?? ""}`;
    }
  };
  assert.equal((await sClient(HOST_TLS)).trim(), "l4-origin-b", "TLS echo");
  assert.notEqual((await sClient("nope.example")).trim(), "l4-origin-b", "foreign SNI");
  pass(
    `d. layer-4 range ${range.app.port}-${range.app.portEnd} echoes on both ports; ${tlsApp.app.name} terminates TLS for ${HOST_TLS} (openssl s_client), a foreign SNI is refused`,
  );

  // -------------------------------------------------------------- e. reload
  const long = spawn(
    "docker",
    ["exec", "-i", await containerId("client-a"), "node", "-e", LONG, "node", "25000"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let out = "";
  long.stdout.on("data", (d) => (out += d));
  await waitFor("long connection open", async () => out.includes("reply 1"), 20);
  const before = await latestRevision();
  await admin.ok("PUT", `/clusters/${clusterId}/listen-ports`, {
    httpPorts: [8081, 8082],
    httpsPorts: [9443],
  });
  assert.ok((await latestRevision()) > before, "new port published");
  await synced("new port applied (reload)");
  const fresh = await request({ target: "node", port: 8082, host: HOST_OTHER, path: "/" });
  assert.equal(fresh.status, 404, `8082 answers: ${summary(fresh)}`);
  long.stdin.write("go\n");
  await waitFor(
    "reply on the old connection",
    async () => out.includes("reply 2") || out.includes("closed"),
    20,
  );
  long.kill();
  assert.match(out, /reply 2 again/, `long connection after the reload: ${out}`);
  pass("e. adding listener port 8082 (reload) keeps an open layer-4 connection; 8082 answers");

  // -------------------------------------------------------------- f. PROXY v2
  const network = Object.keys(
    JSON.parse(await run(["inspect", await containerId("node")]))[0].NetworkSettings.Networks,
  ).find((name) => name.endsWith("_default"));
  assert.ok(network, "node is not on the default network");
  const existing = (await admin.ok("GET", "/clusters")).find((c) => c.name === PROXY_CLUSTER);
  if (existing) {
    for (const site of (await admin.ok("GET", `/sites?clusterId=${existing.id}&pageSize=100`))
      .items)
      await admin.ok("DELETE", `/sites/${site.id}`);
    for (const node of await admin.ok("GET", `/nodes?clusterId=${existing.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${existing.id}`);
  }
  const proxyCluster = await admin.ok("POST", "/clusters", { name: PROXY_CLUSTER });
  await run([
    "run",
    "-d",
    "--name",
    EDGE_CONTAINER,
    "--label",
    LABEL,
    "--hostname",
    "edge-g9",
    "--network",
    network,
    "--network-alias",
    "g9-edge",
    "-v",
    `${project}_origin-ca:/etc/edgeweir-e2e:ro`,
    "-e",
    "EDGEWEIR_TRUSTED_CA=/etc/edgeweir-e2e/origin-ca.pem",
    NODE_IMAGE,
  ]);
  const token = await admin.ok("POST", "/enrollment-tokens", {
    clusterId: proxyCluster.id,
    nodeName: "edge-g9",
    ttlMinutes: 15,
  });
  await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      EDGE_CONTAINER,
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  let edge;
  await waitFor(
    "edge-g9 online",
    async () => {
      edge = (await admin.ok("GET", `/nodes?clusterId=${proxyCluster.id}`)).find(
        (n) => n.name === "edge-g9",
      );
      return edge?.online && edge.supportedFeatures.includes("client-ip-v1");
    },
    120,
    1000,
    () => JSON.stringify(edge ?? null),
  );
  const proxySite = await createSite("g9-proxy", [HOST_PROXY, HOST_BENCH], {}, proxyCluster.id);
  await admin.ok("PUT", `/sites/${proxySite.id}/rules`, {
    rules: [
      {
        name: "g9 src",
        phase: "response-transform",
        enabled: true,
        expression: "true",
        action: { kind: "response_header", header: "x-src", expression: "to_string(ip.src)" },
      },
      {
        name: "g9 peer",
        phase: "response-transform",
        enabled: true,
        expression: "true",
        action: { kind: "response_header", header: "x-peer", expression: "to_string(ip.peer)" },
      },
    ],
  });
  await admin.ok("PUT", `/clusters/${proxyCluster.id}/client-ip`, {
    settings: { mode: "proxy_protocol" },
  });
  await synced("PROXY protocol published", proxyCluster.id, [edge.id]);
  const ipOf = async (service) =>
    Object.values(
      JSON.parse(await run(["inspect", await containerId(service)]))[0].NetworkSettings.Networks,
    ).find((n) => n.NetworkID && n.IPAddress).IPAddress;
  const clientA =
    (
      await nodeIn(
        "client-a",
        "process.stdout.write(require('os').networkInterfaces().eth0?.find((a)=>a.family==='IPv4')?.address ?? '')",
      )
    ).trim() || (await ipOf("client-a"));
  const clientB =
    (
      await nodeIn(
        "client-b",
        "process.stdout.write(require('os').networkInterfaces().eth0?.find((a)=>a.family==='IPv4')?.address ?? '')",
      )
    ).trim() || (await ipOf("client-b"));
  const lb = await ipOf("g9-lb");
  const viaLb = await request({ target: "g9-lb", port: 80, host: HOST_PROXY, path: "/who" });
  assert.equal(viaLb.status, 200, `via the balancer: ${summary(viaLb)}`);
  assert.equal(echoed(viaLb, "X-Real-Ip"), clientA, "origin X-Real-IP");
  assert.equal(viaLb.headers["x-src"], clientA, "ip.src");
  assert.equal(viaLb.headers["x-peer"], lb, "ip.peer");
  assert.equal(echoed(viaLb, "X-Forwarded-For"), lb, "X-Forwarded-For");
  const direct = await request({ target: "g9-edge", port: 80, host: HOST_PROXY, path: "/who" });
  assert.equal(direct.status, 0, `a connection without PROXY header: ${summary(direct)}`);
  const ban = await admin.ok("POST", "/bans", {
    scope: "site",
    siteId: proxySite.id,
    cidr: clientA,
    reason: "other",
    durationSeconds: 600,
  });
  await waitFor(
    "ban applied",
    async () =>
      (await request({ target: "g9-lb", port: 80, host: HOST_PROXY, path: "/b" })).status === 403,
    60,
  );
  const otherClient = await request(
    { target: "g9-lb", port: 80, host: HOST_PROXY, path: "/b" },
    "client-b",
  );
  assert.equal(otherClient.status, 200, `client-b through the balancer: ${summary(otherClient)}`);
  await admin.ok("DELETE", `/bans/${ban.id ?? ban.ban?.id}`);
  pass(
    `f. through g9-lb (PROXY v2): ip.src and X-Real-IP ${clientA}, ip.peer and X-Forwarded-For ${lb}; a ban on ${clientA} answers 403 while client-b passes; a direct connection is refused`,
  );

  // -------------------------------------------------------------- g. header
  await admin.ok("PUT", `/clusters/${proxyCluster.id}/client-ip`, {
    settings: { mode: "header", trustedCidrs: [`${clientB}/32`], header: "x-forwarded-for" },
  });
  await synced("trusted header mode published", proxyCluster.id, [edge.id]);
  const trusted = await request(
    {
      target: "g9-edge",
      port: 80,
      host: HOST_PROXY,
      path: "/t",
      headers: { "x-forwarded-for": "203.0.113.50" },
    },
    "client-b",
  );
  assert.equal(trusted.status, 200, summary(trusted));
  assert.equal(trusted.headers["x-src"], "203.0.113.50", "trusted peer: the header's client");
  assert.equal(trusted.headers["x-peer"], clientB);
  assert.equal(echoed(trusted, "X-Real-Ip"), "203.0.113.50");
  assert.equal(echoed(trusted, "X-Forwarded-For"), `203.0.113.50, ${clientB}`);
  const untrusted = await request({
    target: "g9-edge",
    port: 80,
    host: HOST_PROXY,
    path: "/t",
    headers: { "x-forwarded-for": "203.0.113.51" },
  });
  assert.equal(untrusted.headers["x-src"], clientA, "untrusted peer keeps its address");
  assert.equal(echoed(untrusted, "X-Real-Ip"), clientA);
  pass(
    `g. trusted header mode: X-Forwarded-For from ${clientB} names 203.0.113.50; from ${clientA} (untrusted) it is ignored`,
  );
  // The balancer path stays for the bench (BENCH_SCENARIO=proxy).
  await admin.ok("PUT", `/clusters/${proxyCluster.id}/client-ip`, {
    settings: { mode: "proxy_protocol" },
  });
  await synced("PROXY protocol again", proxyCluster.id, [edge.id]);

  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        clusterId,
        proxyClusterId: proxyCluster.id,
        portsSiteId: ports.id,
        otherSiteId: other.id,
        proxySiteId: proxySite.id,
        rangeAppId: range.app.id,
        tlsAppId: tlsApp.app.id,
        certificateId: cert.id,
      },
      null,
      2,
    )}\n`,
  );
  finished = true;
  console.log("G9 E2E OK");
} finally {
  if (!finished) {
    for (const service of ["node", "g9-lb"])
      try {
        console.log(
          `--- ${service} logs ---\n${(await run([...compose, "logs", "--tail=60", service])).slice(-6000)}`,
        );
      } catch {}
    try {
      console.log(
        `--- ${EDGE_CONTAINER} logs ---\n${(await run(["logs", "--tail=80", EDGE_CONTAINER])).slice(-6000)}`,
      );
    } catch {}
  }
}
