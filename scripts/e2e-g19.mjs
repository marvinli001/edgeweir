// Origin protection G19, after M6: client certificates the nodes present to
// origins (origin mutual TLS) and the Origin CA. Cluster A (`node`,
// `node-upgrade-peer`) serves the sites below; their origin is the test
// server in docker/e2e/origin-tls: origin-tls:8443 requires a certificate
// of the origin client CA, origin-tls:9443 does not; both serve certificates
// of the Origin CA. files:9443 serves a certificate of the test CA the nodes
// trust as their system store. Clients run in client-a and reach the nodes'
// container addresses on port 80.
//   a. both nodes report origin-mtls-v1 and origin-ca-v1
//   b. without the authorities a site can neither present a client
//      certificate (ORIGIN_CLIENT_CA_NOT_FOUND) nor trust the Origin CA
//      (ORIGIN_CA_NOT_FOUND); both are created; Origin CA certificates for
//      origin-tls are issued with a generated key and from a CSR
//   c. with the certificate the nodes reach the origin that requires one
//      over HTTP/1.1, HTTP/2 and gRPC (the origin sees the cluster's
//      certificate); without it the origin refuses them, also when a site
//      verifying the same way just left a connection with the certificate in
//      the keep-alive pool (same address, port and SNI); the active health
//      checks present it too
//   d. trusting the Origin CA alone, the nodes reach an origin with its
//      certificate and refuse one with the test CA's; trusting the system
//      store they refuse the Origin CA's even after the other pool verified
//      the same origin; a site on the system store is unaffected
//   e. revoked, the certificate fails (the data plane and the active health
//      check), the Origin CA's other certificate and the system store site
//      keep working
// State for apps/console/e2e/g19.spec.ts: .e2e/g19-state.json.
// `node scripts/e2e-g19.mjs --cleanup` deletes the sites.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass, sleep } from "./e2e-lib.mjs";

const execute = promisify(execFile);
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, input) => {
  if (input === undefined)
    return (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(out).toString("utf8"))
        : reject(new Error(`docker ${args.join(" ")}: ${Buffer.concat(err).toString("utf8")}`)),
    );
    child.stdin.end(input);
  });
};
const STATE = ".e2e/g19-state.json";
const SUFFIX = ".g19.e2e.test";

async function waitFor(label, fn, seconds = 180, interval = 1500) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label} (last: ${JSON.stringify(last)})`);
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
  const key = await rpc(base, cookie, "accessKeys/create", { name: "g19-e2e" });
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

/** Runs `node -e script args…` in client-a; resolves its stdout. */
const nodeIn = async (script, args) =>
  run(["exec", "-i", await containerId("client-a"), "node", "-e", script, ...args], "");

// GET <path> over HTTP/1.1 with a Host: "<status> <body>".
const HTTP = `
const http = require("node:http");
const [address, host, path] = process.argv.slice(1);
const req = http.get({ host: address, port: 80, path, headers: { host }, agent: false }, (res) => {
  let body = "";
  res.on("data", (d) => (body += d));
  res.on("end", () => process.stdout.write(res.statusCode + " " + body.trim()));
});
req.setTimeout(20000, () => req.destroy(new Error("timeout")));
req.on("error", (e) => process.stdout.write("error " + e.message));`;
// The test origin answers /whoami; files:9443 serves /static/a.txt ("static").
const pathOf = (site) => (site === "files" || site === "oca-public" ? "/static/a.txt" : "/whoami");
const get = (address, site) => nodeIn(HTTP, [address, `${site}${SUFFIX}`, pathOf(site)]);

// One gRPC unary call over h2c: { status, messages, grpcStatus, error } as JSON.
const GRPC = `
const http2 = require("node:http2");
const [address, authority] = process.argv.slice(1);
const m = Buffer.from("hello"); const b = Buffer.alloc(5 + m.length); b.writeUInt32BE(m.length, 1); m.copy(b, 5);
const session = http2.connect("http://" + address + ":80");
session.on("error", () => {});
const out = { messages: [] };
const req = session.request({ ":method": "POST", ":path": "/e2e.Echo/Unary", ":authority": authority,
  "content-type": "application/grpc", te: "trailers" });
