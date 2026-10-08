// Site parity G10 end to end (domain forms, unknown hosts and node IP access,
// CNAME prefixes), after G15. `node` and `node-upgrade-peer` serve the default
// cluster; client-a and client-b reach them by name. Each site answers with
// its own X-G10-Site header (a response header rule).
//   a. both nodes report domains-v2 and unknown-host-v1
//   b. routing on both nodes: `.multi.g10.test` serves any depth below it but
//      not multi.g10.test itself; the exact x.multi.g10.test and the wildcard
//      *.w.multi.g10.test (one label) win over it; the pattern
//      ~r[0-9]+\.g10\.test matches the whole host only; bücher.g10.test is
//      stored as xn--bcher-kva.g10.test, answers that Host and is found by
//      either form
//   c. unknown hosts closed: curl gets an empty reply (444), on both nodes
//   d. unknown hosts and node IP access handed to the default site: an
//      unknown host, the node's IP over HTTP and HTTPS without SNI; unknown
//      SNI is refused until "the default site's certificate" is on, then the
//      handshake presents default.g10.test's certificate
//   e. scan protection (threshold 10): client-b's 11th request to an unknown
//      host bans it on every site of the node (403 on x.multi.g10.test); the
//      console lists the platform ban (unknown_host_scan, node, trigger);
//      lifting it lets client-b in again, and a new scan bans it again
//   f. CNAME prefixes on the cluster's DNS binding: a new site's target uses
//      8 random characters; regenerating keeps the old name in the plan and
//      the provider's zone for 24 hours; a custom prefix; a taken prefix and
//      a name of the DNS plan are refused (CNAME_PREFIX_CONFLICT)
// The G10 sites stay for apps/console/e2e/g10.spec.ts (.e2e/g10-state.json);
// `node scripts/e2e-g10.mjs --cleanup` removes them (and the spec's g10-ui),
// their certificate and scan bans and resets the cluster's unknown host
// handling.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g10-state.json";

const SUFFIX = ".multi.g10.test";
const EXACT = "x.multi.g10.test";
const WILDCARD = "*.w.multi.g10.test";
const PATTERN = "~r[0-9]+\\.g10\\.test";
const IDN = "bücher.g10.test";
const IDN_ASCII = "xn--bcher-kva.g10.test";
const DEFAULT = "default.g10.test";
const UNKNOWN = "nowhere.g10.test";
const SITES = {
  suffix: { name: "g10-suffix", domains: [SUFFIX] },
  exact: { name: "g10-exact", domains: [EXACT, WILDCARD] },
  pattern: { name: "g10-pattern", domains: [PATTERN] },
  idn: { name: "g10-idn", domains: [IDN] },
  default: { name: "g10-default", domains: [DEFAULT] },
};
const NODES = ["node", "node-upgrade-peer"];
const SCAN = { threshold: 10, banSeconds: 600 };
const CUSTOM_PREFIX = "g10-custom";
/** Created by apps/console/e2e/g10.spec.ts. */
const UI_SITE = "g10-ui";

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
  return (await rpc(base, cookie, "accessKeys/create", { name: "g10-e2e" })).key;
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
const ipOf = async (service) =>
  Object.entries(
    JSON.parse(await run(["inspect", await containerId(service)]))[0].NetworkSettings.Networks,
  ).find(([name, n]) => name.endsWith("_default") && n.IPAddress)[1].IPAddress;

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

/**
 * Sequential HTTP(S) requests from a client. `servername: ""` sends no SNI;
 * the presented certificate's first DNS name comes back as `cert`.
 */
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
        res.on("end", () => {
          const peer = r.tls ? res.socket.getPeerCertificate?.() : null;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"),
            cert: peer?.subjectaltname?.split(", ")[0]?.replace(/^DNS:/, "") ?? "" });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message, headers: {}, body: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list, client = "client-a") =>
  list.length ? JSON.parse(await nodeIn(client, REQUESTS, JSON.stringify(list))) : [];
