// Tiered cache end to end (ADR-0073), in a cluster of its own ("tiers"):
// three nodes started here (tier-a and tier-b in region tier-east, tier-c in
// region tier-west) with their container addresses as scheduling addresses,
// and a site on the G4 test origin g4-origin-a, which counts what it serves.
//   a. the nodes report tiered-cache-v1 and tier-upper-v1 and measure the
//      origin; the smart topology names the fastest node as every other
//      node's upper tier and a node of the other region as the fallback
//   b. a URL requested through all three nodes is fetched from the origin
//      once; the upper tiers' hit ratio reaches the site's statistics
//   c. the tier listener refuses a client without a node certificate
//   d. a URL purge clears every tier: the next request through a lower tier
//      reaches the origin once, the other lower tier is then served by the
//      upper tier
//   e. with the upper tier stopped the lower tiers use the fallback; with
//      both upper tiers stopped the last node fetches from the origin
//   f. latency injected on the upper tier's way to the origin (nftables drops
//      each connection's first SYN, so every connect waits for the
//      retransmission) moves the upper tier to another node
// `node scripts/e2e-tiers.mjs --cleanup` removes the site, the nodes, the
// cluster, its regions and the containers.
import assert from "node:assert/strict";
import { actor, execute, pass, stack, waitFor } from "./e2e-lib.mjs";

const { run, containerId, nodeIn } = stack({ maxBuffer: 16 * 1024 * 1024 });
const CLUSTER = "tiers";
const HOST = "tiers.e2e.test";
const REGIONS = [
  { code: "tier-east", name: "Tier East" },
  { code: "tier-west", name: "Tier West" },
];
const NODES = [
  { name: "tier-a", region: "tier-east" },
  { name: "tier-b", region: "tier-east" },
  { name: "tier-c", region: "tier-west" },
];
const IMAGE = `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`;

const project = JSON.parse(await run(["inspect", await containerId("node")]))[0].Config.Labels[
  "com.docker.compose.project"
];
/** Containers started here carry this label; scripts/e2e.sh removes them on exit. */
const LABEL = `dev.edgeweir.e2e-tiers=${project}`;
const container = (name) => `${project}-${name}`;

const admin = await actor("admin@e2e.test", "e2e-admin-password-123", "tiers-e2e");

async function removeContainers() {
  const ids = (await run(["ps", "-aq", "--filter", `label=${LABEL}`])).split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  return ids.length;
}

