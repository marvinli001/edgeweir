// Two edge nodes for the access log and statistics comparison of
// scripts/bench.sh (BENCH_SCENARIO=dims and logs), on a compose.e2e stack after
// the full e2e (or after setup). Each is the only node of its own cluster
// serving <base|new>.cache.bench.g16.test (whoami, a cache rule on /, no
// access logs) and <base|new>.logs.bench.g16.test (the same, sampling every
// request into the access log):
//   g16-bench-base  edgeweir-node:pre-g16 (the node before G16, built from
//                   E2E_PRE_G16_COMMIT when missing), :80 on
//                   127.0.0.1:${E2E_G16_BENCH_BASE_PORT:-18953}
//   g16-bench-new   the image of this stack (edgeweir-node:${E2E_TAG}),
//                   127.0.0.1:${E2E_G16_BENCH_NEW_PORT:-18954}
// Both read the GeoIP fixture. dims compares cache hits with a browser
// User-Agent and an external Referer (G16 counts countries, networks,
// referrers, clients and protocols per request; the node before G16 counts
// none); logs compares the same with every request logged (G16 writes the
// new fields). `--cleanup` removes both nodes, clusters and sites. Prints the
// bench.sh variables of each.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const nodeContext = process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node";
/** The node before G16: no access-logs-v2 or stats-dims-v1. */
const OLD_IMAGE = process.env.E2E_PRE_G16_IMAGE ?? "edgeweir-node:pre-g16";
/** Last edgeweir-node commit before G16 (proto v0.29.0); builds OLD_IMAGE when it is missing. */
const OLD_COMMIT = process.env.E2E_PRE_G16_COMMIT ?? "b9c217b";
const NEW_IMAGE = `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`;
const compose = ["compose", "-f", "compose.e2e.yml"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BENCH = {
  base: {
    cluster: "g16-bench-base",
    image: OLD_IMAGE,
    httpPort: Number(process.env.E2E_G16_BENCH_BASE_PORT ?? 18953),
  },
  new: {
    cluster: "g16-bench-new",
    image: NEW_IMAGE,
    httpPort: Number(process.env.E2E_G16_BENCH_NEW_PORT ?? 18954),
  },
};
/** Sites per node: a domain belongs to one site. */
const cacheHost = (which) => `${which}.cache.bench.g16.test`;
const logsHost = (which) => `${which}.logs.bench.g16.test`;

async function waitFor(label, fn, seconds = 180, interval = 1000) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label}`);
}

const response = await waitFor("sign in", async () => {
  const r = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
  return r.status === 200 ? r : null;
});
const cookie = response.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const key = (await rpc(base, cookie, "accessKeys/create", { name: "g16-bench" })).key;
async function api(method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const consoleId = (await run([...compose, "ps", "-q", "console"])).trim();
assert.ok(consoleId, "console is not running");
const project = JSON.parse(await run(["inspect", consoleId]))[0].Config.Labels[
  "com.docker.compose.project"
];
const LABEL = `dev.edgeweir.g16-bench=${project}`;
const container = (which) => `${project}-g16-bench-${which}`;
const clusterNamed = async (name) => (await api("GET", "/clusters")).find((c) => c.name === name);

async function cleanup() {
  const ids = (await run(["ps", "-aq", "--filter", `label=${LABEL}`])).split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  for (const bench of Object.values(BENCH)) {
    const cluster = await clusterNamed(bench.cluster);
    if (!cluster) continue;
    for (const site of (await api("GET", `/sites?pageSize=100&clusterId=${cluster.id}`)).items)
      await api("DELETE", `/sites/${site.id}`);
    for (const node of await api("GET", `/nodes?clusterId=${cluster.id}`))
      await api("DELETE", `/nodes/${node.id}`);
    await api("DELETE", `/clusters/${cluster.id}`);
  }
  console.log(`g16 bench nodes removed (${ids.length} container(s))`);
}

async function synced(cluster) {
  const latest = (await api("GET", `/clusters/${cluster.id}`)).latestRevision.revision;
  await waitFor(`${cluster.name} applies #${latest}`, async () =>
    (await api("GET", `/nodes?clusterId=${cluster.id}`)).every(
      (n) => n.online && n.applyState === "applied" && n.appliedRevision >= latest,
    ),
  );
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

await cleanup();
try {
  await run(["image", "inspect", OLD_IMAGE]);
} catch {
  console.log(`building ${OLD_IMAGE} from edgeweir-node ${OLD_COMMIT}`);
  await execute(
    "sh",
    [
      "-c",
      'git -C "$1" archive "$2" | docker build -q -t "$3" -',
      "sh",
      nodeContext,
      OLD_COMMIT,
      OLD_IMAGE,
    ],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
const network = Object.keys(
  JSON.parse(await run(["inspect", consoleId]))[0].NetworkSettings.Networks,
).find((name) => name.endsWith("_default"));
for (const [which, bench] of Object.entries(BENCH)) {
  const cluster = await api("POST", "/clusters", { name: bench.cluster });
  await run([
    "run",
    "-d",
    "--name",
    container(which),
    "--label",
    LABEL,
    "--hostname",
    `edge-g16-bench-${which}`,
    "--network",
    network,
    "-p",
    `127.0.0.1:${bench.httpPort}:80`,
    "-v",
    `${project}_geoip-test-data:/etc/edgeweir-geoip:ro`,
    "-e",
    "EDGEWEIR_GEOIP_IPINFO=/etc/edgeweir-geoip/ipinfo_lite.mmdb",
    bench.image,
  ]);
  const token = await api("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: `edge-g16-bench-${which}`,
    ttlMinutes: 15,
  });
  await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      container(which),
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  await waitFor(`edge-g16-bench-${which} online`, async () =>
    (await api("GET", `/nodes?clusterId=${cluster.id}`)).some((n) => n.online),
  );
  const site = (host) =>
    api("POST", "/sites", {
      name: `${bench.cluster}-${host.split(".")[0]}`,
      clusterId: cluster.id,
      domains: [host],
      origins: [{ address: "whoami" }],
      cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 3600, originCacheControl: "override" }],
    });
  await site(cacheHost(which));
  const { site: logged } = await site(logsHost(which));
  await api("PUT", `/sites/${logged.id}/logs/settings`, { sampleRate: 10000 });
  await synced(cluster);
  const node = (await api("GET", `/nodes?clusterId=${cluster.id}`))[0];
  console.log(
    `${which}: BENCH_URL=http://127.0.0.1:${bench.httpPort}/bench-cache.txt BENCH_HOST=${cacheHost(which)} (logs: BENCH_HOST=${logsHost(which)}) BENCH_NODE_CONTAINER=${container(which)} (${bench.image}, ${node.version ?? "?"}, stats-dims-v1 ${node.supportedFeatures.includes("stats-dims-v1") ? "yes" : "no"})`,
  );
}
