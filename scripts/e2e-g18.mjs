// Site parity G18 end to end (WebP / AVIF conversion), after the G17 step.
// `node` and `node-upgrade-peer` serve the default cluster; every request goes
// from client-a to one of them by name, so both nodes are checked the same
// way. Origin g18-origin (docker/e2e/g18-origin) serves JPEG and PNG test
// pictures and counts its answers for /photo.jpg.
//   a. both nodes report image-convert-v1
//   b. img.g18.test before conversion: JPEG for every Accept, no Vary: Accept
//   c. conversion on (WebP 80, AVIF 50, JPEG and PNG, 1 KiB-10 MiB, 1,000,000
//      pixels): Accept image/webp gets image/webp (MISS, then the same
//      variant HIT), image/avif gets image/avif, */* and a navigation get the
//      JPEG; Vary: Accept on all three; the origin answered once per class
//      and node; the variants are smaller than the JPEG
//   d. a path without an extension and the PNG are converted; the 1500 x
//      1000 picture (over the pixel limit) stays JPEG for WebP clients and is
//      cached that way
//   e. AVIF off: AVIF clients get the cached WebP variant
//   f. the saved bytes reach imageConvert.savings
//   g. conversion off: WebP clients get the cached JPEG, no Vary: Accept
// The site stays for apps/console/e2e/g18.spec.ts (.e2e/g18-state.json) with
// conversion on; `node scripts/e2e-g18.mjs --cleanup` removes it.
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
const STATE = ".e2e/g18-state.json";
const HOST = "img.g18.test";
const NODES = ["node", "node-upgrade-peer"];
const ORIGIN = [{ address: "g18-origin", port: 8080 }];
const WEBP = "image/webp,*/*";
const AVIF = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
const NAV = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const SETTINGS = {
  enabled: true,
  webp: true,
  avif: true,
  webpQuality: 80,
  avifQuality: 50,
  jpeg: true,
  png: true,
  minSize: 1024,
  maxSize: 10 * 1024 * 1024,
  maxPixels: 1_000_000,
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
  return (await rpc(base, cookie, "accessKeys/create", { name: "g18-e2e" })).key;
}

/** The signed-in operator with an AccessKey, renewed every 500 calls. */
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

/** Sequential GETs from client-a; the body comes back as its length and first 16 bytes (hex). */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { host: r.host, ...(r.headers ?? {}) };
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path, method: r.method ?? "GET",
        headers, agent: false, timeout: 30000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, length: body.length,
            head: body.subarray(0, 16).toString("hex"), text: body.toString("utf8").slice(0, 200) });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, length: 0, head: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list) =>
  JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
const get = async (target, path, accept) =>
  (await requests([{ target, host: HOST, path, headers: accept ? { accept } : {} }]))[0];
const varyAccept = (r) =>
  (r.headers.vary ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .includes("accept");
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["content-type"] ?? "-"} vary=${r.headers.vary ?? "-"} ${r.length}B ${r.head}${r.error ? ` ${r.error}` : ""}`;
const isWebp = (r) => r.head.startsWith("52494646") && r.head.slice(16, 24) === "57454250";
const isAvif = (r) => r.head.slice(8, 24) === "6674797061766966";
const isJpeg = (r) => r.head.startsWith("ffd8ff");
/** Asserts status 200, X-Cache, Content-Type and Vary: Accept of a response. */
function expectResponse(r, cache, type, vary, label) {
  assert.equal(r.status, 200, `${label}: ${summary(r)}`);
  assert.equal(r.headers["x-cache"], cache, `${label}: ${summary(r)}`);
  assert.equal(r.headers["content-type"], type, `${label}: ${summary(r)}`);
  assert.equal(varyAccept(r), vary, `${label}: ${summary(r)}`);
  assert.equal(r.headers["x-edgeweir-image-saved"], undefined, `${label}: internal header sent`);
}
const originCount = async () =>
  Number(
    (await requests([{ target: "g18-origin", port: 8080, host: "g18-origin", path: "/count" }]))[0]
      .text,
  );

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
  const site = await findSite(HOST);
  if (site) {
    await admin.ok("DELETE", `/sites/${site.id}`);
    removed++;
  }
  // Sites a failed browser run left (apps/console/e2e/g18.spec.ts).
  for (const left of (await admin.ok("GET", "/sites?search=g18-ui-&pageSize=100")).items) {
    if (!left.name.startsWith("g18-ui-")) continue;
    await admin.ok("DELETE", `/sites/${left.id}`);
    removed++;
  }
  pass(`G18 cleanup: ${removed} site(s) removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

