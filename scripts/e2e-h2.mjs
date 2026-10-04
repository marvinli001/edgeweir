// HTTP/2 to origins and end-to-end gRPC, after the G7 step. Cluster A
// (`node`, `node-upgrade-peer`) serves h2.e2e.test, whose origin is the test
// server in docker/e2e/h2-origin (h2-origin:8080, HTTP/2 with prior
// knowledge only, gRPC echo methods). Clients run in client-a and reach the
// nodes' container addresses on port 80.
//   a. both nodes report origin-http2-v1
//   b. gRPC without HTTP/2 is refused (ORIGIN_GRPC_REQUIRES_HTTP2); the site
//      is created with HTTP/2 and gRPC
//   c. through both nodes over HTTP/1.1, the origin sees HTTP/2 and the Host
//   d. gRPC through both nodes over h2c: unary (TE and Host reach the
//      origin), bidirectional streaming (each message only after the echo
//      of the one before) and an error status in the trailers
//   e. omitted from an update, HTTP/2 and gRPC stay; back on HTTP/1.1 the
//      nodes no longer reach the h2c-only origin (its HTTP/2 answer to an
//      HTTP/1.1 request is no HTTP/1.1 response: nginx passes such bytes on
//      as an HTTP/0.9 body, or answers 502)
// State for apps/console/e2e/h2.spec.ts: .e2e/h2-state.json (the site, left
// on HTTP/1.1). `node scripts/e2e-h2.mjs --cleanup` deletes the site.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args) => (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/h2-state.json";
const DOMAIN = "h2.e2e.test";

