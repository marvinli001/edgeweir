// Core gaps G3 end to end (edgeweir-openresty with Brotli, Zstandard and
// ModSecurity), after the G2 step. `node` and `node-upgrade-peer` serve the
// default cluster; the host talks to `node` through its published port, a
// curl container (Brotli and Zstandard built in) through the e2e network.
//   a. both nodes report brotli-v1, zstd-v1 and modsecurity-v1 and run the
//      custom build (nginx -V: /usr/lib/edgeweir-openresty, ngx_brotli,
//      zstd-nginx-module, http_v3)
//   b. compress.g3.test (files origin, cache rule): br, zstd, gzip and
//      identity by q-value (ties zstd > br > gzip, q=0 refuses) from one
//      cached identity object (the origin saw one request, without
//      Accept-Encoding), first MISS then HIT with the right coding per
//      client, Vary: Accept-Encoding, every body decodes to the file;
//      `curl --compressed` decodes br, zstd and gzip; a response the origin
//      compressed itself passes unchanged; a body under the minimum length
//      is not compressed
//   c. crs.g3.test (whoami, query ignored in the cache key, every request
//      logged): detect serves the CRS test payload and logs its rules
//      (wafRuleIds, wafBlocked false) and the top rules show them; block
//      answers 403 waf-blocked to the payload in the query, a header and the
//      body, also on a cached URL, while clean requests and their cache hits
//      get 200; a request body limit of 0 skips the body; excluded rules stop
//      matching; demo.test (no CRS) serves the payload; nginx.conf loads
//      ModSecurity only while a site runs CRS
//   d. an old node (pre-G3 image) in the cluster: features report "nodes"
//      for all three and the old node applies the cluster's revision; the
//      operator's change that requires a feature anyway is published but the
//      old node keeps its revision until the change is undone; a node with
//      only EDGEWEIR_MODSECURITY_MODULE=off makes only CRS unavailable and
//      applies a Zstandard change; once they are removed every feature is
//      available again
// The compression and CRS sites stay (turned off) for apps/console/e2e/g3.spec.ts,
// which also gets the cluster g3-legacy with an old node and the site
// legacy.g3.test (.e2e/g3-state.json). `node scripts/e2e-g3.mjs --cleanup`
// removes the legacy cluster and its node, and turns logging off again.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const nodeImage = `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`;
const nodeContext = process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node";
/** An edge node from before G3: no brotli-v1, zstd-v1 or modsecurity-v1. */
const OLD_NODE_IMAGE = process.env.E2E_OLD_NODE_IMAGE ?? "edgeweir-node:pre-g3";
/** Last edgeweir-node commit before G3 (proto v0.10.1); builds OLD_NODE_IMAGE when it is missing. */
const OLD_NODE_COMMIT = process.env.E2E_OLD_NODE_COMMIT ?? "6da3403";
const CURL_IMAGE =
  "curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777";
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g3-state.json";

const HOST_COMPRESS = "compress.g3.test";
const HOST_CRS = "crs.g3.test";
const HOST_LEGACY = "legacy.g3.test";
const XSS = "<script>alert(1)</script>";
/** The CRS test payload in a query string. */
const XSS_QUERY = `q=${encodeURIComponent(XSS)}`;
/** Rules the payload matches at paranoia level 1 (XSS libinjection, script tag, tag handler, blocking evaluation). */
const XSS_RULES = [941100, 941110, 941160, 949110];
/** CRS files that set up or evaluate the others (the contract's CRS_EVALUATION_FILES): never ranked or excluded. */
const CRS_EVALUATION_FILES = [901, 949, 959, 980];
const detectionRule = (id) => !CRS_EVALUATION_FILES.includes(Math.floor(id / 1000));
const G3_FEATURES = ["brotli-v1", "zstd-v1", "modsecurity-v1"];

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
  return (await rpc(base, cookie, "accessKeys/create", { name: "g3-e2e" })).key;
}

