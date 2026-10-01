// Core gaps G5 end to end (rule engine extensions), after the G4 step. `node`
// and `node-upgrade-peer` serve the default cluster; every request goes from
// client-a to one of them by name, so both nodes are checked the same way.
// The G4 test origins (docker/e2e/g4-origin) echo the Host, path, query,
// Accept-Encoding and local port (8080, or 8081) they saw.
//   a. both nodes report rules-v2
//   b. dyn.g5.test: dynamic redirects (regex_replace with preserved, removed
//      and set query parameters; wildcard_replace over http.request.full_uri;
//      a target from a request header, an invalid one failing closed with
//      503), dynamic and static rewrites with query edits seen by the origin
//   c. bulk redirects: host-specific before path-only entries, status codes
//      and preserved queries; an update is served without an nginx reload
//      (same worker processes); foreign hosts and oversized tables refused
//   d. org.g5.test: an origin rule sends /api/ to the "api" origin group with
//      another Host and port; the rest stays on the default group; a config
//      rule's read timeout turns a slow origin into 504 for matching requests
//   e. cache.g5.test: an expression cache rule (functions) caches /c/ but not
//      *.nocache, with a browser TTL; a builder-shaped rule reads back in its
//      structured form and caches as before
//   f. gz.g5.test: compression rules choose gzip for JSON, keep zstd for HTML
//      and turn compression off for marked requests; config gzip=false no
//      longer bypasses the cache (HIT, uncompressed)
//   g. config overrides: Under Attack and WebSocket per path, a log sample
//      rate that records only matching requests
// The G5 sites stay for apps/console/e2e/g5.spec.ts (.e2e/g5-state.json);
// `node scripts/e2e-g5.mjs --cleanup` deletes them.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g5-state.json";

const HOST_DYN = "dyn.g5.test";
const HOST_ORG = "org.g5.test";
const HOST_CACHE = "cache.g5.test";
const HOST_GZ = "gz.g5.test";
const HOST_CFG = "cfg.g5.test";
const HOSTS = [HOST_DYN, HOST_ORG, HOST_CACHE, HOST_GZ, HOST_CFG];
const NODES = ["node", "node-upgrade-peer"];

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

