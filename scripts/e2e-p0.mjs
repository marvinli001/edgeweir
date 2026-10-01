// Core gaps P0 end to end, after the M6 upgrade step (two real nodes: `node` in
// the "upgrade-canary" group and `node-upgrade-peer` in the default group):
//   1. Idempotency-Key, service accounts and scopes
//   2. a service account disables a site: nodes stop serving it, a stale
//      write is refused, DNS records stay the same throughout
//   3. usage matches what the node reported, a replayed batch changes
//      nothing, completeUntil advances
//   4. configuration canary: automatic promotion, automatic rollback of a
//      change that makes the origin fail; non-canary node never gets it and
//      stays in DNS
//   5. every node offline: DNS records stay, an alert fires
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, seconds = 180, interval = 1000) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label}`);
}

/** Raw /api/v1 call: { status, headers, json, text }. */
async function call(key, method, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) : null,
  };
}
async function ok(key, method, path, body, headers) {
  const result = await call(key, method, path, body, headers);
  assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
  return result.json;
}

async function session(email, password) {
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
  return { cookie, key: await createKey(cookie) };
}

async function createKey(cookie) {
  return (await rpc(base, cookie, "accessKeys/create", { name: "p0-e2e" })).key;
}

/** GET through the real edge node (host port), returns the status. */
function edge(host, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: edgePort, path, headers: { host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("edge timeout")));
  });
}

async function psql(query) {
  return (
    await run([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "edgeweir",
      "-d",
      "edgeweir",
      "-At",
      "-c",
      query,
    ])
  ).trim();
}

const containerIp = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  const info = JSON.parse(await run(["inspect", id]))[0];
  const network = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert.ok(network, `${service} has no default network`);
  return network[1].IPAddress;
};

// ---------------------------------------------------------------- setup
const admin = await session("admin@e2e.test", "e2e-admin-password-123");
// An AccessKey allows 600 requests until it has been idle for 60 seconds;
// the polling below runs longer than that, so it moves to a fresh key.
let adminCalls = 0;
async function a(method, path, body) {
  if (++adminCalls % 500 === 0) admin.key = await createKey(admin.cookie);
  return ok(admin.key, method, path, body);
}
const m5 = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const canaryGroupId = upgrade.nodeGroupId;
const defaultGroupId = (await a("GET", `/node-groups?clusterId=${clusterId}`)).find(
  (g) => g.isDefault,
).id;
const nodeById = (id) => a("GET", `/nodes/${id}`);
async function synced(ids = [edgeId, peerId]) {
  await waitFor(
    "nodes on their target revision",
    async () => {
      for (const id of ids) {
        const n = await nodeById(id);
        if (
          !n.online ||
          !n.dataPlaneHealthy ||
          n.applyState !== "applied" ||
          n.appliedRevision < (n.targetRevision ?? 0)
        )
          return false;
      }
      return true;
    },
    180,
  );
}
await synced();
// Nodes offline for longer than this stop holding back completeUntil.
await a("PUT", "/settings/usage", { retentionDays: 100, offlineThresholdMinutes: 5 });

// DNS: both nodes by their container address, one line per node group.
const edgeIp = await containerIp("node");
const peerIp = await containerIp("node-upgrade-peer");
const policy = {
  mode: "auto",
  providerId: m5.providerId,
  domain: "edge.cdn.m5.test",
  ttl: 60,
  lines: [
    {
      name: "default",
      nodeGroupId: defaultGroupId,
      overrides: [{ nodeId: peerId, addresses: [peerIp] }],
    },
    {
      name: "canary",
      nodeGroupId: canaryGroupId,
      overrides: [{ nodeId: edgeId, addresses: [edgeIp] }],
    },
  ],
};
const dnsBinding = `/clusters/${clusterId}/dns`;
await a("PUT", dnsBinding, { binding: policy });
const held = (await a("GET", dnsBinding)).blocked;
if (held) await a("POST", `${dnsBinding}/force-publish`, { revision: held.revision });
const zone = (await a("GET", "/dns/providers")).items.find((p) => p.id === m5.providerId).zone;
const providerRecords = async () =>
  ((await (await fetch(`${mock}/records`)).json())[zone] ?? [])
    .filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME")
    .map((r) => `${r.name} ${r.type} ${r.data}`)
    .sort();
async function reconcileDns() {
  await a("POST", "/dns/reconcile", { clusterId });
  return a("GET", dnsBinding);
}
// Addresses of the cluster's all-lines record (one per cluster, not per site).
const planAddresses = async () =>
  (await reconcileDns()).records
    .filter((r) => r.name === "all.edge" && r.type === "A")
    .map((r) => r.data)
    .sort();

// Usage traffic first: its 5-minute window completes while the other flows run.
const usageStartedAt = Date.now();
for (let i = 0; i < 20; i++) assert.equal(await edge(m5.domain, `/p0-usage-${i}`), 200);
const usageWindow = Math.floor(usageStartedAt / 300_000) * 300_000;
const usageBefore = await a(
  "GET",
  `/usage?from=${new Date(usageWindow - 300_000).toISOString()}&to=${new Date(usageWindow + 300_000).toISOString()}`,
);
pass(`usage traffic sent for the window starting ${new Date(usageWindow).toISOString()}`);

// ---------------------------------------------------------------- 1. Idempotency-Key, service accounts
const siteBody = { name: "p0-site", domains: ["p0.e2e.test"], origins: [{ address: "whoami" }] };
const first = await call(admin.key, "POST", "/sites", siteBody, { "idempotency-key": "p0-site-1" });
const second = await call(admin.key, "POST", "/sites", siteBody, {
  "idempotency-key": "p0-site-1",
});
assert.equal(first.status, 201, first.text);
assert.equal(second.status, 201);
assert.equal(second.headers.get("idempotent-replayed"), "true");
assert.equal(second.text, first.text);
const site = first.json.site;
const named = async (name) =>
  (await a("GET", `/sites?search=${name}`)).items.filter((s) => s.name === name).length;
assert.equal(await named("p0-site"), 1);
const mismatch = await call(
  admin.key,
  "POST",
  "/sites",
  { ...siteBody, name: "p0-other" },
  { "idempotency-key": "p0-site-1" },
);
assert.equal(mismatch.status, 422);
assert.equal(mismatch.json.code, "IDEMPOTENCY_KEY_MISMATCH");
const race = await Promise.all(
  Array.from({ length: 6 }, () =>
    call(
      admin.key,
      "POST",
      "/sites",
      { name: "p0-race", domains: ["p0-race.e2e.test"], origins: [{ address: "whoami" }] },
      { "idempotency-key": "p0-race" },
    ),
  ),
);
assert.equal(await named("p0-race"), 1);
assert.ok(
  race.every(
    (r) => r.status === 201 || (r.status === 409 && r.json.code === "IDEMPOTENCY_IN_PROGRESS"),
  ),
  JSON.stringify(race.map((r) => [r.status, r.json?.code])),
);
await a("DELETE", `/sites/${race.find((r) => r.status === 201).json.site.id}`);

const created = await a("POST", "/service-accounts", {
  name: "p0-business",
  scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
});
const sa = (await a("POST", `/service-accounts/${created.id}/keys`, { name: "e2e" })).secret;
assert.match(sa, /^ews_/);
const narrowAccount = await a("POST", "/service-accounts", {
  name: "p0-reader",
  scopes: ["sites:read"],
});
const narrow = (await a("POST", `/service-accounts/${narrowAccount.id}/keys`, {})).secret;
const me = await ok(sa, "GET", "/me");
assert.equal(me.serviceAccount.id, created.id);
for (const [method, path] of [
  ["GET", "/system/status"],
  ["GET", "/clusters"],
  ["GET", `/sites/${site.id}`],
])
  await ok(sa, method, path);
const notListed = await call(sa, "POST", "/sites", { ...siteBody, name: "p0-sa" });
assert.equal(notListed.status, 403);
assert.equal(notListed.json.code, "SERVICE_ACCOUNT_FORBIDDEN");
const denied = await call(narrow, "GET", "/clusters");
assert.equal(denied.status, 403);
assert.equal(denied.json.code, "SCOPE_REQUIRED");
assert.equal(denied.json.data.scope, "clusters:read");
pass(
  `Idempotency-Key created one site (replay ${second.headers.get("idempotent-replayed")}, other body 422, ${race.length} concurrent requests -> 1); service account ${created.name}: unlisted procedure 403 SERVICE_ACCOUNT_FORBIDDEN, missing scope 403 SCOPE_REQUIRED ${denied.json.data.scope}`,
);

// ---------------------------------------------------------------- 2. a service account disables a site
await synced();
await waitFor("the site is served", async () => (await edge("p0.e2e.test", "/")) === 200, 60);
await reconcileDns();
const dnsBefore = await providerRecords();
assert.ok(
  dnsBefore.some((r) => r.startsWith(`${site.id}.edge CNAME`)),
  JSON.stringify(dnsBefore),
);
const readOnly = await call(narrow, "PUT", `/sites/${site.id}/enabled`, { enabled: false });
assert.equal(readOnly.status, 403);
assert.equal(readOnly.json.data.scope, "sites:write");
const disabled = await ok(sa, "PUT", `/sites/${site.id}/enabled`, {
  enabled: false,
  expectedUpdatedAt: site.updatedAt,
});
assert.equal(disabled.site.enabled, false);
await synced();
// Since G4 nodes answer the hosts of disabled sites with the platform's page (503).
assert.equal(await edge("p0.e2e.test", "/"), 503);
assert.equal((await reconcileDns()).blocked, null);
assert.deepEqual(await providerRecords(), dnsBefore);
const stale = await call(sa, "PUT", `/sites/${site.id}/enabled`, {
  enabled: true,
  expectedUpdatedAt: site.updatedAt,
});
assert.equal(stale.status, 409);
assert.equal(stale.json.code, "UPDATED_AT_MISMATCH");
assert.equal(stale.json.data.updatedAt, disabled.site.updatedAt);
await ok(sa, "PUT", `/sites/${site.id}/enabled`, {
  enabled: true,
  expectedUpdatedAt: disabled.site.updatedAt,
});
await synced();
await waitFor("the site is served again", async () => (await edge("p0.e2e.test", "/")) === 200, 60);
await reconcileDns();
assert.deepEqual(await providerRecords(), dnsBefore);
pass(
  "disabled by a service account: node answers 503 (the platform's disabled page), a stale write 409 UPDATED_AT_MISMATCH, enabled again: 200, DNS records unchanged",
);

// ---------------------------------------------------------------- 4. canary (before 3, whose window completes meanwhile)
await a("PATCH", `/node-groups/${canaryGroupId}`, { isCanary: true });
const canaryPolicy = {
  enabled: true,
  windowSeconds: 120,
  autoPromote: true,
  errorRatioMultiplier: 2,
  errorRatioFloor: 0.05,
  minRequests: 5,
};
await a("PUT", `/clusters/${clusterId}/rollout-policy`, canaryPolicy);
await synced();
const peerAddress = async () => (await planAddresses()).includes(peerIp);
assert.ok(await peerAddress(), "peer is in the DNS plan before the canary");

const good = (await a("PATCH", `/sites/${site.id}`, { name: "p0-site-renamed" })).revision.revision;
let rollout = await a("GET", `/clusters/${clusterId}/rollout`);
assert.equal(rollout.state, "canary");
assert.equal(rollout.candidateRevision, good);
await waitFor(
  "automatic promotion",
  async () => {
    assert.ok(await peerAddress(), "the non-canary node left the DNS plan during the window");
    rollout = await a("GET", `/clusters/${clusterId}/rollout`);
    return rollout.state === "promoted";
  },
  300,
  3000,
);
assert.equal(rollout.outcome, "auto_promote");
await synced();
const goodHash = (await a("GET", `/clusters/${clusterId}/revisions`)).find(
  (r) => r.revision === good,
).contentHash;
for (const id of [edgeId, peerId]) assert.equal((await nodeById(id)).appliedContentHash, goodHash);
pass(
  `canary revision #${good} promoted automatically; both nodes run it; the non-canary node stayed in DNS`,
);