async function waitFor(label, fn, seconds = 180, interval = 1500) {
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
  const key = await rpc(base, cookie, "accessKeys/create", { name: "h2-e2e" });
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
const get = (address, path) => nodeIn("client-a", HTTP, [address, DOMAIN, path]);

// The three gRPC calls over h2c: { unary, bidi, fail } as JSON.
const GRPC = `
const http2 = require("node:http2");
const [address, authority, port = "80"] = process.argv.slice(1);
const frame = (s) => { const m = Buffer.from(s); const b = Buffer.alloc(5 + m.length); b.writeUInt32BE(m.length, 1); m.copy(b, 5); return b; };
const session = http2.connect("http://" + address + ":" + port);
session.on("error", () => {});
function call(method, onMessage, start) {
  return new Promise((resolve) => {
    const req = session.request({ ":method": "POST", ":path": "/e2e.Echo/" + method, ":authority": authority,
      "content-type": "application/grpc", te: "trailers" });
    const out = { messages: [] };
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { out.error = "timeout"; req.close(); resolve(out); }, 10000);
    req.on("response", (h) => (out.status = h[":status"]));
    req.on("data", (d) => {
      buffer = Buffer.concat([buffer, d]);
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const n = buffer.readUInt32BE(1);
        const m = buffer.subarray(5, 5 + n).toString();
        buffer = buffer.subarray(5 + n);
        out.messages.push(m);
        onMessage(req, m, out.messages.length);
      }
    });
    req.on("trailers", (t) => { out.grpcStatus = t["grpc-status"]; out.grpcMessage = t["grpc-message"]; });
    req.on("end", () => { clearTimeout(timer); resolve(out); });
    req.on("error", (e) => { clearTimeout(timer); out.error = e.message; resolve(out); });
    start(req);
  });
}
(async () => {
  const unary = await call("Unary", () => {}, (req) => req.end(frame("hello")));
  const bidi = await call("Bidi", (req, _m, n) => (n < 3 ? req.write(frame("ping-" + (n + 1))) : req.end()),
    (req) => req.write(frame("ping-1")));
  const fail = await call("Fail", () => {}, (req) => req.end());
  session.close();
  process.stdout.write(JSON.stringify({ unary, bidi, fail }));
})();`;
const grpc = async (address) => JSON.parse(await nodeIn("client-a", GRPC, [address, DOMAIN]));

// ---------------------------------------------------------------- setup
const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const NODES = { node: upgrade.nodeId, "node-upgrade-peer": upgrade.peerId };

async function cleanup() {
  for (const site of (await a("GET", `/sites?pageSize=100`)).items ?? [])
    if (site.domains?.includes(DOMAIN)) await a("DELETE", `/sites/${site.id}`);
  pass("HTTP/2 cleanup: site removed");
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

// -------------------------------------------------------------- a. feature
await waitFor("both nodes report origin-http2-v1", async () =>
  (await Promise.all(Object.values(NODES).map(node))).every((n) =>
    n.supportedFeatures.includes("origin-http2-v1"),
  ),
);
pass("both nodes report origin-http2-v1");

// -------------------------------------------------------------- b. create
await cleanup();
const body = {
  name: "h2-e2e",
  clusterId: clusterA,
  domains: [DOMAIN],
  origins: [{ address: "h2-origin", port: 8080 }],
};
const refusal = await a.raw("POST", "/sites", { ...body, originSettings: { grpc: true } });
assert.equal(refusal.status, 400, refusal.text);
assert.equal(refusal.json?.code, "ORIGIN_GRPC_REQUIRES_HTTP2", refusal.text);
const { site } = await a("POST", "/sites", {
  ...body,
  originSettings: { protocol: "http2", grpc: true },
});
assert.equal(site.originSettings.protocol, "http2");
assert.equal(site.originSettings.grpc, true);
await writeFile(STATE, JSON.stringify({ siteId: site.id }));
await synced("both nodes apply the HTTP/2 site");
pass(
  "gRPC without HTTP/2 refused (ORIGIN_GRPC_REQUIRES_HTTP2); h2.e2e.test created with HTTP/2 and gRPC",
);

const addresses = {};
for (const service of Object.keys(NODES)) addresses[service] = await containerIp(service);

// -------------------------------------------------------------- c. HTTP/2 to the origin
for (const [service, address] of Object.entries(addresses)) {
  const r = await waitFor(
    `${service} serves ${DOMAIN}`,
    async () => {
      const out = await get(address, "/proto");
      return out.startsWith("200 ") ? out : null;
    },
    60,
  );
  assert.equal(r, `200 HTTP/2.0 ${DOMAIN}`, `${service}: ${r}`);
}
pass("both nodes send HTTP/2 to an h2c-only origin, with the client's Host");

// -------------------------------------------------------------- d. gRPC end to end
for (const [service, address] of Object.entries(addresses)) {
  const { unary, bidi, fail } = await grpc(address);
  assert.equal(unary.status, 200, `${service} unary: ${JSON.stringify(unary)}`);
  assert.deepEqual(
    unary.messages,
    [`echo:hello authority=${DOMAIN} te=trailers`],
    `${service} unary: ${JSON.stringify(unary)}`,
  );
  assert.equal(unary.grpcStatus, "0", `${service} unary: ${JSON.stringify(unary)}`);
  assert.deepEqual(
    bidi.messages,
    ["echo:ping-1", "echo:ping-2", "echo:ping-3"],
    `${service} bidi: ${JSON.stringify(bidi)}`,
  );
  assert.equal(bidi.grpcStatus, "0", `${service} bidi: ${JSON.stringify(bidi)}`);
  assert.equal(fail.grpcStatus, "5", `${service} fail: ${JSON.stringify(fail)}`);
  assert.equal(fail.grpcMessage, "no such thing", `${service} fail: ${JSON.stringify(fail)}`);
}
pass("gRPC over h2c through both nodes: unary, bidirectional streaming and error trailers");

// -------------------------------------------------------------- e. kept, then back to HTTP/1.1
const kept = await a("PATCH", `/sites/${site.id}`, { originSettings: { policy: "round_robin" } });
assert.equal(kept.site.originSettings.protocol, "http2");
assert.equal(kept.site.originSettings.grpc, true);
const back = await a("PATCH", `/sites/${site.id}`, {
  originSettings: { policy: "weighted_random", protocol: "http1", grpc: false },
});
assert.equal(back.site.originSettings.protocol, "http1");
await synced("both nodes apply HTTP/1.1");
for (const [service, address] of Object.entries(addresses)) {
  const r = await get(address, "/proto");
  assert.ok(
    !r.startsWith("200 ") && !r.includes(`HTTP/2.0 ${DOMAIN}`),
    `${service} with HTTP/1.1 to an h2c-only origin: ${r}`,
  );
}
pass(
  "an update without the protocol keeps HTTP/2 and gRPC; back on HTTP/1.1 the nodes no longer reach the h2c-only origin",
);