const timer = setTimeout(() => { out.error = "timeout"; req.close(); }, 20000);
let buffer = Buffer.alloc(0);
req.on("response", (h) => (out.status = h[":status"]));
req.on("data", (d) => {
  buffer = Buffer.concat([buffer, d]);
  while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
    const n = buffer.readUInt32BE(1);
    out.messages.push(buffer.subarray(5, 5 + n).toString());
    buffer = buffer.subarray(5 + n);
  }
});
req.on("trailers", (t) => (out.grpcStatus = t["grpc-status"]));
const done = () => { clearTimeout(timer); session.close(); process.stdout.write(JSON.stringify(out)); };
req.on("end", done);
req.on("error", (e) => { out.error = e.message; done(); });
req.end(b);`;
const grpc = async (address, site) => JSON.parse(await nodeIn(GRPC, [address, `${site}${SUFFIX}`]));

// ---------------------------------------------------------------- setup
const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const NODES = { node: upgrade.nodeId, "node-upgrade-peer": upgrade.peerId };

async function cleanup() {
  for (const site of (await a("GET", `/sites?pageSize=100`)).items ?? [])
    if (site.domains?.some((d) => d.endsWith(SUFFIX))) await a("DELETE", `/sites/${site.id}`);
  pass("G19 cleanup: sites removed");
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

/** Writes a file of the TLS origin (its tmpfs) and, with reload, sends SIGHUP. */
async function originFile(name, content) {
  await run(
    ["exec", "-i", await containerId("origin-tls"), "sh", "-c", `cat > /run/origin-tls/${name}`],
    content,
  );
}
const reloadOrigin = async () => run([...compose, "kill", "-s", "HUP", "origin-tls"]);

const site = (name, origin, originSettings) => ({
  name: `g19-${name}`,
  clusterId: clusterA,
  domains: [`${name}${SUFFIX}`],
  origins: [origin],
  originSettings,
});
const mtlsOrigin = { address: "origin-tls", port: 8443, scheme: "https" };
const plainOrigin = { address: "origin-tls", port: 9443, scheme: "https" };
const filesOrigin = { address: "files", port: 9443, scheme: "https" };
const health = {
  enabled: true,
  path: "/whoami",
  intervalSeconds: 5,
  timeoutSeconds: 3,
  healthyThreshold: 1,
  unhealthyThreshold: 1,
};

// -------------------------------------------------------------- a. features
await waitFor("both nodes report origin-mtls-v1 and origin-ca-v1", async () =>
  (await Promise.all(Object.values(NODES).map(node))).every(
    (n) =>
      n.supportedFeatures.includes("origin-mtls-v1") &&
      n.supportedFeatures.includes("origin-ca-v1"),
  ),
);
pass("both nodes report origin-mtls-v1 and origin-ca-v1");

// -------------------------------------------------------------- b. authorities
await cleanup();
const before = await a("GET", "/origin-client-ca");
if (!before.authority) {
  const refused = await a.raw(
    "POST",
    "/sites",
    site("early", mtlsOrigin, { tlsVerify: false, clientCertificate: true }),
  );
  assert.equal(refused.json?.code, "ORIGIN_CLIENT_CA_NOT_FOUND", refused.text);
}
if (!(await a("GET", "/origin-ca")).authority) {
  const refused = await a.raw(
    "POST",
    "/sites",
    site("early", plainOrigin, { tlsTrust: "originCa" }),
  );
  assert.equal(refused.json?.code, "ORIGIN_CA_NOT_FOUND", refused.text);
}
const clientCa = (await a("POST", "/origin-client-ca")).authority;
const originCa = (await a("POST", "/origin-ca")).authority;
assert.ok(clientCa && originCa);
assert.notEqual(clientCa.fingerprint, originCa.fingerprint);

const generated = await a("POST", "/origin-certificates", {
  hostnames: ["origin-tls"],
  validityYears: 1,
});
assert.match(generated.privateKeyPem, /BEGIN PRIVATE KEY/);
// The CSR's key stays with the origin (made in the files container's OpenSSL).
const csrOut = await run([
  "exec",
  await containerId("files"),
  "sh",
  "-c",
  "openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=ignored" +
    " -keyout /tmp/g19.key -out /tmp/g19.csr 2>/dev/null && cat /tmp/g19.csr /tmp/g19.key",
]);
const csrPem = csrOut.match(
  /-----BEGIN CERTIFICATE REQUEST-----[\s\S]+?-----END CERTIFICATE REQUEST-----\n/,
)?.[0];
const csrKey = csrOut.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/)?.[0];
assert.ok(csrPem && csrKey, csrOut);
const fromCsr = await a("POST", "/origin-certificates", { hostnames: ["origin-tls"], csrPem });
assert.equal(fromCsr.privateKeyPem, "");
assert.equal(fromCsr.source, "csr");
await originFile("server.pem", generated.certificatePem);
await originFile("server.key", generated.privateKeyPem);
await originFile("client-ca.pem", clientCa.certificatePem);
await originFile("server-csr.pem", fromCsr.certificatePem);
await originFile("server-csr.key", csrKey);
await reloadOrigin();
pass(
  "without the authorities sites refuse client certificates and the Origin CA; both created; Origin CA certificates issued with a generated key and from a CSR",
);

// -------------------------------------------------------------- c. client certificates
const sites = {};
const create = async (name, origin, settings) => {
  sites[name] = (await a("POST", "/sites", site(name, origin, settings))).site;
};
await create("mtls", mtlsOrigin, {
  tlsVerify: false,
  clientCertificate: true,
  activeHealthCheck: health,
});
await create("nocert", mtlsOrigin, { tlsVerify: false, activeHealthCheck: health });
await create("mtls-h2", mtlsOrigin, {
  tlsVerify: false,
  clientCertificate: true,
  protocol: "http2",
  grpc: true,
});
await create("oca", plainOrigin, { tlsTrust: "originCa", activeHealthCheck: health });
await create("oca-mtls", mtlsOrigin, { tlsTrust: "originCa", clientCertificate: true });
await create("oca-nocert", mtlsOrigin, { tlsTrust: "originCa" });
await create("system", plainOrigin, {});
await create("oca-public", filesOrigin, { tlsTrust: "originCa" });
await create("files", filesOrigin, {});
assert.equal(sites.mtls.originSettings.clientCertificate, true);
assert.equal(sites.oca.originSettings.tlsTrust, "originCa");
await writeFile(
  STATE,
  JSON.stringify({ mtlsSiteId: sites.mtls.id, ocaSiteId: sites.oca.id, fromCsrId: fromCsr.id }),
);
await synced("both nodes apply the G19 sites");

const addresses = {};
for (const service of Object.keys(NODES)) addresses[service] = await containerIp(service);
const ok = async (service, name, want) => {
  const r = await waitFor(
    `${service} serves ${name}`,
    async () => {
      const out = await get(addresses[service], name);
      return out.startsWith("200 ") ? out : null;
    },
    60,
  );
  if (want) assert.equal(r, `200 ${want}`, `${service} ${name}: ${r}`);
  return r;
};
const refused = async (service, name) => {
  const r = await get(addresses[service], name);
  assert.ok(!r.startsWith("200 "), `${service} ${name} reached the origin: ${r}`);
  return r;
};
for (const service of Object.keys(NODES)) {
  await ok(service, "mtls", `1.1 client=${clusterA}`);
  await refused(service, "nocert");
  // Verified connections are pooled (unverified ones never are): the same
  // origin, port, SNI and trust, the first request leaves a connection
  // with the certificate in the pool, which the second must not reuse.
  await ok(service, "oca-mtls", `1.1 client=${clusterA}`);
  await refused(service, "oca-nocert");
  await ok(service, "oca-mtls", `1.1 client=${clusterA}`);
  await ok(service, "mtls-h2", `2.0 client=${clusterA}`);
  const call = await grpc(addresses[service], "mtls-h2");
  assert.equal(call.grpcStatus, "0", `${service} gRPC: ${JSON.stringify(call)}`);
  assert.deepEqual(
    call.messages,
    [`echo:hello client=${clusterA}`],
    `${service} gRPC: ${JSON.stringify(call)}`,
  );
}
const originHealth = async (name) => (await a("GET", `/sites/${sites[name].id}/origin-health`))[0];
// Nodes report the origins their checks find down (or failing), not the healthy ones: the site
// without the certificate is reported down by both nodes' active checks, the one with it never.
await waitFor("the active checks without the certificate fail", async () => {
  const active = (await originHealth("nocert"))?.nodes.filter((n) => n.source === "active") ?? [];
  return (
    active.length === 2 &&
    active.every((n) => !n.healthy && n.lastError.includes("certificate required"))
  );
});
const presenting = await originHealth("mtls");
assert.equal(presenting?.downNodes, 0, JSON.stringify(presenting));
assert.ok(
  (presenting?.nodes ?? []).every((n) => n.healthy && n.consecutiveFailures === 0),
  JSON.stringify(presenting),
);
pass(
  "with the cluster's certificate both nodes reach the origin that requires one over HTTP/1.1, HTTP/2 and gRPC; without it the origin refuses them even after the pool held a connection with it; the active checks agree",
);

// -------------------------------------------------------------- d. Origin CA
for (const service of Object.keys(NODES)) {
  await ok(service, "oca", "1.1 client=none");
  // The same origin verified against the system store: never through the Origin CA's pool.
  await refused(service, "system");
  await refused(service, "oca-public");
  await ok(service, "files", "static");
}
pass(
  "trusting the Origin CA alone the nodes reach its certificates and refuse the test CA's; on the system store they refuse the Origin CA's after the other pool verified the origin; the system store site is unaffected",
);

// -------------------------------------------------------------- e. revocation
const latest = (await a("GET", `/clusters/${clusterA}`)).latestRevision.revision;
const revoked = await a("POST", `/origin-certificates/${fromCsr.id}/revoke`);
assert.ok(revoked.revokedAt);
const after = (await a("GET", `/clusters/${clusterA}`)).latestRevision;
assert.equal(after.revision, latest + 1);
assert.equal(after.reasonCode, "origin_certificate_revoked");
await synced("both nodes apply the revocation");
for (const service of Object.keys(NODES)) {
  await waitFor(
    `${service} refuses the revoked certificate`,
    async () => !(await get(addresses[service], "oca")).startsWith("200 "),
  );
  await ok(service, "oca-mtls", `1.1 client=${clusterA}`);
  await ok(service, "files", "static");
}
await waitFor("the active checks refuse the revoked certificate", async () => {
  const h = await originHealth("oca");
  const active = h?.nodes.filter((n) => n.source === "active") ?? [];
  return active.length === 2 && active.every((n) => !n.healthy);
});
pass(
  "revoked, the certificate fails on both nodes and in the active checks; the Origin CA's other certificate and the system store site keep working",
);
