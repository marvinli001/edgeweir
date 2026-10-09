// Site parity G13 end to end (access control, ADR-0039), after G12.
// `node` and `node-upgrade-peer` serve the default cluster; client-a and
// client-b send the requests (the GeoIP fixture puts the e2e network in NZ,
// subdivision AUK, AS64513); whoami echoes requests and WebSocket frames;
// g15-origin-a answers /powered/... with X-Powered-By, X-Frame-Options and
// Access-Control-* headers of its own.
//   a. both nodes report access-control-v1; the sites' features allow it
//   b. site lists on g13-lists: client-a's list as a site block list 403
//      ip-blocked (client-b 200); as a site allow list it skips the site's
//      geo denial of NZ that client-b gets (403 geo-denied)
//   c. geo on g13-geo: deny NZ 403 geo-denied but not under /status;
//      deny the subdivision NZ-AUK 403; allow only AU 403
//   d. hotlink on g13-hot (.png): a denied source 403 hotlink-denied, an
//      allowed source, the site's own domain and no Referer 200, another
//      source 403, an unparseable Referer 403, .css not checked; with the
//      302 action the placeholder (/placeholder.png) is not checked itself
//   e. user agents on g13-ua: deny * and allow *Googlebot*: curl 403
//      ua-denied, Googlebot 200 (allow first), /robots.txt excluded
//   f. CORS on g13-cors: a preflight answered at the edge with 204, the
//      Origin echoed with credentials, methods, headers, Max-Age and Vary:
//      Origin (the origin never sees it); another origin's preflight 403
//      cors-origin-denied; GETs with the Origin carry the headers on the miss
//      and on the cache hit; the origin's own Access-Control-* replaced
//   g. WebSocket origins on g13-ws: an upgrade from the allowed origin 101,
//      from another origin or without one 403 websocket-origin-denied
//   h. security headers on g13-sec: on the miss and the cache hit nosniff,
//      X-Frame-Options (the origin's replaced), Referrer-Policy,
//      Permissions-Policy; no Server and no X-Powered-By
//   i. IP check: client-a's address on g13-lists (allowed by the site allow
//      list), client-b's (geo applies, nothing decides earlier)
// `node scripts/e2e-g13.mjs --cleanup` removes its sites and IP list, and
// those apps/console/e2e/g13.spec.ts leaves (g13-ui-*, g13_ui_*).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = {
  lists: "lists.g13.test",
  geo: "geo.g13.test",
  hot: "hot.g13.test",
  ua: "ua.g13.test",
  cors: "cors.g13.test",
  ws: "ws.g13.test",
  sec: "sec.g13.test",
};
const SITES = Object.fromEntries(Object.keys(HOST).map((k) => [k, `g13-${k}`]));
const LIST = "g13_clients";
const NODES = ["node", "node-upgrade-peer"];
const APP = "https://app.g13.test";

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
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "g13-e2e" })).key;
  const user = { cookie, key };
  user.raw = (method, path, body) => call(user.key, method, path, body);
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
 * Sequential HTTP requests from a client (no redirects followed). A request
 * with `upgrade` sends a WebSocket handshake: a 101 resolves with status 101.
 */