const request = async (r, client) => (await requests([r], client))[0];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"} site=${r.headers["x-g10-site"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
/** The X-G10-Site of a 200 answer, "unknown-host" for the platform's page, else the summary. */
const servedBy = (r) =>
  r.status === 200
    ? (r.headers["x-g10-site"] ?? "?")
    : r.status === 404 && r.headers["x-edgeweir-error"] === "unknown-host"
      ? "unknown-host"
      : summary(r);

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
const latestRevision = async () =>
  (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
async function synced(label) {
  const latest = await latestRevision();
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
  );
  return latest;
}
const siteNamed = async (name) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(name)}&pageSize=100`)).items.find(
    (s) => s.name === name,
  );
const unknownHosts = (settings) =>
  admin.ok("PUT", `/clusters/${clusterId}/unknown-hosts`, { settings });
const clientB = async () => {
  const address = (
    await nodeIn(
      "client-b",
      "process.stdout.write(require('os').networkInterfaces().eth0?.find((a)=>a.family==='IPv4')?.address ?? '')",
    )
  ).trim();
  return address || ipOf("client-b");
};
const scanBans = async (address) =>
  (
    await admin.ok(
      "GET",
      `/bans?scope=platform&source=auto&address=${encodeURIComponent(address)}&pageSize=100`,
    )
  ).items.filter((b) => b.reason === "unknown_host_scan");

async function cleanup() {
  await unknownHosts({});
  let removed = 0;
  for (const name of [...Object.values(SITES).map((s) => s.name), UI_SITE]) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  for (const cert of await admin.ok("GET", "/certificates"))
    if (cert.name.startsWith("g10-")) await admin.raw("DELETE", `/certificates/${cert.id}`);
  let lifted = 0;
  for (const ban of await scanBans(await clientB())) {
    await admin.ok("DELETE", `/bans/${ban.id}`);
    lifted++;
  }
  pass(
    `G10 cleanup: ${removed} site(s), ${lifted} scan ban(s) removed, unknown host handling reset`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

async function createSite(key) {
  const { name, domains } = SITES[key];
  const old = await siteNamed(name);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains,
    origins: [{ address: "whoami" }],
    clusterId,
  });
  await admin.ok("PUT", `/sites/${site.id}/rules`, {
    rules: [
      {
        name: "g10 site",
        phase: "response-transform",
        enabled: true,
        expression: "true",
        action: { kind: "response_header", header: "x-g10-site", value: key },
      },
    ],
  });
  return site;
}

/** A self-signed leaf certificate for the default site (host openssl). */
async function certificate() {
  const dir = await mkdtemp(join(tmpdir(), "g10-"));
  const config = join(dir, "leaf.cnf");
  await writeFile(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = leaf",
      "prompt = no",
      "[dn]",
      `CN = ${DEFAULT}`,
      "[leaf]",
      "basicConstraints = critical,CA:FALSE",
      `subjectAltName = DNS:${DEFAULT}`,
      "",
    ].join("\n"),
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-pkeyopt",
    "ec_param_enc:named_curve",
    "-nodes",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-days",
    "7",
    "-config",
    config,
  ]);
  const pem = {
    chainPem: await readFile(join(dir, "cert.pem"), "utf8"),
    privateKeyPem: await readFile(join(dir, "key.pem"), "utf8"),
  };
  await rm(dir, { recursive: true, force: true });
  return pem;
}

/** curl from the host to `node` (published port); resolves exit code and stderr. */
async function curl(host) {
  try {
    await execute("curl", [
      "-sS",
      "-o",
      "/dev/null",
      "-m",
      "10",
      "-H",
      `Host: ${host}`,
      `http://localhost:${edgePort}/`,
    ]);
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.code, stderr: String(error.stderr).trim() };
  }
}

