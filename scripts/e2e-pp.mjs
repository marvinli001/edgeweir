// PROXY protocol to HTTP origins and gRPC active health checks, after the
// h2 step. Cluster A (`node`, `node-upgrade-peer`) serves pp.e2e.test,
// whose origins are the test server in docker/e2e/h2-origin: 8081 (HTTP/1.1
// after a PROXY protocol header, answering with what the header said and
// the connection's and request's numbers), 8083 (HTTP/2 and gRPC after a
// PROXY protocol header, with grpc.health.v1) and the control port 8082.
// Clients run in client-a and reach the nodes' container addresses on
// port 80.
//   a. both nodes report origin-proxy-protocol-v1 and active-health-grpc-v1
//   b. PROXY protocol v2, then v1, through both nodes: the origin sees the
//      client's address and port and the node's address and port 80.
//      Origin connections are pooled per client connection in each nginx
//      worker (the edge reaches the origin layer over a new unix socket
//      connection per request, so any worker may take it): 2 x workers + 2
//      sequential requests of one client connection use at most one origin
//      connection per worker, and a second client connection never gets
//      one of them
//   c. without PROXY protocol the origin refuses the connection: 502
//   d. HTTP/2 and gRPC over PROXY protocol v2 (8083): the patched upstream
//      writes the header before the h2c preface
//   e. a gRPC health check (e2e.Echo) through PROXY protocol: the probes
//      reach the origin (the LOCAL command first); NOT_SERVING marks the
//      origin down on both nodes with grpc_not_serving {status
//      NOT_SERVING}, SERVING brings it back
// State for apps/console/e2e/pp.spec.ts: .e2e/pp-state.json (the site, left
// with PROXY protocol v2 to 8083 and the gRPC check).
// `node scripts/e2e-pp.mjs --cleanup` deletes the site and sets the origin
// back to SERVING.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass, stack, waitFor as waitUntil } from "./e2e-lib.mjs";

const { run, containerId } = stack({ profiles: ["upgrades"] });
const STATE = ".e2e/pp-state.json";
const DOMAIN = "pp.e2e.test";

const waitFor = (label, fn, seconds = 180, interval = 1500) =>
  waitUntil(label, fn, seconds, interval);

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
  const key = await rpc(base, cookie, "accessKeys/create", { name: "pp-e2e" });
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

const containerIp = async (service) => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const entry = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert.ok(entry, `${service} is not on the default network`);
  return entry[1].IPAddress;
};

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

// Two GETs over one keep-alive connection, then one over a second: JSON
// [{ status, body, local }] with the client's address and port.
const HTTP = `
const http = require("node:http");
const [address, host, n] = process.argv.slice(1);
function get(agent) {
  return new Promise((resolve) => {
    const req = http.get({ host: address, port: 80, path: "/", headers: { host }, agent }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body: body.trim(),
        local: req.socket.localAddress + ":" + req.socket.localPort }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
  });
}
(async () => {
  const one = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const two = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const first = [];
  for (let i = 0; i < Number(n); i++) first.push(await get(one));
  const second = await get(two);
  one.destroy();
  two.destroy();
  process.stdout.write(JSON.stringify({ first, second }));
})();`;
/** n requests on one client connection, then one on a second: { first, second }. */
const requests = async (address, n = 1) =>
  JSON.parse(await nodeIn("client-a", HTTP, [address, DOMAIN, String(n)]));

/** The number of a node's nginx workers ("nginx: worker process", not shutting down). */
const workers = async (service) =>
  Number(
    (
      await run([
        "exec",
        await containerId(service),
        "sh",
        "-c",
        'n=0; for f in /proc/[0-9]*/cmdline; do [ "$(tr -d "\\0" < "$f" 2>/dev/null)" = "nginx: worker process" ] && n=$((n+1)); done; echo $n',
      ])
    ).trim(),
  );

// GET /proto over HTTP/1.1: "<status> <body>".
const PROTO = `
const http = require("node:http");
const [address, host] = process.argv.slice(1);
http.get({ host: address, port: 80, path: "/proto", headers: { host } }, (res) => {
  let body = "";
  res.on("data", (d) => (body += d));
  res.on("end", () => process.stdout.write(res.statusCode + " " + body.trim()));
}).on("error", (e) => process.stdout.write("error " + e.message));`;

// A gRPC unary call over h2c: JSON { status, messages, grpcStatus }.
const GRPC = `
const http2 = require("node:http2");
const [address, authority] = process.argv.slice(1);
const m = Buffer.from("hello");
const f = Buffer.alloc(5 + m.length); f.writeUInt32BE(m.length, 1); m.copy(f, 5);
const session = http2.connect("http://" + address + ":80");
session.on("error", (e) => { process.stdout.write(JSON.stringify({ error: e.message })); });
const req = session.request({ ":method": "POST", ":path": "/e2e.Echo/Unary", ":authority": authority,
  "content-type": "application/grpc", te: "trailers" });
const out = { messages: [] };
let buffer = Buffer.alloc(0);
req.on("response", (h) => (out.status = h[":status"]));
req.on("data", (d) => (buffer = Buffer.concat([buffer, d])));
req.on("trailers", (t) => (out.grpcStatus = t["grpc-status"]));
req.on("end", () => {
  if (buffer.length >= 5) out.messages.push(buffer.subarray(5, 5 + buffer.readUInt32BE(1)).toString());
  session.close();
  process.stdout.write(JSON.stringify(out));
});
req.on("error", (e) => { out.error = e.message; process.stdout.write(JSON.stringify(out)); session.close(); });
req.end(f);`;