async function cleanup() {
  const removed = await removeContainers();
  const site = (
    await admin.ok("GET", `/sites?search=${encodeURIComponent(HOST)}&pageSize=100`)
  ).items.find((s) => s.domains.includes(HOST));
  if (site) await admin.ok("DELETE", `/sites/${site.id}`);
  const cluster = (await admin.ok("GET", "/clusters")).find((c) => c.name === CLUSTER);
  if (cluster) {
    for (const node of await admin.ok("GET", `/nodes?clusterId=${cluster.id}`))
      await admin.ok("DELETE", `/nodes/${node.id}`);
    await admin.ok("DELETE", `/clusters/${cluster.id}`);
  }
  for (const region of await admin.ok("GET", "/regions"))
    if (REGIONS.some((r) => r.code === region.code))
      await admin.ok("DELETE", `/regions/${region.id}`);
  pass(
    `tiers cleanup: site, cluster ${cluster ? CLUSTER : "(none)"} and ${removed} container(s) removed`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

/** Sequential HTTP requests from client-a: { status, headers, body }. */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path, method: r.method ?? "GET",
        headers: { host: r.host, ...(r.headers ?? {}) }, agent: false, timeout: 30000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
      if (r.body) req.write(r.body);
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list) =>
  JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
const get = async (node, path) =>
  (await requests([{ target: container(node), host: HOST, path }]))[0];
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;

/** Requests the origin g4-origin-a served for `path` of the site. */
async function originHits(path) {
  const [r] = await requests([
    { target: "g4-origin-a", port: 8080, host: "g4-origin-a", path: "/control/hits" },
  ]);
  assert.equal(r.status, 200, `origin hits: ${summary(r)}`);
  const { hits } = JSON.parse(r.body);
  // Every key, so that a request under another Host shows in the output.
  console.log(`origin hits for ${path}: ${JSON.stringify(hits)}`);
  return hits[`${HOST} ${path} d`] ?? 0;
}

// ---------------------------------------------------------------- setup
await removeContainers();
await cleanup();
const network = Object.keys(
  JSON.parse(await run(["inspect", await containerId("node")]))[0].NetworkSettings.Networks,
).find((name) => name.endsWith("_default"));
assert.ok(network, "node is not on the default network");
const cluster = await admin.ok("POST", "/clusters", { name: CLUSTER });
const groups = {};
for (const region of REGIONS) {
  const created = await admin.ok("POST", "/regions", region);
  groups[region.code] = (
    await admin.ok("POST", "/node-groups", {
      clusterId: cluster.id,
      name: region.code,
      regionId: created.id,
    })
  ).id;
}

const nodes = {};
for (const spec of NODES) {
  const name = container(spec.name);
  await run([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    LABEL,
    "--hostname",
    spec.name,
    "--network",
    network,
    "--cap-add",
    "NET_ADMIN",
    "-v",
    `${project}_origin-ca:/etc/edgeweir-e2e:ro`,
    "-e",
    "EDGEWEIR_TRUSTED_CA=/etc/edgeweir-e2e/origin-ca.pem",
    "-e",
    `EDGEWEIR_STATS_INTERVAL=${process.env.E2E_STATS_INTERVAL ?? "5s"}`,
    IMAGE,
  ]);
  const token = await admin.ok("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeGroupId: groups[spec.region],
    nodeName: spec.name,
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
  const ip = JSON.parse(await run(["inspect", name]))[0].NetworkSettings.Networks[network]
    .IPAddress;
  nodes[spec.name] = { ...spec, container: name, ip };
}
const byId = {};
let listed = [];
await waitFor(
  "the tier nodes online with tiered-cache-v1 and tier-upper-v1",
  async () => {
    listed = await admin.ok("GET", `/nodes?clusterId=${cluster.id}`);
    return (
      listed.length === NODES.length &&
      listed.every(
        (n) =>
          n.online &&
          n.supportedFeatures.includes("tiered-cache-v1") &&
          n.supportedFeatures.includes("tier-upper-v1"),
      )
    );
  },
  180,
  1000,
  () =>
    JSON.stringify(
      listed.map((n) => ({
        name: n.name,
        online: n.online,
        f: n.supportedFeatures.filter((f) => f.startsWith("tier")),
      })),
    ),
);
for (const n of listed) {
  nodes[n.name].id = n.id;
  byId[n.id] = nodes[n.name];
  await admin.ok("PUT", `/nodes/${n.id}/addresses`, {
    addresses: [{ address: nodes[n.name].ip, level: 0 }],
  });
}
pass(`a: ${NODES.length} nodes in 2 regions report tiered-cache-v1 and tier-upper-v1`);

const { site } = await admin.ok("POST", "/sites", {
  name: "tiers",
  clusterId: cluster.id,
  domains: [HOST],
  origins: [{ address: "g4-origin-a", port: 8080 }],
  cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 600, originCacheControl: "override" }],
});
await admin.ok("PUT", `/sites/${site.id}/tiered-cache`, {
  topology: "smart",
  upperNodeIds: [],
  upperNodeGroupIds: [],
});

/** Waits until the selection has upper tiers and `check` holds; returns it. */
let selection;
const selected = (label, check = () => true, seconds = 240) =>
  waitFor(
    label,
    async () => {
      selection = await admin.ok("GET", `/sites/${site.id}/tiered-cache/selection`);
      return selection.idleReason === null &&
        selection.nodes.some((n) => n.uppers.length) &&
        check(selection)
        ? selection
        : null;
    },
    seconds,
    2000,
    () => JSON.stringify(selection),
  );
