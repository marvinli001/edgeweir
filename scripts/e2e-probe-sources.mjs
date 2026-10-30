// External probe sources end to end (ADR-0069), on a cluster of its own
// ("ps-e2e") with two nodes whose rows the story writes through psql and
// keeps online (it refreshes their heartbeat time every 5 s: this section is
// about the console's decision and the DNS it publishes, not the data plane).
// The cluster's DNS binding writes all.edge.ps.e2e.test on the test provider
// of mock-services; its probe mode is "external".
//   a. sources: a generic webhook (secret shown once, signed deliveries) maps
//      monitor ps-a to node A; an UptimeRobot source whose API is the
//      mock-services simulator (EDGEWEIR_PROBE_SOURCE_TEST_ENDPOINT) maps its
//      monitor to node B; both healthy, all.edge answers with A and B
//   b. the webhook reports A down from two locations: A leaves all.edge
//      (DNS revision, reason health), then up again: A is back
//   c. the simulator reports B down: B leaves all.edge after the next poll,
//      then up: B is back
//   d. safety: the simulator fails (503) while it reports B down: the source
//      is failing and B stays; the webhook falls silent: its source goes
//      stale, the probe_source_stale alert fires, nothing is removed
//   e. refusals: a wrong signature (401), a replay (409), an unknown source (404)
// State for apps/console/e2e/probe-sources.spec.ts: .e2e/probe-sources-state.json.
// `node scripts/e2e-probe-sources.mjs --cleanup` removes the sources, nodes,
// binding and cluster and restores the probe settings.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { actor, base, pass, stack, waitFor as waitUntil } from "./e2e-lib.mjs";

const execute = promisify(execFile);
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const STATE = ".e2e/probe-sources-state.json";
const CLUSTER = "ps-e2e";
const ZONE = "ps.e2e.test";
const DOMAIN = `edge.${ZONE}`;
const DNS_TOKEN = "e2e-dns-token-ps";
const ROBOT_KEY = "u0000001-e2eprobesourcekey";
const ROBOT_MONITOR = 778899;
const A = "198.51.100.11";
const B = "198.51.100.12";
const SETTINGS = { ipDownSeconds: 5, ipUpSeconds: 5 };

const waitFor = (label, fn, seconds = 180, interval = 2000, detail) =>
  waitUntil(label, fn, seconds, interval, detail);

/**
 * psql in the stack's postgres service, or in the container E2E_PG_CONTAINER
 * names (a stack started without compose.e2e.yml).
 */
const { psql: composePsql } = stack();
const psql = process.env.E2E_PG_CONTAINER
  ? async (query) =>
      (
        await execute("docker", [
          "exec",
          process.env.E2E_PG_CONTAINER,
          "psql",
          "-U",
          "edgeweir",
          "-d",
          "edgeweir",
          "-At",
          "-c",
          query,
        ])
      ).stdout.trim()
  : composePsql;

const op = await actor("admin@e2e.test", "e2e-admin-password-123", "probe-sources-e2e");
const a = op.ok;

const sign = (secret, timestamp, body) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
/** Posts a signed delivery; returns { status, json }. */
async function deliver(source, secret, results, opts = {}) {
  const body = JSON.stringify({ results });
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const response = await fetch(`${base}/api/hooks/probe-sources/${opts.id ?? source}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-edgeweir-timestamp": String(timestamp),
      "x-edgeweir-signature": opts.signature ?? sign(secret, timestamp, body),
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, body, timestamp };
}
/** The simulator's UptimeRobot account: its monitor's state, or a failing API. */
const robot = (state) =>
  fetch(`${mock}/probe-api/uptimerobot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: ROBOT_KEY, ...state }),
  }).then((r) => assert.equal(r.status, 200));
const allEdge = async () =>
  ((await (await fetch(`${mock}/records`)).json())[ZONE] ?? [])
    .filter((r) => r.name === "all.edge" && r.type === "A")
    .map((r) => r.data)
    .sort();
const expectEdge = (label, expected) =>
  waitFor(
    label,
    async () => {
      await a("POST", "/dns/reconcile", {});
      const got = await allEdge();
      return JSON.stringify(got) === JSON.stringify(expected) ? got : null;
    },
    180,
    2000,
    async () => JSON.stringify(await allEdge()),
  );