// The test origin's control port: { serving, checks }.
const CONTROL = `
const [path] = process.argv.slice(1);
fetch("http://h2-origin:8082" + path).then((r) => r.text()).then((t) => process.stdout.write(t),
  (e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
const control = async (path) => JSON.parse(await nodeIn("client-a", CONTROL, [path]));

// ---------------------------------------------------------------- setup
const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const NODES = { node: upgrade.nodeId, "node-upgrade-peer": upgrade.peerId };

async function cleanup() {
  for (const site of (await a("GET", `/sites?pageSize=100`)).items ?? [])
    if (site.domains?.includes(DOMAIN)) await a("DELETE", `/sites/${site.id}`);
  await control("/serving/1");
  pass("PROXY protocol cleanup: site removed, the origin SERVING");
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const node = (id) => a("GET", `/nodes/${id}`);
async function synced(label) {
  const latest = (await a("GET", `/clusters/${clusterA}`)).latestRevision.revision;
  await waitFor(`${label} (#${latest})`, async () =>
    (await Promise.all(Object.values(NODES).map(node))).every(
      (n) =>
        n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
    ),
  );
}

// -------------------------------------------------------------- a. features
await waitFor("both nodes report origin-proxy-protocol-v1 and active-health-grpc-v1", async () =>
  (await Promise.all(Object.values(NODES).map(node))).every(
    (n) =>
      n.supportedFeatures.includes("origin-proxy-protocol-v1") &&
      n.supportedFeatures.includes("active-health-grpc-v1"),
  ),
);
pass("both nodes report origin-proxy-protocol-v1 and active-health-grpc-v1");

// -------------------------------------------------------------- b. v2, then v1
await cleanup();
const pp = (proxyProtocolVersion, port = 8081) => [
  { address: "h2-origin", port, proxyProtocolVersion },
];
const { site } = await a("POST", "/sites", {
  name: "pp-e2e",
  clusterId: clusterA,
  domains: [DOMAIN],
  origins: pp(2),
});
assert.equal(site.origins[0].proxyProtocolVersion, 2);
await writeFile(STATE, JSON.stringify({ siteId: site.id }));
await synced("both nodes apply the PROXY protocol site");

const addresses = {};
for (const service of Object.keys(NODES)) addresses[service] = await containerIp(service);
const client = await containerIp("client-a");

/** Checks that the origin saw version v, the client and the node, and the connections. */
async function seen(v) {
  const lines = [];
  for (const [service, address] of Object.entries(addresses)) {
    const n = await workers(service);
    assert.ok(n > 0, `${service}: no nginx workers`);
    const total = 2 * n + 2;
    const out = await waitFor(
      `${service} serves ${DOMAIN} with PROXY protocol v${v}`,
      async () => {
        const o = await requests(address, total);
        return [...o.first, o.second].every(
          (x) => x.status === 200 && x.body.startsWith(`pp=${v} `),
        )
          ? o
          : null;
      },
      60,
    );
    const r = [...out.first, out.second];
    const parsed = r.map((x) => Object.fromEntries(x.body.split(" ").map((kv) => kv.split("="))));
    for (const [i, p] of parsed.entries()) {
      assert.equal(
        p.src,
        r[i].local,
        `${service}: the origin saw ${p.src}, the client is ${r[i].local}`,
      );
      assert.ok(p.src.startsWith(`${client}:`), `${service}: ${p.src} is not client-a`);
      assert.equal(p.dst, `${address}:80`, `${service}: destination ${p.dst}`);
    }
    const first = parsed.slice(0, total);
    const last = parsed[total];
    const conns = new Set(first.map((p) => p.conn));
    assert.ok(
      conns.size <= n,
      `${service}: ${total} requests of one client connection used ${conns.size} origin connections, more than the ${n} workers: ${JSON.stringify(first)}`,
    );
    // Each origin connection served its requests in order: reused, not reopened.
    for (const conn of conns) {
      const reqs = first.filter((p) => p.conn === conn).map((p) => Number(p.req));
      assert.deepEqual(
        reqs,
        reqs.map((_, i) => i + 1),
        `${service}: origin connection ${conn}: ${JSON.stringify(first)}`,
      );
    }
    assert.ok(
      !conns.has(last.conn) && last.req === "1",
      `${service}: a second client connection got origin connection ${last.conn} (req ${last.req}) of the first: ${JSON.stringify(parsed)}`,
    );
    lines.push(
      `${service}: ${r[0].body}; ${total} requests on ${conns.size} origin connections (${n} workers)`,
    );
  }
  return lines;
}
pass(
  `PROXY protocol v2 through both nodes, origin connections pooled per client connection and worker (${(await seen(2)).join("; ")})`,
);