/** The node every other node names first, and the fallback (the other region's). */
const roles = (s) => {
  const lower = s.nodes.find((n) => n.uppers.length > 1) ?? s.nodes.find((n) => n.uppers.length);
  const upper = lower.uppers[0].nodeId;
  const fallback = lower.uppers.find((u) => u.reason === "fallback_region")?.nodeId;
  return {
    upper,
    fallback,
    lowers: s.nodes.filter((n) => n.nodeId !== upper).map((n) => n.nodeId),
  };
};
/** Every node of the cluster applied the latest revision. */
const applied = () =>
  waitFor(
    "every tier node applied the latest revision",
    async () => {
      const latest =
        (await admin.ok("GET", `/clusters/${cluster.id}`)).latestRevision?.revision ?? 0;
      const list = await admin.ok("GET", `/nodes?clusterId=${cluster.id}`);
      return list.every(
        (n) => !n.online || (n.appliedRevision >= latest && n.applyState === "applied"),
      );
    },
    120,
  );

await selected("smart selection after the nodes measured the origin");
let { upper, fallback, lowers } = roles(selection);
assert.ok(fallback, `no fallback upper tier: ${JSON.stringify(selection)}`);
assert.notEqual(byId[upper].region, byId[fallback].region, "the fallback is in the other region");
assert.equal(selection.target, "g4-origin-a:8080");
for (const n of selection.nodes)
  if (n.nodeId !== upper)
    assert.equal(
      n.uppers[0].reason,
      "lowest_latency",
      `${n.nodeName}: ${JSON.stringify(n.uppers)}`,
    );
await applied();
pass(
  `a: smart: ${byId[upper].name} is the upper tier (lowest_latency), ${byId[fallback].name} the fallback in ${byId[fallback].region}`,
);

// ---------------------------------------------------------------- b. one origin fetch
const order = [...lowers, upper];
for (const id of order) {
  const r = await get(byId[id].name, "/page/shared");
  assert.equal(r.status, 200, `${byId[id].name}: ${summary(r)}`);
}
assert.equal(
  await originHits("/page/shared"),
  1,
  "the origin served /page/shared once for three nodes",
);
const stats = await waitFor(
  "tier statistics",
  async () => {
    const s = await admin.ok("GET", `/sites/${site.id}/tiered-cache/stats?range=1h`);
    return (s.fetches.HIT ?? 0) >= 1 && (s.served.HIT ?? 0) >= 1 ? s : null;
  },
  120,
  2000,
);
assert.ok(stats.hitRatio !== null && stats.hitRatio > 0, JSON.stringify(stats));
pass(
  `b: /page/shared through ${order.length} nodes: one origin fetch; statistics ${JSON.stringify(stats.fetches)} hit ratio ${stats.hitRatio}`,
);

// ---------------------------------------------------------------- c. node certificates only
const tls = await nodeIn(
  "client-a",
  `const tls = require("node:tls");
const s = tls.connect({ host: ${JSON.stringify(byId[upper].ip)}, port: 8444, rejectUnauthorized: false, servername: "x" }, () => {
  s.write("GET / HTTP/1.1\\r\\nHost: ${HOST}\\r\\nConnection: close\\r\\n\\r\\n");
});
let out = "";
s.on("data", (d) => (out += d)).on("error", (e) => { process.stdout.write("error " + e.code); process.exit(0); })
  .on("close", () => { process.stdout.write(out.split("\\r\\n")[0] || "closed"); process.exit(0); });
setTimeout(() => { process.stdout.write("timeout"); process.exit(0); }, 10000);`,
);
assert.ok(
  !/^HTTP\/1\.1 200/.test(tls),
  `the tier listener served a client without a certificate: ${tls}`,
);
pass(`c: the tier listener refuses a client without a node certificate (${tls.slice(0, 60)})`);