await a("PUT", `/clusters/${clusterId}/rollout-policy`, { ...canaryPolicy, windowSeconds: 300 });
const bad = (await a("PATCH", `/sites/${site.id}`, { origins: [{ address: "whoami", port: 9 }] }))
  .revision.revision;
assert.equal((await a("GET", `/clusters/${clusterId}/rollout`)).candidateRevision, bad);
await waitFor(
  "canary applies the candidate",
  async () => (await nodeById(edgeId)).appliedRevision === bad,
  60,
);
let peerSawBad = false;
await waitFor(
  "automatic rollback",
  async () => {
    for (let i = 0; i < 10; i++) await edge("p0.e2e.test", `/bad-${i}`);
    const peer = await nodeById(peerId);
    if (peer.appliedRevision === bad || peer.targetRevision === bad) peerSawBad = true;
    assert.ok(await peerAddress(), "the non-canary node left the DNS plan during the window");
    rollout = await a("GET", `/clusters/${clusterId}/rollout`);
    return rollout.state === "rolled_back";
  },
  280,
  3000,
);
assert.equal(peerSawBad, false, "the non-canary node received the candidate");
assert.equal(rollout.outcome, "error_ratio");
assert.equal(rollout.lastCandidateRevision, bad);
await synced();
const restored = rollout.stableRevision;
for (const id of [edgeId, peerId]) assert.equal((await nodeById(id)).appliedContentHash, goodHash);
assert.ok(
  (await a("GET", "/alerts/events")).some(
    (e) => e.kind === "config_rollout_failed" && e.status === "firing" && e.siteId === null,
  ),
);
assert.equal(await edge("p0.e2e.test", "/"), 200);
pass(
  `candidate #${bad} (origin fails, 5xx) rolled back automatically to #${restored} (content of #${good}); the non-canary node never had it and stayed in DNS; config_rollout_failed alert`,
);
// Restore the origin (a canary again), promote it by hand, then turn the canary off.
await a("PATCH", `/sites/${site.id}`, { origins: [{ address: "whoami" }] });
await waitFor("canary runs the fix", async () => {
  const r = await a("GET", `/clusters/${clusterId}/rollout`);
  return r.state === "canary" && (await nodeById(edgeId)).appliedRevision === r.candidateRevision;
});
assert.equal(
  (await a("POST", `/clusters/${clusterId}/rollout/promote`, {})).outcome,
  "manual_promote",
);
await a("PUT", `/clusters/${clusterId}/rollout-policy`, { ...canaryPolicy, enabled: false });
await a("PATCH", `/node-groups/${canaryGroupId}`, { isCanary: false });
await synced();
pass("fixed origin promoted by an administrator; canary turned off");

