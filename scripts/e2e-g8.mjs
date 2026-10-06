// Site parity G8 end to end (expressions, fields and header values), after the
// G7 step. `node` and `node-upgrade-peer` serve the default cluster; every
// request goes from client-a to one of them by name, so both nodes are checked
// the same way. Origin whoami echoes the request it received.
//   a. both nodes report rules-v3
//   b. hdr.g8.test: origin request headers X-Client-Country = ip.geoip.country
//      (the GeoIP fixture's NZ for client-a) and X-Req = http.request.id (the
//      response's X-Request-Id) reach the origin; a header whose computed
//      value is invalid (a control character) is not sent and the request is
//      served, logged once per rule; two Link lines added with append; the
//      cache status as a response header (MISS, then HIT); a User-Agent
//      wildcard on *curl*
//   c. http.request.cookies["role"] eq "admin" blocks (403) with the site's
//      page filling {{time}} (RFC 3339) and {{path}} (escaped)
//   d. a redirect whose value expression target is
//      http.request.uri.args["next"] (an invalid one fails closed with 503)
//      and a 303 with a computed query parameter
//   e. an edge node from before G8 (edgeweir-node:pre-g8, built from
//      E2E_PRE_G8_COMMIT when missing) in cluster g8-legacy: features say
//      rules-v3 is missing on legacy.g8.test (rules-v2 available); the
//      operator's change that needs rules-v3 publishes, the old node keeps
//      its last-known-good revision and keeps serving it, and catches up once
//      the change is undone
// The G8 sites, the legacy cluster and its node stay for
// apps/console/e2e/g8.spec.ts (.e2e/g8-state.json); `node scripts/e2e-g8.mjs
// --cleanup` removes them, except the bench site hdr-bench.g8.test (whoami,
// cached, the header value rules) for BENCH_SCENARIO=headers in
// scripts/bench.sh.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const nodeContext = process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node";
/** An edge node from before G8: rules-v2 but no rules-v3. */
const OLD_NODE_IMAGE = process.env.E2E_PRE_G8_IMAGE ?? "edgeweir-node:pre-g8";
/** Last edgeweir-node commit before G8 (proto v0.21.0); builds OLD_NODE_IMAGE when it is missing. */
const OLD_NODE_COMMIT = process.env.E2E_PRE_G8_COMMIT ?? "7e1338f";
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g8-state.json";

const HOST_HDR = "hdr.g8.test";
const HOST_BENCH = "hdr-bench.g8.test";
const HOST_LEGACY = "legacy.g8.test";
/** Sites --cleanup removes (the bench site stays). */
const HOSTS = [HOST_HDR, HOST_LEGACY];
const NODES = ["node", "node-upgrade-peer"];
const LEGACY_CLUSTER = "g8-legacy";
/** RFC 3339 in UTC, as {{time}} renders it. */
const RFC3339 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;

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
  return (await rpc(base, cookie, "accessKeys/create", { name: "g8-e2e" })).key;
}

/** The signed-in operator with an AccessKey, renewed every 500 calls (600 per idle minute). */
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
// The compose project (COMPOSE_PROJECT_NAME), as Compose labels the node.
const project = JSON.parse(await run(["inspect", await containerId("node")]))[0].Config.Labels[
  "com.docker.compose.project"
];
/** Containers started here carry this label; scripts/e2e.sh removes them on exit. */
const LABEL = `dev.edgeweir.e2e-g8=${project}`;
const OLD_CONTAINER = `${project}-g8-old-node`;

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

/** Sequential HTTP requests from client-a, with the raw header lines (repeated headers apart). */
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
        headers, agent: false, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, rawHeaders: [], body: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
async function requests(list) {
  if (list.length === 0) return [];
  return JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
}
const request = async (r) => (await requests([r]))[0];
/** The values of every line of a response header, as sent. */
const lines = (r, name) =>
  r.rawHeaders.flatMap((v, i) =>
    i % 2 === 0 && v.toLowerCase() === name ? [r.rawHeaders[i + 1]] : [],
  );
