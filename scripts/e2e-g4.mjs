// Core gaps G4 end to end (purge by Host and Cache-Tag, device variant and
// sitemap prefetch, active health checks, session affinity, error pages),
// after the G3 step. `node` and `node-upgrade-peer` serve the default
// cluster; every request here goes from client-a to one of them by name, so
// both nodes are checked the same way. The test origins g4-origin-a and
// g4-origin-b (docker/e2e/g4-origin) name themselves and number their
// responses, count what they served and can be broken and repaired.
//   a. both nodes report purge-tag-v1, prefetch-v2, active-health-v1,
//      session-affinity-v1 and error-pages-v1
//   b. tag.g4.test (+ tag2.g4.test): objects tagged by the origin's Cache-Tag
//      are cached on both nodes, the header is not sent to clients unless the
//      site keeps it; a tag purge (case-insensitive) makes every node MISS
//      exactly the objects carrying the tag (untagged and other-tag objects
//      stay HIT, also on the other host); a Host purge MISSes that host only;
//      an expired object with stale-if-error is served STALE while the origin
//      is down, and after a purge of its tag no node serves it (502 page, not
//      the object); tag validation, the 500-tag limit and tenants' scope
//   c. pre.g4.test (cache key separates devices): a prefetch of desktop and
//      mobile caches both variants on both nodes (the origin saw both
//      User-Agents once per node); a site without device keys gets one request
//   d. sitemap prefetch: urlset (foreign and non-http entries skipped, capped
//      at maxUrls in document order) and a sitemapindex with a gzip child and
//      a foreign child; the listed pages are HITs for both variants, the rest
//      MISS, the foreign host is never requested; sitemaps on hosts no site of
//      the caller serves are refused
//   e. pool.g4.test (a, b, backup "hidden" on the isolated network): active
//      checks keep "hidden" down (address_forbidden, source active) by the
//      origin address policy; breaking a's /health takes it out of rotation
//      on both nodes (console: down, source active), repairing it brings it
//      back
//   f. session affinity: a signed __ew_affinity cookie pins a client to one
//      origin on both nodes, a tampered cookie is replaced, the pinned origin
//      failing its checks moves the client to the other one with a new cookie
//   g. err.g4.test site pages (403 WAF rule, 403 IP list, 429 rate limit, 502,
//      503 and 504, origin errors intercepted or passed through): status,
//      template content, escaped placeholders, other {{...}} untouched,
//      no-store, X-Request-Id (reused when valid) equal to the page's and the
//      sampled log's; built-in pages in Chinese or English without templates
//   h. platform pages: unknown host (404, escaped host), disabled site (503),
//      suspended site (503) with the administrator's templates, built-in pages
//      without them
// The G4 sites stay for apps/console/e2e/g4.spec.ts (.e2e/g4-state.json);
// `node scripts/e2e-g4.mjs --cleanup` deletes them, the IP list and the
// platform templates.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g4-state.json";

const HOST_TAG = "tag.g4.test";
const HOST_TAG2 = "tag2.g4.test";
const HOST_PRE = "pre.g4.test";
const HOST_POOL = "pool.g4.test";
const HOST_ERR = "err.g4.test";
const HOST_ERR502 = "err502.g4.test";
const HOST_OFF = "off.g4.test";
const HOST_SUS = "sus.g4.test";
const HOST_PLAIN = "plain.g4.test";
const HOST_SLICE = "slice.g4.test";
const DEFAULT_KEY = {
  query: "all",
  queryParams: [],
  sortQuery: false,
  headers: [],
  cookies: [],
  deviceType: false,
  includeHost: true,
};
const LIST = "g4_blocked";
const NODES = ["node", "node-upgrade-peer"];
const G4_FEATURES = [
  "purge-tag-v1",
  "prefetch-v2",
  "active-health-v1",
  "session-affinity-v1",
  "error-pages-v1",
];
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) edgeweir-e2e-g4";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile edgeweir-e2e-g4";
const ERROR_STATUSES = [403, 429, 502, 503, 504];
const template = (label, status) =>
  `<!doctype html><title>${label} ${status}</title><p id="g4">${label} ${status} status={{status}} id={{request_id}} ip={{client_ip}} host={{host}} other={{other}}</p>`;

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
    body: JSON.stringify({ name: "g4-e2e" }),
  });
  assert.equal(created.status, 200);
  return (await created.json()).key;
}

/**
 * A signed-in user with an AccessKey. An AccessKey allows 600 requests until
 * it has been idle for 60 seconds; the polling below runs longer than that,
 * so every 500 calls move to a fresh key.
 */
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

/** Asserts an error response: status and code. */
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
const containerIp = async (service, network = "_default") => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const name = Object.keys(info.NetworkSettings.Networks).find((n) => n.endsWith(network));
  assert.ok(name, `${service} is not on ${network}`);
  return info.NetworkSettings.Networks[name].IPAddress;
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

/** Sequential HTTP requests from client-a: [{ target, host, path, method, headers, body }]. */
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
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
      req.end(r.body);
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
async function requests(list) {
  if (list.length === 0) return [];
  return JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
}
/** One request through `target` (a node service name). */
const get = async (target, host, path, headers = {}, method = "GET") =>
  (await requests([{ target, host, path, headers, method }]))[0];
const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    throw new Error(
      `not JSON (${r.status} ${r.headers["x-cache"] ?? "-"}): ${r.body.slice(0, 300)}`,
    );
  }
};
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;