/**
 * The signed-in operator with an AccessKey. An AccessKey allows 600 requests until
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

/** A request from the host to the edge node's HTTP port: { status, headers, body (Buffer) }. */
function edge(host, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: edgePort,
        path,
        method,
        headers: { host, ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("edge timeout")));
    req.end(body);
  });
}
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["content-encoding"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}`;

/** Decodes a body by its Content-Encoding (exactly one coding). */
function decode(encoding, body) {
  if (!encoding) return body;
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "zstd") return zlib.zstdDecompressSync(body);
  if (encoding === "gzip") return zlib.gunzipSync(body);
  throw new Error(`unexpected Content-Encoding ${encoding}`);
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
const LABEL = `dev.edgeweir.e2e-g3=${project}`;
const CONTAINERS = {
  old: `${project}-g3-old-node`,
  noModsec: `${project}-g3-nomodsec-node`,
  legacy: `${project}-g3-legacy-node`,
  curl: `${project}-g3-curl`,
};
/** Runs a shell command in a compose service, with `input` on stdin. */
function inService(service, script, input) {
  return containerId(service).then(
    (id) =>
      new Promise((resolvePromise, reject) => {
        const child = spawn("docker", ["exec", "-i", id, "sh", "-c", script], {
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
            : reject(new Error(`${service}: ${script}: ${Buffer.concat(err).toString("utf8")}`)),
        );
        child.stdin.end(input ?? "");
      }),
  );
}
/** nginx.conf the agent rendered on a node. */
const nginxConf = (service = "node") =>
  inService(service, "cat /var/lib/edgeweir-node/nginx/conf/nginx.conf");
const loadsModSecurity = (conf) => /^load_module .*ngx_http_modsecurity_module\.so;/m.test(conf);
const compresses = (conf, algorithm) => new RegExp(`^\\s*${algorithm} on;`, "m").test(conf);

/** The e2e default network (`<project>_default`). */
async function e2eNetwork() {
  const info = JSON.parse(await run(["inspect", await containerId("node")]))[0];
  const name = Object.keys(info.NetworkSettings.Networks).find((n) => n.endsWith("_default"));
  assert.ok(name, "node is not on the default network");
  return name;
}

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

/**
 * Deletes the legacy cluster, its site and node and the helper containers; turns
 * Brotli, Zstandard, CRS and logging off on the G3 sites.
 */
async function cleanup() {
  const removed = await removeContainers();
  const legacySite = await findSite(HOST_LEGACY);
  if (legacySite) await admin.ok("DELETE", `/sites/${legacySite.id}`);
  const legacyCluster = (await admin.ok("GET", "/clusters")).find((c) => c.name === "g3-legacy");
  if (legacyCluster) {
    for (const node of await admin.ok("GET", `/nodes?clusterId=${legacyCluster.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${legacyCluster.id}`);
  }
  for (const node of await admin.ok("GET", `/nodes?clusterId=${clusterId}`))
    if (node.name.startsWith("edge-g3-")) await admin.ok("DELETE", `/nodes/${node.id}`);
  const compress = await findSite(HOST_COMPRESS);
  if (compress) {
    const settings = await admin.ok("GET", `/sites/${compress.id}/https`);
    await admin.ok("PUT", `/sites/${compress.id}/https`, {
      settings: { ...settings, brotli: false, zstd: false },
    });
  }
  const crs = await findSite(HOST_CRS);
  if (crs) {
    await admin.ok("PATCH", `/sites/${crs.id}/waf`, { mode: "off" });
    await admin.ok("PUT", `/sites/${crs.id}/logs/settings`, { sampleRate: 0 });
  }
  return { removed, legacySite: !!legacySite, legacyCluster: !!legacyCluster };
}

if (process.argv.includes("--cleanup")) {
  const done = await cleanup();
  await synced("cleanup published");
  const conf = await nginxConf();
  assert.ok(!loadsModSecurity(conf), "a node still loads ModSecurity after the cleanup");
  pass(
    `G3 cleanup: ${done.removed} helper container(s) removed, legacy site ${done.legacySite ? "and" : "or"} cluster ${done.legacyCluster ? "deleted" : "absent"}, CRS off and logging off on ${HOST_CRS}`,
  );
  process.exit(0);
}

const leftovers = await cleanup();
await everyNode(
  "both nodes online on their revision",
  (n) => n.online && n.dataPlaneHealthy && n.applyState === "applied",
  180,
);
await synced();
const network = await e2eNetwork();
const before = await nginxConf();
assert.ok(
  !loadsModSecurity(before) && !compresses(before, "brotli") && !compresses(before, "zstd"),
  "a site of the default cluster already uses Brotli, Zstandard or CRS",
);

/** Creates a site in the default cluster (after deleting one left by an earlier run). */
async function createSite(name, domain, origin, extra = {}) {
  const old = await findSite(domain);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    clusterId,
    domains: [domain],
    origins: [{ address: origin }],
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 300, originCacheControl: "override" }],
    ...extra,
  });
  return site;
}
const https = (siteId) => admin.ok("GET", `/sites/${siteId}/https`);
const putHttps = (siteId, settings) => admin.raw("PUT", `/sites/${siteId}/https`, { settings });
/** Availability of the G3 features (later milestones add their own to the response). */
const features = async (siteId) => {
  const { brotli, zstd, crs } = await admin.ok("GET", `/sites/${siteId}/features`);
  return { brotli, zstd, crs };
};
const AVAILABLE = { available: true, reason: null };
const BY_NODES = { available: false, reason: "nodes" };

// The curl container (curl with Brotli and Zstandard) on the e2e network.
await run([
  "run",
  "-d",
  "--name",
  CONTAINERS.curl,
  "--label",
  LABEL,
  "--network",
  network,
  "--entrypoint",
  "sh",
  CURL_IMAGE,
  "-c",
  "trap 'exit 0' TERM; while :; do sleep 3600 & wait; done",
]);
/** curl in the curl container; prints the body, then a line "<content-encoding>|<x-cache>". */
async function curl(host, path, ...args) {
  const out = await run([
    "exec",
    CONTAINERS.curl,
    "curl",
    "-sS",
    "--compressed",
    "-H",
    `Host: ${host}`,
    ...args,
    "-w",
    "\n%header{content-encoding}|%header{x-cache}",
    `http://node${path}`,
  ]);
  const cut = out.lastIndexOf("\n");
  const [encoding, cache] = out.slice(cut + 1).split("|");
  return { body: out.slice(0, cut), encoding, cache };
}

