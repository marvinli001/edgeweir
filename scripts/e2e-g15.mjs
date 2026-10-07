// Site parity G15 end to end (cache, origins and content), after the G8 step.
// `node` and `node-upgrade-peer` serve the default cluster; every request goes
// from client-a (or client-b) to one of them by name, so both nodes are
// checked the same way. Origins g15-origin-a and g15-origin-b
// (docker/e2e/g15-origin) and MinIO (S3-compatible object storage).
//   a. both nodes report site-content-v1 and cache-zone-v1
//   b. cache zone: the cluster's size and inactive time reach nginx.conf on
//      both nodes (keys_zone derived from the size), node-upgrade-peer's own
//      size overrides it there only, and both nodes report their usage
//   c. content.g15.test: a cache rule that caches Set-Cookie responses sends
//      the cookies (both lines, the comma intact) with the fetched response
//      only, cache hits for other visitors carry none; utm_* parameters are
//      left out of the cache key, others are not
//   d. charset gbk (force, upper case) on text responses, none on an image
//   e. request body limit 1024 bytes: 413 with the 4xx page above it by
//      Content-Length, a config rule lifts it under /upload/, a chunked
//      upload is bounded by the nodes' global limit only
//   f. gzip level 9 rendered, a response over the largest compressed length
//      stays uncompressed
//   g. PURGE with the key: 202 with the task, a URL purge of the cluster
//      (source purge_method) that both nodes run; a wrong key 403; more
//      than the per-second rate 429
//   h. error pages: a 4xx class template, a 404 redirect with {{status}} and
//      {{request_id}}, a 405 page, a 5xx class template sent as 200
//   i. X-Cache off on nox.g15.test only
//   j. maintenance on maint.g15.test: 503 with Retry-After, no-store and the
//      page for client-b; client-a's address, an allowed path prefix and
//      ACME HTTP-01 pass; the change is audited; off again, the origin answers
//   k. origin tries: retry.g15.test (2 tries) retries origin a's 502 on b,
//      noretry.g15.test (no retry after 502-504) and once.g15.test (1 try)
//      pass it on
//   l. s3.g15.test: the MinIO preset (path-style bucket, region us-east-1)
//      signs requests to a private bucket the script fills with SigV4
//      requests of its own
// The G15 sites stay for apps/console/e2e/g15.spec.ts (.e2e/g15-state.json);
// `node scripts/e2e-g15.mjs --cleanup` removes them, except the bench site
// charset-bench.g15.test (whoami, cached, charset gbk forced) for
// BENCH_SCENARIO=charset in scripts/bench.sh.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g15-state.json";

const HOST = {
  content: "content.g15.test",
  nox: "nox.g15.test",
  maint: "maint.g15.test",
  retry: "retry.g15.test",
  noretry: "noretry.g15.test",
  once: "once.g15.test",
  s3: "s3.g15.test",
};
const HOST_BENCH = "charset-bench.g15.test";
const NODES = ["node", "node-upgrade-peer"];
const PURGE_KEY = "e2e-g15-purge-key-0123456789";
const MINIO = {
  host: "minio",
  port: 9000,
  region: "us-east-1",
  bucket: "g15",
  accessKeyId: "e2e-minio-access",
  secretAccessKey: "e2e-only-minio-secret",
};

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
  return (await rpc(base, cookie, "accessKeys/create", { name: "g15-e2e" })).key;
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
const containerIp = async (service, network = "_default") => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const name = Object.keys(info.NetworkSettings.Networks).find((n) => n.endsWith(network));
  assert.ok(name, `${service} is not on ${network}`);
  return info.NetworkSettings.Networks[name].IPAddress;
};
/** nginx.conf the agent rendered on a node. */
const nginxConf = async (service) =>
  run(["exec", await containerId(service), "cat", "/var/lib/edgeweir-node/nginx/conf/nginx.conf"]);

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
 * HTTP requests from a client container (sequential, or all at once with
 * parallel), with the raw header lines. A request may carry `bodySize` bytes
 * of "a", with a Content-Length or, with `chunked`, in chunks.
 */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const { list, parallel } = JSON.parse(input);
  const one = (r) => new Promise((resolve) => {
    const headers = { ...(r.headers ?? {}) };
    if (r.host) headers.host = r.host;
    const body = r.bodySize === undefined ? undefined : "a".repeat(r.bodySize);
    if (body !== undefined && !r.chunked) headers["content-length"] = String(body.length);
    const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path, method: r.method ?? "GET",
      headers, agent: false, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders,
        body: Buffer.concat(chunks).toString("latin1") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, rawHeaders: [], body: "" }));
    if (body !== undefined && r.chunked) {
      const half = Math.floor(body.length / 2);
      req.write(body.slice(0, half));
      req.write(body.slice(half));
    } else if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
  const out = [];
  if (parallel) out.push(...(await Promise.all(list.map(one))));
  else for (const r of list) out.push(await one(r));
  process.stdout.write(JSON.stringify(out));
});`;
async function requests(list, { from = "client-a", parallel = false } = {}) {
  if (list.length === 0) return [];
  return JSON.parse(await nodeIn(from, REQUESTS, JSON.stringify({ list, parallel })));
}
const request = async (r, options) => (await requests([r], options))[0];
/** The values of every line of a response header, as sent. */
const lines = (r, name) =>
  r.rawHeaders.flatMap((v, i) =>
    i % 2 === 0 && v.toLowerCase() === name ? [r.rawHeaders[i + 1]] : [],
  );
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""} ${JSON.stringify(r.body.slice(0, 120))}`;