/** The value of a request header the whoami origin echoed ("" without one). */
const echoed = (r, name) =>
  r.body
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}: `))
    ?.slice(name.length + 2) ?? "";
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;

/** Removes the containers started here. */
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
  const removedContainers = await removeContainers();
  let removed = 0;
  for (const host of HOSTS) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  const legacy = (await admin.ok("GET", "/clusters")).find((c) => c.name === LEGACY_CLUSTER);
  if (legacy) {
    for (const node of await admin.ok("GET", `/nodes?clusterId=${legacy.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${legacy.id}`);
  }
  pass(
    `G8 cleanup: ${removed} site(s), cluster ${legacy ? LEGACY_CLUSTER : "(none)"} and ${removedContainers} container(s) removed`,
  );
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
    domains,
    origins,
    clusterId,
    ...extra,
  });
  return admin.ok("GET", `/sites/${site.id}`);
}
const whoami = [{ address: "whoami" }];
const cacheAll = [
  { pathPrefixes: ["/cached/"], edgeTtlSeconds: 60, originCacheControl: "override" },
];
const saveRules = (siteId, rules) => admin.ok("PUT", `/sites/${siteId}/rules`, { rules });
const header = (name, phase, kind, headerName, extra) => ({
  name,
  phase,
  enabled: true,
  expression: "true",
  action: { kind, header: headerName, ...extra },
});
/** The rules of hdr.g8.test (and, without the Cookie block, hdr-bench.g8.test). */
const headerRules = [
  header("g8 country", "origin", "request_header", "x-client-country", {
    expression: "ip.geoip.country",
  }),
  header("g8 request id", "origin", "request_header", "x-req", { expression: "http.request.id" }),
  header("g8 bad", "request-transform", "request_header", "x-bad", {
    expression: 'url_decode(http.request.uri.args["bad"])',
  }),
  header("g8 link preload", "response-transform", "response_header", "link", {
    value: "</a.css>; rel=preload",
    append: true,
  }),
  header("g8 link canonical", "response-transform", "response_header", "link", {
    expression: 'concat("<", http.request.uri.path, ">; rel=canonical")',
    append: true,
  }),
  header("g8 cache status", "response-transform", "response_header", "x-cache-status", {
    expression: "http.response.cache_status",
  }),
  {
    name: "g8 curl",
    phase: "response-transform",
    enabled: true,
    expression: 'http.user_agent wildcard "*curl*"',
    action: { kind: "response_header", header: "x-ua-match", value: "curl" },
  },
];

const rid = randomUUID().slice(0, 8);
const sites = {};
let finished = false;
try {
  await removeContainers();
  // -------------------------------------------------------------- a. feature
  await everyNode(
    "both nodes report rules-v3",
    (n) => n.online && n.supportedFeatures.includes("rules-v3"),
  );
  pass("both nodes report rules-v3");

  // -------------------------------------------------------------- b. header values
  sites.hdr = await createSite("g8-headers", [HOST_HDR], whoami, { cacheRules: cacheAll });
  assert.deepEqual((await admin.ok("GET", `/sites/${sites.hdr.id}/features`)).rulesV3, {
    available: true,
    reason: null,
  });
  await saveRules(sites.hdr.id, [
    ...headerRules,
    {
      name: "g8 admin cookie",
      phase: "waf-custom",
      enabled: true,
      expression: 'http.request.cookies["role"] eq "admin"',
      action: { kind: "block", statusCode: 403 },
    },
    {
      name: "g8 next",
      phase: "redirect",
      enabled: true,
      expression: 'http.request.uri.path eq "/go"',
      action: { kind: "redirect", target: 'http.request.uri.args["next"]', statusCode: 302 },
    },
    {
      name: "g8 login",
      phase: "redirect",
      enabled: true,
      expression: 'http.request.uri.path eq "/login"',
      action: {
        kind: "redirect",
        value: "/signin",
        statusCode: 303,
        setQuery: [{ name: "next", value: "", expression: 'http.request.uri.args["next"]' }],
      },
    },
  ]);
  await admin.ok("PUT", `/sites/${sites.hdr.id}/error-pages`, {
    pages: [{ status: 403, template: "<p>g8 {{status}} at {{time}} for {{path}}</p>" }],
  });
  const config = await admin.ok("GET", `/clusters/${clusterId}`);
  await synced("the G8 site on both nodes");
  assert.ok(
    (
      await admin.ok("GET", `/clusters/${clusterId}/revisions/${config.latestRevision.revision}`)
    ).requiredFeatures?.includes?.("rules-v3") ?? true,
  );
  for (const target of NODES) {
    const path = `/cached/echo-${rid}-${target}?bad=a%0Ab`;
    const [miss, hit] = await requests([
      { target, host: HOST_HDR, path, headers: { "user-agent": "curl/8.10.1" } },
      { target, host: HOST_HDR, path, headers: { "user-agent": "Mozilla/5.0" } },
    ]);
    assert.equal(miss.status, 200, `${target}: ${summary(miss)}`);
    assert.equal(echoed(miss, "x-client-country"), "NZ", `${target}: ${miss.body}`);
    assert.ok(miss.headers["x-request-id"], `${target}: no X-Request-Id`);
    assert.equal(echoed(miss, "x-req"), miss.headers["x-request-id"], `${target}: ${miss.body}`);
    assert.equal(
      echoed(miss, "x-bad"),
      "",
      `${target}: an invalid computed header reached the origin`,
    );
    assert.deepEqual(
      lines(miss, "link"),
      ["</a.css>; rel=preload", `<${path.split("?")[0]}>; rel=canonical`],
      `${target}: Link lines`,
    );
    assert.equal(miss.headers["x-cache-status"], "MISS", `${target}: ${summary(miss)}`);
    assert.equal(miss.headers["x-ua-match"], "curl", `${target}: User-Agent wildcard`);
    assert.equal(hit.headers["x-cache-status"], "HIT", `${target}: ${summary(hit)}`);
    assert.equal(hit.headers["x-cache"], "HIT", `${target}: ${summary(hit)}`);
    assert.equal(hit.headers["x-ua-match"], undefined, `${target}: Mozilla matched *curl*`);
    assert.equal(lines(hit, "link").length, 2, `${target}: Link lines on a HIT`);
  }
  for (const service of NODES) {
    const logs = await waitFor(
      `${service} logs the skipped header`,
      async () => {
        const out = await execute("docker", ["logs", await containerId(service)], {
          maxBuffer: 64 * 1024 * 1024,
        });
        const text = `${out.stdout}\n${out.stderr}`;
        return text.includes("header value skipped site=") ? text : null;
      },
      30,
    );
    const skipped = logs.split("\n").filter((l) => l.includes("header value skipped site="));
    assert.ok(
      skipped.length >= 1 && skipped.every((l) => l.includes(` rule=`)),
      skipped.join("\n"),
    );
    assert.ok(
      !skipped.some((l) => l.includes("a%0Ab") || l.includes("echo-")),
      "the log names IDs only",
    );
  }
  pass(
    `on both nodes the origin sees X-Client-Country NZ (ip.geoip.country) and X-Req = X-Request-Id (http.request.id); an invalid computed header (a newline) is skipped while the request is served and logged by IDs; two Link lines (append); X-Cache-Status MISS then HIT (http.response.cache_status); User-Agent curl/8.10.1 matches *curl*, Mozilla does not`,
  );

  // -------------------------------------------------------------- c. Cookie block and its page
  for (const target of NODES) {
    const [blocked, other] = await requests([
      { target, host: HOST_HDR, path: "/x%3Cy", headers: { cookie: "a=1; role=admin; role=user" } },
      { target, host: HOST_HDR, path: "/x", headers: { cookie: "role=user; a=1" } },
    ]);
    assert.equal(blocked.status, 403, `${target}: ${summary(blocked)}`);
    assert.match(
      blocked.body,
      new RegExp(`^<p>g8 403 at ${RFC3339.source} for /x&lt;y</p>$`),
      blocked.body,
    );
    assert.equal(other.status, 200, `${target}: ${summary(other)}`);
  }
  pass(
    `http.request.cookies["role"] eq "admin" blocks with 403 on both nodes (the first role cookie counts); the page fills {{time}} (RFC 3339) and {{path}} (escaped /x&lt;y)`,
  );

  // -------------------------------------------------------------- d. redirects
  for (const target of NODES) {
    const [next, invalid, seeOther] = await requests([
      { target, host: HOST_HDR, path: "/go?next=/dashboard&next=/other" },
      { target, host: HOST_HDR, path: "/go?next=//evil.test/" },
      { target, host: HOST_HDR, path: "/login?next=%2Fa%20b" },
    ]);
    assert.equal(next.status, 302, `${target}: ${summary(next)}`);
    assert.equal(next.headers.location, "/dashboard");
    assert.equal(invalid.status, 503, `${target}: ${summary(invalid)}`);
    assert.equal(invalid.headers["x-edgeweir-error"], "policy-unavailable");
    assert.equal(seeOther.status, 303, `${target}: ${summary(seeOther)}`);
    assert.equal(seeOther.headers.location, "/signin?next=%252Fa%2520b");
  }
  pass(
    `a redirect to http.request.uri.args["next"] goes to /dashboard (the first next) and fails closed (503 policy-unavailable) for //evil.test/; /login answers 303 /signin with the computed next=%252Fa%2520b, on both nodes`,
  );

  // -------------------------------------------------------------- bench site
  sites.bench = await createSite("g8-header-bench", [HOST_BENCH], whoami, {
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 3600, originCacheControl: "override" }],
  });
  await saveRules(
    sites.bench.id,
    headerRules.filter((rule) => rule.name !== "g8 bad"),
  );
  await synced("the header bench site");
  pass(`${HOST_BENCH} (header value expressions, cached) for BENCH_SCENARIO=headers`);

  // -------------------------------------------------------------- e. a node without rules-v3
  try {
    await run(["image", "inspect", OLD_NODE_IMAGE]);
  } catch {
    console.log(`building ${OLD_NODE_IMAGE} from edgeweir-node ${OLD_NODE_COMMIT}`);
    await execute(
      "sh",
      [
        "-c",
        'git -C "$1" archive "$2" | docker build -q -t "$3" -',
        "sh",
        nodeContext,
        OLD_NODE_COMMIT,
        OLD_NODE_IMAGE,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  }
  const network = Object.keys(
    JSON.parse(await run(["inspect", await containerId("node")]))[0].NetworkSettings.Networks,
  ).find((name) => name.endsWith("_default"));
  assert.ok(network, "node is not on the default network");
  const existing = (await admin.ok("GET", "/clusters")).find((c) => c.name === LEGACY_CLUSTER);
  if (existing) {
    for (const node of await admin.ok("GET", `/nodes?clusterId=${existing.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${existing.id}`);
  }
  const legacyCluster = await admin.ok("POST", "/clusters", { name: LEGACY_CLUSTER });
  await run([
    "run",
    "-d",
    "--name",
    OLD_CONTAINER,
    "--label",
    LABEL,
    "--hostname",
    "edge-g8-old",
    "--network",
    network,
    "-v",
    `${project}_origin-ca:/etc/edgeweir-e2e:ro`,
    "-v",
    `${project}_geoip-test-data:/etc/edgeweir-geoip:ro`,
    "-e",
    "EDGEWEIR_TRUSTED_CA=/etc/edgeweir-e2e/origin-ca.pem",
    "-e",
    "EDGEWEIR_GEOIP_IPINFO=/etc/edgeweir-geoip/ipinfo_lite.mmdb",
    OLD_NODE_IMAGE,
  ]);
  const token = await admin.ok("POST", "/enrollment-tokens", {
    clusterId: legacyCluster.id,
    nodeName: "edge-g8-old",
    ttlMinutes: 15,
  });
  await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      OLD_CONTAINER,
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  let old;
  await waitFor(
    "edge-g8-old online",
    async () => {
      old = (await admin.ok("GET", `/nodes?clusterId=${legacyCluster.id}`)).find(
        (n) => n.name === "edge-g8-old",
      );
      return old?.online && old.supportedFeatures.includes("rules-v2");
    },
    120,
    1000,
    () => JSON.stringify(old ?? null),
  );
  assert.ok(!old.supportedFeatures.includes("rules-v3"), "the old node reports rules-v3");
  const { site: legacySite } = await admin.ok("POST", "/sites", {
    name: "g8-legacy",
    clusterId: legacyCluster.id,
    domains: [HOST_LEGACY],
    origins: whoami,
  });
  sites.legacy = legacySite;
  await saveRules(legacySite.id, [
    header("g8 old", "request-transform", "request_header", "x-old", { value: "1" }),
  ]);
  const applied = (revision) =>
    waitFor(
      `edge-g8-old applies #${revision}`,
      async () => {
        const n = await nodeById(old.id);
        return n.applyState === "applied" && n.appliedRevision >= revision ? n : null;
      },
      120,
    );
  const before = await latestRevision(legacyCluster.id);
  await applied(before);
  const features = await admin.ok("GET", `/sites/${legacySite.id}/features`);
  assert.deepEqual(features.rulesV3, { available: false, reason: "nodes" });
  assert.deepEqual(features.rulesV2, { available: true, reason: null });
  // The operator saves a rule that needs rules-v3 anyway.
  await saveRules(legacySite.id, [
    header("g8 old", "request-transform", "request_header", "x-old", { value: "1" }),
    header("g8 new", "request-transform", "request_header", "x-new", {
      expression: "http.request.id",
    }),
  ]);
  const forced = await latestRevision(legacyCluster.id);
  assert.ok(forced > before, "the change published no revision");
  await sleep(15_000);
  const held = await nodeById(old.id);
  assert.ok(held.appliedRevision < forced, `the old node applied #${held.appliedRevision}`);
  assert.ok(held.online, "the old node went offline");
  const served = await request({ target: OLD_CONTAINER, host: HOST_LEGACY, path: "/lkg" });
  assert.equal(served.status, 200, summary(served));
  assert.equal(echoed(served, "x-old"), "1", served.body);
  assert.equal(echoed(served, "x-new"), "", served.body);
  // Undone, the old node catches up.
  await saveRules(legacySite.id, [
    header("g8 old", "request-transform", "request_header", "x-old", { value: "2" }),
  ]);
  const undone = await latestRevision(legacyCluster.id);
  await applied(undone);
  const caughtUp = await request({ target: OLD_CONTAINER, host: HOST_LEGACY, path: "/lkg2" });
  assert.equal(echoed(caughtUp, "x-old"), "2", caughtUp.body);
  pass(
    `edge-g8-old (${OLD_NODE_IMAGE}, rules-v2 without rules-v3) in ${LEGACY_CLUSTER}: features report rulesV3 "nodes" on ${HOST_LEGACY}; the operator's computed header (#${forced}) publishes, the old node stays on #${held.appliedRevision} (last-known-good, X-Old: 1 and no X-New) and applies #${undone} once the change is undone`,
  );

  // Left for g8.spec.ts: the legacy site keeps a rule-v3-free configuration.
  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        hdrSiteId: sites.hdr.id,
        hdrHost: HOST_HDR,
        legacySiteId: legacySite.id,
        legacyClusterId: legacyCluster.id,
      },
      null,
      2,
    )}\n`,
  );
  finished = true;
  console.log("G8 E2E OK");
} finally {
  if (!finished) {
    console.log("G8 E2E FAILED (sites kept for inspection)");
    await removeContainers().catch((e) => console.error(`cleanup: ${e.message}`));
  }
}
