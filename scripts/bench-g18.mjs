// WebP / AVIF conversion bench (G18) on a running compose.e2e stack: how long
// a variant's first request (a cache miss that converts) takes compared with
// the original's first request and with a cache hit, and how much wall and
// CPU time each conversion took in the node's converter (its "image
// converted" log lines). `node scripts/bench-g18.mjs` sets up
// bench-img.g18.test (origin g18-origin, cached, WebP 80 / AVIF 50, JPEG and
// PNG), requests BENCH_IMAGES (default 20) distinct URLs of each test picture
// per class from client-a to the node `node` one after another, writes
// .e2e/bench-g18.json (BENCH_OUTPUT) and prints a summary. The site stays for
// `BENCH_SCENARIO=image` / `image-original` of scripts/bench.sh;
// `node scripts/bench-g18.mjs --cleanup` removes it.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args) => (await execute("docker", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const HOST = "bench-img.g18.test";
const IMAGES = Number(process.env.BENCH_IMAGES ?? 20);
const OUTPUT = process.env.BENCH_OUTPUT ?? ".e2e/bench-g18.json";
const CLASSES = { original: "*/*", webp: "image/webp,*/*", avif: "image/avif,image/webp,*/*" };
const PICTURES = ["/photo.jpg", "/icon.png"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status < 300, `${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const signIn = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
assert.equal(signIn.status, 200, "sign in");
const cookie = signIn.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const key = (await rpc(base, cookie, "accessKeys/create", { name: "g18-bench" })).key;
const api = (method, path, body) => call(key, method, path, body);
const findSite = async () =>
  (await api("GET", `/sites?search=${HOST}&pageSize=100`)).items.find((s) =>
    s.domains.includes(HOST),
  );

if (process.argv.includes("--cleanup")) {
  const site = await findSite();
  if (site) await api("DELETE", `/sites/${site.id}`);
  console.log(`bench-g18 cleanup: ${site ? 1 : 0} site(s) removed`);
  process.exit(0);
}

const containerId = async (service) => (await run([...compose, "ps", "-q", service])).trim();
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
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(out).toString("utf8"))
        : reject(new Error(Buffer.concat(err).toString("utf8"))),
    );
    child.stdin.end(input);
  });
}
/** Sequential timed GETs from client-a: status, X-Cache, Content-Type, bytes and milliseconds. */
const TIMED = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    const start = process.hrtime.bigint();
    out.push(await new Promise((resolve) => {
      const req = http.request({ host: "node", port: 80, path: r.path, headers: { host: r.host, accept: r.accept },
        agent: false, timeout: 30000 }, (res) => {
        let bytes = 0;
        res.on("data", (d) => (bytes += d.length));
        res.on("end", () => resolve({ status: res.statusCode, cache: res.headers["x-cache"], type: res.headers["content-type"],
          bytes, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
      });
      req.on("error", (e) => resolve({ status: 0, error: e.message, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const timed = async (list) => JSON.parse(await nodeIn("client-a", TIMED, JSON.stringify(list)));

const old = await findSite();
if (old) await api("DELETE", `/sites/${old.id}`);
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const { site } = await api("POST", "/sites", {
  name: "g18-bench",
  domains: [HOST],
  origins: [{ address: "g18-origin", port: 8080 }],
  clusterId: upgrade.clusterId,
  cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 3600, originCacheControl: "override" }],
});
await api("PUT", `/sites/${site.id}/image-convert`, {
  enabled: true,
  webp: true,
  avif: true,
  webpQuality: 80,
  avifQuality: 50,
  jpeg: true,
  png: true,
  minSize: 1024,
  maxSize: 10 * 1024 * 1024,
  maxPixels: 16_000_000,
});
// Until the node serves the site with conversion.
const deadline = Date.now() + 120_000;
for (;;) {
  const [probe] = await timed([
    { host: HOST, path: `/photo.jpg?probe=${Date.now()}`, accept: CLASSES.webp },
  ]);
  if (probe.type === "image/webp") break;
  assert.ok(Date.now() < deadline, `the node does not convert yet: ${JSON.stringify(probe)}`);
  await sleep(1000);
}

const since = new Date().toISOString();
const runId = Date.now().toString(36);
const results = {};
for (const picture of PICTURES) {
  for (const [name, accept] of Object.entries(CLASSES)) {
    const misses = await timed(
      Array.from({ length: IMAGES }, (_, i) => ({
        host: HOST,
        path: `${picture}?b=${runId}-${i}`,
        accept,
      })),
    );
    const hits = await timed(
      Array.from({ length: IMAGES }, (_, i) => ({
        host: HOST,
        path: `${picture}?b=${runId}-${i}`,
        accept,
      })),
    );
    for (const r of misses)
      assert.equal(r.cache, "MISS", `${picture} ${name}: ${JSON.stringify(r)}`);
    for (const r of hits) assert.equal(r.cache, "HIT", `${picture} ${name}: ${JSON.stringify(r)}`);
    results[`${picture} ${name}`] = {
      type: misses[0].type,
      bytes: misses[0].bytes,
      missMs: stats(misses.map((r) => r.ms)),
      hitMs: stats(hits.map((r) => r.ms)),
    };
  }
}
await sleep(1000);
const logs = await run([...compose, "logs", "--no-color", "--since", since, "node"]);
const conversions = logs
  .split("\n")
  .filter((line) => line.includes("image converted") && line.includes(`site=${site.id}`))
  .map((line) => ({
    format: /format=(\w+)/.exec(line)?.[1],
    kind: /kind=(\w+)/.exec(line)?.[1],
    pixels: Number(/pixels=(\d+)/.exec(line)?.[1]),
    ms: Number(/ ms=(\d+)/.exec(line)?.[1]),
    cpuMs: Number(/cpu_ms=(\d+)/.exec(line)?.[1]),
    in: Number(/ in=(\d+)/.exec(line)?.[1]),
    out: Number(/ out=(\d+)/.exec(line)?.[1]),
  }));
const converter = {};
for (const c of conversions) {
  const k = `${c.kind} -> ${c.format}`;
  converter[k] ??= {
    count: 0,
    pixels: c.pixels,
    inBytes: c.in,
    outBytes: c.out,
    ms: [],
    cpuMs: [],
  };
  converter[k].count++;
  converter[k].ms.push(c.ms);
  converter[k].cpuMs.push(c.cpuMs);
}
for (const v of Object.values(converter)) {
  v.ms = stats(v.ms);
  v.cpuMs = stats(v.cpuMs);
}
const summary = {
  host: HOST,
  images: IMAGES,
  at: new Date().toISOString(),
  requests: results,
  converter,
};
await writeFile(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    p50: Number(at(0.5)?.toFixed(1)),
    p95: Number(at(0.95)?.toFixed(1)),
    max: Number(sorted.at(-1)?.toFixed(1)),
  };
}