// ---------------------------------------------------------------- 3. usage
const windowEnd = new Date(usageWindow + 300_000).toISOString();
const usageAfter = await waitFor(
  "completeUntil passes the traffic window",
  async () => {
    const page = await ok(
      sa,
      "GET",
      `/usage?siteId=${m5.siteId}&from=${new Date(usageWindow).toISOString()}&to=${windowEnd}`,
    );
    return page.completeUntil && page.completeUntil >= windowEnd && page.items.length ? page : null;
  },
  600,
  3000,
);
const [record] = usageAfter.items;
const reported = (
  await psql(
    `select sum(requests)::text || ' ' || sum(bytes_sent)::text || ' ' || sum(bytes_received)::text from node_minute_stats where site_id = '${m5.siteId}' and minute >= '${new Date(usageWindow).toISOString()}' and minute < '${windowEnd}'`,
  )
).split(" ");
assert.deepEqual([record.requests, record.bytesSent, record.bytesReceived], reported);
assert.ok(Number(record.requests) >= 20);
assert.ok(
  !usageBefore.completeUntil || usageAfter.completeUntil > usageBefore.completeUntil,
  "completeUntil did not advance",
);
// Replay the node's last accepted statistics batch with its own mTLS identity.
const nodeContainer = (await run([...compose, "ps", "-q", "node"])).trim();
const pem = async (file) => run(["exec", nodeContainer, "cat", `/var/lib/edgeweir-node/${file}`]);
const [cert, key, ca] = [await pem("node.crt"), await pem("node.key"), await pem("ca.crt")];
const replayScript = `
const https = require("node:https");
const post = (body) => new Promise((resolve, reject) => {
  const req = https.request({ host: "console", port: 8443, servername: "console", method: "POST",
    path: "/edgeweir.node.v1.NodeService/ReportStatsV2", cert: process.env.CERT, key: process.env.KEY, ca: process.env.CA,
    headers: { "content-type": "application/json", "connect-protocol-version": "1" } }, (res) => {
    let data = ""; res.on("data", (c) => data += c); res.on("end", () => resolve({ status: res.statusCode, body: data }));
  });
  req.on("error", reject); req.end(JSON.stringify(body));
});
(async () => {
  const cursor = await post({});
  const sequence = JSON.parse(cursor.body).batchSequence;
  const replay = await post({ batchSequence: sequence, stats: [{ minute: process.env.MINUTE, siteId: process.env.SITE, requests: "1000000", bytesSent: "1000000" }] });
  console.log(JSON.stringify({ cursor, sequence, replay }));
})().catch((e) => { console.error(e); process.exit(1); });`;
const mockContainer = (await run([...compose, "ps", "-q", "mock-services"])).trim();
const replay = JSON.parse(
  await run([
    "exec",
    "-e",
    `CERT=${cert}`,
    "-e",
    `KEY=${key}`,
    "-e",
    `CA=${ca}`,
    "-e",
    `MINUTE=${new Date(usageWindow + 60_000).toISOString()}`,
    "-e",
    `SITE=${m5.siteId}`,
    mockContainer,
    "node",
    "-e",
    replayScript,
  ]),
);
assert.equal(replay.replay.status, 200, JSON.stringify(replay));
assert.equal(JSON.parse(replay.replay.body).accepted ?? 0, 0);
await sleep(70_000); // one usage recomputation cycle
const afterReplay = await ok(
  sa,
  "GET",
  `/usage?siteId=${m5.siteId}&from=${new Date(usageWindow).toISOString()}&to=${windowEnd}`,
);
assert.deepEqual(afterReplay.items[0], record);
const changes = await ok(sa, "GET", "/usage/changes?afterSeq=0&limit=5000");
assert.ok(changes.items.some((i) => i.id === record.id));
pass(
  `usage ${record.id}: requests ${record.requests}, bytes ${record.bytesSent}/${record.bytesReceived} equal the node's minute statistics; replayed batch #${replay.sequence} accepted 0 and changed nothing; completeUntil ${usageBefore.completeUntil} -> ${afterReplay.completeUntil}`,
);