/** Raw /api/v1 call: { status, json, text }. */
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
  const created = await fetch(`${base}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify({ name: "g5-e2e" }),
  });
  assert.equal(created.status, 200);
  return (await created.json()).key;
}

/** A signed-in user whose AccessKey is replaced every 500 calls (better-auth's limit). */
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

/** Sequential HTTP requests from client-a; bodies come back base64-encoded. */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path, method: r.method ?? "GET",
        headers, agent: false, timeout: r.timeout ?? 20000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString("base64") }));
      });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: "" }); });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
      req.end(r.body);
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
async function requests(list) {
  if (list.length === 0) return [];
  const out = JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
  return out.map((r) => ({ ...r, raw: Buffer.from(r.body, "base64") }));
}
/** Decodes a body by its Content-Encoding (exactly one coding). */
function decode(encoding, body) {
  if (!encoding) return body;
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "zstd") return zlib.zstdDecompressSync(body);
  if (encoding === "gzip") return zlib.gunzipSync(body);
  throw new Error(`unexpected Content-Encoding ${encoding}`);
}
const text = (r) => decode(r.headers["content-encoding"], r.raw).toString("utf8");
const json = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    throw new Error(`not JSON (${summary(r)}): ${text(r).slice(0, 300)}`);
  }
};
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["content-encoding"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;

/** PIDs of the nginx worker processes of a node container (a reload replaces them). */
async function workers(service) {
  const script =
    "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case \"$c\" in 'nginx: worker'*) echo ${p#/proc/};; esac; done";
  const out = await run(["exec", await containerId(service), "sh", "-c", script]);
  return out.split(/\s+/).filter(Boolean).sort().join(",");
}

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
const everyNode = (label, check, seconds = 120) =>
  waitFor(
    label,
    async () => {
      lastNodes = [await nodeById(edgeId), await nodeById(peerId)];
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
async function synced(label = "nodes on the latest revision") {
  const latest = await latestRevision();
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
  );
  return latest;
}
const findSite = async (domain) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(domain)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(domain),
  );

async function cleanup() {
  let removed = 0;
  for (const host of HOSTS) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  pass(`G5 cleanup: ${removed} site(s) removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

async function createSite(name, domains, origins, extra = {}) {
  for (const domain of domains) {
    const old = await findSite(domain);
    if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  }
  const { site } = await admin.ok("POST", "/sites", {
    name,
    clusterId,
    domains,
    origins,
    ...extra,
  });
  for (const proof of await admin.ok("GET", `/sites/${site.id}/ownership`))
    if (!proof.verified)
      await admin.ok("POST", `/sites/${site.id}/ownership/approve`, { domain: proof.domain });
  return admin.ok("GET", `/sites/${site.id}`);
}
const originA = { address: "g4-origin-a", port: 8080 };
const originB = { address: "g4-origin-b", port: 8080 };
const saveRules = (siteId, rules) => admin.ok("PUT", `/sites/${siteId}/rules`, { rules });

const rid = randomUUID().slice(0, 8);
const sites = {};
let finished = false;
try {
  // -------------------------------------------------------------- a. feature
  await everyNode(
    "both nodes report rules-v2",
    (n) => n.online && n.supportedFeatures.includes("rules-v2"),
  );
  pass("both nodes report rules-v2");

  // -------------------------------------------------------------- b. dynamic redirects and rewrites
  sites.dyn = await createSite("g5-dynamic", [HOST_DYN], [originA]);
  await saveRules(sites.dyn.id, [
    {
      name: "g5 old to new",
      phase: "redirect",
      expression: 'starts_with(http.request.uri.path, "/old/")',
      action: {
        kind: "redirect",
        target: 'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")',
        statusCode: 301,
        preserveQuery: true,
        setQuery: [{ name: "from", value: "old site" }],
        removeQuery: ["utm_source"],
      },
    },
    {
      name: "g5 shop",
      phase: "redirect",
      expression: 'starts_with(http.request.uri.path, "/shop/")',
      action: {
        kind: "redirect",
        target: `wildcard_replace(http.request.full_uri, "http://${HOST_DYN}/shop/*", "https://shop.example.test/\${1}")`,
        statusCode: 302,
      },
    },
    {
      name: "g5 header target",
      phase: "redirect",
      expression: 'http.request.uri.path eq "/go"',
      action: { kind: "redirect", target: 'http.request.headers["x-to"]', statusCode: 302 },
    },
    {
      name: "g5 v1 to v2",
      phase: "request-transform",
      expression: 'starts_with(http.request.uri.path, "/v1/")',
      action: {
        kind: "rewrite",
        target: 'wildcard_replace(http.request.uri.path, "/v1/*", "/v2/${1}")',
        preserveQuery: false,
        setQuery: [{ name: "v", value: "2" }],
      },
    },
    {
      name: "g5 legacy",
      phase: "request-transform",
      expression: 'http.request.uri.path eq "/legacy"',
      action: { kind: "rewrite", value: "/modern", removeQuery: ["debug"] },
    },
  ]);
  await synced("dynamic redirect and rewrite rules published");
  for (const target of NODES) {
    const [old, shop, go, bad, v1, legacy] = await requests([
      { target, host: HOST_DYN, path: "/old/a/b?utm_source=x&keep=1" },
      { target, host: HOST_DYN, path: "/shop/item/1?x=1" },
      { target, host: HOST_DYN, path: "/go", headers: { "x-to": "/landing" } },
      { target, host: HOST_DYN, path: "/go", headers: { "x-to": "javascript:alert(1)" } },
      { target, host: HOST_DYN, path: "/v1/users?page=3" },
      { target, host: HOST_DYN, path: "/legacy?debug=1&a=b" },
    ]);
    assert.equal(old.status, 301, summary(old));
    assert.equal(old.headers.location, "/new/a/b?keep=1&from=old%20site");
    assert.equal(shop.status, 302, summary(shop));
    assert.equal(shop.headers.location, "https://shop.example.test/item/1?x=1");
    assert.equal(go.status, 302, summary(go));
    assert.equal(go.headers.location, "/landing");
    assert.equal(bad.status, 503, summary(bad));
    assert.equal(bad.headers["x-edgeweir-error"], "policy-unavailable");
    assert.equal(v1.status, 200, summary(v1));
    assert.deepEqual([json(v1).path, json(v1).query], ["/v2/users", "?v=2"]);
    assert.equal(legacy.status, 200, summary(legacy));
    assert.deepEqual([json(legacy).path, json(legacy).query], ["/modern", "?a=b"]);
  }
  pass(
    `dynamic redirects and rewrites on both nodes: regex_replace /old/a/b?utm_source=x&keep=1 -> 301 /new/a/b?keep=1&from=old%20site; wildcard_replace on http.request.full_uri -> 302 https://shop.example.test/item/1?x=1; a header target -> 302 /landing, an invalid one (javascript:) -> 503 policy-unavailable; rewrite /v1/users?page=3 -> origin /v2/users?v=2; static rewrite /legacy?debug=1&a=b -> origin /modern?a=b`,
  );

  // -------------------------------------------------------------- c. bulk redirects
  const table = [
    { source: "/promo", target: "https://example.test/sale", statusCode: 302, preserveQuery: true },
    { source: "/about", target: "/x", statusCode: 301, preserveQuery: false },
    { source: `${HOST_DYN}/about`, target: "/about-us", statusCode: 308, preserveQuery: false },
  ];
  const saved = await admin.ok("PUT", `/sites/${sites.dyn.id}/bulk-redirects`, {
    redirects: table,
  });
  assert.equal(saved.length, 3);
  await synced("bulk redirects published");
  const before = Object.fromEntries(
    await Promise.all(NODES.map(async (n) => [n, await workers(n)])),
  );
  for (const target of NODES) {
    const [promo, about, miss] = await requests([
      { target, host: HOST_DYN, path: "/promo?a=1" },
      { target, host: HOST_DYN, path: "/about" },
      { target, host: HOST_DYN, path: "/promo/x" },
    ]);
    assert.equal(promo.status, 302, summary(promo));
    assert.equal(promo.headers.location, "https://example.test/sale?a=1");
    assert.equal(about.status, 308, summary(about));
    assert.equal(about.headers.location, "/about-us");
    assert.equal(miss.status, 200, `exact match only: ${summary(miss)}`);
  }
  await admin.ok("PUT", `/sites/${sites.dyn.id}/bulk-redirects`, {
    redirects: [{ ...table[0], target: "https://example.test/sale-2" }, table[1]],
  });
  await synced("bulk redirect update published");
  for (const target of NODES) {
    const [promo, about] = await requests([
      { target, host: HOST_DYN, path: "/promo" },
      { target, host: HOST_DYN, path: "/about" },
    ]);
    assert.equal(promo.headers.location, "https://example.test/sale-2", summary(promo));
    assert.equal(about.status, 301, summary(about));
    assert.equal(about.headers.location, "/x");
    assert.equal(await workers(target), before[target], `${target} reloaded nginx`);
  }
  refused(
    await admin.raw("PUT", `/sites/${sites.dyn.id}/bulk-redirects`, {
      redirects: [{ source: "elsewhere.g5.test/a", target: "/b" }],
    }),
    400,
  );
  refused(
    await admin.raw("PUT", `/sites/${sites.dyn.id}/bulk-redirects`, {
      redirects: Array.from({ length: 5001 }, (_, i) => ({ source: `/p${i}`, target: "/b" })),
    }),
    400,
  );
  pass(
    `bulk redirects on both nodes: ${HOST_DYN}/about (308) before /about, /promo?a=1 -> 302 https://example.test/sale?a=1 (query kept), /promo/x not matched; an update served without an nginx reload (worker PIDs ${Object.values(before).join(" / ")} unchanged); a foreign host and 5001 entries refused`,
  );

  // -------------------------------------------------------------- d. origin rules and timeouts
  sites.org = await createSite("g5-origins", [HOST_ORG], [originA, { ...originB, group: "api" }]);
  await saveRules(sites.org.id, [
    {
      name: "g5 api origin",
      phase: "origin",
      expression: 'starts_with(http.request.uri.path, "/api/")',
      action: { kind: "origin", originGroup: "api", hostHeader: "backend.g5.internal", port: 8081 },
    },
    {
      name: "g5 impatient",
      phase: "config",
      expression:
        'http.request.uri.path eq "/slow" and not http.request.headers["x-patient"] eq "1"',
      action: { kind: "config", originReadTimeoutMs: 1000 },
    },
  ]);
  await synced("origin rules published");
  for (const target of NODES) {
    const [api, web, slow, patient] = await requests([
      { target, host: HOST_ORG, path: "/api/users" },
      { target, host: HOST_ORG, path: "/web" },
      { target, host: HOST_ORG, path: "/slow?ms=2500", timeout: 30000 },
      {
        target,
        host: HOST_ORG,
        path: "/slow?ms=2500",
        headers: { "x-patient": "1" },
        timeout: 30000,
      },
    ]);
    assert.equal(api.status, 200, summary(api));
    const a = json(api);
    assert.deepEqual([a.origin, a.host, a.port], ["b", "backend.g5.internal", 8081]);
    const w = json(web);
    assert.deepEqual([w.origin, w.host, w.port], ["a", HOST_ORG, 8080]);
    assert.equal(slow.status, 504, summary(slow));
    assert.equal(patient.status, 200, summary(patient));
  }
  pass(
    `origin rules on both nodes: /api/users -> group "api" (origin b) with Host backend.g5.internal on port 8081, /web -> default group (origin a, Host ${HOST_ORG}, port 8080); a config rule's 1 s read timeout answers a 2.5 s origin with 504, other requests wait (200)`,
  );

  // -------------------------------------------------------------- e. expression cache rules
  sites.cache = await createSite("g5-cache", [HOST_CACHE], [originA], {
    cacheRules: [
      {
        expression:
          'starts_with(http.request.uri.path, "/c/") and not ends_with(http.request.uri.path, ".nocache")',
        edgeTtlSeconds: 600,
        browserTtlSeconds: 120,
      },
      { pathPrefixes: ["/s/"], edgeTtlSeconds: 600 },
    ],
  });
  const readBack = (await admin.ok("GET", `/sites/${sites.cache.id}`)).cacheRules;
  assert.equal(readBack.length, 2);
  assert.match(readBack[0].expression, /ends_with/);
  assert.deepEqual(readBack[0].pathPrefixes, []);
  assert.equal(readBack[0].browserTtlSeconds, 120);
  assert.equal(readBack[1].expression, 'starts_with(http.request.uri.path, "/s/")');
  assert.deepEqual(readBack[1].pathPrefixes, ["/s/"]);
  await synced("expression cache rules published");
  for (const target of NODES) {
    const path = `/c/${rid}-${target}`;
    const [c1, c2, n1, n2, s1, s2] = await requests([
      { target, host: HOST_CACHE, path },
      { target, host: HOST_CACHE, path },
      { target, host: HOST_CACHE, path: `${path}.nocache` },
      { target, host: HOST_CACHE, path: `${path}.nocache` },
      { target, host: HOST_CACHE, path: `/s/${rid}-${target}` },
      { target, host: HOST_CACHE, path: `/s/${rid}-${target}` },
    ]);
    assert.equal(c1.headers["x-cache"], "MISS", summary(c1));
    assert.equal(c2.headers["x-cache"], "HIT", summary(c2));
    assert.equal(json(c1).version, json(c2).version);
    assert.equal(c2.headers["cache-control"], "max-age=120");
    assert.notEqual(n2.headers["x-cache"], "HIT", summary(n2));
    assert.notEqual(json(n1).version, json(n2).version);
    assert.equal(s1.headers["x-cache"], "MISS", summary(s1));
    assert.equal(s2.headers["x-cache"], "HIT", summary(s2));
  }
  pass(
    `expression cache rules on both nodes: /c/* MISS then HIT with Cache-Control: max-age=120 (browser TTL), /c/*.nocache never cached (ends_with), the builder-shaped /s/ rule reads back as pathPrefixes ["/s/"] and caches MISS then HIT`,
  );

  // -------------------------------------------------------------- f. compression rules
  sites.gz = await createSite("g5-compress", [HOST_GZ], [originA], {
    cacheRules: [{ expression: 'http.request.uri.path eq "/text"', edgeTtlSeconds: 600 }],
  });
  const settings = await admin.ok("GET", `/sites/${sites.gz.id}/https`);
  await admin.ok("PUT", `/sites/${sites.gz.id}/https`, {
    settings: { ...settings, gzip: true, brotli: true, zstd: true },
  });
  await saveRules(sites.gz.id, [
    {
      name: "g5 no gzip",
      phase: "config",
      expression: 'http.request.headers["x-no-gzip"] eq "1"',
      action: { kind: "config", gzip: false },
    },
    {
      name: "g5 json gzip",
      phase: "compression",
      expression: 'http.response.content_type.media_type eq "application/json"',
      action: { kind: "compression", algorithms: ["gzip"] },
    },
    {
      name: "g5 raw",
      phase: "compression",
      expression: 'http.request.uri.query contains "raw=1"',
      action: { kind: "compression", algorithms: [] },
    },
  ]);
  await synced("compression rules published");
  const all = { "accept-encoding": "zstd, br, gzip" };
  for (const target of NODES) {
    const q = `&n=${rid}-${target}`;
    const [jsonBody, html, raw, fill, noGzip] = await requests([
      { target, host: HOST_GZ, path: `/text?type=application/json&size=8000${q}`, headers: all },
      { target, host: HOST_GZ, path: `/text?type=text/html&size=8000${q}`, headers: all },
      { target, host: HOST_GZ, path: `/text?type=text/html&size=8000&raw=1${q}`, headers: all },
      { target, host: HOST_GZ, path: `/text?type=text/html&size=8000&cached=1${q}`, headers: all },
      {
        target,
        host: HOST_GZ,
        path: `/text?type=text/html&size=8000&cached=1${q}`,
        headers: { "accept-encoding": "gzip", "x-no-gzip": "1" },
      },
    ]);
    assert.equal(jsonBody.headers["content-encoding"], "gzip", summary(jsonBody));
    assert.equal(html.headers["content-encoding"], "zstd", summary(html));
    assert.equal(raw.headers["content-encoding"], undefined, summary(raw));
    assert.equal(text(raw).length, 8000);
    assert.equal(fill.headers["content-encoding"], "zstd", summary(fill));
    assert.equal(noGzip.headers["x-cache"], "HIT", summary(noGzip));
    assert.equal(noGzip.headers["content-encoding"], undefined, summary(noGzip));
    assert.equal(text(noGzip), text(fill));
  }
  pass(
    `compression rules on both nodes (Accept-Encoding: zstd, br, gzip): application/json -> gzip (rule), text/html -> zstd (site default), raw=1 -> identity (empty list); config gzip=false on a gzip-only client returns the cached object uncompressed as a HIT (no cache bypass)`,
  );

  // -------------------------------------------------------------- g. config overrides
  sites.cfg = await createSite("g5-config", [HOST_CFG], [originA]);
  await saveRules(sites.cfg.id, [
    {
      name: "g5 guarded",
      phase: "config",
      expression: 'starts_with(http.request.uri.path, "/guarded/")',
      action: { kind: "config", underAttack: true },
    },
    {
      name: "g5 no websocket",
      phase: "config",
      expression: 'http.request.uri.path eq "/ws-off"',
      action: { kind: "config", websocket: false },
    },
    {
      name: "g5 logged",
      phase: "config",
      expression: 'starts_with(http.request.uri.path, "/logged")',
      action: { kind: "config", logSampleRate: 10000 },
    },
  ]);
  await synced("config override rules published");
  const upgradeHeaders = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  const loggedId = `g5-log-${rid}`;
  const unloggedId = `g5-nolog-${rid}`;
  for (const target of NODES) {
    const [guarded, open, wsOff] = await requests([
      { target, host: HOST_CFG, path: "/guarded/x", headers: { "user-agent": "g5" } },
      { target, host: HOST_CFG, path: "/open" },
      { target, host: HOST_CFG, path: "/ws-off", headers: upgradeHeaders },
    ]);
    assert.equal(guarded.status, 403, summary(guarded));
    assert.ok(guarded.headers["x-edgeweir-challenge"], "Under Attack challenges /guarded/");
    assert.equal(open.status, 200, summary(open));
    assert.equal(wsOff.status, 403, summary(wsOff));
    assert.equal(wsOff.headers["x-edgeweir-error"], "websocket-disabled");
  }
  await requests([
    { target: "node", host: HOST_CFG, path: "/logged", headers: { "x-request-id": loggedId } },
    { target: "node", host: HOST_CFG, path: "/open", headers: { "x-request-id": unloggedId } },
  ]);
  const from = new Date(Date.now() - 600_000).toISOString();
  const logs = () =>
    admin.ok(
      "GET",
      `/sites/${sites.cfg.id}/logs?from=${from}&to=${new Date(Date.now() + 60_000).toISOString()}`,
    );
  const entry = await waitFor(
    "the request a rule samples in the logs",
    async () => (await logs()).entries.find((e) => e.requestId === loggedId),
    120,
    2000,
  );
  assert.equal(entry.path, "/logged");
  assert.ok(!(await logs()).entries.some((e) => e.requestId === unloggedId));
  pass(
    `config overrides on both nodes: underAttack challenges /guarded/x (403, ${"x-edgeweir-challenge"}) while /open is served, websocket=false refuses an upgrade on /ws-off (403 websocket-disabled), logSampleRate=10000 records /logged (request ${loggedId}) while the site samples nothing else`,
  );

  await writeFile(
    STATE,
    JSON.stringify(
      Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, { id: v.id, name: v.name }])),
    ),
  );
  finished = true;
  console.log("G5 E2E OK");
} finally {
  if (!finished) console.log("G5 E2E FAILED (sites kept for inspection)");
}
