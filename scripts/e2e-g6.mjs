// Core gaps G6 end to end (regional probes, node metrics, smart scheduling,
// resolution lines, backup line groups and backup IPs), after the DNS step.
// Cluster A (`node` = edge, `node-upgrade-peer` = peer) keeps its binding on
// account A (the local `test` provider, which implements every line) and
// gets two binding lines: "tel" (edge's group, line telecom, backup group:
// peer's) and "uni" (peer's group, line unicom). Two probe containers
// (probe-a in region east, probe-b in region north) run `edgeweir-node
// probe` on both e2e networks; the edge node has a primary (default
// network) and a backup (isolated network) scheduling address.
//   a. both nodes report probe-health-v1 and metrics-v1 and send host metrics
//   b. probes enroll with one-time tokens, come online in their regions and
//      report every node address × listener port (HTTP through the health
//      endpoint), without loss
//   c. resolution lines: all.edge answers telecom with edge, unicom with peer
//      and the default line with both; names and CNAMEs stay on the default
//      line
//   d. backup IP: the edge's primary address stops answering for everyone;
//      most probers lose it, the edge moves to its backup address (DNS
//      revision, reason health) and back once the primary answers again
//   e. region-scoped rule: only probe-a (east) loses the edge; the backup IP
//      does not move (one prober of two), the rule "east loss > 50%" removes
//      the edge (DNS revision reason scheduling, system audit, alert), the
//      telecom line falls back to its backup group (peer), the preview shows
//      the rule active; after the block ends the rule recovers and telecom
//      returns to the edge
//   f. node acting as a probe: node-dns (cluster dns-b, region north) probes
//      cluster A's nodes with its node certificate
// State for apps/console/e2e/g6.spec.ts: .e2e/g6-state.json; the probes keep
// running for it. `node scripts/e2e-g6.mjs --cleanup` removes the rule,
// restores the binding and settings and stops the probes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const compose = [
  "compose",
  "-f",
  "compose.e2e.yml",
  "--profile",
  "upgrades",
  "--profile",
  "dns",
  "--profile",
  "probes",
];
const run = async (args, env) =>
  (await execute("docker", args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g6-state.json";
const SETTINGS = {
  intervalSeconds: 5,
  timeoutMs: 1000,
  attempts: 1,
  lossPercent: 50,
  ipDownSeconds: 5,
  ipUpSeconds: 5,
};

async function waitFor(label, fn, seconds = 180, interval = 1500, detail = () => "") {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(interval);
  }
  const why = await detail();
  throw new Error(`timeout: ${label}${why ? ` (last: ${why})` : ""}`);
}

/** The operator with an AccessKey from the console's RPC, replaced every 500 calls. */
async function operator(email, password) {
  const response = await waitFor(
    `sign in ${email}`,
    async () => {
      const r = await signInResponse(base, email, password);
      return r.status === 200 ? r : null;
    },
    60,
    3000,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const createKey = () => rpc(base, cookie, "accessKeys/create", { name: "g6-e2e" });
  let current = await createKey(),
    calls = 0;
  const raw = async (method, path, body) => {
    if (++calls % 500 === 0) {
      const previous = current;
      current = await createKey();
      await rpc(base, cookie, "accessKeys/revoke", { id: previous.id });
    }
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": current.key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const ok = async (method, path, body) => {
    const result = await raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  ok.raw = raw;
  return ok;
}

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};
const containerIp = async (service, network) => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const entry = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith(`_${network}`),
  );
  assert.ok(entry, `${service} is not on ${network}`);
  return entry[1].IPAddress;
};
/** Mock DNS records of a zone as "name type data line" (the default line is "default"). */
const zone = async (name) =>
  ((await (await fetch(`${mock}/records`)).json())[name] ?? [])
    .map((r) => `${r.name} ${r.type} ${r.data} ${r.line || "default"}`)
    .sort();
const linesOf = async (zoneName, recordName) =>
  (await zone(zoneName))
    .filter((r) => r.startsWith(`${recordName} A `))
    .map((r) => r.split(" ").slice(2).join(" "));

