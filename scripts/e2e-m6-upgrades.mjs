import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile),
  base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const run = async (args, env) =>
  (await execute("docker", args, { env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 })).stdout;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const fixtures = JSON.parse(await readFile(".e2e/upgrade-fixtures.json", "utf8"));
const m5 = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const login = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
assert.equal(login.status, 200);
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const created = await fetch(`${base}/api/auth/api-key/create`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie },
  body: JSON.stringify({ name: "upgrade-e2e" }),
});
assert.equal(created.status, 200);
const { key } = await created.json();
async function api(method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function wait(label, fn, seconds = 180) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}
const edge = await api("GET", `/nodes/${m5.nodeId}`);
const groups = await api("GET", `/node-groups?clusterId=${edge.clusterId}`);
let canaryGroup = groups.find((g) => g.id === edge.nodeGroupId && !g.isDefault);
if (!canaryGroup) {
  canaryGroup = await api("POST", "/node-groups", {
    clusterId: edge.clusterId,
    name: "upgrade-canary",
  });
  await api("PATCH", `/nodes/${edge.id}`, { nodeGroupId: canaryGroup.id });
}
const defaultGroup = groups.find((g) => g.isDefault);
assert.ok(defaultGroup);
let peer = (await api("GET", `/nodes?clusterId=${edge.clusterId}`)).find(
  (n) => n.name === "edge-upgrade-peer",
);
if (!peer) {
  const token = await api("POST", "/enrollment-tokens", {
    clusterId: edge.clusterId,
    nodeGroupId: defaultGroup.id,
    nodeName: "edge-upgrade-peer",
    ttlMinutes: 15,
  });
  const id = (await run([...compose, "ps", "-q", "node-upgrade-peer"])).trim();
  assert.ok(id);
  await run(
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      id,
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { ...process.env, EDGEWEIR_TOKEN: token.token },
  );
  peer = await wait("peer enrolled", async () =>
    (await api("GET", `/nodes?clusterId=${edge.clusterId}`)).find(
      (n) => n.name === "edge-upgrade-peer",
    ),
  );
}
const node = async (id) => api("GET", `/nodes/${id}`);
const synced = async () => {
  const cluster = await api("GET", `/clusters/${edge.clusterId}`);
  for (const id of [edge.id, peer.id]) {
    const n = await node(id);
    if (
      !n.online ||
      !n.dataPlaneHealthy ||
      n.applyState !== "applied" ||
      n.appliedRevision !== cluster.latestRevision.revision ||
      n.appliedContentHash !== cluster.latestRevision.contentHash ||
      !n.supportedFeatures.includes("self-upgrade-v1")
    )
      return false;
  }
  return true;
};
await wait("both supervised nodes ready", synced);
const before = {
  edge: (await node(edge.id)).agentVersion,
  peer: (await node(peer.id)).agentVersion,
};
const jobs = () => api("GET", `/node-upgrades?clusterId=${edge.clusterId}`);
const job = async (id) => (await jobs()).find((j) => j.id === id);
const good = await api("POST", "/node-upgrades", {
  version: fixtures.versions.good,
  nodeGroupId: canaryGroup.id,
});
assert.deepEqual(good.deliveries.map((d) => d.state).sort(), ["held", "pending"]);
await wait("canary observed healthy", async () => {
  const j = await job(good.id);
  assert.notEqual(j.state, "failed", JSON.stringify(j));
  return j.canPromote && j;
});
assert.equal((await node(edge.id)).agentVersion, fixtures.versions.good);
assert.equal((await node(peer.id)).agentVersion, before.peer, "peer upgraded before promotion");
const edgeContainer = (await run([...compose, "ps", "-q", "node"])).trim();
const config = await run([
  "exec",
  edgeContainer,
  "cat",
  "/var/lib/edgeweir-node/nginx/conf/nginx.conf",
]);
assert.match(
  config,
  /upgrades\/releases\/[0-9a-f-]+\/lua/,
  "Lua did not switch with the executable",
);
await api("POST", `/node-upgrades/${good.id}/promote`, {});
await wait("rollout complete", async () => {
  const j = await job(good.id);
  assert.notEqual(j.state, "failed", JSON.stringify(j));
  return j.state === "succeeded";
});
assert.equal((await node(peer.id)).agentVersion, fixtures.versions.good);
console.log(
  `PASS signed upgrade ${before.edge} -> ${fixtures.versions.good}; observed canary -> explicit peer promotion; Lua switched`,
);
for (const [kind, code] of [
  ["signature", "upgrade_rejected"],
  ["broken", "upgrade_rolled_back"],
]) {
  const attempt = await api("POST", "/node-upgrades", {
    version: fixtures.versions[kind],
    nodeGroupId: canaryGroup.id,
  });
  const done = await wait(`${kind} package rejected`, async () => {
    const j = await job(attempt.id);
    return j.state === "failed" && j;
  });
  const target = done.deliveries.find((d) => d.nodeId === edge.id);
  assert.equal(target.errorCode, code, JSON.stringify(done));
  if (kind === "signature") assert.match(target.message, /signature verification failed/);
  assert.equal(done.deliveries.find((d) => d.nodeId === peer.id).state, "cancelled");
  await wait("old version healthy after failure", async () => {
    const n = await node(edge.id);
    return n.agentVersion === fixtures.versions.good && n.online && n.dataPlaneHealthy;
  });
  assert.equal((await node(peer.id)).agentVersion, fixtures.versions.good);
  console.log(`PASS ${kind}: ${code}; both nodes keep ${fixtures.versions.good}`);
}
await writeFile(
  ".e2e/m6-upgrade-state.json",
  JSON.stringify(
    {
      clusterId: edge.clusterId,
      nodeId: edge.id,
      peerId: peer.id,
      nodeGroupId: canaryGroup.id,
      groupName: canaryGroup.name,
      version: fixtures.versions.ui,
      versions: fixtures.versions,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "M6 UPGRADE E2E OK: real cosign, A -> B, wrong-key rejection, signed startup failure rollback, durable results",
);