// ---------------------------------------------------------------- d. purges reach every tier
const task = await admin.ok("POST", "/cache-tasks", {
  type: "url",
  urls: [`http://${HOST}/page/shared`],
});
await waitFor(
  "URL purge on every tier node",
  async () => {
    const t = await admin.ok("GET", `/cache-tasks/${task.id}`);
    assert.notEqual(t.state, "failed", JSON.stringify(t.nodes));
    return t.state === "succeeded";
  },
  120,
);
const [first, second] = lowers;
let r = await get(byId[first].name, "/page/shared");
assert.equal(r.status, 200, summary(r));
assert.equal(
  await originHits("/page/shared"),
  2,
  "after the purge the lower tier's request reaches the origin once",
);
r = await get(byId[second].name, "/page/shared");
assert.equal(r.status, 200, summary(r));
assert.equal(
  await originHits("/page/shared"),
  2,
  "the other lower tier is served by the upper tier",
);
pass("d: a URL purge clears the lower and the upper tiers; one origin fetch afterwards");

// ---------------------------------------------------------------- e. fallback
const lone = lowers.find((id) => id !== fallback);
await run(["stop", "-t", "2", byId[upper].container]);
r = await get(byId[lone].name, "/page/fallback");
assert.equal(r.status, 200, `upper tier down: ${summary(r)}`);
assert.equal(await originHits("/page/fallback"), 1);
await run(["stop", "-t", "2", byId[fallback].container]);
r = await get(byId[lone].name, "/page/origin");
assert.equal(r.status, 200, `both upper tiers down: ${summary(r)}`);
assert.equal(await originHits("/page/origin"), 1);
pass(
  `e: ${byId[lone].name} serves with ${byId[upper].name} down (fallback ${byId[fallback].name}) and with both down (origin)`,
);
await run(["start", byId[upper].container]);
await run(["start", byId[fallback].container]);
await waitFor(
  "the stopped nodes online again",
  async () => (await admin.ok("GET", `/nodes?clusterId=${cluster.id}`)).every((n) => n.online),
  120,
);

// ---------------------------------------------------------------- f. latency moves the upper tier
const originIp = JSON.parse(await run(["inspect", await containerId("g4-origin-a")]))[0]
  .NetworkSettings.Networks[network].IPAddress;
const slow = upper;
// The first SYN of every connection to the origin is dropped (its source port
// remembered for 30 s), so each handshake waits for the retransmission (~1 s):
// all of the agent's attempts are slow, not only every other one.
const rules = `table inet e2etiers {
  set seen { type inet_service; flags dynamic,timeout; timeout 30s; }
  chain out {
    type filter hook output priority 0; policy accept;
    ip daddr ${originIp} tcp dport 8080 tcp flags & (syn | ack) == syn tcp sport @seen accept
    ip daddr ${originIp} tcp dport 8080 tcp flags & (syn | ack) == syn add @seen { tcp sport } drop
  }
}`;
await run([
  "exec",
  "-u",
  "0",
  "-e",
  `RULES=${rules}`,
  byId[slow].container,
  "sh",
  "-c",
  'printf "%s\\n" "$RULES" | nft -f -',
]);
await selected(
  `the upper tier leaves ${byId[slow].name} once its round trip time to the origin grows`,
  (s) => roles(s).upper !== slow,
  360,
);
({ upper } = roles(selection));
const slowRtt = selection.nodes.flatMap((n) => n.uppers).find((u) => u.nodeId === slow)?.rttMs;
pass(
  `f: injected latency on ${byId[slow].name}${slowRtt == null ? "" : ` (${slowRtt} ms)`}: the upper tier moved to ${byId[upper].name}`,
);
await run(["exec", "-u", "0", byId[slow].container, "nft", "delete", "table", "inet", "e2etiers"]);
pass("tiered cache checks passed");