let finished = false;
try {
  // -------------------------------------------------------------- a. features
  await everyNode(
    "both nodes report image-convert-v1",
    (n) => n.online && n.supportedFeatures.includes("image-convert-v1"),
  );
  pass("both nodes report image-convert-v1");

  // -------------------------------------------------------------- b. before
  const old = await findSite(HOST);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name: "g18-images",
    domains: [HOST],
    origins: ORIGIN,
    clusterId,
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 300, originCacheControl: "override" }],
  });
  const features = await admin.ok("GET", `/sites/${site.id}/features`);
  assert.deepEqual(features.imageConvert, { available: true, reason: null });
  assert.deepEqual(
    await admin.ok("GET", `/sites/${site.id}/image-convert`),
    { ...SETTINGS, enabled: false, avif: false, png: true, maxPixels: 16_000_000 },
    "defaults",
  );
  await synced("img.g18.test published");
  for (const target of NODES) {
    const r = await get(target, "/photo.jpg?before", WEBP);
    expectResponse(r, "MISS", "image/jpeg", false, `${target} before conversion`);
  }
  pass("before conversion: JPEG for image/webp clients, no Vary: Accept");

  // -------------------------------------------------------------- c. on
  const saved = await admin.ok("PUT", `/sites/${site.id}/image-convert`, SETTINGS);
  assert.deepEqual(saved, SETTINGS);
  await synced("conversion on");
  const countBefore = await originCount();
  const sizes = {};
  for (const target of NODES) {
    for (const [accept, type, check] of [
      [WEBP, "image/webp", isWebp],
      [AVIF, "image/avif", isAvif],
      ["*/*", "image/jpeg", isJpeg],
    ]) {
      const first = await get(target, "/photo.jpg", accept);
      expectResponse(first, "MISS", type, true, `${target} ${accept} (first)`);
      assert.ok(check(first), `${target} ${accept}: not a ${type} file: ${summary(first)}`);
      const second = await get(target, "/photo.jpg", accept);
      expectResponse(second, "HIT", type, true, `${target} ${accept} (second)`);
      assert.equal(second.length, first.length, `${target} ${accept}: another object`);
      assert.match(
        second.headers.etag ?? "",
        type === "image/jpeg" ? /^"g18-\d+"$/ : new RegExp(`-${type.slice(6)}"$`),
      );
      sizes[type] = first.length;
    }
    const nav = await get(target, "/photo.jpg", NAV);
    expectResponse(nav, "HIT", "image/jpeg", true, `${target} navigation`);
    const none = await get(target, "/photo.jpg");
    expectResponse(none, "HIT", "image/jpeg", true, `${target} without Accept`);
  }
  assert.equal(
    (await originCount()) - countBefore,
    NODES.length * 3,
    "the origin served /photo.jpg once per class and node",
  );
  assert.ok(sizes["image/webp"] < sizes["image/jpeg"], JSON.stringify(sizes));
  assert.ok(sizes["image/avif"] < sizes["image/jpeg"], JSON.stringify(sizes));
  pass(
    `both nodes: image/webp and image/avif (MISS, then HIT), the JPEG for */*, navigations and no Accept, Vary: Accept; origin once per class and node; sizes ${JSON.stringify(sizes)}`,
  );

  // -------------------------------------------------------------- d. paths and limits
  for (const target of NODES) {
    expectResponse(
      await get(target, "/photo", WEBP),
      "MISS",
      "image/webp",
      true,
      `${target} no extension`,
    );
    const png = await get(target, "/icon.png", WEBP);
    expectResponse(png, "MISS", "image/webp", true, `${target} PNG`);
    assert.ok(isWebp(png), summary(png));
    const huge = await get(target, "/huge.jpg", WEBP);
    expectResponse(huge, "MISS", "image/jpeg", true, `${target} over the pixel limit`);
    assert.ok(isJpeg(huge), summary(huge));
    expectResponse(
      await get(target, "/huge.jpg", WEBP),
      "HIT",
      "image/jpeg",
      true,
      `${target} over the limit, cached`,
    );
    const text = await get(target, "/page.txt", WEBP);
    assert.equal(varyAccept(text), false, `${target} /page.txt: ${summary(text)}`);
  }
  pass(
    "a path without an extension and the PNG converted; over the pixel limit the JPEG is served and cached; other paths untouched",
  );

  // -------------------------------------------------------------- e. AVIF off
  await admin.ok("PUT", `/sites/${site.id}/image-convert`, { ...SETTINGS, avif: false });
  await synced("AVIF off");
  for (const target of NODES)
    expectResponse(
      await get(target, "/photo.jpg", AVIF),
      "HIT",
      "image/webp",
      true,
      `${target} AVIF off`,
    );
  await admin.ok("PUT", `/sites/${site.id}/image-convert`, SETTINGS);
  await synced("AVIF on again");
  pass("AVIF off: AVIF clients get the cached WebP variant");

  // -------------------------------------------------------------- f. savings
  const savings = await waitFor(
    "saved bytes in imageConvert.savings",
    async () => {
      const s = await admin.ok("GET", `/sites/${site.id}/image-convert/savings?range=1h`);
      return s.bytesSaved > 0 ? s : null;
    },
    240,
    5000,
  );
  assert.equal(savings.unsupportedNodes, 0);
  pass(`saved bytes reported: ${savings.bytesSaved}`);

  // -------------------------------------------------------------- g. off
  await admin.ok("PUT", `/sites/${site.id}/image-convert`, { ...SETTINGS, enabled: false });
  await synced("conversion off");
  for (const target of NODES)
    expectResponse(
      await get(target, "/photo.jpg", WEBP),
      "HIT",
      "image/jpeg",
      false,
      `${target} off`,
    );
  await admin.ok("PUT", `/sites/${site.id}/image-convert`, SETTINGS);
  await synced("conversion on for the browser checks");
  pass("conversion off: the cached JPEG for every Accept, no Vary: Accept");

  await writeFile(STATE, JSON.stringify({ siteId: site.id, host: HOST }, null, 2));
  finished = true;
  pass("G18 end-to-end checks passed");
} finally {
  if (!finished) console.error("G18 checks failed; the site stays for inspection");
}