/** Controls a test origin (g4-origin-a / g4-origin-b) from client-a. */
async function origin(name, action, body) {
  const [r] = await requests([
    {
      target: `g4-origin-${name}`,
      port: 8080,
      host: `g4-origin-${name}`,
      path: `/control/${action}`,
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  ]);
  assert.equal(r.status, 200, `origin ${name} ${action}: ${summary(r)} ${r.body}`);
  return JSON.parse(r.body);
}
const hits = async (name) => (await origin(name, "hits")).hits;

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
/** Waits until `check` holds for both compose nodes; returns them. */
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
const latestRevision = async (id = clusterId) =>
  (await admin.ok("GET", `/clusters/${id}`)).latestRevision.revision;
/** Waits until both compose nodes run the cluster's latest revision. */
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
  for (const host of [
    HOST_TAG,
    HOST_SLICE,
    HOST_PRE,
    HOST_POOL,
    HOST_ERR,
    HOST_ERR502,
    HOST_OFF,
    HOST_SUS,
    HOST_PLAIN,
  ]) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  const list = (await admin.ok("GET", "/ip-lists")).find((l) => l.name === LIST);
  if (list) await admin.ok("DELETE", `/ip-lists/${list.id}`);
  await admin.ok("PUT", "/settings/error-pages", {
    unknownHost: "",
    siteDisabled: "",
    siteSuspended: "",
  });
  for (const name of ["a", "b"]) {
    await origin(name, "health", { status: 200 });
    await origin(name, "down", { down: false });
  }
  return removed;
}

if (process.argv.includes("--cleanup")) {
  const removed = await cleanup();
  await synced("cleanup published");
  pass(`G4 cleanup: ${removed} site(s) deleted, IP list ${LIST} removed, platform pages reset`);
  process.exit(0);
}

const leftovers = await cleanup();
const p0 = JSON.parse(await readFile(".e2e/p0-state.json", "utf8"));
const tenant = await actor("owner@p0.test", "p0-owner-password-123");
const tenantSite = await tenant.ok("GET", `/sites/${p0.siteId}`);
assert.equal(tenantSite.clusterId, clusterId, "the P0 site must be in the default cluster");
await everyNode(
  "both nodes online on their revision",
  (n) => n.online && n.dataPlaneHealthy && n.applyState === "applied",
  180,
);
await synced();

/** Creates a site in the default cluster with verified domains. */
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
const siteOf = (id) => admin.ok("GET", `/sites/${id}`);
async function patchSite(id, change) {
  const result = await admin.ok("PATCH", `/sites/${id}`, change);
  return result.site;
}
async function setCacheSettings(id, change) {
  const site = await siteOf(id);
  return patchSite(id, { cacheSettings: { ...site.cacheSettings, ...change } });
}
async function setOriginSettings(id, change) {
  const site = await siteOf(id);
  return patchSite(id, { originSettings: { ...site.originSettings, ...change } });
}

/** Creates a cache task as `user` and waits until every node finished it. */
async function runTask(user, body, expect = "succeeded") {
  const task = await user.ok("POST", "/cache-tasks", body);
  const done = await waitFor(
    `${body.type} task ${task.id}`,
    async () => {
      const t = await user.ok("GET", `/cache-tasks/${task.id}`);
      return t.state === "succeeded" || t.state === "failed" ? t : null;
    },
    300,
  );
  assert.equal(done.state, expect, JSON.stringify(done.nodes));
  const ran = done.nodes.filter((n) => n.state !== "skipped");
  assert.equal(
    ran.length,
    2,
    `the task ran on ${ran.length} node(s): ${JSON.stringify(done.nodes)}`,
  );
  return done;
}