// ---------------------------------------------------------------- 5. every node offline
await synced();
await reconcileDns();
const beforeOutage = await providerRecords();
assert.ok(beforeOutage.some((r) => r.includes(peerIp)));
try {
  await run([...compose, "stop", "node", "node-upgrade-peer"]);
  await waitFor(
    "both nodes offline",
    async () => !(await nodeById(edgeId)).online && !(await nodeById(peerId)).online,
    120,
  );
  const outage = await reconcileDns();
  assert.ok(outage.blocked, "DNS change was not held back");
  assert.equal(outage.blocked.status, "blocked");
  assert.deepEqual(await providerRecords(), beforeOutage);
  assert.ok(
    (await a("GET", "/alerts/events")).some(
      (e) => e.kind === "dns_mass_removal_blocked" && e.status === "firing",
    ),
  );
  pass(
    `every node offline: DNS kept ${beforeOutage.length} records (held back ${outage.blocked.removedRecords}/${outage.blocked.previousRecords}), dns_mass_removal_blocked alert`,
  );
} finally {
  await run([...compose, "start", "node", "node-upgrade-peer"]);
}
await synced();
const recovered = await reconcileDns();
assert.equal(recovered.blocked, null);
assert.deepEqual(await providerRecords(), beforeOutage);

const canaryGroupName = (await a("GET", `/node-groups?clusterId=${clusterId}`)).find(
  (g) => g.id === canaryGroupId,
).name;
await writeFile(
  ".e2e/p0-state.json",
  `${JSON.stringify(
    {
      clusterId,
      siteId: site.id,
      serviceAccountId: created.id,
      canaryGroupName,
    },
    null,
    2,
  )}\n`,
);
console.log("P0 E2E OK");
