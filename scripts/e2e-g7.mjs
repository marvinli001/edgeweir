// Core gaps G7 end to end (layer-4 forwarding), after the G6 step. Cluster A
// (`node`, `node-upgrade-peer`) gets TCP and UDP port pools and L4 apps whose
// origins are the test servers in docker/e2e/l4-origin (l4-origin-a/b: TCP
// echo 7000, UDP echo 7001, PROXY protocol reader 7002). Clients connect
// from client-a / client-b to the nodes' container addresses.
//   a. both nodes report l4-v1
//   b. port pools: replaced and read back with the reserved listener ports;
//      an overlapping pool and an app outside the pools are refused
//   c. TCP echo through both nodes; a long TCP connection keeps echoing
//      across the reload that adding another port causes (new nginx workers)
//   d. UDP echo through both nodes
//   e. PROXY protocol to the origin: v1 and v2 carry the client's address; a
//      listener that accepts PROXY protocol passes the claimed address on
//   f. hot upstream change (origin a -> b) without a reload (same workers)
//   g. an IP block list closes client-b's connections, client-a still works;
//      max connections 1 closes a second concurrent connection
//   h. statistics (connections, refused, bytes) reach the console; the app's
//      CNAME is in the cluster's DNS zone
// State for apps/console/e2e/g7.spec.ts: .e2e/g7-state.json. `node
// scripts/e2e-g7.mjs --cleanup` deletes the apps, the list and the pools.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args) => (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g7-state.json";
const LIST = "g7_block";
const PORTS = { tcp: 20001, reload: 20002, udp: 20003, v1: 20004, v2: 20005, accept: 20006 };

async function waitFor(label, fn, seconds = 180, interval = 1500, detail = () => "") {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(interval);
  }
  const why = await detail();
  throw new Error(`timeout: ${label}${why ? ` (last: ${why})` : ""}`);
}