const rid = randomUUID().slice(0, 8);
const sites = {};
const clientIp = await containerIp("client-a");
let finished = false;
try {
  // -------------------------------------------------------------- a. features
  const nodes = await everyNode("both nodes report the G4 features", (n) =>
    G4_FEATURES.every((f) => n.supportedFeatures.includes(f)),
  );
  pass(`${nodes.map((n) => n.name).join(" and ")} report ${G4_FEATURES.join(", ")}`);

  // -------------------------------------------------------------- b. purge by tag and host
  sites.tag = await createSite("g4-tag", [HOST_TAG, HOST_TAG2], [originA], {
    cacheRules: [
      // Expires at once but may be served stale for 10 minutes when the origin fails.
      {
        priority: 10,
        pathPrefixes: ["/stale/"],
        edgeTtlSeconds: 2,
        originCacheControl: "override",
        staleIfErrorSeconds: 600,
      },
      { priority: 100, pathPrefixes: ["/"], edgeTtlSeconds: 600, originCacheControl: "override" },
    ],
  });
  await synced("tag site published");
  const objects = {
    p1: [HOST_TAG, "/tag/p1?tags=Product-1,%20List"],
    p2: [HOST_TAG, "/tag/p2?tags=list"],
    p3: [HOST_TAG, "/tag/p3?tags=other"],
    u1: [HOST_TAG, "/tag/u1"],
    h2: [HOST_TAG2, "/tag/p2?tags=list"],
  };
  /** Requests every object on both nodes; returns { "<node> <name>": response }. */
  async function fetchAll(names = Object.keys(objects)) {
    const list = NODES.flatMap((target) =>
      names.map((name) => ({ target, host: objects[name][0], path: objects[name][1] })),
    );
    const out = await requests(list);
    const result = {};
    list.forEach((r, i) => {
      result[`${r.target} ${names[i % names.length]}`] = out[i];
    });
    return result;
  }
  const first = await fetchAll();
  for (const [key, r] of Object.entries(first)) {
    assert.equal(r.status, 200, `${key}: ${summary(r)}`);
    assert.equal(r.headers["x-cache"], "MISS", `${key}: ${summary(r)}`);
    assert.equal(r.headers["cache-tag"], undefined, `${key} leaks Cache-Tag`);
  }
  const cached = await fetchAll();
  for (const [key, r] of Object.entries(cached)) {
    assert.equal(r.headers["x-cache"], "HIT", `${key}: ${summary(r)}`);
    assert.equal(json(r).version, json(first[key]).version, key);
    assert.equal(r.headers["cache-tag"], undefined, `${key} leaks Cache-Tag on a hit`);
  }
  /** Asserts which objects MISS (refetched) and which stay HIT on both nodes. */
  async function expectMisses(label, missing) {
    const before = await fetchAll();
    for (const [key, r] of Object.entries(before)) {
      const name = key.split(" ")[1];
      const want = missing.includes(name) ? "MISS" : "HIT";
      assert.equal(r.headers["x-cache"], want, `${label}: ${key} ${summary(r)}`);
    }
    const after = await fetchAll();
    for (const [key, r] of Object.entries(after))
      assert.equal(r.headers["x-cache"], "HIT", `${label} (again): ${key} ${summary(r)}`);
    return before;
  }

  // A purge of a tag the objects do not carry changes nothing; tags compare case-insensitively.
  let task = await runTask(admin, { type: "tag", siteIds: [sites.tag.id], tags: ["unused-tag"] });
  await expectMisses("unused tag", []);
  task = await runTask(admin, { type: "tag", siteIds: [sites.tag.id], tags: ["PRODUCT-1"] });
  assert.deepEqual(task.targets, ["product-1"]);
  await expectMisses("tag product-1", ["p1"]);
  task = await runTask(admin, { type: "tag", siteIds: [sites.tag.id], tags: [" list "] });
  await expectMisses("tag list", ["p1", "p2", "h2"]);
  pass(
    `Cache-Tag: objects tagged by the origin are cached on both nodes without the header; a purge of tag "PRODUCT-1" makes both nodes MISS only /tag/p1 (Product-1, List), a purge of "list" only /tag/p1, /tag/p2 and ${HOST_TAG2}/tag/p2; untagged and "other" objects stay HIT; an unused tag changes nothing`,
  );

  task = await runTask(admin, { type: "host", hosts: [HOST_TAG] });
  assert.deepEqual(task.targets, [HOST_TAG]);
  await expectMisses("host purge", ["p1", "p2", "p3", "u1"]);
  pass(
    `Host purge of ${HOST_TAG}: every object of the host MISSes on both nodes, ${HOST_TAG2} stays HIT`,
  );

  // Range slices: a tag purge moves every slice of an object at once, not only
  // the slice the next request happens to fetch.
  sites.slice = await createSite("g4-slice", [HOST_SLICE], [originA], {
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 600, originCacheControl: "override" }],
    cacheSettings: {
      cacheKey: { ...DEFAULT_KEY },
      rangeSlice: true,
    },
  });
  await synced("slice site published");
  const big = "/big?tags=big-tag";
  const SLICES = ["bytes=0-1048575", "bytes=1048576-2097151", "bytes=2097152-3145727"];
  const sliceHits = async () => {
    const all = await hits("a");
    return SLICES.map((range) => all[`${HOST_SLICE} /big ${range}`] ?? 0);
  };
  await origin("a", "reset", {});
  for (const target of NODES) {
    const whole = await get(target, HOST_SLICE, big);
    assert.equal(whole.status, 200, summary(whole));
    assert.equal(Buffer.byteLength(whole.body, "latin1") > 0, true);
    const again = await get(target, HOST_SLICE, big);
    assert.equal(again.headers["x-cache"], "HIT", `${target}: ${summary(again)}`);
    const third = await get(target, HOST_SLICE, big, { range: "bytes=2200000-2200099" });
    assert.equal(third.status, 206, summary(third));
    assert.equal(third.headers["x-cache"], "HIT", `${target} slice 3: ${summary(third)}`);
  }
  assert.deepEqual(await sliceHits(), [2, 2, 2], "each node fetched each slice once");
  task = await runTask(admin, { type: "tag", siteIds: [sites.slice.id], tags: ["big-tag"] });
  for (const target of NODES) {
    const first = await get(target, HOST_SLICE, big, { range: "bytes=10-19" });
    assert.equal(first.status, 206, summary(first));
    assert.equal(
      first.headers["x-cache"],
      "MISS",
      `${target} slice 1 after the purge: ${summary(first)}`,
    );
    const third = await get(target, HOST_SLICE, big, { range: "bytes=2200000-2200099" });
    assert.equal(third.status, 206, summary(third));
    assert.equal(
      third.headers["x-cache"],
      "MISS",
      `${target} slice 3 after the purge: ${summary(third)}`,
    );
    const thirdAgain = await get(target, HOST_SLICE, big, { range: "bytes=2200000-2200099" });
    assert.equal(
      thirdAgain.headers["x-cache"],
      "HIT",
      `${target} slice 3 again: ${summary(thirdAgain)}`,
    );
  }
  assert.deepEqual(await sliceHits(), [4, 2, 4], "slices 1 and 3 were fetched again on both nodes");
  pass(
    "range slices: after a purge of the object's tag, slice 1 and slice 3 both MISS on both nodes (slice 3 is not served from before the purge although only slice 1 was fetched again), then HIT",
  );

  await setCacheSettings(sites.tag.id, { keepCacheTag: true });
  await synced("keep Cache-Tag published");
  for (const target of NODES) {
    const kept = await get(target, HOST_TAG, objects.p1[1]);
    assert.equal(kept.headers["x-cache"], "HIT", summary(kept));
    assert.equal(kept.headers["cache-tag"], "Product-1, List", JSON.stringify(kept.headers));
  }
  await setCacheSettings(sites.tag.id, { keepCacheTag: false });
  await synced("Cache-Tag hidden again");
  for (const target of NODES)
    assert.equal((await get(target, HOST_TAG, objects.p1[1])).headers["cache-tag"], undefined);
  pass(
    "keepCacheTag forwards the origin's Cache-Tag on cache hits of both nodes, off hides it again",
  );

  // Stale: expired copies are served while the origin is down, until their tag is purged.
  const stalePath = "/stale/s1?tags=stale-tag";
  const staleFirst = [];
  for (const target of NODES) {
    const r = await get(target, HOST_TAG, stalePath);
    assert.equal(r.headers["x-cache"], "MISS", summary(r));
    staleFirst.push(json(r).version);
  }
  await sleep(3500);
  await origin("a", "down", { down: true });
  try {
    for (const [i, target] of NODES.entries()) {
      const r = await get(target, HOST_TAG, stalePath);
      assert.equal(r.status, 200, `${target}: stale copy expected, ${summary(r)}`);
      assert.equal(r.headers["x-cache"], "STALE", `${target}: ${summary(r)}`);
      assert.equal(json(r).version, staleFirst[i]);
    }
    task = await runTask(admin, { type: "tag", siteIds: [sites.tag.id], tags: ["stale-tag"] });
    for (const target of NODES) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await get(target, HOST_TAG, stalePath);
        assert.equal(r.status, 502, `${target}: the purged object was served: ${summary(r)}`);
        assert.ok(!r.body.includes('"version"'), `${target}: ${r.body.slice(0, 200)}`);
        assert.equal(r.headers["x-cache"], "MISS", summary(r));
      }
    }
  } finally {
    await origin("a", "down", { down: false });
  }
  for (const target of NODES) {
    const r = await get(target, HOST_TAG, stalePath);
    assert.equal(r.status, 200, summary(r));
    assert.ok(!staleFirst.includes(json(r).version));
  }
  pass(
    "stale-if-error: with the origin down both nodes serve the expired object STALE; after a purge of its tag both answer 502 (MISS, never the object), and the origin's next response is a new one",
  );

  // Validation, the 500-tag limit and the tenant's scope.
  refused(
    await admin.raw("POST", "/cache-tasks", {
      type: "tag",
      siteIds: [sites.tag.id],
      tags: ["a,b"],
    }),
    400,
    "CACHE_TASK_TAG_INVALID",
  );
  refused(
    await admin.raw("POST", "/cache-tasks", {
      type: "tag",
      siteIds: [sites.tag.id],
      tags: ["x".repeat(129)],
    }),
    400,
    "CACHE_TASK_TAG_INVALID",
  );
  refused(
    await admin.raw("POST", "/cache-tasks", {
      type: "tag",
      siteIds: [sites.tag.id],
      tags: Array.from({ length: 501 }, (_, i) => `t${i}`),
    }),
    400,
  );
  const five = await admin.ok("POST", "/cache-tasks", {
    type: "tag",
    siteIds: [sites.tag.id],
    tags: Array.from({ length: 500 }, (_, i) => `bulk-${i}`),
  });
  assert.equal(five.targets.length, 500);
  refused(
    await tenant.raw("POST", "/cache-tasks", { type: "tag", siteIds: [sites.tag.id], tags: ["x"] }),
    404,
    "SITE_NOT_FOUND",
  );
  refused(
    await tenant.raw("POST", "/cache-tasks", { type: "host", hosts: [HOST_TAG] }),
    400,
    "CACHE_TASK_HOST_UNKNOWN",
  );
  const own = await tenant.ok("POST", "/cache-tasks", {
    type: "tag",
    siteIds: [p0.siteId],
    tags: ["p0-tag"],
  });
  assert.deepEqual(own.targets, ["p0-tag"]);
  pass(
    "tags with commas or over 128 bytes are refused (CACHE_TASK_TAG_INVALID), 501 tags 400, 500 accepted; a tenant purges tags of its own site only (another organization's site 404 SITE_NOT_FOUND, its host 400 CACHE_TASK_HOST_UNKNOWN)",
  );

  // -------------------------------------------------------------- c. device variants
  const deviceKey = { ...DEFAULT_KEY, deviceType: true };
  sites.pre = await createSite("g4-prefetch", [HOST_PRE], [originB], {
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 600, originCacheControl: "override" }],
    cacheSettings: { cacheKey: deviceKey, rangeSlice: false },
  });
  await synced("prefetch site published");
  await origin("b", "reset", {});
  task = await runTask(admin, {
    type: "prefetch",
    urls: [`http://${HOST_PRE}/page/v1`],
    variants: ["desktop", "mobile"],
  });
  for (const n of task.nodes) assert.equal(n.succeeded, 2, JSON.stringify(n));
  let seen = await hits("b");
  assert.equal(seen[`${HOST_PRE} /page/v1 d`], 2, JSON.stringify(seen));
  assert.equal(seen[`${HOST_PRE} /page/v1 m`], 2, JSON.stringify(seen));
  for (const target of NODES) {
    const desktop = await get(target, HOST_PRE, "/page/v1", { "user-agent": DESKTOP_UA });
    const mobile = await get(target, HOST_PRE, "/page/v1", { "user-agent": MOBILE_UA });
    assert.equal(desktop.headers["x-cache"], "HIT", `${target} desktop ${summary(desktop)}`);
    assert.equal(mobile.headers["x-cache"], "HIT", `${target} mobile ${summary(mobile)}`);
    assert.equal(json(desktop).device, "d");
    assert.equal(json(mobile).device, "m");
  }
  // A site whose key does not separate devices gets one request per URL.
  await origin("a", "reset", {});
  task = await runTask(admin, {
    type: "prefetch",
    urls: [`http://${HOST_TAG}/tag/pre`],
    variants: ["desktop", "mobile"],
  });
  for (const n of task.nodes) assert.equal(n.succeeded, 1, JSON.stringify(n));
  seen = await hits("a");
  assert.equal(seen[`${HOST_TAG} /tag/pre d`], 2, JSON.stringify(seen));
  assert.equal(seen[`${HOST_TAG} /tag/pre m`], undefined, JSON.stringify(seen));
  pass(
    `device variants: a desktop + mobile prefetch caches both variants of ${HOST_PRE}/page/v1 on both nodes (the origin saw a desktop and a mobile User-Agent from each node; desktop and iPhone clients HIT their own variant); ${HOST_TAG} (no device key) got one request per node`,
  );

  // -------------------------------------------------------------- d. sitemaps
  await origin("b", "reset", {});
  task = await runTask(admin, {
    type: "sitemap",
    urls: [`http://${HOST_PRE}/sitemap.xml`],
    maxUrls: 5,
    variants: ["desktop", "mobile"],
  });
  for (const n of task.nodes) assert.equal(n.succeeded, 10, JSON.stringify(n));
  seen = await hits("b");
  for (const page of [1, 2, 3, 4, 5])
    for (const device of ["d", "m"])
      assert.equal(
        seen[`${HOST_PRE} /page/${page} ${device}`],
        2,
        `page ${page} ${device}: ${JSON.stringify(seen)}`,
      );
  for (const key of Object.keys(seen))
    assert.ok(
      !key.startsWith("elsewhere.") && !key.includes("/page/6") && !key.includes("/page/7"),
      `unexpected origin request ${key}`,
    );
  for (const target of NODES) {
    for (const page of [1, 5]) {
      const desktop = await get(target, HOST_PRE, `/page/${page}`, { "user-agent": DESKTOP_UA });
      const mobile = await get(target, HOST_PRE, `/page/${page}`, { "user-agent": MOBILE_UA });
      assert.equal(
        desktop.headers["x-cache"],
        "HIT",
        `${target} /page/${page} ${summary(desktop)}`,
      );
      assert.equal(mobile.headers["x-cache"], "HIT", `${target} /page/${page} ${summary(mobile)}`);
    }
    const beyond = await get(target, HOST_PRE, "/page/6", { "user-agent": DESKTOP_UA });
    assert.equal(beyond.headers["x-cache"], "MISS", `${target} /page/6 ${summary(beyond)}`);
  }
  pass(
    "sitemap urlset: the first 5 pages of the site (maxUrls 5, foreign and ftp entries skipped) are prefetched for desktop and mobile on both nodes (10 per node), /page/6 is a MISS, the foreign host was never requested",
  );
  await origin("b", "reset", {});
  task = await runTask(admin, {
    type: "sitemap",
    urls: [`http://${HOST_PRE}/sitemap-index.xml`],
    maxUrls: 100,
    variants: ["desktop"],
  });
  for (const n of task.nodes) assert.equal(n.succeeded, 5, JSON.stringify(n));
  seen = await hits("b");
  for (const page of ["a1", "a2", "b1", "b2", "b3"])
    assert.equal(seen[`${HOST_PRE} /page/${page} d`], 2, `${page}: ${JSON.stringify(seen)}`);
  assert.equal(seen[`${HOST_PRE} /sitemap-b.xml.gz d`], 2, JSON.stringify(seen));
  for (const target of NODES) {
    const r = await get(target, HOST_PRE, "/page/b3", { "user-agent": DESKTOP_UA });
    assert.equal(r.headers["x-cache"], "HIT", `${target} /page/b3 ${summary(r)}`);
  }
  refused(
    await admin.raw("POST", "/cache-tasks", {
      type: "sitemap",
      urls: [`http://nowhere-${rid}.g4.test/sitemap.xml`],
    }),
    400,
    "CACHE_TASK_HOST_UNKNOWN",
  );
  refused(
    await tenant.raw("POST", "/cache-tasks", {
      type: "sitemap",
      urls: [`http://${HOST_PRE}/sitemap.xml`],
    }),
    400,
    "CACHE_TASK_HOST_UNKNOWN",
  );
  pass(
    "sitemapindex: both children of the site (one gzip-compressed) prefetched on both nodes (5 pages each), the foreign child skipped; sitemaps on hosts no site of the caller serves are refused (CACHE_TASK_HOST_UNKNOWN)",
  );

  // -------------------------------------------------------------- e. active health checks
  sites.pool = await createSite(
    "g4-pool",
    [HOST_POOL],
    [originA, originB, { address: "hidden", port: 80, backup: true }],
  );
  const health = {
    enabled: true,
    path: "/health",
    method: "GET",
    expectedStatusMin: 200,
    expectedStatusMax: 299,
    host: "",
    intervalSeconds: 5,
    timeoutSeconds: 2,
    healthyThreshold: 2,
    unhealthyThreshold: 2,
  };
  await setOriginSettings(sites.pool.id, { policy: "round_robin", activeHealthCheck: health });
  await synced("active health checks published");
  sites.pool = await siteOf(sites.pool.id);
  const idOf = (address) => sites.pool.origins.find((o) => o.address === address).id;
  const ids = { a: idOf("g4-origin-a"), b: idOf("g4-origin-b"), hidden: idOf("hidden") };
  const originHealth = () => admin.ok("GET", `/sites/${sites.pool.id}/origin-health`);
  /** Active entries that mark `origin` down, by node id. */
  const activeDown = (report, originId) =>
    (report.find((o) => o.originId === originId)?.nodes ?? []).filter(
      (n) => n.source === "active" && !n.healthy,
    );
  let report = await waitFor(
    "hidden reported down by both nodes' active checks",
    async () => {
      const r = await originHealth();
      return activeDown(r, ids.hidden).length === 2 ? r : null;
    },
    120,
  );
  for (const n of activeDown(report, ids.hidden))
    assert.equal(n.lastErrorCode, "address_forbidden", JSON.stringify(n));
  /** Which origins answered 12 requests on each node. */
  async function spread() {
    const out = {};
    for (const target of NODES) {
      const results = await requests(
        Array.from({ length: 12 }, () => ({ target, host: HOST_POOL, path: "/spread" })),
      );
      out[target] = [
        ...new Set(results.map((r) => (r.status === 200 ? json(r).origin : summary(r)))),
      ].sort();
    }
    return out;
  }
  assert.deepEqual(await spread(), { node: ["a", "b"], "node-upgrade-peer": ["a", "b"] });
  await origin("a", "health", { status: 500 });
  report = await waitFor(
    "a reported down by both nodes' active checks",
    async () => {
      const r = await originHealth();
      return activeDown(r, ids.a).length === 2 ? r : null;
    },
    90,
  );
  const aEntry = activeDown(report, ids.a)[0];
  assert.equal(aEntry.lastErrorCode, "upstream_status", JSON.stringify(aEntry));
  assert.equal(aEntry.lastErrorParams.status, "500", JSON.stringify(aEntry));
  assert.equal(report.find((o) => o.originId === ids.a).downNodes, 2);
  await waitFor(
    "requests avoid a on both nodes",
    async () => {
      const s = await spread();
      return s.node.join() === "b" && s["node-upgrade-peer"].join() === "b";
    },
    60,
  );
  await origin("a", "health", { status: 200 });
  await waitFor(
    "a healthy again on both nodes",
    async () => activeDown(await originHealth(), ids.a).length === 0,
    90,
  );
  await waitFor(
    "requests reach a again on both nodes",
    async () => {
      const s = await spread();
      return s.node.join() === "a,b" && s["node-upgrade-peer"].join() === "a,b";
    },
    60,
  );
  pass(
    "active health checks: the backup on the isolated network stays down on both nodes (address_forbidden, source active); a failing /health takes a out of rotation on both nodes (console: down on 2 nodes, source active, HTTP 500) and it rejoins after it recovers",
  );

  // -------------------------------------------------------------- f. session affinity
  await setOriginSettings(sites.pool.id, { sessionAffinity: { enabled: true, ttlSeconds: 600 } });
  await synced("session affinity published");
  const cookieOf = (r) =>
    [r.headers["set-cookie"] ?? []].flat().find((c) => c.startsWith("__ew_affinity="));
  const firstVisit = await get("node", HOST_POOL, "/affinity");
  const issued = cookieOf(firstVisit);
  assert.ok(issued, `no affinity cookie: ${JSON.stringify(firstVisit.headers)}`);
  for (const attribute of ["Path=/", "Max-Age=600", "HttpOnly", "SameSite=Lax"])
    assert.ok(issued.includes(attribute), issued);
  const pinned = json(firstVisit).origin;
  const other = pinned === "a" ? "b" : "a";
  let cookie = issued.split(";")[0];
  assert.ok(cookie.startsWith(`__ew_affinity=${ids[pinned]}.`), cookie);
  for (const target of NODES) {
    const results = await requests(
      Array.from({ length: 10 }, () => ({
        target,
        host: HOST_POOL,
        path: "/affinity",
        headers: { cookie },
      })),
    );
    for (const r of results) {
      assert.equal(json(r).origin, pinned, `${target}: ${r.body}`);
      assert.equal(cookieOf(r), undefined, `${target} issued a new cookie for a fresh pin`);
    }
  }
  const tampered = `${cookie.slice(0, -2)}${cookie.endsWith("A") ? "BB" : "AA"}`;
  const reissued = cookieOf(
    await get("node-upgrade-peer", HOST_POOL, "/affinity", { cookie: tampered }),
  );
  assert.ok(reissued, "a tampered cookie was not replaced");
  await origin(pinned, "health", { status: 503 });
  try {
    const moved = await waitFor(
      `the client pinned to ${pinned} moves to ${other}`,
      async () => {
        const r = await get("node", HOST_POOL, "/affinity", { cookie });
        return r.status === 200 && json(r).origin === other && cookieOf(r) ? r : null;
      },
      90,
    );
    cookie = cookieOf(moved).split(";")[0];
    assert.ok(cookie.startsWith(`__ew_affinity=${ids[other]}.`), cookie);
    await waitFor(
      "the peer moves the client too",
      async () =>
        json(await get("node-upgrade-peer", HOST_POOL, "/affinity", { cookie })).origin === other,
      90,
    );
  } finally {
    await origin(pinned, "health", { status: 200 });
  }
  await waitFor(
    `${pinned} healthy again`,
    async () => activeDown(await originHealth(), ids[pinned]).length === 0,
    90,
  );
  for (const target of NODES) {
    const results = await requests(
      Array.from({ length: 6 }, () => ({
        target,
        host: HOST_POOL,
        path: "/affinity",
        headers: { cookie },
      })),
    );
    for (const r of results) assert.equal(json(r).origin, other, `${target} left the new pin`);
  }
  await setOriginSettings(sites.pool.id, { sessionAffinity: { enabled: false, ttlSeconds: 600 } });
  await synced("session affinity off");
  pass(
    `session affinity: the first response sets __ew_affinity (HttpOnly, SameSite=Lax, Max-Age=600) for ${pinned}; both nodes keep the client on ${pinned} without re-issuing it, replace a tampered cookie, move it to ${other} with a new cookie once ${pinned} fails its checks, and keep it there after ${pinned} recovers`,
  );

  // -------------------------------------------------------------- g. site error pages
  let list = (await admin.ok("GET", "/ip-lists")).find((l) => l.name === LIST);
  if (!list) list = await admin.ok("POST", "/ip-lists", { name: LIST, entries: [] });
  await admin.ok("PUT", `/ip-lists/${list.id}`, {
    entries: [`${clientIp}/32`],
    kind: "collection",
  });
  sites.err = await createSite("g4-errors", [HOST_ERR, `*.${HOST_ERR}`], [originA], {
    originSettings: { readTimeoutMs: 1500 },
  });
  await admin.ok("PUT", `/sites/${sites.err.id}/rules`, {
    rules: [
      {
        name: "g4 blocked",
        phase: "waf-custom",
        expression: 'http.request.uri.path eq "/blocked"',
        action: { kind: "block" },
      },
      {
        name: "g4 listed",
        phase: "waf-custom",
        expression: `http.request.uri.path eq "/listed" and ip.src in $${LIST}`,
        action: { kind: "block" },
      },
      {
        name: "g4 limited",
        phase: "ratelimit",
        expression: 'http.request.uri.path eq "/limited"',
        action: { kind: "rate_limit", limit: 1, windowSeconds: 60, statusCode: 429 },
      },
    ],
  });
  sites.err502 = await createSite(
    "g4-errors-502",
    [HOST_ERR502],
    [{ address: "g4-origin-a", port: 9 }],
  );
  await synced("error sites published");

  // Built-in pages first: Chinese or English by Accept-Language, no template yet.
  for (const target of NODES) {
    const zh = await get(target, HOST_ERR, "/blocked", {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.5",
    });
    const en = await get(target, HOST_ERR, "/blocked", { "accept-language": "en-US,en;q=0.9" });
    for (const r of [zh, en]) {
      assert.equal(r.status, 403, summary(r));
      assert.match(r.headers["content-type"] ?? "", /^text\/html/);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.ok(
        r.body.includes(r.headers["x-request-id"]),
        "the built-in page shows the request id",
      );
    }
    assert.match(zh.body, /lang="zh/);
    assert.match(en.body, /lang="en/);
  }
  const pages = ERROR_STATUSES.map((status) => ({
    status,
    template: template("site-page", status),
  }));
  await admin.ok("PUT", `/sites/${sites.err.id}/error-pages`, {
    pages,
    interceptOriginErrors: true,
  });
  await admin.ok("PUT", `/sites/${sites.err502.id}/error-pages`, {
    pages,
    interceptOriginErrors: false,
  });
  await synced("site error pages published");
  /** Asserts a rendered site page: status, template, placeholders, headers. */
  function sitePage(r, status, host, label = "site-page") {
    assert.equal(r.status, status, `${host}: ${summary(r)} ${r.body.slice(0, 200)}`);
    assert.match(r.headers["content-type"] ?? "", /^text\/html/, JSON.stringify(r.headers));
    assert.equal(r.headers["cache-control"], "no-store", JSON.stringify(r.headers));
    const id = r.headers["x-request-id"];
    assert.ok(id, "no X-Request-Id");
    assert.ok(
      r.body.includes(
        `${label} ${status} status=${status} id=${id} ip=${clientIp} host=${host} other={{other}}`,
      ),
      `${status}: ${r.body}`,
    );
    return id;
  }
  const seenCodes = {};
  for (const target of NODES) {
    let r = await get(target, HOST_ERR, "/blocked");
    sitePage(r, 403, HOST_ERR);
    seenCodes["403 rule"] = r.headers["x-edgeweir-error"];
    r = await get(target, HOST_ERR, "/listed");
    sitePage(r, 403, HOST_ERR);
    seenCodes["403 list"] = r.headers["x-edgeweir-error"];
    await get(target, HOST_ERR, "/limited");
    r = await get(target, HOST_ERR, "/limited");
    sitePage(r, 429, HOST_ERR);
    seenCodes[429] = r.headers["x-edgeweir-error"];
    r = await get(target, HOST_ERR502, "/");
    sitePage(r, 502, HOST_ERR502);
    seenCodes[502] = r.headers["x-edgeweir-error"];
    r = await get(target, HOST_ERR, "/status/503");
    sitePage(r, 503, HOST_ERR);
    seenCodes["503 origin"] = r.headers["x-edgeweir-error"];
    r = await get(target, HOST_ERR, "/slow?ms=4000");
    sitePage(r, 504, HOST_ERR);
    seenCodes[504] = r.headers["x-edgeweir-error"];
    r = await get(target, HOST_ERR, "/status/429");
    sitePage(r, 429, HOST_ERR);
    seenCodes["429 origin"] = r.headers["x-edgeweir-error"];
    // Placeholders are HTML-escaped (a wildcard host with markup in its first label).
    const odd = `a<i>&"'.${HOST_ERR}`;
    r = await get(target, odd, "/blocked");
    assert.equal(r.status, 403, summary(r));
    assert.ok(!r.body.includes("<i>&"), r.body);
    assert.ok(r.body.includes("host=a&lt;i&gt;&amp;&quot;"), r.body);
    // A valid client request id is kept, an invalid one replaced.
    r = await get(target, HOST_ERR, "/blocked", { "x-request-id": `g4-e2e-${rid}-0001` });
    assert.equal(sitePage(r, 403, HOST_ERR), `g4-e2e-${rid}-0001`);
    r = await get(target, HOST_ERR, "/blocked", { "x-request-id": "bad id!" });
    assert.notEqual(sitePage(r, 403, HOST_ERR), "bad id!");
  }
  await admin.ok("PUT", `/sites/${sites.err.id}/error-pages`, {
    pages,
    interceptOriginErrors: false,
  });
  await synced("interception off");
  for (const target of NODES) {
    const r = await get(target, HOST_ERR, "/status/503");
    assert.equal(r.status, 503);
    assert.equal(r.body, "origin 503 page from a\n", "the origin's own page passes through");
    assert.equal((await get(target, HOST_ERR, "/blocked")).status, 403);
  }
  // The sampled log of a page request carries the page's request id.
  await admin.ok("PUT", `/sites/${sites.err.id}/logs/settings`, { sampleRate: 10000 });
  await synced("full sampling published");
  const logged = `g4-log-${rid}`;
  const page = await get("node", HOST_ERR, "/blocked", { "x-request-id": logged });
  sitePage(page, 403, HOST_ERR);
  const from = new Date(Date.now() - 600_000).toISOString();
  const entry = await waitFor(
    "the page request in the sampled logs",
    async () => {
      const to = new Date(Date.now() + 60_000).toISOString();
      const result = await admin.ok(
        "GET",
        `/sites/${sites.err.id}/logs?from=${from}&to=${to}&requestId=${logged}`,
      );
      return result.entries.find((e) => e.requestId === logged);
    },
    120,
    2000,
  );
  assert.equal(entry.status, 403);
  assert.equal(entry.path, "/blocked");
  await admin.ok("PUT", `/sites/${sites.err.id}/logs/settings`, { sampleRate: 0 });
  pass(
    `site error pages on both nodes: built-in pages in Chinese and English by Accept-Language; templates for 403 (rule ${seenCodes["403 rule"]}, IP list ${seenCodes["403 list"]}), 429 (${seenCodes[429]}), 502 (${seenCodes[502]}), 503 and 429 from the origin (intercepted, ${seenCodes["503 origin"]} / ${seenCodes["429 origin"]}) and 504 (${seenCodes[504]}) with status, request id, client IP and host filled in and escaped, other {{...}} untouched, text/html and Cache-Control: no-store; a valid X-Request-Id is kept, an invalid one replaced; without interception the origin's 503 passes through; the sampled log of a page request has its request id`,
  );

  // -------------------------------------------------------------- h. platform pages
  sites.off = await createSite("g4-disabled", [HOST_OFF], [originA]);
  sites.sus = await createSite("g4-suspended", [HOST_SUS], [originA]);
  await admin.ok("PUT", "/settings/error-pages", {
    unknownHost: template("platform-unknown", 404),
    siteDisabled: template("platform-disabled", 503),
    siteSuspended: template("platform-suspended", 503),
  });
  await admin.ok("PUT", `/sites/${sites.off.id}/enabled`, { enabled: false });
  await admin.ok("POST", `/admin/sites/${sites.sus.id}/suspend`, { reason: "abuse", note: "g4" });
  await synced("platform pages and offline hosts published");
  const unknownHost = `unknown-${rid}.g4.test`;
  for (const target of NODES) {
    let r = await get(target, unknownHost, "/");
    sitePage(r, 404, unknownHost, "platform-unknown");
    assert.equal(r.headers["x-edgeweir-error"], "unknown-host");
    r = await get(target, `x<b>.${unknownHost}`, "/");
    assert.equal(r.status, 404);
    assert.ok(r.body.includes(`host=x&lt;b&gt;.${unknownHost}`), r.body);
    r = await get(target, HOST_OFF, "/");
    sitePage(r, 503, HOST_OFF, "platform-disabled");
    assert.equal(r.headers["x-edgeweir-error"], "site-disabled");
    r = await get(target, HOST_SUS, "/");
    sitePage(r, 503, HOST_SUS, "platform-suspended");
    assert.equal(r.headers["x-edgeweir-error"], "site-suspended");
  }
  await admin.ok("PUT", "/settings/error-pages", {
    unknownHost: "",
    siteDisabled: "",
    siteSuspended: "",
  });
  await admin.ok("PUT", `/sites/${sites.off.id}/enabled`, { enabled: true });
  await admin.ok("POST", `/admin/sites/${sites.sus.id}/resume`, {});
  await synced("platform pages reset, sites back");
  for (const target of NODES) {
    let r = await get(target, unknownHost, "/", { "accept-language": "zh-CN" });
    assert.equal(r.status, 404);
    assert.match(r.body, /lang="zh/);
    assert.equal(r.headers["cache-control"], "no-store");
    for (const host of [HOST_OFF, HOST_SUS]) {
      r = await get(target, host, "/");
      assert.equal(r.status, 200, `${target} ${host}: ${summary(r)}`);
    }
  }
  pass(
    "platform pages on both nodes: unknown host 404 (host escaped), disabled site 503 site-disabled and suspended site 503 site-suspended with the administrator's templates; built-in pages once they are reset; enabled and resumed sites are served again",
  );

  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        tagSiteId: sites.tag.id,
        preSiteId: sites.pre.id,
        poolSiteId: sites.pool.id,
        poolHiddenOriginId: ids.hidden,
        errSiteId: sites.err.id,
        loggedRequestId: logged,
        loggedPath: "/blocked",
      },
      null,
      2,
    )}\n`,
  );
  finished = true;
} finally {
  if (!finished) {
    for (const name of ["a", "b"]) {
      await origin(name, "health", { status: 200 }).catch(() => {});
      await origin(name, "down", { down: false }).catch(() => {});
    }
  }
}
pass(`G4 E2E OK (${leftovers} leftover site(s) from an earlier run removed)`);