const REQUESTS = `
const http = require("node:http");
const crypto = require("node:crypto");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      if (r.upgrade) Object.assign(headers, { connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64") });
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path ?? "/",
        method: r.method ?? "GET", headers, agent: false, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("upgrade", (res, socket) => { socket.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: "" }); });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message, headers: {}, body: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list, client = "client-a") =>
  list.length ? JSON.parse(await nodeIn(client, REQUESTS, JSON.stringify(list))) : [];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
const both = (r, client) =>
  requests(
    NODES.map((target) => ({ target, ...r })),
    client,
  );
/** Asserts status (and X-Edgeweir-Error) of a request on both nodes. */
async function expectBoth(r, status, error, client) {
  for (const [i, res] of (await both(r, client)).entries()) {
    assert.equal(res.status, status, `${NODES[i]} ${r.host}${r.path ?? "/"}: ${summary(res)}`);
    if (error) assert.equal(res.headers["x-edgeweir-error"], error, `${NODES[i]}: ${summary(res)}`);
  }
}
const clientAddress = async (client) =>
  (
    await nodeIn(
      client,
      `const a = Object.values(require("node:os").networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal); process.stdout.write(a.address);`,
    )
  ).trim();
const varyHas = (r, token) =>
  String(r.headers.vary ?? "")
    .split(",")
    .some((v) => v.trim().toLowerCase() === token.toLowerCase());

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

async function cleanup() {
  let removed = 0;
  for (const name of Object.values(SITES)) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  // apps/console/e2e/g13.spec.ts leaves g13-ui-<run> and its list g13_ui_<run>.
  for (const site of (await admin.ok("GET", "/sites?search=g13-ui-&pageSize=100")).items)
    if (site.name.startsWith("g13-ui-")) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  const lists = (await admin.ok("GET", "/ip-lists")).filter(
    (l) => l.name === LIST || l.name.startsWith("g13_ui_"),
  );
  for (const list of lists) await admin.ok("DELETE", `/ip-lists/${list.id}`);
  console.log(`G13 cleanup: ${removed} site(s), ${lists.length} IP list(s)`);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const cacheAll = [{ pathPrefixes: ["/"], edgeTtlSeconds: 60, originCacheControl: "override" }];
async function createSite(name, domain, origins = [{ address: "whoami" }]) {
  const old = await siteNamed(name);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains: [domain],
    origins,
    clusterId,
    cacheRules: cacheAll,
  });
  return site;
}
const access = (siteId, body) => admin.ok("PATCH", `/sites/${siteId}/access-control`, body);

let finished = false;
try {
  // ---------------------------------------------------------------- a
  const nodes = await everyNode("nodes report access-control-v1", (n) =>
    n.supportedFeatures.includes("access-control-v1"),
  );
  await cleanup();
  const g15 = [{ address: "g15-origin-a", port: 8080 }];
  const sites = {};
  for (const key of Object.keys(HOST))
    sites[key] = await createSite(
      SITES[key],
      HOST[key],
      ["cors", "sec"].includes(key) ? g15 : undefined,
    );
  const features = await admin.ok("GET", `/sites/${sites.lists.id}/features`);
  assert.deepEqual(features.accessControl, { available: true, reason: null });
  pass(`a. ${nodes.map((n) => n.name).join(" and ")} report access-control-v1`);

  // ---------------------------------------------------------------- b
  const [addressA, addressB] = [await clientAddress("client-a"), await clientAddress("client-b")];
  assert.notEqual(addressA, addressB);
  const list = await admin.ok("POST", "/ip-lists", {
    name: LIST,
    kind: "collection",
    entries: [addressA],
  });
  await access(sites.lists.id, { siteLists: { blockListIds: [list.id], allowListIds: [] } });
  await synced("g13-lists with a site block list");
  await expectBoth({ host: HOST.lists, path: "/x" }, 403, "ip-blocked", "client-a");
  await expectBoth({ host: HOST.lists, path: "/x" }, 200, undefined, "client-b");
  await access(sites.lists.id, {
    siteLists: { blockListIds: [], allowListIds: [list.id] },
    geo: { enabled: true, mode: "deny", countries: ["NZ"] },
  });
  await synced("g13-lists with a site allow list and geo");
  await expectBoth({ host: HOST.lists, path: "/y" }, 200, undefined, "client-a");
  await expectBoth({ host: HOST.lists, path: "/y" }, 403, "geo-denied", "client-b");
  pass(
    `b. g13-lists: ${addressA} on a site block list 403 ip-blocked (${addressB} 200); on a site allow list it skips the NZ denial ${addressB} gets (403 geo-denied)`,
  );

  // ---------------------------------------------------------------- c
  await access(sites.geo.id, {
    geo: { enabled: true, mode: "deny", countries: ["NZ"], exceptPathPrefixes: ["/status"] },
  });
  await synced("g13-geo denying NZ");
  await expectBoth({ host: HOST.geo, path: "/x" }, 403, "geo-denied");
  await expectBoth({ host: HOST.geo, path: "/status" }, 200);
  await access(sites.geo.id, { geo: { enabled: true, mode: "deny", subdivisions: ["NZ-AUK"] } });
  await synced("g13-geo denying NZ-AUK");
  await expectBoth({ host: HOST.geo, path: "/x" }, 403, "geo-denied");
  await access(sites.geo.id, { geo: { enabled: true, mode: "allow", countries: ["AU"] } });
  await synced("g13-geo allowing AU only");
  await expectBoth({ host: HOST.geo, path: "/x" }, 403, "geo-denied");
  await access(sites.geo.id, { geo: { enabled: true, mode: "allow", countries: ["AU", "NZ"] } });
  await synced("g13-geo allowing AU and NZ");
  await expectBoth({ host: HOST.geo, path: "/x" }, 200);
  pass(
    "c. g13-geo with the test MMDB: deny NZ 403 geo-denied but /status (exception) 200; deny NZ-AUK 403; allow only AU 403; allow AU and NZ 200",
  );

  // ---------------------------------------------------------------- d
  await access(sites.hot.id, {
    hotlink: {
      enabled: true,
      extensions: ["png"],
      allowed: ["friend.g13.test", "*.cdn.g13.test"],
      denied: ["evil.g13.test"],
    },
  });
  await synced("g13-hot with hotlink protection");
  const ref = (referer) => ({
    host: HOST.hot,
    path: "/a.png",
    headers: referer === undefined ? {} : { referer },
  });
  await expectBoth(ref("https://evil.g13.test/page"), 403, "hotlink-denied");
  await expectBoth(ref("https://friend.g13.test/page"), 200);
  await expectBoth(ref("https://img.cdn.g13.test/"), 200);
  await expectBoth(ref(`https://${HOST.hot}/article`), 200);
  await expectBoth(ref(undefined), 200);
  await expectBoth(ref("https://stranger.test/"), 403, "hotlink-denied");
  await expectBoth(ref("not a url"), 403, "hotlink-denied");
  await expectBoth(
    { host: HOST.hot, path: "/a.css", headers: { referer: "https://evil.g13.test/" } },
    200,
  );
  // A cached object is checked too.
  const [warm] = await requests([{ target: "node", ...ref(undefined), path: "/cached.png" }]);
  assert.equal(warm.status, 200, summary(warm));
  const [hitDenied] = await requests([
    { target: "node", ...ref("https://evil.g13.test/"), path: "/cached.png" },
  ]);
  assert.equal(hitDenied.status, 403, summary(hitDenied));
  await access(sites.hot.id, {
    hotlink: {
      enabled: true,
      extensions: ["png"],
      denied: ["evil.g13.test"],
      action: "redirect",
      redirectUrl: "/placeholder.png",
    },
  });
  await synced("g13-hot redirecting to a placeholder");
  for (const [i, r] of (await both(ref("https://evil.g13.test/"))).entries()) {
    assert.equal(r.status, 302, `${NODES[i]}: ${summary(r)}`);
    assert.equal(r.headers.location, "/placeholder.png");
    assert.equal(r.headers["cache-control"], "no-store");
  }
  await expectBoth(
    { host: HOST.hot, path: "/placeholder.png", headers: { referer: "https://evil.g13.test/" } },
    200,
  );
  pass(
    "d. g13-hot: denied source 403 hotlink-denied; allowed exact and *. sources, the site's own domain and no Referer 200; another source and an unparseable Referer 403; .css unchecked; a cached object denied the same; the 302 action sends /placeholder.png, which is not checked itself",
  );

  // ---------------------------------------------------------------- e
  await access(sites.ua.id, {
    userAgents: {
      rules: [
        { pattern: "*", action: "deny" },
        { pattern: "*Googlebot*", action: "allow" },
      ],
      excludePathPrefixes: ["/robots.txt"],
    },
  });
  await synced("g13-ua with user agent rules");
  await expectBoth(
    { host: HOST.ua, path: "/x", headers: { "user-agent": "curl/8.10.1" } },
    403,
    "ua-denied",
  );
  await expectBoth({ host: HOST.ua, path: "/x" }, 403, "ua-denied");
  await expectBoth(
    {
      host: HOST.ua,
      path: "/x",
      headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
    },
    200,
  );
  await expectBoth(
    { host: HOST.ua, path: "/robots.txt", headers: { "user-agent": "curl/8.10.1" } },
    200,
  );
  pass(
    "e. g13-ua: deny * with allow *Googlebot*: curl and no User-Agent 403 ua-denied, Googlebot 200 (allow first), /robots.txt excluded",
  );

  // ---------------------------------------------------------------- f
  await access(sites.cors.id, {
    cors: {
      enabled: true,
      allowedOrigins: [APP],
      allowCredentials: true,
      allowedMethods: ["GET", "PUT"],
      allowedHeaders: ["x-token"],
      exposedHeaders: ["x-request-id"],
      maxAgeSeconds: 600,
    },
  });
  await synced("g13-cors with CORS");
  const preflight = (origin) => ({
    host: HOST.cors,
    path: "/api/item",
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "x-token",
    },
  });
  for (const [i, r] of (await both(preflight(APP))).entries()) {
    assert.equal(r.status, 204, `${NODES[i]}: ${summary(r)}`);
    assert.equal(r.body, "", "the preflight reached the origin");
    assert.equal(r.headers["access-control-allow-origin"], APP);
    assert.equal(r.headers["access-control-allow-credentials"], "true");
    assert.equal(r.headers["access-control-allow-methods"], "GET, PUT");
    assert.equal(r.headers["access-control-allow-headers"], "x-token");
    assert.equal(r.headers["access-control-max-age"], "600");
    assert.ok(varyHas(r, "Origin"), `Vary: ${r.headers.vary}`);
  }
  await expectBoth(preflight("https://evil.g13.test"), 403, "cors-origin-denied");
  const get = (origin, path = "/data") => ({
    target: "node",
    host: HOST.cors,
    path,
    headers: origin ? { origin } : {},
  });
  const [miss, hit, foreign, plain, powered] = await requests([
    get(APP),
    get(APP),
    get("https://evil.g13.test"),
    get(undefined),
    get(APP, "/powered/x"),
  ]);
  for (const [label, r] of [
    ["miss", miss],
    ["hit", hit],
  ]) {
    assert.equal(r.status, 200, `${label}: ${summary(r)}`);
    assert.equal(r.headers["access-control-allow-origin"], APP, label);
    assert.equal(r.headers["access-control-allow-credentials"], "true", label);
    assert.equal(r.headers["access-control-expose-headers"], "x-request-id", label);
    assert.ok(varyHas(r, "Origin"), `${label} Vary: ${r.headers.vary}`);
  }
  assert.deepEqual([miss.headers["x-cache"], hit.headers["x-cache"]], ["MISS", "HIT"]);
  assert.equal(foreign.headers["access-control-allow-origin"], undefined);
  assert.equal(plain.headers["access-control-allow-origin"], undefined);
  assert.ok(varyHas(plain, "Origin"), `Vary without Origin: ${plain.headers.vary}`);
  assert.equal(powered.headers["access-control-allow-origin"], APP, "the origin's own ACAO");
  assert.equal(powered.headers["access-control-allow-methods"], undefined, "the origin's own ACAM");
  pass(
    "f. g13-cors: preflight 204 at the edge (empty body) with the Origin echoed, credentials, methods, headers, Max-Age 600 and Vary: Origin; another origin's preflight 403 cors-origin-denied; GET with the Origin carries the headers on the MISS and the HIT, another origin none, Vary: Origin always; the origin's own Access-Control-* replaced",
  );

  // ---------------------------------------------------------------- g
  await access(sites.ws.id, {
    websocket: { allowAllOrigins: false, origins: [APP], idleTimeoutSeconds: 600 },
  });
  await synced("g13-ws with WebSocket origins");
  const ws = (origin) => ({
    host: HOST.ws,
    path: "/echo",
    upgrade: true,
    headers: origin ? { origin } : {},
  });
  await expectBoth(ws(APP), 101);
  await expectBoth(ws("https://evil.g13.test"), 403, "websocket-origin-denied");
  await expectBoth(ws(undefined), 403, "websocket-origin-denied");
  pass(
    "g. g13-ws: an upgrade from the allowed origin 101; from another origin or without Origin 403 websocket-origin-denied",
  );

  // ---------------------------------------------------------------- h
  await access(sites.sec.id, {
    securityHeaders: {
      nosniff: true,
      frameOptions: "SAMEORIGIN",
      referrerPolicy: "no-referrer",
      permissionsPolicy: "camera=(), microphone=()",
      hideServer: true,
      removePoweredBy: true,
    },
  });
  await synced("g13-sec with security headers");
  for (const target of NODES) {
    const [first, second] = await requests([
      { target, host: HOST.sec, path: "/powered/page" },
      { target, host: HOST.sec, path: "/powered/page" },
    ]);
    assert.equal(second.headers["x-cache"], "HIT", `${target}: ${second.headers["x-cache"]}`);
    for (const r of [first, second]) {
      assert.equal(r.status, 200, `${target}: ${summary(r)}`);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.equal(r.headers["permissions-policy"], "camera=(), microphone=()");
      assert.equal(r.headers.server, undefined, `${target}: Server ${r.headers.server}`);
      assert.equal(r.headers["x-powered-by"], undefined);
    }
  }
  pass(
    "h. g13-sec: on the MISS and the HIT of both nodes nosniff, X-Frame-Options SAMEORIGIN (the origin's ALLOWALL replaced), Referrer-Policy, Permissions-Policy; no Server, no X-Powered-By",
  );

  // ---------------------------------------------------------------- i
  const checkA = await admin.ok("GET", `/ip-check?ip=${addressA}&siteId=${sites.lists.id}`);
  assert.equal(checkA.ip, addressA);
  assert.deepEqual(checkA.verdict, {
    outcome: "allowed",
    platformAllowed: false,
    siteAllowed: true,
  });
  assert.deepEqual(
    checkA.lists.map((l) => [l.name, l.siteRole]),
    [[LIST, "allow"]],
  );
  assert.ok(checkA.clusters.some((c) => c.id === clusterId));
  const checkB = await admin.ok("GET", `/ip-check?ip=${addressB}&siteId=${sites.lists.id}`);
  assert.equal(checkB.verdict.outcome, "none");
  assert.deepEqual(checkB.lists, []);
  pass(
    `i. IP check: ${addressA} allowed by g13-lists' site allow list; ${addressB} not decided by lists or bans`,
  );

  finished = true;
  console.log("G13 OK");
} finally {
  if (!finished)
    console.error("G13 failed; `node scripts/e2e-g13.mjs --cleanup` removes its sites");
}