/** The operator with an AccessKey from the console's RPC, replaced every 500 calls. */
async function operator(email, password) {
  const response = await waitFor(
    `sign in ${email}`,
    async () => {
      const r = await signInResponse(base, email, password);
      return r.status === 200 ? r : null;
    },
    60,
    3000,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const createKey = () => rpc(base, cookie, "accessKeys/create", { name: "g7-e2e" });
  let current = await createKey(),
    calls = 0;
  const raw = async (method, path, body) => {
    if (++calls % 500 === 0) {
      const previous = current;
      current = await createKey();
      await rpc(base, cookie, "accessKeys/revoke", { id: previous.id });
    }
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": current.key },
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
function refused(result, status, code) {
  assert.equal(result.status, status, result.text);
  if (code) assert.equal(result.json?.code, code, result.text);
  return result.json;
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

/** Runs `node -e script args…` in a service with input on stdin; resolves stdout. */
async function nodeIn(service, script, args, input) {
  const id = await containerId(service);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", id, "node", "-e", script, ...args], {
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

// One TCP connection: sends each payload (a string; "\n" ends a line) and
// collects the answer to each (the bytes until the next "\n", or the data
// that arrived within 1.5 s); "closed" when the node closed the connection.
const TCP = `
const net = require("node:net");
const [host, port, payloads] = [process.argv[1], Number(process.argv[2]), JSON.parse(process.argv[3])];
const s = net.connect(port, host);
const answers = [];
let buffer = "", closed = false;
s.on("data", (d) => (buffer += d));
s.on("close", () => (closed = true));
s.on("error", () => (closed = true));
(async () => {
  await new Promise((r) => { s.once("connect", r); s.once("close", r); });
  for (const p of payloads) {
    if (closed) { answers.push("closed"); continue; }
    buffer = "";
    s.write(p);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !closed && !(buffer.includes("\\n") || (!p.endsWith("\\n") && buffer.length >= p.length)))
      await new Promise((r) => setTimeout(r, 20));
    answers.push(buffer ? buffer.replace(/\\n$/, "") : closed ? "closed" : "timeout");
  }
  s.end();
  process.stdout.write(JSON.stringify(answers));
})();`;
const tcp = async (client, host, port, payloads) =>
  JSON.parse(await nodeIn(client, TCP, [host, String(port), JSON.stringify(payloads)]));

const UDP = `
const dgram = require("node:dgram");
const [host, port, payloads] = [process.argv[1], Number(process.argv[2]), JSON.parse(process.argv[3])];
const s = dgram.createSocket("udp4");
const answers = [];
(async () => {
  for (const p of payloads) {
    const reply = new Promise((r) => { s.once("message", (m) => r(m.toString())); setTimeout(() => r("timeout"), 3000); });
    s.send(p, port, host);
    answers.push(await reply);
  }
  s.close();
  process.stdout.write(JSON.stringify(answers));
})();`;
const udp = async (client, host, port, payloads) =>
  JSON.parse(await nodeIn(client, UDP, [host, String(port), JSON.stringify(payloads)]));

// A long TCP connection driven line by line from stdin; prints one JSON line
// per answer or event.
const SESSION = `
const net = require("node:net");
const s = net.connect(Number(process.argv[2]), process.argv[1]);
let buffer = "";
const waiters = [];
s.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    (waiters.shift() ?? (() => {}))(line);
  }
});
s.on("close", () => process.stdout.write(JSON.stringify({ event: "closed" }) + "\\n"));
s.on("error", (e) => process.stdout.write(JSON.stringify({ event: "error", message: e.message }) + "\\n"));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  waiters.push((reply) => process.stdout.write(JSON.stringify({ sent: line, reply }) + "\\n"));
  s.write(line + "\\n");
}).on("close", () => s.end());`;
async function session(client, host, port) {
  const id = await containerId(client);
  const child = spawn("docker", ["exec", "-i", id, "node", "-e", SESSION, host, String(port)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let pending = "";
  child.stdout.on("data", (d) => {
    pending += d;
    for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
      lines.push(JSON.parse(pending.slice(0, i)));
      pending = pending.slice(i + 1);
    }
  });
  return {
    async send(text) {
      const before = lines.length;
      child.stdin.write(`${text}\n`);
      await waitFor(`answer to ${text}`, () => lines.length > before, 10, 50);
      return lines[before];
    },
    close() {
      child.stdin.end();
    },
  };
}

/**
 * PIDs of the nginx worker processes of a node container (a reload replaces
 * them). With active, only workers that are not shutting down: a reload's
 * old generation drains its connections and exits on its own schedule, so
 * whether it is still there says nothing about a later reload.
 */
async function workers(service, { active = false } = {}) {
  const draining = active ? "*'shutting down'*) ;; " : "";
  const script = `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in ${draining}'nginx: worker'*) echo \${p#/proc/};; esac; done`;
  const out = await run(["exec", await containerId(service), "sh", "-c", script]);
  return out.split(/\s+/).filter(Boolean).sort().join(",");
}

// ---------------------------------------------------------------- setup
const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const NODES = ["node", "node-upgrade-peer"];

async function cleanup() {
  for (const app of await a("GET", `/l4-apps?clusterId=${clusterA}`))
    if (app.name.startsWith("g7-")) await a("DELETE", `/l4-apps/${app.id}`);
  const list = (await a("GET", "/ip-lists")).find((l) => l.name === LIST);
  if (list) await a("DELETE", `/ip-lists/${list.id}`);
  await a("PUT", `/clusters/${clusterA}/port-pools`, { pools: [] });
  pass("G7 cleanup: apps, list and pools removed");
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const node = (id) => a("GET", `/nodes/${id}`);
const latestRevision = async () =>
  (await a("GET", `/clusters/${clusterA}`)).latestRevision.revision;
async function synced(label) {
  const latest = await latestRevision();
  await waitFor(`${label} (#${latest})`, async () => {
    const list = [await node(edgeId), await node(peerId)];
    return list.every(
      (n) =>
        n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
    );
  });
}
const create = async (body) => (await a("POST", "/l4-apps", { clusterId: clusterA, ...body })).app;

const apps = {};
let finished = false;
try {
  // -------------------------------------------------------------- a. feature
  await waitFor("both nodes report l4-v1", async () =>
    (await Promise.all([node(edgeId), node(peerId)])).every((n) =>
      n.supportedFeatures.includes("l4-v1"),
    ),
  );
  pass("both nodes report l4-v1");

  // -------------------------------------------------------------- b. port pools
  refused(
    await a.raw("PUT", `/clusters/${clusterA}/port-pools`, {
      pools: [
        { protocol: "tcp", from: 20000, to: 20010 },
        { protocol: "both", from: 20005, to: 20020 },
      ],
    }),
    400,
    "L4_PORT_POOL_OVERLAP",
  );
  const pools = await a("PUT", `/clusters/${clusterA}/port-pools`, {
    pools: [
      { protocol: "tcp", from: 20000, to: 20020 },
      { protocol: "udp", from: 20000, to: 20020 },
    ],
  });
  assert.equal(pools.pools.length, 2);
  assert.ok(pools.reservedPorts.includes(80), JSON.stringify(pools.reservedPorts));
  assert.deepEqual(pools.nodesWithoutL4, []);
  refused(
    await a.raw("POST", "/l4-apps", {
      clusterId: clusterA,
      name: "g7-outside",
      protocol: "tcp",
      port: 30000,
      origins: [{ address: "l4-origin-a", port: 7000 }],
    }),
    400,
    "L4_PORT_OUTSIDE_POOL",
  );
  refused(
    await a.raw("POST", "/l4-apps", {
      clusterId: clusterA,
      name: "g7-udp-proxy",
      protocol: "udp",
      port: 20010,
      proxyProtocolVersion: 1,
      origins: [{ address: "l4-origin-a", port: 7001 }],
    }),
    400,
    "L4_PROXY_PROTOCOL_UNSUPPORTED",
  );
  pass(
    `port pools: tcp and udp 20000-20020 saved (reserved listener ports ${pools.reservedPorts.join(", ")}); an overlapping pool (L4_PORT_POOL_OVERLAP), port 30000 outside the pools (L4_PORT_OUTSIDE_POOL) and PROXY protocol on UDP (L4_PROXY_PROTOCOL_UNSUPPORTED) refused`,
  );

  // -------------------------------------------------------------- c. TCP echo and a reload
  apps.tcp = await create({
    name: "g7-tcp-echo",
    protocol: "tcp",
    port: PORTS.tcp,
    origins: [{ address: "l4-origin-a", port: 7000 }],
  });
  await synced("TCP app published");
  for (const target of NODES) {
    const answers = await waitFor(`TCP echo through ${target}`, async () => {
      const r = await tcp("client-a", target, PORTS.tcp, ["NAME\n", "hello\n"]);
      return r[0] === "a" ? r : null;
    });
    assert.deepEqual(answers, ["a", "hello"]);
  }
  const long = await session("client-a", "node", PORTS.tcp);
  assert.deepEqual(await long.send("before"), { sent: "before", reply: "before" });
  const workersBefore = await workers("node");
  apps.reload = await create({
    name: "g7-tcp-reload",
    protocol: "tcp",
    port: PORTS.reload,
    origins: [{ address: "l4-origin-b", port: 7000 }],
  });
  await synced("second TCP port published");
  const workersAfter = await waitFor("the node reloaded (new workers)", async () => {
    const now = await workers("node");
    return now !== workersBefore ? now : null;
  });
  assert.deepEqual(await long.send("after"), { sent: "after", reply: "after" });
  const reloadAnswer = await tcp("client-a", "node", PORTS.reload, ["NAME\n"]);
  assert.deepEqual(reloadAnswer, ["b"]);
  long.close();
  pass(
    `TCP echo through both nodes on ${PORTS.tcp} (origin a); a long connection echoed "before", the new port ${PORTS.reload} reloaded nginx (workers ${workersBefore} -> ${workersAfter}) and the same connection still echoed "after"; the new port answers (origin b)`,
  );

  // -------------------------------------------------------------- d. UDP echo
  apps.udp = await create({
    name: "g7-udp-echo",
    protocol: "udp",
    port: PORTS.udp,
    origins: [{ address: "l4-origin-a", port: 7001 }],
  });
  await synced("UDP app published");
  for (const target of NODES) {
    const answers = await waitFor(`UDP echo through ${target}`, async () => {
      const r = await udp("client-a", target, PORTS.udp, ["NAME", "ping"]);
      return r[0] === "a" ? r : null;
    });
    assert.deepEqual(answers, ["a", "ping"]);
  }
  pass(`UDP echo through both nodes on ${PORTS.udp}: NAME -> a, ping -> ping`);

  // -------------------------------------------------------------- e. PROXY protocol
  const clientA = await containerIp("client-a");
  const clientB = await containerIp("client-b");
  apps.v1 = await create({
    name: "g7-proxy-v1",
    protocol: "tcp",
    port: PORTS.v1,
    proxyProtocolVersion: 1,
    origins: [{ address: "l4-origin-a", port: 7002 }],
  });
  apps.v2 = await create({
    name: "g7-proxy-v2",
    protocol: "tcp",
    port: PORTS.v2,
    proxyProtocolVersion: 2,
    origins: [{ address: "l4-origin-a", port: 7002 }],
  });
  apps.accept = await create({
    name: "g7-proxy-accept",
    protocol: "tcp",
    port: PORTS.accept,
    acceptProxyProtocol: true,
    proxyProtocolVersion: 2,
    origins: [{ address: "l4-origin-a", port: 7002 }],
  });
  await synced("PROXY protocol apps published");
  const header = async (port, payloads) => {
    const [first, ...rest] = await waitFor(`PROXY header via ${port}`, async () => {
      const r = await tcp("client-a", "node", port, payloads);
      return r[0]?.startsWith("{") ? r : null;
    });
    return { header: JSON.parse(first.split("\n")[0]), rest };
  };
  const v1 = await header(PORTS.v1, ["x\n", "y\n"]);
  assert.equal(v1.header.version, 1);
  assert.equal(v1.header.source, clientA);
  const v2 = await header(PORTS.v2, ["x\n", "y\n"]);
  assert.equal(v2.header.version, 2);
  assert.equal(v2.header.command, "PROXY");
  assert.equal(v2.header.source, clientA);
  const claimed = await header(PORTS.accept, [
    `PROXY TCP4 198.51.100.7 192.0.2.1 4321 ${PORTS.accept}\r\nx\n`,
    "y\n",
  ]);
  assert.equal(claimed.header.version, 2);
  assert.equal(claimed.header.source, "198.51.100.7");
  assert.equal(claimed.header.sourcePort, 4321);
  pass(
    `PROXY protocol to the origin: v1 and v2 headers name client-a (${clientA}); a listener that accepts PROXY protocol passed the claimed 198.51.100.7:4321 on in a v2 header`,
  );

  // -------------------------------------------------------------- f. hot upstream change
  const workersHot = await workers("node", { active: true });
  await a("PATCH", `/l4-apps/${apps.tcp.id}`, {
    origins: [{ address: "l4-origin-b", port: 7000 }],
  });
  await synced("origin change published");
  await waitFor("the TCP app answers from origin b", async () => {
    const r = await tcp("client-a", "node", PORTS.tcp, ["NAME\n"]);
    return r[0] === "b";
  });
  assert.equal(
    await workers("node", { active: true }),
    workersHot,
    "an origin change must not reload nginx",
  );
  pass(
    `hot upstream change: ${PORTS.tcp} moved to origin b without a reload (workers ${workersHot} unchanged)`,
  );

  // -------------------------------------------------------------- g. IP list and limits
  let list = (await a("GET", "/ip-lists")).find((l) => l.name === LIST);
  if (!list) list = await a("POST", "/ip-lists", { name: LIST, entries: [`${clientB}/32`] });
  await a("PATCH", `/l4-apps/${apps.tcp.id}`, { blockListIds: [list.id] });
  await synced("block list published");
  await waitFor("client-b is refused, client-a is served", async () => {
    const b = await tcp("client-b", "node", PORTS.tcp, ["hello\n"]);
    const ok = await tcp("client-a", "node", PORTS.tcp, ["hello\n"]);
    return b[0] === "closed" && ok[0] === "hello";
  });
  await a("PATCH", `/l4-apps/${apps.tcp.id}`, { blockListIds: [], maxConnections: 1 });
  await synced("connection limit published");
  const holder = await session("client-a", "node", PORTS.tcp);
  assert.deepEqual(await holder.send("held"), { sent: "held", reply: "held" });
  const second = await waitFor("a second concurrent connection is refused", async () => {
    const r = await tcp("client-a", "node", PORTS.tcp, ["second\n"]);
    return r[0] === "closed" ? r : null;
  });
  holder.close();
  await waitFor("the slot is free again", async () => {
    const r = await tcp("client-a", "node", PORTS.tcp, ["again\n"]);
    return r[0] === "again";
  });
  await a("PATCH", `/l4-apps/${apps.tcp.id}`, { maxConnections: 0 });
  pass(
    `IP block list closed client-b (${clientB}) while client-a was served; with maxConnections 1 a second concurrent connection was closed (${second[0]}) and served again once the first ended`,
  );

  // -------------------------------------------------------------- h. statistics and DNS
  const from = new Date(Date.now() - 30 * 60_000).toISOString();
  const stats = await waitFor(
    "L4 statistics reach the console",
    async () => {
      const s = await a(
        "GET",
        `/l4-apps/${apps.tcp.id}/stats?from=${from}&to=${new Date(Date.now() + 120_000).toISOString()}`,
      );
      return s.totals.connections > 0 && s.totals.refused > 0 && s.totals.bytesSent > 0 ? s : null;
    },
    180,
    5000,
  );
  const app = await a("GET", `/l4-apps/${apps.tcp.id}`);
  assert.ok(app.dnsTarget, "the app has a DNS target");
  const label = app.dnsTarget.replace(/\.cdn\.m5\.test$/, "");
  const cname = await waitFor("the app's CNAME in the DNS zone", async () => {
    await a("POST", "/dns/reconcile", {});
    const zone = (await (await fetch(`${mock}/records`)).json())["cdn.m5.test"] ?? [];
    return zone.find((r) => r.name === label && r.type === "CNAME");
  });
  pass(
    `statistics: ${stats.totals.connections} connections, ${stats.totals.refused} refused, ${stats.totals.bytesReceived} bytes in / ${stats.totals.bytesSent} bytes out over ${stats.nodes.length} node(s); DNS: ${app.dnsTarget} CNAME ${cname.data}`,
  );

  await writeFile(
    STATE,
    JSON.stringify({
      clusterId: clusterA,
      pools: pools.pools,
      apps: Object.fromEntries(
        Object.entries(apps).map(([k, v]) => [
          k,
          { id: v.id, name: v.name, port: v.port, cnamePrefix: v.cnamePrefix },
        ]),
      ),
    }),
  );
  finished = true;
  console.log("G7 E2E OK");
} finally {
  if (!finished) console.log("G7 E2E FAILED (apps kept for inspection)");
}