let finished = false;
try {
  // -------------------------------------------------------------- a. features
  await everyNode("both nodes report domains-v2 and unknown-host-v1", (n) =>
    ["domains-v2", "unknown-host-v1"].every((f) => n.supportedFeatures.includes(f)),
  );
  pass("a. both nodes report domains-v2 and unknown-host-v1");

  // -------------------------------------------------------------- b. routing
  await unknownHosts({});
  const sites = {};
  for (const key of Object.keys(SITES)) sites[key] = await createSite(key);
  assert.deepEqual(sites.idn.domains, [IDN_ASCII], "stored as Punycode");
  assert.deepEqual(sites.suffix.domains, [SUFFIX]);
  assert.deepEqual(sites.pattern.domains, [PATTERN]);
  for (const search of ["bücher", "xn--bcher", "BÜCHER.g10.test"]) {
    const found = (
      await admin.ok("GET", `/sites?search=${encodeURIComponent(search)}&pageSize=100`)
    ).items.map((s) => s.name);
    assert.ok(found.includes(SITES.idn.name), `search ${search}: ${found}`);
  }
  const taken = await admin.raw("POST", "/sites", {
    name: "g10-taken",
    domains: [SUFFIX.toUpperCase()],
    origins: [{ address: "whoami" }],
    clusterId,
  });
  assert.equal(taken.status, 409, `the same suffix twice: ${taken.text}`);
  const badPattern = await admin.raw("POST", "/sites", {
    name: "g10-bad",
    domains: ["~(?=x)y\\.g10\\.test"],
    origins: [{ address: "whoami" }],
    clusterId,
  });
  // The contract refuses a pattern outside the shared subset as input.
  assert.equal(badPattern.status, 400, `a lookahead pattern: ${badPattern.text}`);
  assert.equal(badPattern.json.code, "BAD_REQUEST");
  // A Unicode host reaches the console's UTS #46 conversion: a joiner outside
  // its context (CheckJoiners) is refused there.
  const badUnicode = await admin.raw("POST", "/sites", {
    name: "g10-bad",
    domains: ["a\u200db.g10.test"],
    origins: [{ address: "whoami" }],
    clusterId,
  });
  assert.equal(badUnicode.status, 400, `a joiner out of context: ${badUnicode.text}`);
  assert.equal(badUnicode.json.code, "DOMAIN_INVALID");
  assert.equal(badUnicode.json.data?.domain, "a\u200db.g10.test");
  await synced("G10 sites published");
  const ROUTES = [
    ["a.multi.g10.test", "suffix"],
    ["a.b.c.multi.g10.test", "suffix"],
    ["multi.g10.test", "unknown-host"],
    [EXACT, "exact"],
    ["a.w.multi.g10.test", "exact"],
    ["a.b.w.multi.g10.test", "suffix"],
    ["r42.g10.test", "pattern"],
    ["r.g10.test", "unknown-host"],
    ["xr42.g10.test", "unknown-host"],
    ["r42.g10.test.evil.test", "unknown-host"],
    [IDN_ASCII, "idn"],
    [DEFAULT, "default"],
    [UNKNOWN, "unknown-host"],
  ];
  for (const target of NODES) {
    const answers = await requests(ROUTES.map(([host]) => ({ target, host, path: "/route" })));
    for (const [i, [host, want]] of ROUTES.entries())
      assert.equal(servedBy(answers[i]), want, `${target} ${host}: ${summary(answers[i])}`);
  }
  pass(
    `b. on both nodes: ${SUFFIX} serves a. and a.b.c. but not its apex; ${EXACT} and ${WILDCARD} win over it (a.b.w. falls back to the suffix); ${PATTERN} matches r42 only as the whole host; ${IDN} stored as ${IDN_ASCII}, served by that Host and found by both forms; a duplicate suffix (409), a lookahead pattern (BAD_REQUEST) and a joiner out of context (DOMAIN_INVALID, UTS #46) refused`,
  );

  // -------------------------------------------------------------- c. close
  await unknownHosts({ unknownHost: "close" });
  await synced("unknown hosts closed");
  const closed = await curl(UNKNOWN);
  assert.equal(closed.code, 52, `curl ${UNKNOWN}: ${JSON.stringify(closed)}`);
  assert.match(closed.stderr, /Empty reply from server/);
  for (const target of NODES) {
    const [unknown, known] = await requests([
      { target, host: UNKNOWN },
      { target, host: EXACT },
    ]);
    assert.equal(unknown.status, 0, `${target} ${UNKNOWN}: ${summary(unknown)}`);
    assert.equal(servedBy(known), "exact", `${target} ${EXACT}: ${summary(known)}`);
  }
  pass(
    `c. unknown hosts closed: curl ${UNKNOWN} -> exit 52 "${closed.stderr}" (444), on both nodes; known hosts served`,
  );

  // -------------------------------------------------------------- d. default site
  const cert = await admin.ok("POST", "/certificates/upload", {
    name: "g10-default",
    ...(await certificate()),
  });
  await admin.ok("PUT", `/sites/${sites.default.id}/https`, {
    settings: { certificateId: cert.id },
  });
  const handed = { unknownHost: "site", ipAccess: "site", defaultSiteId: sites.default.id };
  await unknownHosts(handed);
  await synced("unknown hosts handed to the default site");
  const ips = Object.fromEntries(await Promise.all(NODES.map(async (n) => [n, await ipOf(n)])));
  for (const target of NODES) {
    const [unknown, byIp, tlsByIp, unknownSni, known] = await requests([
      { target, host: UNKNOWN },
      { target, host: ips[target] },
      { target, host: ips[target], tls: true, servername: "" },
      { target, host: UNKNOWN, tls: true },
      { target, host: EXACT },
    ]);
    assert.equal(servedBy(unknown), "default", `${target} ${UNKNOWN}: ${summary(unknown)}`);
    assert.equal(servedBy(byIp), "default", `${target} Host ${ips[target]}: ${summary(byIp)}`);
    assert.equal(servedBy(tlsByIp), "default", `${target} https without SNI: ${summary(tlsByIp)}`);
    assert.equal(unknownSni.status, 0, `${target} unknown SNI refused: ${summary(unknownSni)}`);
    assert.equal(servedBy(known), "exact");
  }
  const invalid = await admin.raw("PUT", `/clusters/${clusterId}/unknown-hosts`, {
    settings: { ...handed, defaultCertificate: true, defaultSiteId: sites.suffix.id },
  });
  assert.equal(invalid.status, 409, `a default site without a certificate: ${invalid.text}`);
  assert.equal(invalid.json.code, "DEFAULT_SITE_CERTIFICATE_REQUIRED");
  await unknownHosts({ ...handed, defaultCertificate: true });
  await synced("the default site's certificate for unknown SNI");
  for (const target of NODES) {
    const sni = await request({ target, host: UNKNOWN, tls: true });
    assert.equal(servedBy(sni), "default", `${target} unknown SNI: ${summary(sni)}`);
    assert.equal(sni.cert, DEFAULT, `${target} certificate`);
  }
  pass(
    `d. handed to ${DEFAULT} on both nodes: ${UNKNOWN}, Host ${Object.values(ips).join(" / ")} and HTTPS without SNI; unknown SNI refused, then (default certificate on) served with ${DEFAULT}'s certificate; a default site without one refused (DEFAULT_SITE_CERTIFICATE_REQUIRED)`,
  );

  // -------------------------------------------------------------- e. scan protection
  await unknownHosts({ scan: { enabled: true, ...SCAN } });
  await synced("scan protection on");
  const scanner = await clientB();
  for (const ban of await scanBans(scanner)) await admin.ok("DELETE", `/bans/${ban.id}`);
  const before = await requests(
    Array.from({ length: SCAN.threshold }, (_, i) => ({
      target: "node",
      host: `scan-${i}.g10.test`,
    })),
    "client-b",
  );
  assert.ok(
    before.every((r) => servedBy(r) === "unknown-host"),
    `the first ${SCAN.threshold}: ${before.map(summary)}`,
  );
  const [stillIn] = await requests([{ target: "node", host: EXACT }], "client-b");
  assert.equal(servedBy(stillIn), "exact", `before the threshold: ${summary(stillIn)}`);
  const [last, banned] = await requests(
    [
      { target: "node", host: `scan-${SCAN.threshold}.g10.test` },
      { target: "node", host: EXACT },
    ],
    "client-b",
  );
  assert.equal(servedBy(last), "unknown-host", `request ${SCAN.threshold + 1}: ${summary(last)}`);
  assert.equal(banned.status, 403, `after request ${SCAN.threshold + 1}: ${summary(banned)}`);
  const [other] = await requests([{ target: "node", host: EXACT }], "client-a");
  assert.equal(servedBy(other), "exact", `client-a is not banned: ${summary(other)}`);
  const [ban] = await waitFor("the console lists the scan ban", async () => {
    const found = await scanBans(scanner);
    return found.length ? found : null;
  });
  assert.equal(ban.scope, "platform");
  assert.equal(ban.siteId, null);
  assert.equal(ban.cidr, `${scanner}/32`);
  assert.equal(ban.node?.id, edgeId);
  assert.deepEqual(
    {
      metric: ban.trigger?.metric,
      threshold: ban.trigger?.threshold,
      window: ban.trigger?.windowSeconds,
    },
    { metric: "unknown_host_requests", threshold: SCAN.threshold, window: 60 },
  );
  assert.ok(ban.trigger.observed > SCAN.threshold, JSON.stringify(ban.trigger));
  const seconds = (Date.parse(ban.expiresAt) - Date.parse(ban.createdAt)) / 1000;
  assert.ok(Math.abs(seconds - SCAN.banSeconds) <= 2, `ban for ${seconds} s`);
  await admin.ok("DELETE", `/bans/${ban.id}`);
  await waitFor(
    "the lifted ban lets client-b in",
    async () => servedBy(await request({ target: "node", host: EXACT }, "client-b")) === "exact",
    60,
  );
  // Lifted, client-b is counted afresh: scanning on bans it again.
  const again = await requests(
    [
      ...Array.from({ length: SCAN.threshold + 1 }, (_, i) => ({
        target: "node",
        host: `rescan-${i}.g10.test`,
      })),
      { target: "node", host: EXACT },
    ],
    "client-b",
  );
  assert.ok(
    again.slice(0, SCAN.threshold + 1).every((r) => servedBy(r) === "unknown-host"),
    `the new scan: ${again.map(summary)}`,
  );
  assert.equal(again.at(-1).status, 403, `scanning again after the lift: ${summary(again.at(-1))}`);
  const [rebanned] = await waitFor("the console lists the new scan ban", async () => {
    const found = (await scanBans(scanner)).filter((b) => b.id !== ban.id);
    return found.length ? found : null;
  });
  await admin.ok("DELETE", `/bans/${rebanned.id}`);
  await unknownHosts({});
  await waitFor(
    "the second lift lets client-b in",
    async () => servedBy(await request({ target: "node", host: EXACT }, "client-b")) === "exact",
    60,
  );
  pass(
    `e. scan protection (${SCAN.threshold} in 60 s): client-b (${scanner}) passed ${SCAN.threshold} unknown hosts, request ${SCAN.threshold + 1} banned it on every site (403 on ${EXACT}, client-a served); the console lists the platform ban (unknown_host_scan, node ${ban.node.name}, observed ${ban.trigger.observed}, ${seconds} s); lifted, client-b is served again and counted afresh (a new scan banned it again, lifted)`,
  );

  // -------------------------------------------------------------- f. CNAME prefixes
  const binding = (await admin.ok("GET", "/dns/bindings")).find((b) => b.clusterId === clusterId);
  assert.equal(binding?.mode, "auto", `the cluster's DNS binding: ${JSON.stringify(binding)}`);
  const zoneRecords = async () =>
    ((await (await fetch(`${mock}/records`)).json())[binding.zone] ?? [])
      .filter((r) => r.type === "CNAME")
      .map((r) => r.name);
  const label = (name) => name.slice(0, -(binding.zone.length + 1));
  const published = (names, label_) =>
    waitFor(
      `${names.join(", ")} in the zone`,
      async () => {
        await admin.ok("POST", "/dns/reconcile", { clusterId });
        const zone = await zoneRecords();
        return names.every((n) => zone.includes(label(n))) ? zone : null;
      },
      120,
      3000,
      () => label_,
    );
  const site = sites.suffix;
  assert.match(site.cnamePrefix, /^[a-z][a-z0-9]{7}$/, `new site's prefix ${site.cnamePrefix}`);
  const first = await admin.ok("GET", `/sites/${site.id}/cname`);
  assert.equal(first.target, `${site.cnamePrefix}.${binding.domain}`);
  assert.deepEqual(first.retired, []);
  await published([first.target]);
  const regenerated = await admin.ok("PUT", `/sites/${site.id}/cname-prefix`, {});
  assert.match(regenerated.prefix, /^[a-z][a-z0-9]{7}$/);
  assert.notEqual(regenerated.prefix, site.cnamePrefix);
  const second = await admin.ok("GET", `/sites/${site.id}/cname`);
  assert.equal(second.target, `${regenerated.prefix}.${binding.domain}`);
  assert.deepEqual(
    second.retired.map((r) => r.name),
    [first.target],
  );
  const hours = (Date.parse(second.retired[0].expiresAt) - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.05, `the old name expires in ${hours} h`);
  await published([first.target, second.target]);
  const custom = await admin.ok("PUT", `/sites/${site.id}/cname-prefix`, { prefix: CUSTOM_PREFIX });
  assert.equal(custom.prefix, CUSTOM_PREFIX);
  assert.deepEqual(
    custom.retired.map((r) => r.prefix).sort(),
    [site.cnamePrefix, regenerated.prefix].sort(),
  );
  const third = await admin.ok("GET", `/sites/${site.id}/cname`);
  assert.equal(third.target, `${CUSTOM_PREFIX}.${binding.domain}`);
  const zone = await published([first.target, second.target, third.target]);
  for (const prefix of [CUSTOM_PREFIX, "all", regenerated.prefix]) {
    const conflict = await admin.raw("PUT", `/sites/${sites.idn.id}/cname-prefix`, { prefix });
    assert.equal(conflict.status, 409, `${prefix}: ${conflict.text}`);
    assert.equal(conflict.json.code, "CNAME_PREFIX_CONFLICT");
  }
  pass(
    `f. CNAME prefixes on ${binding.domain}: new site ${site.cnamePrefix}, regenerated ${regenerated.prefix} with ${label(first.target)} kept until ${second.retired[0].expiresAt}, custom ${CUSTOM_PREFIX}; all three in the provider's zone (${zone.length} CNAMEs); ${CUSTOM_PREFIX}, all and a retired prefix refused for another site (CNAME_PREFIX_CONFLICT)`,
  );

  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        clusterId,
        clusterName: (await admin.ok("GET", `/clusters/${clusterId}`)).name,
        suffixSiteId: sites.suffix.id,
        idnSiteId: sites.idn.id,
        defaultSiteId: sites.default.id,
        domain: binding.domain,
      },
      null,
      2,
    )}\n`,
  );
  finished = true;
  console.log("G10 E2E OK");
} finally {
  if (!finished) {
    for (const service of NODES)
      try {
        console.log(
          `--- ${service} logs ---\n${(await run([...compose, "logs", "--tail=60", service])).slice(-6000)}`,
        );
      } catch {}
  }
}