/**
 * Signs and sends S3 requests to MinIO from client-a (AWS Signature Version
 * 4, as https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 * describes it); resolves the statuses and bodies.
 */
const S3_REQUESTS = `
const crypto = require("node:crypto");
const http = require("node:http");
let input = "";
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, v) => crypto.createHmac("sha256", key).update(v).digest();
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const { s3, list } = JSON.parse(input);
  const out = [];
  for (const r of list) {
    out.push(await new Promise((resolve) => {
      const body = r.body ?? "";
      const amzDate = new Date().toISOString().replace(/[-:]|\\.\\d{3}/g, "");
      const day = amzDate.slice(0, 8);
      const headers = { host: s3.host + ":" + s3.port, "x-amz-content-sha256": sha(body), "x-amz-date": amzDate };
      const names = Object.keys(headers).sort();
      const canonical = [r.method, r.path, "", ...names.map((n) => n + ":" + headers[n]), "", names.join(";"), sha(body)].join("\\n");
      const scope = day + "/" + s3.region + "/s3/aws4_request";
      const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\\n");
      let key = hmac("AWS4" + s3.secretAccessKey, day);
      for (const part of [s3.region, "s3", "aws4_request"]) key = hmac(key, part);
      const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
      if (r.signed !== false)
        headers.authorization = "AWS4-HMAC-SHA256 Credential=" + s3.accessKeyId + "/" + scope +
          ", SignedHeaders=" + names.join(";") + ", Signature=" + signature;
      if (r.contentType) headers["content-type"] = r.contentType;
      headers["content-length"] = String(Buffer.byteLength(body));
      const req = http.request({ host: s3.host, port: s3.port, path: r.path, method: r.method, headers, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", (e) => resolve({ status: 0, body: e.message }));
      req.end(body);
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const s3Requests = async (list) =>
  JSON.parse(await nodeIn("client-a", S3_REQUESTS, JSON.stringify({ s3: MINIO, list })));

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
          cache: n.cache,
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

/** The cluster's cache zone as the e2e stack starts it, restored at the end and by --cleanup. */
const DEFAULT_CACHE = { maxSizeGb: 10, inactiveDays: 7 };
async function restoreCache() {
  await admin.ok("PUT", `/nodes/${peerId}/cache`, { maxSizeGb: null });
  await admin.ok("PUT", `/clusters/${clusterId}/cache`, DEFAULT_CACHE);
}

async function cleanup() {
  let removed = 0;
  for (const host of Object.values(HOST)) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  await restoreCache();
  pass(`G15 cleanup: ${removed} site(s) removed, cache zone sizes restored`);
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
const originA = [{ address: "g15-origin-a", port: 8080 }];
const originsAB = [
  { address: "g15-origin-a", port: 8080 },
  { address: "g15-origin-b", port: 8080 },
];
const cacheRule = (prefix, extra = {}) => ({
  pathPrefixes: [prefix],
  edgeTtlSeconds: 60,
  originCacheControl: "override",
  ...extra,
});
/** The cache zone line of a rendered nginx.conf: keys_zone and max_size in MiB, inactive in seconds. */
function cacheZone(conf) {
  const m =
    /proxy_cache_path \S+ levels=1:2 keys_zone=([^:]+):(\d+)m max_size=(\d+)m inactive=(\d+)s/.exec(
      conf,
    );
  assert.ok(m, "nginx.conf has no proxy_cache_path");
  return { name: m[1], keysMb: Number(m[2]), maxMb: Number(m[3]), inactive: Number(m[4]) };
}

let finished = false;
try {
  // -------------------------------------------------------------- a. features
  await everyNode(
    "both nodes report site-content-v1 and cache-zone-v1",
    (n) =>
      n.online &&
      n.supportedFeatures.includes("site-content-v1") &&
      n.supportedFeatures.includes("cache-zone-v1"),
  );
  pass("both nodes report site-content-v1 and cache-zone-v1");

  // -------------------------------------------------------------- b. cache zone
  const cluster = await admin.ok("GET", `/clusters/${clusterId}`);
  assert.deepEqual(cluster.cache, DEFAULT_CACHE, "the stack's default cache zone changed");
  await admin.ok("PUT", `/clusters/${clusterId}/cache`, { maxSizeGb: 3, inactiveDays: 2 });
  await synced("the cluster's cache zone");
  for (const service of NODES) {
    const zone = cacheZone(await nginxConf(service));
    assert.deepEqual(
      { maxMb: zone.maxMb, keysMb: zone.keysMb, inactive: zone.inactive },
      { maxMb: 3072, keysMb: 20, inactive: 2 * 86_400 },
      `${service}: ${JSON.stringify(zone)}`,
    );
  }
  await admin.ok("PUT", `/nodes/${peerId}/cache`, { maxSizeGb: 2 });
  await synced("node-upgrade-peer's own cache size");
  assert.equal(cacheZone(await nginxConf("node")).maxMb, 3072);
  const own = cacheZone(await nginxConf("node-upgrade-peer"));
  assert.deepEqual([own.maxMb, own.keysMb], [2048, 16], JSON.stringify(own));
  assert.equal((await nodeById(peerId)).cache.maxSizeGb, 2);
  const reported = await everyNode(
    "cache usage of both nodes with their sizes",
    (n) =>
      n.cache.usage !== null &&
      n.cache.usage.maxBytes === (n.id === peerId ? 2 : 3) * 1024 ** 3 &&
      Date.now() - Date.parse(n.cache.usage.measuredAt) < 60_000,
    90,
  );
  pass(
    `cache zone: 3 GB / 2 days on both nodes (keys_zone 20m), node-upgrade-peer's own 2 GB (16m) there only; usage ${reported.map((n) => `${n.name} ${n.cache.usage.usedBytes}/${n.cache.usage.maxBytes}`).join(", ")}`,
  );

  // -------------------------------------------------------------- sites
  const content = await createSite("g15-content", [HOST.content], originA, {
    cacheRules: [
      cacheRule("/account/", { cacheSetCookie: true }),
      cacheRule("/ck"),
      cacheRule("/text/"),
    ],
    cacheSettings: {
      cacheKey: { query: "exclude", queryParams: ["utm_*"] },
      purgeMethod: { enabled: true, key: PURGE_KEY },
    },
    contentSettings: {
      charset: { name: "gbk", force: true, uppercase: true },
      requestBodyLimit: 1024,
    },
  });
  await admin.ok("PUT", `/sites/${content.id}/rules`, {
    rules: [
      {
        name: "g15 uploads",
        phase: "config",
        enabled: true,
        expression: 'starts_with(http.request.uri.path, "/upload/")',
        action: { kind: "config", requestBodyLimit: 0 },
      },
    ],
  });
  const https = await admin.ok("GET", `/sites/${content.id}/https`);
  await admin.ok("PUT", `/sites/${content.id}/https`, {
    id: content.id,
    settings: {
      ...https,
      gzip: true,
      gzipMinLength: 100,
      gzipTypes: ["text/plain"],
      gzipLevel: 9,
      compressMaxLength: 2000,
    },
  });
  await admin.ok("PUT", `/sites/${content.id}/error-pages`, {
    id: content.id,
    interceptOriginErrors: true,
    pages: [
      { status: "4xx", template: "<p>c4 {{status}}</p>" },
      { status: 404, redirectUrl: "/nf?s={{status}}&id={{request_id}}" },
      { status: 405, template: "<p>m405 {{status}}</p>" },
      { status: "5xx", template: "<p>c5 {{status}}</p>", responseStatus: 200 },
    ],
  });
  const nox = await createSite("g15-nox", [HOST.nox], originA, {
    cacheRules: [cacheRule("/")],
    cacheSettings: { xCache: false },
  });
  const maint = await createSite("g15-maint", [HOST.maint], originA, {
    cacheRules: [cacheRule("/")],
  });
  const retrySite = (name, host, settings) =>
    createSite(name, [host], originsAB, {
      originSettings: { policy: "round_robin", ...settings },
    });
  await retrySite("g15-retry", HOST.retry, { tries: 2 });
  await retrySite("g15-noretry", HOST.noretry, { tries: 2, statusRetry: false });
  await retrySite("g15-once", HOST.once, { tries: 1 });
  const s3 = await createSite(
    "g15-s3",
    [HOST.s3],
    [
      {
        address: MINIO.host,
        port: MINIO.port,
        s3: {
          region: MINIO.region,
          bucket: MINIO.bucket,
          accessKeyId: MINIO.accessKeyId,
          secretAccessKey: MINIO.secretAccessKey,
        },
      },
    ],
  );
  await createSite("g15-charset-bench", [HOST_BENCH], [{ address: "whoami" }], {
    cacheRules: [cacheRule("/")],
    contentSettings: { charset: { name: "gbk", force: true, uppercase: false } },
  });
  const features = await admin.ok("GET", `/sites/${content.id}/features`);
  assert.deepEqual(features.siteContent, { available: true, reason: null });
  await synced("the G15 sites");

  // -------------------------------------------------------------- c. Set-Cookie, cache key
  for (const target of NODES) {
    const [first, ...hits] = await requests([
      { target, host: HOST.content, path: "/account/me" },
      ...[1, 2, 3].map(() => ({
        target,
        host: HOST.content,
        path: "/account/me",
        headers: { cookie: "other=visitor" },
      })),
    ]);
    assert.equal(first.headers["x-cache"], "MISS", `${target}: ${summary(first)}`);
    const sid = /^account (a-\d+)$/m.exec(first.body)?.[1];
    assert.ok(sid, `${target}: ${summary(first)}`);
    assert.deepEqual(lines(first, "set-cookie"), [
      `sid=${sid}; Path=/; HttpOnly`,
      "pref=a,b; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    ]);
    for (const hit of hits) {
      assert.equal(hit.headers["x-cache"], "HIT", `${target}: ${summary(hit)}`);
      assert.deepEqual(lines(hit, "set-cookie"), [], `${target}: a cache hit carries cookies`);
      assert.deepEqual(lines(hit, "x-edgeweir-set-cookie"), []);
      assert.ok(!hit.rawHeaders.join("\n").includes(sid), `${target}: ${hit.rawHeaders}`);
      assert.match(hit.body, new RegExp(`^account ${sid}$`, "m"));
    }
    const [ckMiss, ckHit, ckOther] = await requests([
      { target, host: HOST.content, path: "/ck?id=1&utm_source=a" },
      { target, host: HOST.content, path: "/ck?utm_medium=b&id=1&utm_source=z" },
      { target, host: HOST.content, path: "/ck?id=2&utm_source=a" },
    ]);
    assert.deepEqual(
      [ckMiss.headers["x-cache"], ckHit.headers["x-cache"], ckOther.headers["x-cache"]],
      ["MISS", "HIT", "MISS"],
      `${target}: ${[ckMiss, ckHit, ckOther].map(summary).join(" | ")}`,
    );
  }
  pass(
    "Set-Cookie: both lines (comma intact) with the fetched response only, cache hits for other visitors carry none, on both nodes; utm_* left out of the cache key, id kept",
  );

  // -------------------------------------------------------------- d. charset
  for (const target of NODES) {
    const [plain, text, img] = await requests([
      { target, host: HOST.content, path: "/plain" },
      { target, host: HOST.content, path: "/text/10" },
      { target, host: HOST.content, path: "/img" },
    ]);
    assert.equal(plain.headers["content-type"], "text/plain; charset=GBK", summary(plain));
    assert.equal(text.headers["content-type"], "text/plain; charset=GBK", summary(text));
    assert.equal(img.headers["content-type"], "image/png", summary(img));
  }
  pass("charset: GBK (forced over the origin's utf-8, upper case) on text, none on image/png");

  // -------------------------------------------------------------- e. body limit
  for (const target of NODES) {
    const [over, within, upload, chunked] = await requests([
      {
        target,
        host: HOST.content,
        path: "/form",
        method: "POST",
        bodySize: 2000,
        headers: { "accept-language": "en" },
      },
      { target, host: HOST.content, path: "/form", method: "POST", bodySize: 1000 },
      { target, host: HOST.content, path: "/upload/x", method: "POST", bodySize: 2000 },
      { target, host: HOST.content, path: "/form", method: "POST", bodySize: 2000, chunked: true },
    ]);
    assert.equal(over.status, 413, summary(over));
    assert.equal(over.headers["x-edgeweir-error"], "body-too-large", summary(over));
    assert.match(over.body, /<p>c4 413<\/p>/);
    assert.match(within.body, /^received 1000 bytes$/m, summary(within));
    assert.match(upload.body, /^received 2000 bytes$/m, summary(upload));
    assert.match(chunked.body, /^received 2000 bytes$/m, summary(chunked));
  }
  pass(
    "body limit: 413 with the 4xx page over 1024 bytes by Content-Length, 1000 bytes pass, the config rule lifts it under /upload/, a chunked upload is not checked",
  );

  // -------------------------------------------------------------- f. gzip
  for (const target of NODES) {
    assert.match(await nginxConf(target), /gzip_comp_level 9;/, `${target}: gzip level`);
    const [small, large] = await requests([
      { target, host: HOST.content, path: "/text/1500", headers: { "accept-encoding": "gzip" } },
      { target, host: HOST.content, path: "/text/5000", headers: { "accept-encoding": "gzip" } },
    ]);
    assert.equal(small.headers["content-encoding"], "gzip", summary(small));
    assert.equal(large.headers["content-encoding"], undefined, summary(large));
    assert.equal(large.body.length, 5000);
  }
  pass("gzip: level 9 rendered, 1500 bytes compressed, 5000 bytes over the largest length are not");

  // -------------------------------------------------------------- g. PURGE
  for (const target of NODES)
    assert.equal(
      (await request({ target, host: HOST.content, path: "/ck?id=1" })).headers["x-cache"],
      "HIT",
    );
  const purged = await request({
    target: "node",
    host: HOST.content,
    path: "/ck?id=1&utm_source=x",
    method: "PURGE",
    headers: { "x-purge-key": PURGE_KEY },
  });
  assert.equal(purged.status, 202, summary(purged));
  assert.equal(purged.headers["cache-control"], "no-store");
  // The site forces charset GBK; the node's own answers keep their type.
  assert.equal(purged.headers["content-type"], "application/json");
  const taskId = JSON.parse(purged.body).task_id;
  const task = await waitFor(
    "the PURGE task succeeds on both nodes",
    async () => {
      const t = await admin.ok("GET", `/cache-tasks/${taskId}`);
      return t.state === "succeeded" ? t : null;
    },
    60,
  );
  assert.equal(task.type, "url");
  assert.equal(task.source, "purge_method");
  assert.deepEqual(task.targets, [`http://${HOST.content}/ck?id=1&utm_source=x`]);
  assert.deepEqual(task.sites, [{ id: content.id, name: "g15-content" }]);
  assert.deepEqual(
    task.nodes.map((n) => n.nodeId).sort(),
    [edgeId, peerId].sort(),
    JSON.stringify(task.nodes),
  );
  for (const target of NODES)
    assert.equal(
      (await request({ target, host: HOST.content, path: "/ck?id=1" })).headers["x-cache"],
      "MISS",
      `${target}: not purged`,
    );
  const [wrong, missing] = await requests([
    {
      target: "node-upgrade-peer",
      host: HOST.content,
      path: "/ck?id=1",
      method: "PURGE",
      headers: { "x-purge-key": "wrong-key-0123456789abc" },
    },
    { target: "node-upgrade-peer", host: HOST.content, path: "/ck?id=1", method: "PURGE" },
  ]);
  assert.equal(wrong.status, 403, summary(wrong));
  assert.equal(wrong.headers["x-edgeweir-error"], "purge-key-invalid");
  assert.equal(missing.status, 403, summary(missing));
  const off = await request({ target: "node", host: HOST.nox, path: "/", method: "PURGE" });
  assert.notEqual(off.status, 202, `PURGE on a site without the method: ${summary(off)}`);
  const burst = await requests(
    Array.from({ length: 40 }, () => ({
      target: "node",
      host: HOST.content,
      path: "/x",
      method: "PURGE",
      headers: { "x-purge-key": "wrong-key-0123456789abc" },
    })),
    { parallel: true },
  );
  const limited = burst.filter((r) => r.status === 429);
  assert.ok(limited.length > 0, `no 429 in ${burst.map((r) => r.status).join(",")}`);
  assert.equal(limited[0].headers["x-edgeweir-error"], "purge-rate-limited");
  const tasks = await admin.ok("GET", `/cache-tasks?siteId=${content.id}&pageSize=50`);
  assert.equal(tasks.items.filter((t) => t.source === "purge_method").length, 1);
  pass(
    `PURGE: 202 with task ${taskId} (url, purge_method) that both nodes ran, the object misses again; a wrong or missing key 403, a site without the method refuses, ${limited.length} of 40 at once 429`,
  );

  // -------------------------------------------------------------- h. error pages
  for (const target of NODES) {
    const [notFound, gone, method, server] = await requests([
      { target, host: HOST.content, path: "/status/404" },
      { target, host: HOST.content, path: "/status/410" },
      { target, host: HOST.content, path: "/status/405" },
      { target, host: HOST.content, path: "/status/500" },
    ]);
    assert.equal(notFound.status, 302, summary(notFound));
    assert.match(notFound.headers.location, /^\/nf\?s=404&id=[0-9a-f]{32}$/);
    assert.equal(
      notFound.headers.location.slice(-32),
      notFound.headers["x-request-id"],
      "{{request_id}} is the response's X-Request-Id",
    );
    assert.equal(gone.status, 410, summary(gone));
    assert.match(gone.body, /<p>c4 410<\/p>/);
    assert.equal(method.status, 405, summary(method));
    assert.match(method.body, /<p>m405 405<\/p>/);
    assert.equal(server.status, 200, summary(server));
    assert.match(server.body, /<p>c5 500<\/p>/);
    assert.equal(server.headers["x-edgeweir-error"], "origin-error");
  }
  pass(
    "error pages: 404 redirect (302, status and request id), 4xx class for 410, a 405 page, 5xx class for 500 sent as 200",
  );

  // -------------------------------------------------------------- i. X-Cache
  for (const target of NODES) {
    const [hidden, shown] = await requests([
      { target, host: HOST.nox, path: "/x" },
      { target, host: HOST.content, path: "/ck?id=9" },
    ]);
    assert.equal(hidden.status, 200, summary(hidden));
    assert.equal(hidden.headers["x-cache"], undefined, summary(hidden));
    assert.equal(shown.headers["x-cache"], "MISS", summary(shown));
  }
  pass("X-Cache: hidden on nox.g15.test, sent on content.g15.test");

  // -------------------------------------------------------------- j. maintenance
  const clientA = await containerIp("client-a");
  const maintenance = await admin.ok("PUT", `/sites/${maint.id}/maintenance`, {
    id: maint.id,
    enabled: true,
    template: "<p>maint {{status}}</p>",
    retryAfterSeconds: 30,
    allowedCidrs: [`${clientA}/32`],
    allowedPathPrefixes: ["/open"],
  });
  await synced("maintenance on");
  for (const target of NODES) {
    const [closed, again, open, acme] = await requests(
      [
        { target, host: HOST.maint, path: "/closed" },
        { target, host: HOST.maint, path: "/closed" },
        { target, host: HOST.maint, path: "/open/x" },
        { target, host: HOST.maint, path: "/.well-known/acme-challenge/g15-token" },
      ],
      { from: "client-b" },
    );
    assert.equal(closed.status, 503, summary(closed));
    assert.equal(closed.headers["retry-after"], "30");
    assert.equal(closed.headers["cache-control"], "no-store");
    assert.equal(closed.headers["x-edgeweir-error"], "maintenance");
    assert.match(closed.body, /<p>maint 503<\/p>/);
    assert.equal(again.status, 503, summary(again));
    assert.equal(open.status, 200, summary(open));
    assert.match(open.body, /^a GET \/open\/x$/m);
    assert.notEqual(acme.status, 503, `ACME HTTP-01 under maintenance: ${summary(acme)}`);
    assert.notEqual(acme.headers["x-edgeweir-error"], "maintenance");
    const allowed = await request({ target, host: HOST.maint, path: "/" });
    assert.equal(allowed.status, 200, `client-a (${clientA}): ${summary(allowed)}`);
  }
  const audit = await admin.ok("GET", "/audit-logs?action=site.maintenance_update&limit=10");
  assert.ok(
    audit.items.some((e) => e.targetId === maint.id),
    `no site.maintenance_update for ${maint.id}`,
  );
  await admin.ok("PUT", `/sites/${maint.id}/maintenance`, {
    id: maint.id,
    enabled: false,
    template: "<p>maint {{status}}</p>",
    retryAfterSeconds: 30,
    allowedCidrs: [`${clientA}/32`],
    allowedPathPrefixes: ["/open"],
    expectedUpdatedAt: maintenance.updatedAt,
  });
  await synced("maintenance off");
  for (const target of NODES) {
    const reopened = await request(
      { target, host: HOST.maint, path: "/closed" },
      { from: "client-b" },
    );
    assert.equal(reopened.status, 200, `the 503 was cached: ${summary(reopened)}`);
    assert.equal(reopened.headers["x-cache"], "MISS", summary(reopened));
  }
  pass(
    `maintenance: 503 with Retry-After 30, no-store and the page for client-b; client-a (${clientA}/32), /open and ACME HTTP-01 pass; audited; off again, the origin answers (nothing cached)`,
  );

  // -------------------------------------------------------------- k. origin tries
  const fails = async (target, host) =>
    (await requests(Array.from({ length: 12 }, () => ({ target, host, path: "/fail-a" })))).filter(
      (r) => r.status === 502,
    ).length;
  const counts = {};
  for (const target of NODES) {
    counts[target] = {
      retry: await fails(target, HOST.retry),
      noretry: await fails(target, HOST.noretry),
      once: await fails(target, HOST.once),
    };
    assert.equal(counts[target].retry, 0, `${target}: ${JSON.stringify(counts[target])}`);
    assert.ok(counts[target].noretry >= 3, `${target}: ${JSON.stringify(counts[target])}`);
    assert.ok(counts[target].once >= 1, `${target}: ${JSON.stringify(counts[target])}`);
  }
  pass(
    `origin tries: 502 of origin a retried on b (2 tries), passed on without status retries or with 1 try (502 of 12: ${JSON.stringify(counts)})`,
  );

  // -------------------------------------------------------------- l. S3 (MinIO)
  const objectBody = "hello from minio\n";
  const filled = await s3Requests([
    { method: "PUT", path: `/${MINIO.bucket}` },
    {
      method: "PUT",
      path: `/${MINIO.bucket}/hello.txt`,
      body: objectBody,
      contentType: "text/plain",
    },
    { method: "GET", path: `/${MINIO.bucket}/hello.txt`, signed: false },
  ]);
  assert.ok([200, 409].includes(filled[0].status), `create bucket: ${JSON.stringify(filled[0])}`);
  assert.equal(filled[1].status, 200, `put object: ${JSON.stringify(filled[1])}`);
  assert.equal(filled[2].status, 403, `the bucket is not private: ${JSON.stringify(filled[2])}`);
  for (const target of NODES) {
    const [object, missingObject] = await requests([
      { target, host: HOST.s3, path: "/hello.txt" },
      { target, host: HOST.s3, path: "/missing.txt" },
    ]);
    assert.equal(object.status, 200, summary(object));
    assert.equal(object.body, objectBody);
    assert.equal(missingObject.status, 404, summary(missingObject));
  }
  pass(
    "S3 origin (MinIO preset, path-style g15, us-east-1): signed requests read a private object, 404 for a missing one",
  );

  await restoreCache();
  await synced("the cache zone restored");
  for (const service of NODES)
    assert.equal(cacheZone(await nginxConf(service)).maxMb, DEFAULT_CACHE.maxSizeGb * 1024);

  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        contentSiteId: content.id,
        maintSiteId: maint.id,
        s3SiteId: s3.id,
        noxSiteId: nox.id,
        clusterId,
        nodeId: peerId,
      },
      null,
      2,
    )}\n`,
  );
  finished = true;
  console.log("G15 E2E OK");
} finally {
  if (!finished) {
    console.log("G15 E2E FAILED (sites kept for inspection)");
    await restoreCache().catch((e) => console.error(`cleanup: ${e.message}`));
  }
}