await a("PATCH", `/sites/${site.id}`, { origins: pp(1) });
await synced("both nodes apply PROXY protocol v1");
pass(`PROXY protocol v1 through both nodes (${(await seen(1)).join("; ")})`);

// -------------------------------------------------------------- c. none
await a("PATCH", `/sites/${site.id}`, { origins: pp(0) });
await synced("both nodes apply the origin without PROXY protocol");
for (const [service, address] of Object.entries(addresses)) {
  const {
    first: [r],
  } = await requests(address);
  assert.equal(r.status, 502, `${service} without PROXY protocol: ${JSON.stringify(r)}`);
}
pass("without PROXY protocol the origin closes the connection: 502 on both nodes");

// -------------------------------------------------------------- d. HTTP/2 and gRPC
const current = (await a("GET", `/sites/${site.id}`)).originSettings;
await a("PATCH", `/sites/${site.id}`, {
  origins: pp(2, 8083),
  originSettings: { ...current, protocol: "http2", grpc: true },
});
await synced("both nodes apply HTTP/2 and gRPC to the PROXY protocol origin");
for (const [service, address] of Object.entries(addresses)) {
  const r = await waitFor(
    `${service} serves /proto over HTTP/2 with PROXY protocol`,
    async () => {
      const out = await nodeIn("client-a", PROTO, [address, DOMAIN]);
      return out.startsWith("200 ") ? out : null;
    },
    60,
  );
  assert.equal(r, `200 HTTP/2.0 ${DOMAIN}`, `${service}: ${r}`);
  const call = JSON.parse(await nodeIn("client-a", GRPC, [address, DOMAIN]));
  assert.equal(call.status, 200, `${service} gRPC: ${JSON.stringify(call)}`);
  assert.equal(call.grpcStatus, "0", `${service} gRPC: ${JSON.stringify(call)}`);
  assert.deepEqual(
    call.messages,
    [`echo:hello authority=${DOMAIN} te=trailers`],
    `${service} gRPC`,
  );
}
pass("HTTP/2 and gRPC to an origin that reads PROXY protocol v2 first, through both nodes");

// -------------------------------------------------------------- e. gRPC health check
const settings = (await a("GET", `/sites/${site.id}`)).originSettings;
const { site: checked } = await a("PATCH", `/sites/${site.id}`, {
  originSettings: {
    ...settings,
    activeHealthCheck: {
      ...settings.activeHealthCheck,
      enabled: true,
      type: "grpc",
      grpcService: "e2e.Echo",
      intervalSeconds: 5,
      timeoutSeconds: 2,
      healthyThreshold: 1,
      unhealthyThreshold: 1,
    },
  },
});
assert.equal(checked.originSettings.activeHealthCheck.type, "grpc");
await synced("both nodes apply the gRPC health check");
const before = (await control("/checks")).checks["e2e.Echo"] ?? 0;
await waitFor("both nodes probe e2e.Echo over PROXY protocol", async () => {
  const now = (await control("/checks")).checks["e2e.Echo"] ?? 0;
  return now >= before + 4;
});
const originId = checked.origins[0].id;
const health = async () =>
  ((await a("GET", `/sites/${site.id}/origin-health`)) ?? []).find((h) => h.originId === originId);
const active = (h) => (h?.nodes ?? []).filter((n) => n.source === "active");
pass("both nodes call grpc.health.v1.Health/Check for e2e.Echo through PROXY protocol");

await control("/serving/0");
const down = await waitFor(
  "both nodes mark the origin down: grpc_not_serving",
  async () => {
    const h = await health();
    const entries = active(h);
    return entries.length === 2 &&
      entries.every(
        (n) =>
          !n.healthy &&
          n.lastErrorCode === "grpc_not_serving" &&
          n.lastErrorParams.status === "NOT_SERVING",
      )
      ? h
      : null;
  },
  120,
  2000,
);
assert.equal(down.downNodes, 2, JSON.stringify(down));
pass("NOT_SERVING marks the origin down on both nodes (grpc_not_serving {status: NOT_SERVING})");

await control("/serving/1");
await waitFor(
  "both nodes bring the origin back",
  async () => {
    const h = await health();
    return active(h).every((n) => n.healthy) && (h?.downNodes ?? 0) === 0;
  },
  120,
  2000,
);
for (const [service, address] of Object.entries(addresses)) {
  const r = await waitFor(
    `${service} serves ${DOMAIN} again`,
    async () => {
      const out = await nodeIn("client-a", PROTO, [address, DOMAIN]);
      return out.startsWith("200 ") ? out : null;
    },
    60,
  );
  assert.equal(r, `200 HTTP/2.0 ${DOMAIN}`);
}
pass("SERVING brings the origin back on both nodes");