const rid = randomUUID().slice(0, 8);
let finished = false;
const sites = {};
try {
  // -------------------------------------------------------------- a. the custom build
  const nodes = await everyNode("both nodes report brotli-v1, zstd-v1 and modsecurity-v1", (n) =>
    G3_FEATURES.every((f) => n.supportedFeatures.includes(f)),
  );
  const builds = [];
  for (const service of ["node", "node-upgrade-peer"]) {
    const version = await inService(
      service,
      "/usr/lib/edgeweir-openresty/nginx/sbin/nginx -V 2>&1",
    );
    for (const want of [
      "nginx version: openresty/1.31.1.1",
      "--prefix=/usr/lib/edgeweir-openresty/nginx",
      "/ngx_brotli",
      "/zstd-nginx-module-",
      "--with-http_v3_module",
      "--with-http_v2_module",
      "--with-compat",
    ])
      assert.ok(version.includes(want), `${service}: nginx -V lacks ${want}`);
    // The master process the agent manages runs that binary.
    const exe = await inService(
      service,
      'for d in /proc/[0-9]*; do case "$(tr "\\0" " " <"$d/cmdline" 2>/dev/null)" in "nginx: master"*) readlink "$d/exe" ;; esac; done',
    );
    assert.equal(exe.trim(), "/usr/lib/edgeweir-openresty/nginx/sbin/nginx", `${service}: ${exe}`);
    const modules = await inService(
      service,
      "ls /usr/lib/edgeweir-openresty/modules /usr/share/edgeweir-openresty/crs/rules | grep -cE 'modsecurity_module|REQUEST-9'",
    );
    assert.ok(Number(modules) >= 10, `${service}: ModSecurity module or CRS missing (${modules})`);
    builds.push(
      `${service}: ${version.split("\n")[0]}, ${/built with (OpenSSL [^ ]+)/.exec(version)?.[1]}`,
    );
  }
  pass(
    `${nodes.map((n) => n.name).join(" and ")} report ${G3_FEATURES.join(", ")}; ${builds.join("; ")}; nginx -V: --prefix=/usr/lib/edgeweir-openresty/nginx, ngx_brotli, zstd-nginx-module, http_v3; the agent's nginx master runs /usr/lib/edgeweir-openresty/nginx/sbin/nginx`,
  );

  // -------------------------------------------------------------- b. compression
  sites.compress = await createSite("g3-compress", HOST_COMPRESS, "files");
  const compressDefaults = await https(sites.compress.id);
  assert.equal(compressDefaults.gzip, true);
  assert.equal(compressDefaults.brotli, false);
  assert.equal(compressDefaults.zstd, false);
  assert.deepEqual(await features(sites.compress.id), {
    brotli: AVAILABLE,
    zstd: AVAILABLE,
    crs: AVAILABLE,
  });
  const put = await putHttps(sites.compress.id, {
    ...compressDefaults,
    brotli: true,
    brotliLevel: 5,
    zstd: true,
    zstdLevel: 3,
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.brotliLevel, 5);
  await synced("Brotli and Zstandard published");
  const conf = await nginxConf();
  assert.ok(
    compresses(conf, "brotli") && compresses(conf, "zstd") && /brotli_comp_level 5;/.test(conf),
  );

  const text = Buffer.from(
    Array.from(
      { length: 160 },
      (_, i) =>
        `edgeweir g3 ${rid} line ${String(i).padStart(3, "0")}: compressed once at the edge\n`,
    ).join(""),
  );
  const encodedText = Buffer.from(
    Array.from({ length: 80 }, (_, i) => `origin-encoded ${rid} line ${i}\n`).join(""),
  );
  const tiny = Buffer.from(`tiny ${rid}\n`);
  await inService("files", `mkdir -p /srv/g3 && cat > /srv/g3/page-${rid}.txt`, text);
  await inService("files", `cat > /srv/g3/tiny-${rid}.txt`, tiny);
  await inService(
    "files",
    `mkdir -p /srv/g3-encoded && cat > /srv/g3-encoded/page-${rid}.txt`,
    zlib.gzipSync(encodedText),
  );
  const page = `/g3/page-${rid}.txt`;
  await waitFor(
    `${HOST_COMPRESS} served`,
    async () => (await edge(HOST_COMPRESS, "/g3-ready")).status === 404,
    60,
  );

  const NEGOTIATION = [
    ["br", "br"],
    ["zstd", "zstd"],
    ["gzip", "gzip"],
    [null, null],
    ["gzip, deflate, br, zstd", "zstd"],
    ["br;q=1, gzip;q=1, zstd;q=1", "zstd"],
    ["gzip, br", "br"],
    ["zstd;q=0.5, br;q=0.8, gzip;q=0.2", "br"],
    ["zstd;q=0, br;q=0, gzip", "gzip"],
    ["zstd;q=0, br;q=0, gzip;q=0", null],
    ["*;q=0.1, gzip", "gzip"],
    ["x-gzip", "gzip"],
    ["deflate", null],
    ["identity", null],
  ];
  const seen = [];
  for (const [index, [accept, want]] of NEGOTIATION.entries()) {
    const r = await edge(HOST_COMPRESS, page, {
      headers: accept === null ? {} : { "accept-encoding": accept },
    });
    const label = `Accept-Encoding: ${accept ?? "(none)"}`;
    assert.equal(r.status, 200, `${label}: ${summary(r)}`);
    assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT", `${label}: ${summary(r)}`);
    assert.equal(r.headers["content-encoding"], want ?? undefined, `${label}: ${summary(r)}`);
    assert.match(r.headers.vary ?? "", /accept-encoding/i, `${label}: Vary ${r.headers.vary}`);
    assert.ok(decode(want, r.body).equals(text), `${label}: the body does not decode to the file`);
    if (want) assert.ok(r.body.length < text.length / 2, `${label}: ${r.body.length} bytes`);
    seen.push(
      `${accept ?? "(none)"} -> ${r.headers["x-cache"]} ${want ?? "identity"} ${r.body.length}`,
    );
  }
  const originLog = (
    await inService("files", `grep -F ' /g3/page-${rid}.txt ' /tmp/g3.log || true`)
  ).trim();
  assert.equal(originLog, `GET /g3/page-${rid}.txt ae="-" status=200`, originLog);
  pass(
    `${HOST_COMPRESS}${page} (${text.length} bytes, text/plain): ${seen.join("; ")}; every response has Vary: Accept-Encoding and decodes to the file; the origin saw one request: ${originLog}`,
  );

  const viaCurl = [];
  for (const accept of ["br", "zstd", "gzip"]) {
    const r = await curl(HOST_COMPRESS, page, "-H", `Accept-Encoding: ${accept}`);
    assert.equal(
      r.encoding,
      accept,
      `curl --compressed -H 'Accept-Encoding: ${accept}': ${r.encoding}`,
    );
    assert.equal(r.cache, "HIT");
    assert.equal(r.body, text.toString("utf8"), `curl --compressed ${accept}: body differs`);
    viaCurl.push(`${accept} ${r.cache}`);
  }
  const plainCurl = await curl(HOST_COMPRESS, page);
  assert.equal(
    plainCurl.encoding,
    "zstd",
    "curl --compressed (deflate, gzip, br, zstd) must get zstd",
  );
  assert.equal(plainCurl.body, text.toString("utf8"));
  pass(
    `curl 8.22 --compressed in a container decodes ${viaCurl.join(", ")} to the file; with its own Accept-Encoding (deflate, gzip, br, zstd) it gets zstd`,
  );

  const encodedPath = `/g3-encoded/page-${rid}.txt`;
  const encodedSeen = [];
  for (const [index, accept] of ["br, zstd", "gzip, deflate, br, zstd", null].entries()) {
    const r = await edge(HOST_COMPRESS, encodedPath, {
      headers: accept === null ? {} : { "accept-encoding": accept },
    });
    assert.equal(r.status, 200, summary(r));
    assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT", summary(r));
    assert.equal(r.headers["content-encoding"], "gzip", `compressed again: ${summary(r)}`);
    assert.ok(zlib.gunzipSync(r.body).equals(encodedText), "the origin's gzip body changed");
    encodedSeen.push(`${accept ?? "(none)"} -> ${r.headers["x-cache"]} gzip`);
  }
  const encodedCurl = await curl(HOST_COMPRESS, encodedPath);
  assert.equal(encodedCurl.encoding, "gzip");
  assert.equal(encodedCurl.body, encodedText.toString("utf8"));
  const tinySeen = [];
  for (const index of [0, 1]) {
    const r = await edge(HOST_COMPRESS, `/g3/tiny-${rid}.txt`, {
      headers: { "accept-encoding": "zstd, br, gzip" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT");
    assert.equal(
      r.headers["content-encoding"],
      undefined,
      `under the minimum length: ${summary(r)}`,
    );
    assert.ok(r.body.equals(tiny));
    tinySeen.push(r.headers["x-cache"]);
  }
  pass(
    `an origin response with Content-Encoding: gzip passes unchanged (${encodedSeen.join("; ")}; one gunzip gives the text; curl --compressed decodes it); ${tiny.length} bytes (under the 256-byte minimum) stay identity (${tinySeen.join(" then ")})`,
  );
  const off = await putHttps(sites.compress.id, compressDefaults);
  assert.equal(off.status, 200, off.text);
  await synced("Brotli and Zstandard off");

  // -------------------------------------------------------------- c. OWASP CRS
  sites.crs = await createSite("g3-crs", HOST_CRS, "whoami", {
    cacheSettings: { cacheKey: { query: "ignore" } },
  });
  await admin.ok("PUT", `/sites/${sites.crs.id}/logs/settings`, { sampleRate: 10000 });
  assert.equal((await admin.ok("GET", `/sites/${sites.crs.id}/waf`)).mode, "off");
  const detect = await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, {
    mode: "detect",
    paranoiaLevel: 1,
    anomalyThreshold: 5,
    excludedRuleIds: [],
    requestBodyLimit: 131072,
  });
  assert.equal(detect.mode, "detect");
  await synced("CRS detect published");
  assert.ok(
    loadsModSecurity(await nginxConf()),
    "nginx.conf does not load ModSecurity for a CRS site",
  );
  await waitFor(
    `${HOST_CRS} served`,
    async () => (await edge(HOST_CRS, "/g3-ready")).status === 200,
    60,
  );

  /** Sampled log entries of a path (waits until `count` arrived). */
  async function logged(path, count = 1) {
    let entries = [];
    await waitFor(
      `sampled log of ${path}`,
      async () => {
        const query = new URLSearchParams({
          from: new Date(Date.now() - 600_000).toISOString(),
          to: new Date(Date.now() + 60_000).toISOString(),
          path,
          limit: "100",
        });
        entries = (await admin.ok("GET", `/sites/${sites.crs.id}/logs?${query}`)).entries.filter(
          (e) => e.path === path,
        );
        return entries.length >= count;
      },
      120,
      2000,
    );
    return entries;
  }

  const detectPath = `/g3-detect-${rid}`;
  const detected = [];
  for (const index of [0, 1]) {
    const r = await edge(HOST_CRS, `${detectPath}?${XSS_QUERY}`);
    assert.equal(r.status, 200, `detect mode must serve the payload: ${summary(r)}`);
    assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT");
    detected.push(r.headers["x-cache"]);
  }
  const detectLogs = await logged(detectPath, 2);
  for (const entry of detectLogs) {
    assert.equal(entry.status, 200);
    assert.equal(entry.wafBlocked, false);
    for (const rule of XSS_RULES)
      assert.ok(entry.wafRuleIds.includes(rule), `detect: ${rule} not in ${entry.wafRuleIds}`);
  }
  const detectIds = detectLogs[0].wafRuleIds;
  pass(
    `CRS detect on ${HOST_CRS}: GET ${detectPath}?${XSS_QUERY} -> 200 ${detected.join(" then ")}; sampled logs: wafRuleIds [${detectIds}] (${detectLogs.map((e) => e.cacheStatus).join(", ")}), wafBlocked false`,
  );

  let top = [];
  await waitFor(
    "the CRS rules in the site's top rules",
    async () => {
      const result = await admin.ok("GET", `/sites/${sites.crs.id}/waf/rules?range=1h`);
      assert.equal(result.approximate, true);
      top = result.items;
      return XSS_RULES.filter(detectionRule).every((rule) =>
        top.some((item) => item.ruleId === rule && item.requests >= 2),
      );
    },
    240,
    5000,
    () => JSON.stringify(top),
  );
  // 949110 matched every request above, but only detection rules rank.
  assert.ok(
    top.every((item) => detectionRule(item.ruleId)),
    `evaluation rules ranked: ${JSON.stringify(top)}`,
  );
  pass(`waf/rules?range=1h: ${top.map((t) => `${t.ruleId}×${t.requests}`).join(", ")}`);

  const block = await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, { mode: "block" });
  assert.deepEqual(
    {
      mode: block.mode,
      paranoiaLevel: block.paranoiaLevel,
      anomalyThreshold: block.anomalyThreshold,
    },
    { mode: "block", paranoiaLevel: 1, anomalyThreshold: 5 },
  );
  await synced("CRS block published");
  const cachedPath = `/g3-cached-${rid}`;
  const clean = [];
  for (const index of [0, 1]) {
    const r = await edge(HOST_CRS, cachedPath);
    assert.equal(r.status, 200, summary(r));
    assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT");
    assert.ok(!/^x-edgeweir/im.test(r.body.toString("utf8")), "X-Edgeweir-* reached the origin");
    clean.push(r.headers["x-cache"]);
  }
  const expectBlocked = (r, what) => {
    assert.equal(r.status, 403, `${what}: ${summary(r)}`);
    assert.equal(r.headers["x-edgeweir-error"], "waf-blocked", `${what}: ${summary(r)}`);
    assert.match(r.headers["cache-control"] ?? "", /no-store/, what);
    assert.equal(r.headers["x-cache"], undefined, `${what} reached the cache: ${summary(r)}`);
  };
  // The query is not part of the cache key: without CRS this would be a HIT.
  expectBlocked(await edge(HOST_CRS, `${cachedPath}?${XSS_QUERY}`), "payload on a cached URL");
  expectBlocked(
    await edge(HOST_CRS, cachedPath, { headers: { referer: XSS } }),
    "payload in a header on a cached URL",
  );
  const after = await edge(HOST_CRS, cachedPath);
  assert.equal(`${after.status} ${after.headers["x-cache"]}`, "200 HIT");
  const blockPath = `/g3-block-${rid}`;
  expectBlocked(await edge(HOST_CRS, `${blockPath}?${XSS_QUERY}`), "payload on a new URL");
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const postPath = `/g3-post-${rid}`;
  expectBlocked(
    await edge(HOST_CRS, postPath, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ comment: XSS }).toString(),
    }),
    "payload in a POST body",
  );
  const blockedLog = (await logged(blockPath))[0];
  assert.equal(blockedLog.status, 403);
  assert.equal(blockedLog.wafBlocked, true);
  assert.ok(blockedLog.wafRuleIds.includes(949110), `${blockedLog.wafRuleIds}`);
  // The cached URL's log (queries are not logged): three clean requests, two blocked ones.
  const cachedLog = await logged(cachedPath, 5);
  const describe = (entries) =>
    entries.map((e) => `${e.status} ${e.cacheStatus} ${e.wafBlocked} [${e.wafRuleIds}]`).join("; ");
  const cleanEntries = cachedLog.filter((e) => e.status === 200);
  const blockedEntries = cachedLog.filter((e) => e.status === 403);
  assert.equal(cleanEntries.length, 3, describe(cachedLog));
  assert.equal(blockedEntries.length, 2, describe(cachedLog));
  assert.ok(
    cleanEntries.every((e) => e.wafRuleIds.length === 0 && !e.wafBlocked),
    describe(cleanEntries),
  );
  assert.deepEqual(cleanEntries.map((e) => e.cacheStatus).sort(), ["HIT", "HIT", "MISS"]);
  assert.ok(
    blockedEntries.every((e) => e.wafBlocked && e.wafRuleIds.includes(949110)),
    describe(blockedEntries),
  );
  pass(
    `CRS block: a clean URL -> 200 ${clean.join(" then ")} (the origin sees no X-Edgeweir-*); the payload on that cached URL (query ignored in the cache key) and in its Referer -> 403 waf-blocked, no-store, no X-Cache; the clean URL is still 200 HIT; payload on a new URL and in a POST body -> 403; sampled logs: ${blockPath} 403, wafBlocked true, [${blockedLog.wafRuleIds}]; ${cachedPath}: ${describe(cachedLog)}`,
  );

  await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, { requestBodyLimit: 0 });
  await synced("request body limit 0 published");
  const unchecked = await edge(HOST_CRS, `${postPath}-nobody`, {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ comment: XSS }).toString(),
  });
  assert.equal(
    unchecked.status,
    200,
    `a body limit of 0 must skip the body: ${summary(unchecked)}`,
  );
  expectBlocked(await edge(HOST_CRS, `/g3-nobody-${rid}?${XSS_QUERY}`), "query with body limit 0");
  await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, { requestBodyLimit: 131072 });

  const excluded1 = await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, {
    excludedRuleIds: [941100],
  });
  assert.deepEqual(excluded1.excludedRuleIds, [941100]);
  await synced("excluded rule 941100 published");
  const excl1Path = `/g3-exclude-one-${rid}`;
  expectBlocked(await edge(HOST_CRS, `${excl1Path}?${XSS_QUERY}`), "payload with 941100 excluded");
  const excl1Log = (await logged(excl1Path))[0];
  assert.ok(!excl1Log.wafRuleIds.includes(941100), `941100 still matched: ${excl1Log.wafRuleIds}`);
  assert.ok(excl1Log.wafRuleIds.includes(941110), `${excl1Log.wafRuleIds}`);
  const allXss = detectIds.filter(detectionRule);
  const excluded2 = await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, {
    excludedRuleIds: [...allXss].reverse(),
  });
  assert.deepEqual(
    excluded2.excludedRuleIds,
    [...allXss].sort((a, b) => a - b),
  );
  await synced("every matched rule excluded");
  const excl2Path = `/g3-exclude-all-${rid}`;
  const passed = await edge(HOST_CRS, `${excl2Path}?${XSS_QUERY}`);
  assert.equal(
    passed.status,
    200,
    `with its rules excluded the payload must pass: ${summary(passed)}`,
  );
  const excl2Log = (await logged(excl2Path))[0];
  assert.deepEqual(excl2Log.wafRuleIds, []);
  assert.equal(excl2Log.wafBlocked, false);
  await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, { excludedRuleIds: [] });
  const demo = await edge("demo.test", `/g3-noncrs-${rid}?${XSS_QUERY}`);
  assert.equal(demo.status, 200, `demo.test (no CRS) must serve the payload: ${summary(demo)}`);
  pass(
    `request body limit 0: the POST payload passes (200), the query payload is still 403; excluding 941100: still 403, logged [${excl1Log.wafRuleIds}] without 941100; excluding [${allXss}]: 200, logged [] and not blocked; demo.test without CRS: payload -> ${summary(demo)}`,
  );

  await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, { mode: "off" });
  await synced("CRS off everywhere");
  const plain = await nginxConf();
  assert.ok(!loadsModSecurity(plain), "nginx.conf still loads ModSecurity without CRS sites");
  assert.ok(!compresses(plain, "brotli") && !compresses(plain, "zstd"));
  const offPayload = await edge(HOST_CRS, `/g3-off-${rid}?${XSS_QUERY}`);
  assert.equal(offPayload.status, 200, summary(offPayload));
  pass(
    "no site runs CRS: nginx.conf loads no ModSecurity module and the payload is served again; no site uses Brotli or Zstandard",
  );

  // -------------------------------------------------------------- d. old nodes
  const volumes = (await run(["volume", "ls", "--format", "{{.Name}}"])).split("\n");
  for (const volume of ["origin-ca", "geoip-test-data"])
    assert.ok(volumes.includes(`${project}_${volume}`), `volume ${project}_${volume} is missing`);
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
  /** Starts a node container on the e2e network and enrolls it into a cluster. */
  async function startNode(name, nodeName, image, cluster, env = {}) {
    await run([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      LABEL,
      "--hostname",
      nodeName,
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
      "-e",
      "EDGEWEIR_GEOIP_CITY=/etc/edgeweir-geoip/city.mmdb",
      "-e",
      "EDGEWEIR_GEOIP_ASN=/etc/edgeweir-geoip/asn.mmdb",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image,
    ]);
    const token = await admin.ok("POST", "/enrollment-tokens", {
      clusterId: cluster,
      nodeName,
      ttlMinutes: 15,
    });
    await execute(
      "docker",
      [
        "exec",
        "-e",
        "EDGEWEIR_TOKEN",
        name,
        "edgeweir-node",
        "enroll",
        "--server",
        token.serverUrl,
        "--ca-sha256",
        token.caSha256,
      ],
      { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
    );
    let found;
    await waitFor(
      `${nodeName} online with its features`,
      async () => {
        found = (await admin.ok("GET", `/nodes?clusterId=${cluster}`)).find(
          (n) => n.name === nodeName,
        );
        return found?.online && found.supportedFeatures.includes("challenge-v1");
      },
      120,
      1000,
      () => JSON.stringify(found ?? null),
    );
    return found;
  }
  async function removeNode(node, name) {
    await admin.ok("DELETE", `/nodes/${node.id}`);
    await run(["rm", "-f", name]);
  }
  const unchanged = async (siteId, what) => {
    const settings = await https(siteId);
    assert.equal(settings.brotli, false, `${what}: brotli changed`);
    assert.equal(settings.zstd, false, `${what}: zstd changed`);
    assert.equal(
      (await admin.ok("GET", `/sites/${siteId}/waf`)).mode,
      "off",
      `${what}: CRS changed`,
    );
  };

  await unchanged(sites.compress.id, "before the old nodes");
  const old = await startNode(CONTAINERS.old, "edge-g3-old", OLD_NODE_IMAGE, clusterId);
  for (const feature of G3_FEATURES)
    assert.ok(!old.supportedFeatures.includes(feature), `the old node reports ${feature}`);
  const oldBuild = await run(["exec", CONTAINERS.old, "sh", "-c", '"$EDGEWEIR_NGINX_BIN" -V 2>&1']);
  const oldVersion = oldBuild.split("\n")[0];
  assert.match(oldVersion, /openresty\/1\.31\.1\.1/);
  assert.ok(
    !/ngx_brotli|zstd-nginx-module|edgeweir-openresty/.test(oldBuild),
    `the old node's nginx is not the stock OpenResty: ${oldBuild}`,
  );
  const expectAllNodes = { brotli: BY_NODES, zstd: BY_NODES, crs: BY_NODES };
  assert.deepEqual(await features(sites.compress.id), expectAllNodes);
  assert.deepEqual(await features(sites.crs.id), expectAllNodes);
  const revisionWithOld = await latestRevision();
  // The old node runs the cluster's configuration (nothing needs G3 yet).
  await waitFor(
    "the old node applies the cluster's revision",
    async () => {
      const n = await nodeById(old.id);
      return n.applyState === "applied" && n.appliedRevision >= revisionWithOld;
    },
    90,
  );
  pass(
    `old node edge-g3-old (${OLD_NODE_IMAGE}, stock ${oldVersion}, features without ${G3_FEATURES.join(", ")}) joined the default cluster and applied #${revisionWithOld}: features brotli, zstd and crs report "nodes" on ${HOST_COMPRESS} and ${HOST_CRS}`,
  );

  // The operator may still require the feature: the old node cannot take that revision.
  const forced = await putHttps(sites.compress.id, { ...compressDefaults, brotli: true });
  assert.equal(forced.status, 200, forced.text);
  const forcedRevision = await synced("the operator's Brotli published");
  await sleep(5000);
  const held = await nodeById(old.id);
  assert.ok(held.appliedRevision < forcedRevision, `the old node applied #${held.appliedRevision}`);
  const undo = await putHttps(sites.compress.id, compressDefaults);
  assert.equal(undo.status, 200, undo.text);
  const undoRevision = await synced("Brotli off again");
  await waitFor(
    "the old node catches up once Brotli is off",
    async () => (await nodeById(old.id)).appliedRevision >= undoRevision,
    90,
  );
  pass(
    `the operator turns Brotli on anyway (#${forcedRevision}): node and peer apply it, the old node stays on #${held.appliedRevision}; with Brotli off again (#${undoRevision}) the old node applies the new revision`,
  );

  await removeNode(old, CONTAINERS.old);
  assert.deepEqual(await features(sites.compress.id), {
    brotli: AVAILABLE,
    zstd: AVAILABLE,
    crs: AVAILABLE,
  });
  const noModsec = await startNode(CONTAINERS.noModsec, "edge-g3-nomodsec", nodeImage, clusterId, {
    EDGEWEIR_MODSECURITY_MODULE: "off",
  });
  assert.ok(noModsec.supportedFeatures.includes("brotli-v1"), `${noModsec.supportedFeatures}`);
  assert.ok(noModsec.supportedFeatures.includes("zstd-v1"), `${noModsec.supportedFeatures}`);
  assert.ok(
    !noModsec.supportedFeatures.includes("modsecurity-v1"),
    `${noModsec.supportedFeatures}`,
  );
  const onlyCrs = { brotli: AVAILABLE, zstd: AVAILABLE, crs: BY_NODES };
  assert.deepEqual(await features(sites.compress.id), onlyCrs);
  assert.deepEqual(await features(sites.crs.id), onlyCrs);
  // Zstandard needs nothing this node lacks: it takes the revision.
  const zstdOn = await putHttps(sites.compress.id, { ...compressDefaults, zstd: true });
  assert.equal(zstdOn.status, 200, zstdOn.text);
  const zstdRevision = await synced("Zstandard published");
  await waitFor(
    "the node without ModSecurity applies the Zstandard revision",
    async () => {
      const n = await nodeById(noModsec.id);
      return n.applyState === "applied" && n.appliedRevision >= zstdRevision;
    },
    90,
  );
  assert.equal((await putHttps(sites.compress.id, compressDefaults)).status, 200);
  await removeNode(noModsec, CONTAINERS.noModsec);
  for (const siteId of [sites.compress.id, sites.crs.id])
    assert.deepEqual(await features(siteId), {
      brotli: AVAILABLE,
      zstd: AVAILABLE,
      crs: AVAILABLE,
    });
  await unchanged(sites.compress.id, "after the old nodes");
  await synced("old nodes removed");
  pass(
    `edge-g3-nomodsec (${nodeImage}, EDGEWEIR_MODSECURITY_MODULE=off) reports brotli-v1 and zstd-v1 but not modsecurity-v1: only crs reports "nodes"; it applies the operator's Zstandard (#${zstdRevision}); both nodes removed: brotli, zstd and crs available again`,
  );

  // -------------------------------------------------------------- g3.spec.ts: a cluster with an old node
  const legacyCluster = await admin.ok("POST", "/clusters", { name: "g3-legacy" });
  const legacyNode = await startNode(
    CONTAINERS.legacy,
    "edge-g3-legacy",
    OLD_NODE_IMAGE,
    legacyCluster.id,
  );
  const { site: legacySite } = await admin.ok("POST", "/sites", {
    name: "g3-legacy",
    clusterId: legacyCluster.id,
    domains: [HOST_LEGACY],
    origins: [{ address: "whoami" }],
  });
  assert.deepEqual(await features(legacySite.id), expectAllNodes);
  await waitFor(
    "the legacy node applies its cluster's revision",
    async () => {
      const n = await nodeById(legacyNode.id);
      return (
        n.applyState === "applied" && n.appliedRevision >= (await latestRevision(legacyCluster.id))
      );
    },
    90,
  );
  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        compressSiteId: sites.compress.id,
        compressHost: HOST_COMPRESS,
        crsSiteId: sites.crs.id,
        crsHost: HOST_CRS,
        crsRuleIds: detectIds,
        crsLoggedPath: blockPath,
        legacySiteId: legacySite.id,
        legacyClusterId: legacyCluster.id,
        legacyNodeName: legacyNode.name,
      },
      null,
      2,
    )}\n`,
  );
  pass(
    `cluster g3-legacy with the old node ${legacyNode.name} (online) and site ${HOST_LEGACY} (brotli, zstd and crs unavailable: "nodes") for g3.spec.ts; ${leftovers.removed} leftover container(s) removed`,
  );
  finished = true;
} finally {
  if (!finished) {
    await removeContainers().catch((e) => console.error(`cleanup: ${e.message}`));
  } else {
    await run(["rm", "-f", CONTAINERS.curl]).catch(() => {});
  }
}
console.log("G3 E2E OK");