/** nftables rules in the edge node container (it has NET_ADMIN): a table of our own. */
async function block(service, rules) {
  const id = await containerId(service);
  const script = [
    "nft add table inet g6e2e",
    "nft 'add chain inet g6e2e input { type filter hook input priority -5; policy accept; }'",
    ...rules.map((r) => `nft add rule inet g6e2e input ${r} drop`),
  ].join(" && ");
  await run(["exec", "-u", "0", id, "sh", "-c", script]);
}
async function unblock(service) {
  const id = await containerId(service);
  await run(["exec", "-u", "0", id, "sh", "-c", "nft delete table inet g6e2e || true"]);
}

// ---------------------------------------------------------------- setup
const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const m5 = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const ZONE = "cdn.m5.test";
const DOMAIN = "edge.cdn.m5.test";

async function cleanup() {
  for (const rule of await a("GET", `/scheduling/rules?clusterId=${clusterA}`))
    if (rule.name.startsWith("g6 ")) await a("DELETE", `/scheduling/rules/${rule.id}`);
  await unblock("node").catch(() => {});
  await run([...compose, "stop", "probe-a", "probe-b"]).catch(() => {});
  pass("G6 cleanup: rules removed, blocks lifted, probes stopped");
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const node = (id) => a("GET", `/nodes/${id}`);
let finished = false;
try {
  // -------------------------------------------------------------- a. features and metrics
  const nodes = await waitFor(
    "both nodes report probe-health-v1, metrics-v1 and host metrics",
    async () => {
      const list = [await node(edgeId), await node(peerId)];
      return list.every(
        (n) =>
          n.online &&
          n.supportedFeatures.includes("probe-health-v1") &&
          n.supportedFeatures.includes("metrics-v1") &&
          n.metrics &&
          n.metrics.memoryTotalBytes > 0,
      )
        ? list
        : null;
    },
    120,
  );
  pass(
    `both nodes report probe-health-v1 and metrics-v1 with host metrics: ${nodes
      .map(
        (n) =>
          `${n.name} cpu ${n.metrics.cpuPercent.toFixed(1)}% load ${n.metrics.load1} memory ${Math.round(n.metrics.memoryUsedBytes / 2 ** 20)}/${Math.round(n.metrics.memoryTotalBytes / 2 ** 20)} MiB egress ${n.metrics.egressBps} bit/s connections ${n.metrics.activeConnections}`,
      )
      .join("; ")}`,
  );

  // -------------------------------------------------------------- b. probes
  const previousSettings = await a("GET", "/settings/probes");
  await a("PUT", "/settings/probes", SETTINGS);
  const region = async (code, name) => {
    const existing = (await a("GET", "/regions")).find((r) => r.code === code);
    return existing ?? (await a("POST", "/regions", { name, code }));
  };
  const east = await region("g6-east", "G6 East");
  const north = await region("g6-north", "G6 North");
  // Node groups: edge in east, peer in north; both stay in cluster A.
  const groups = await a("GET", `/node-groups?clusterId=${clusterA}`);
  const group = async (name, regionId) =>
    groups.find((g) => g.name === name) ??
    (await a("POST", "/node-groups", { clusterId: clusterA, name, regionId }));
  const telGroup = await group("g6-tel", east.id);
  const uniGroup = await group("g6-uni", north.id);
  await a("PATCH", `/nodes/${edgeId}`, { nodeGroupId: telGroup.id });
  await a("PATCH", `/nodes/${peerId}`, { nodeGroupId: uniGroup.id });

  const tokens = {};
  for (const [key, r] of [
    ["A", east],
    ["B", north],
  ]) {
    const token = await a("POST", "/probe-tokens", { name: `g6-probe-${r.code}`, regionId: r.id });
    assert.match(token.token, /^ewp_/);
    tokens[key] = token;
  }
  await run([...compose, "up", "-d", "probe-a", "probe-b"], {
    ...process.env,
    E2E_PROBE_SERVER: tokens.A.serverUrl,
    E2E_PROBE_CA_SHA256: tokens.A.caSha256,
    E2E_PROBE_A_TOKEN: tokens.A.token,
    E2E_PROBE_B_TOKEN: tokens.B.token,
  });
  const probes = await waitFor(
    "both probes enrolled and online",
    async () => {
      const list = (await a("GET", "/probes")).filter((p) => p.name.startsWith("g6-probe-"));
      return list.length === 2 && list.every((p) => p.online && p.lastRound) ? list : null;
    },
    120,
  );
  const probeEast = probes.find((p) => p.regionId === east.id);
  const probeNorth = probes.find((p) => p.regionId === north.id);
  assert.ok(probeEast && probeNorth);
  // Scheduling addresses: the edge's primary on the default network, backup on the isolated one.
  const edgeIp = await containerIp("node", "default");
  const edgeBackupIp = await containerIp("node", "isolated");
  const peerIp = await containerIp("node-upgrade-peer", "default");
  await a("PUT", `/nodes/${edgeId}/addresses`, {
    addresses: [
      { address: edgeIp, level: 0 },
      { address: edgeBackupIp, level: 1 },
    ],
  });
  await a("PUT", `/nodes/${peerId}/addresses`, { addresses: [{ address: peerIp, level: 0 }] });
  const results = await waitFor(
    "both probes report every scheduling address of both nodes without loss",
    async () => {
      const list = await a("GET", "/probe-results");
      const from = (p) => list.filter((r) => r.proberId === p.id);
      const covered = (p) =>
        [edgeIp, edgeBackupIp, peerIp].every((ip) =>
          from(p).some((r) => r.address === ip && r.lost === 0 && r.method === "http"),
        );
      return covered(probeEast) && covered(probeNorth) ? list : null;
    },
    90,
  );
  const sample = results.find((r) => r.proberId === probeEast.id && r.address === edgeIp);
  pass(
    `probes enrolled with one-time tokens (ewp_…) and online: ${probeEast.name} (${east.name}), ${probeNorth.name} (${north.name}); they report ${results.length} results over every scheduling address × listener port, HTTP via /.edgeweir/health, no loss (e.g. ${sample.address}:${sample.port} ${sample.method} ${sample.rttMs} ms)`,
  );

  // -------------------------------------------------------------- c. resolution lines
  const binding = (await a("GET", `/clusters/${clusterA}/dns`)).binding;
  const previousBinding = binding;
  await a("PUT", `/clusters/${clusterA}/dns`, {
    binding: {
      mode: "auto",
      providerId: binding.providerId,
      domain: DOMAIN,
      ttl: 60,
      allLabel: binding.allLabel,
      lineAliases: binding.lineAliases,
      lines: [
        {
          name: "tel",
          nodeGroupId: telGroup.id,
          overrides: [],
          resolutionLine: "telecom",
          backupNodeGroupIds: [uniGroup.id],
          minHealthyIps: 1,
        },
        {
          name: "uni",
          nodeGroupId: uniGroup.id,
          overrides: [],
          resolutionLine: "unicom",
          backupNodeGroupIds: [],
          minHealthyIps: 1,
        },
      ],
    },
  });
  const expectAll = async (label, expected) =>
    waitFor(
      label,
      async () => {
        await a("POST", "/dns/reconcile", {});
        const got = await linesOf(ZONE, "all.edge");
        return JSON.stringify(got) === JSON.stringify([...expected].sort()) ? got : null;
      },
      120,
      2000,
      async () => JSON.stringify(await linesOf(ZONE, "all.edge")),
    );
  await expectAll("all.edge answers per resolution line", [
    `${edgeIp} telecom`,
    `${peerIp} unicom`,
    `${edgeIp} default`,
    `${peerIp} default`,
  ]);
  const names = await zone(ZONE);
  assert.ok(names.includes(`tel.edge A ${edgeIp} default`), JSON.stringify(names));
  assert.ok(names.includes(`uni.edge A ${peerIp} default`), JSON.stringify(names));
  assert.ok(
    names.some((r) => r.startsWith(`${m5.siteId}.edge CNAME all.edge.cdn.m5.test default`)),
    JSON.stringify(names),
  );
  pass(
    `resolution lines on the test provider: all.edge telecom -> ${edgeIp} (tel), unicom -> ${peerIp} (uni), default -> both; tel.edge, uni.edge and site CNAMEs on the default line`,
  );

  // -------------------------------------------------------------- d. backup IP
  const revisionsSince = async (after) =>
    (await a("GET", `/clusters/${clusterA}/dns/revisions`)).filter((r) => r.revision > after);
  const latestDnsRevision = async () =>
    Math.max(0, ...(await a("GET", `/clusters/${clusterA}/dns/revisions`)).map((r) => r.revision));
  let mark = await latestDnsRevision();
  await block("node", [`ip daddr ${edgeIp} tcp dport { 80, 443 }`]);
  const moved = await waitFor(
    "the edge moves to its backup address",
    async () => {
      const n = await node(edgeId);
      return n.schedulingLevel === 1 ? n : null;
    },
    90,
    1500,
    async () => JSON.stringify((await node(edgeId)).schedulingAddresses),
  );
  assert.deepEqual(
    moved.schedulingAddresses.map((x) => [x.address, x.level, x.reachable]).sort(),
    [
      [edgeBackupIp, 1, true],
      [edgeIp, 0, false],
    ].sort(),
  );
  await expectAll("telecom answers with the edge's backup address", [
    `${edgeBackupIp} telecom`,
    `${peerIp} unicom`,
    `${edgeBackupIp} default`,
    `${peerIp} default`,
  ]);
  const healthRevision = (await revisionsSince(mark)).find((r) => r.reason === "health");
  assert.ok(healthRevision, "a DNS revision with reason health");
  await unblock("node");
  mark = await latestDnsRevision();
  await waitFor(
    "the edge is back on its primary address",
    async () => (await node(edgeId)).schedulingLevel === 0,
    90,
  );
  await expectAll("telecom answers with the primary again", [
    `${edgeIp} telecom`,
    `${peerIp} unicom`,
    `${edgeIp} default`,
    `${peerIp} default`,
  ]);
  pass(
    `backup IP: with ${edgeIp}:80/443 dropped both probers lost it, the edge moved to level 1 (${edgeBackupIp}) and all.edge telecom/default followed (DNS revision #${healthRevision.revision}, reason health); once the primary answered it returned to level 0`,
  );

  // -------------------------------------------------------------- e. region-scoped rule
  const rule = await a("POST", "/scheduling/rules", {
    clusterId: clusterA,
    name: "g6 east loss",
    match: "all",
    conditions: [
      {
        metric: "probe_loss_percent",
        aggregate: "max",
        comparator: "gt",
        threshold: 50,
        durationSeconds: 5,
        regionId: east.id,
      },
    ],
    action: "remove_node",
    holdSeconds: 0,
    recoverSeconds: 10,
  });
  const probeAIps = [
    await containerIp("probe-a", "default"),
    await containerIp("probe-a", "isolated"),
  ];
  mark = await latestDnsRevision();
  await block("node", [`ip saddr { ${probeAIps.join(", ")} } tcp dport { 80, 443 }`]);
  const preview = await waitFor(
    "the rule removes the edge for region east",
    async () => {
      const p = await a("GET", `/clusters/${clusterA}/scheduling/preview`);
      const entry = p.rules
        .find((r) => r.ruleId === rule.id)
        ?.nodes.find((n) => n.nodeId === edgeId);
      return entry?.state === "active" ? { p, entry } : null;
    },
    90,
    1500,
    async () => JSON.stringify(await a("GET", `/clusters/${clusterA}/scheduling/preview`)),
  );
  // One prober of two lost the edge: its addresses stay reachable (no backup IP).
  const edgeNow = await node(edgeId);
  assert.equal(edgeNow.schedulingLevel, 0, JSON.stringify(edgeNow.schedulingAddresses));
  await expectAll("telecom falls back to the backup group (peer)", [
    `${peerIp} telecom`,
    `${peerIp} unicom`,
    `${peerIp} default`,
  ]);
  const activation = (await revisionsSince(mark)).find(
    (r) => r.reason === "scheduling" && r.reasonParams?.event === "activated",
  );
  assert.ok(activation, "a DNS revision with reason scheduling (activated)");
  assert.equal(activation.reasonParams.ruleId, rule.id);
  const audits = async (action) =>
    (await a("GET", `/audit-logs?action=${action}`)).items.filter(
      (e) => e.targetId?.includes(rule.id) || JSON.stringify(e).includes(rule.id),
    );
  const activated = await waitFor("system audit scheduling.activate", async () => {
    const list = await audits("scheduling.activate");
    return list.length ? list[0] : null;
  });
  assert.equal(activated.actorType, "system");
  const alert = await waitFor("scheduling_action alert firing", async () =>
    (await a("GET", "/alerts/events")).find(
      (e) => e.kind === "scheduling_action" && e.status === "firing",
    ),
  );
  await unblock("node");
  await waitFor(
    "the rule recovers after 10 s without loss",
    async () => {
      const p = await a("GET", `/clusters/${clusterA}/scheduling/preview`);
      return (
        p.rules.find((r) => r.ruleId === rule.id)?.nodes.find((n) => n.nodeId === edgeId)?.state ===
        "idle"
      );
    },
    90,
  );
  await expectAll("telecom returns to the edge", [
    `${edgeIp} telecom`,
    `${peerIp} unicom`,
    `${edgeIp} default`,
    `${peerIp} default`,
  ]);
  const recovered = await waitFor("system audit scheduling.recover", async () => {
    const list = await audits("scheduling.recover");
    return list.length ? list[0] : null;
  });
  assert.equal(recovered.actorType, "system");
  await waitFor("scheduling_action alert resolved", async () =>
    (await a("GET", "/alerts/events")).some(
      (e) => e.kind === "scheduling_action" && e.status === "resolved",
    ),
  );
  const loss = preview.entry.conditions[0];
  pass(
    `region-scoped rule: only probe-a (east) lost the edge (max loss ${loss.value}% > 50 for ${loss.heldSeconds}s), the backup IP stayed at level 0 (one prober of two), the rule removed the edge and telecom fell back to the backup group (${peerIp}); DNS revision #${activation.revision} reason scheduling (activated), audit scheduling.activate by the system, alert scheduling_action ${alert.status}; after the block ended it recovered (preview idle, telecom -> ${edgeIp}, audit scheduling.recover, alert resolved)`,
  );

  // -------------------------------------------------------------- f. node acting as a probe
  const clusterB = (await a("GET", "/clusters")).find((c) => c.name === "dns-b");
  const nodeB = (await a("GET", `/nodes?clusterId=${clusterB.id}`)).find(
    (n) => n.name === "edge-dns-b",
  );
  const groupB = (await a("GET", `/node-groups?clusterId=${clusterB.id}`)).find(
    (g) => g.id === nodeB.nodeGroupId,
  );
  const refused = await a.raw("PUT", `/nodes/${nodeB.id}/probe`, { enabled: true });
  if (!groupB.regionId) {
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, "NODE_REGION_REQUIRED");
    await a("PATCH", `/node-groups/${groupB.id}`, { regionId: north.id });
    await a("PUT", `/nodes/${nodeB.id}/probe`, { enabled: true });
  }
  const fromNode = await waitFor(
    "node-dns probes cluster A with its node certificate",
    async () => {
      const list = await a("GET", `/probe-results?probeId=${nodeB.id}`);
      return list.some((r) => r.proberKind === "node" && r.address === edgeIp && r.lost === 0)
        ? list
        : null;
    },
    90,
  );
  assert.ok(!fromNode.some((r) => r.nodeId === nodeB.id), "a node never probes itself");
  pass(
    `node acting as a probe: edge-dns-b (region ${north.name}) reports ${fromNode.length} results over cluster A's addresses with its node certificate, never itself; without a region the switch is refused (NODE_REGION_REQUIRED)`,
  );
  await a("PUT", `/nodes/${nodeB.id}/probe`, { enabled: false });

  await writeFile(
    STATE,
    JSON.stringify({
      clusterId: clusterA,
      regions: {
        east: { id: east.id, name: east.name },
        north: { id: north.id, name: north.name },
      },
      probes: {
        east: { id: probeEast.id, name: probeEast.name },
        north: { id: probeNorth.id, name: probeNorth.name },
      },
      nodes: {
        edge: { id: edgeId, name: nodes[0].name },
        peer: { id: peerId, name: nodes[1].name },
      },
      ruleId: rule.id,
      bindingProviderId: binding.providerId,
      previousSettings,
      previousBinding,
    }),
  );
  finished = true;
  console.log("G6 E2E OK");
} finally {
  if (!finished) {
    await unblock("node").catch(() => {});
    console.log("G6 E2E FAILED (state kept for inspection)");
  }
}