async function cleanup() {
  const state = JSON.parse(await readFile(STATE, "utf8").catch(() => "{}"));
  for (const source of await a("GET", "/probe-sources"))
    if (source.name.startsWith("ps-e2e ")) await a("DELETE", `/probe-sources/${source.id}`);
  if (state.settings) await a("PUT", "/settings/probes", state.settings);
  const cluster = (await a("GET", "/clusters")).find((c) => c.name === CLUSTER);
  if (cluster) {
    await op.raw("PUT", `/clusters/${cluster.id}/dns`, { binding: null });
    await psql(
      `DELETE FROM node WHERE cluster_id = '${cluster.id}'; DELETE FROM site WHERE cluster_id = '${cluster.id}'`,
    );
    await op.raw("DELETE", `/clusters/${cluster.id}`);
  }
  for (const provider of (await a("GET", "/dns/providers")).items ?? [])
    if (provider.name === "ps-e2e") await op.raw("DELETE", `/dns/providers/${provider.id}`);
  pass("probe sources cleanup: sources, nodes, binding and cluster removed, settings restored");
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

// ---------------------------------------------------------------- setup
const previousSettings = await a("GET", "/settings/probes");
await writeFile(STATE, JSON.stringify({ settings: previousSettings }));
await a("PUT", "/settings/probes", { ...previousSettings, ...SETTINGS });
const cluster =
  (await a("GET", "/clusters")).find((c) => c.name === CLUSTER) ??
  (await a("POST", "/clusters", { name: CLUSTER }));
const group = (await a("GET", `/node-groups?clusterId=${cluster.id}`))[0];
assert.ok(group, "the cluster has a default node group");
const insertNode = async (name, address) => {
  const id = await psql(
    `INSERT INTO node (cluster_id, node_group_id, name, last_seen_at) VALUES ('${cluster.id}', '${group.id}', '${name}', now()) RETURNING id`,
  );
  const nodeId = id.split("\n")[0];
  await psql(`INSERT INTO node_ip (node_id, address) VALUES ('${nodeId}', '${address}')`);
  await psql(
    `INSERT INTO node_config_status (node_id, applied_revision, applied_content_hash, state, data_plane_healthy)
     SELECT '${nodeId}', revision, content_hash, 'applied', true FROM config_revision
     WHERE cluster_id = '${cluster.id}' ORDER BY revision DESC LIMIT 1`,
  );
  return nodeId;
};
const nodeA = await insertNode("ps-a", A);
const nodeB = await insertNode("ps-b", B);
const heartbeat = setInterval(() => {
  psql(`UPDATE node SET last_seen_at = now() WHERE id IN ('${nodeA}', '${nodeB}')`).catch(() => {});
}, 5000);
heartbeat.unref();
// Documentation-range addresses are not public: configured as scheduling addresses.
await a("PUT", `/nodes/${nodeA}/addresses`, { addresses: [{ address: A, level: 0 }] });
await a("PUT", `/nodes/${nodeB}/addresses`, { addresses: [{ address: B, level: 0 }] });
const provider = await a("POST", "/dns/providers", {
  name: "ps-e2e",
  provider: "test",
  zone: ZONE,
  credentials: { api_token: DNS_TOKEN },
});
await a("PUT", `/clusters/${cluster.id}/dns`, {
  binding: { mode: "auto", providerId: provider.id, domain: DOMAIN, ttl: 60, lines: [] },
});
await a("PUT", `/clusters/${cluster.id}/probe-mode`, { mode: "external" });

let finished = false;
let webhookRounds;
try {
  // -------------------------------------------------------------- a. sources
  const hook = await a("POST", "/probe-sources", {
    name: "ps-e2e webhook",
    provider: "generic_webhook",
    staleAfterSeconds: 60,
  });
  assert.match(hook.webhookSecret, /^ewh_/);
  assert.ok(hook.source.webhookUrl.endsWith(`/api/hooks/probe-sources/${hook.source.id}`));
  assert.ok(!JSON.stringify(await a("GET", "/probe-sources")).includes(hook.webhookSecret));
  await a("PUT", `/probe-sources/${hook.source.id}/mappings`, {
    mappings: [{ monitorId: "ps-a", monitorName: "A over HTTPS", nodeId: nodeA }],
  });
  await robot({ fail: false, monitors: [{ id: ROBOT_MONITOR, name: "B", url: B, up: true }] });
  const check = await a("POST", "/probe-sources/check", {
    provider: "uptimerobot",
    fields: { api_key: ROBOT_KEY },
  });
  assert.deepEqual(check, { ok: true, monitors: 1, error: "" });
  const pull = await a("POST", "/probe-sources", {
    name: "ps-e2e robot",
    provider: "uptimerobot",
    fields: { api_key: ROBOT_KEY },
    pollIntervalSeconds: 60,
    staleAfterSeconds: 300,
  });
  assert.equal(pull.webhookSecret, null);
  const monitors = await a("GET", `/probe-sources/${pull.source.id}/monitors`);
  assert.deepEqual(
    monitors.map((m) => [m.id, m.suggestedNodeId, m.suggestedAddress]),
    [[String(ROBOT_MONITOR), nodeB, B]],
  );
  await a("PUT", `/probe-sources/${pull.source.id}/mappings`, {
    mappings: [{ monitorId: String(ROBOT_MONITOR), monitorName: "B", nodeId: nodeB, address: B }],
  });
  // The webhook reports A every 3 s as `state.a` says.
  const state = { a: true };
  let silent = false;
  webhookRounds = setInterval(() => {
    if (silent) return;
    deliver(hook.source.id, hook.webhookSecret, [
      { monitor: "ps-a", location: "fra", up: state.a, latencyMs: state.a ? 21 : null },
      { monitor: "ps-a", location: "sin", up: state.a, latencyMs: state.a ? 88 : null },
    ]).catch(() => {});
  }, 3000);
  await waitFor(
    "both sources healthy",
    async () => {
      const list = await a("GET", "/probe-sources");
      return list.filter((s) => s.name.startsWith("ps-e2e ")).every((s) => s.status === "healthy")
        ? list
        : null;
    },
    120,
  );
  await expectEdge("all.edge answers with both nodes", [A, B]);
  pass(
    `generic webhook (ewh_… secret shown once, never listed) and UptimeRobot via the simulator (check: 1 monitor, suggested node B by its URL) are healthy; all.edge -> ${A}, ${B}`,
  );

  const revisions = () => a("GET", `/clusters/${cluster.id}/dns/revisions`);
  const latest = async () => Math.max(0, ...(await revisions()).map((r) => r.revision));

  // -------------------------------------------------------------- b. webhook drives A
  let mark = await latest();
  state.a = false;
  await expectEdge("A leaves all.edge while the webhook reports it down", [B]);
  const down = (await revisions()).filter((r) => r.revision > mark);
  assert.ok(
    down.some((r) => r.reason === "health"),
    JSON.stringify(down),
  );
  pass(
    `webhook: A down from fra and sin -> all.edge ${B} (DNS revision ${down.map((r) => `${r.revision} ${r.reason}`).join(", ")})`,
  );
  mark = await latest();
  state.a = true;
  await expectEdge("A back in all.edge", [A, B]);
  assert.ok((await revisions()).some((r) => r.revision > mark && r.reason === "health"));
  pass("webhook: A up again -> all.edge back to both nodes (new health revision)");

  // -------------------------------------------------------------- c. provider drives B
  mark = await latest();
  await robot({ fail: false, monitors: [{ id: ROBOT_MONITOR, name: "B", url: B, up: false }] });
  await expectEdge("B leaves all.edge after a poll reports it down", [A]);
  assert.ok((await revisions()).some((r) => r.revision > mark && r.reason === "health"));
  const results = await a("GET", `/probe-sources/${pull.source.id}/results`);
  assert.ok(results.some((r) => r.monitorId === String(ROBOT_MONITOR) && !r.up && r.counted));
  pass(`UptimeRobot (simulated API): B down -> all.edge ${A}`);
  await robot({ fail: false, monitors: [{ id: ROBOT_MONITOR, name: "B", url: B, up: true }] });
  await expectEdge("B back in all.edge", [A, B]);
  pass("UptimeRobot: B up again -> both nodes");

  // -------------------------------------------------------------- d. safety
  await robot({ fail: true, monitors: [{ id: ROBOT_MONITOR, name: "B", url: B, up: false }] });
  await waitFor(
    "the UptimeRobot source is failing",
    async () => {
      const s = (await a("GET", "/probe-sources")).find((x) => x.id === pull.source.id);
      return s?.status === "failing" ? s : null;
    },
    150,
  );
  await new Promise((r) => setTimeout(r, 15_000));
  assert.deepEqual(await allEdge(), [A, B]);
  pass("a failing source (simulator answers 503 while it says B is down) removes nothing");
  silent = true;
  await waitFor(
    "the webhook source goes stale",
    async () => {
      const s = (await a("GET", "/probe-sources")).find((x) => x.id === hook.source.id);
      return s?.status === "stale" ? s : null;
    },
    150,
  );
  const alert = await waitFor(
    "probe_source_stale fires",
    async () => {
      const events = await a("GET", "/alerts/events");
      return events.find((e) => e.kind === "probe_source_stale" && e.status === "firing");
    },
    60,
  );
  assert.deepEqual(await allEdge(), [A, B]);
  pass(
    `a silent webhook source goes stale: alert ${alert.kind} "${alert.siteName}", nothing removed`,
  );

  // -------------------------------------------------------------- e. refusals
  const results2 = [{ monitor: "ps-a", up: true }];
  const wrong = await deliver(hook.source.id, "ewh_wrong-secret-0123456789", results2);
  assert.equal(wrong.status, 401);
  const first = await deliver(hook.source.id, hook.webhookSecret, results2);
  assert.equal(first.status, 202);
  const replay = await fetch(`${base}/api/hooks/probe-sources/${hook.source.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-edgeweir-timestamp": String(first.timestamp),
      "x-edgeweir-signature": sign(hook.webhookSecret, first.timestamp, first.body),
    },
    body: first.body,
  });
  assert.equal(replay.status, 409);
  const unknown = await deliver("00000000-0000-4000-8000-000000000000", "x", results2);
  assert.equal(unknown.status, 404);
  pass("deliveries: wrong signature 401, replay 409, unknown source 404");

  await writeFile(
    STATE,
    JSON.stringify({
      settings: previousSettings,
      clusterId: cluster.id,
      hookId: hook.source.id,
      pullId: pull.source.id,
    }),
  );
  finished = true;
} finally {
  clearInterval(webhookRounds);
  clearInterval(heartbeat);
  if (!finished) await cleanup().catch((error) => console.error(error));
}
