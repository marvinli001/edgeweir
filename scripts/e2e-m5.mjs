import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`,
  mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`,
  edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const compose = ["compose", "-f", "compose.e2e.yml"];
async function run(args) {
  return (await execute("docker", args, { maxBuffer: 2 * 1024 * 1024 })).stdout;
}
async function login(email, password) {
  const response = await signInResponse(base, email, password);
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const created = await fetch(`${base}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify({ name: "m5-e2e" }),
  });
  assert.equal(created.status, 200);
  return { ...(await created.json()), cookie };
}
async function api(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function waitFor(label, fn, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}
async function fixture(path, body) {
  const response = await fetch(mock + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer e2e-dns-token" },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok);
  return response.json();
}
function request(host, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: edgePort, path, headers: { host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("edge timeout")));
  });
}
await waitFor("console ready", async () => {
  try {
    return (await fetch(base + "/healthz")).ok;
  } catch {
    return false;
  }
});
const admin = await login("admin@e2e.test", "e2e-admin-password-123"),
  a = (method, path, body) => api(admin.key, method, path, body);
const cluster = (await a("GET", "/clusters")).find((c) => c.name === "default");
assert.ok(cluster);
const edge = await waitFor("M5 capable node", async () =>
  (await a("GET", "/nodes")).find(
    (n) =>
      n.online && n.clusterId === cluster.id && n.supportedFeatures.includes("stats-sequence-v1"),
  ),
);
// Upgrade this isolated fixture's pre-M5 administrative sites explicitly.
for (const site of (await a("GET", "/sites?pageSize=100")).items) {
  for (const proof of await a("GET", `/sites/${site.id}/ownership`)) {
    if (!proof.verified)
      await a("POST", `/sites/${site.id}/ownership/approve`, { domain: proof.domain });
  }
}
const organizations = await a("GET", "/organizations");
let org = organizations.find((o) => o.name === "M5 tenant");
if (!org)
  org = await a("POST", "/organizations", { name: "M5 tenant", defaultClusterId: cluster.id });
const users = await a("GET", "/users?search=tenant%40m5.test");
if (!users.length)
  await a("POST", "/users", {
    name: "M5 tenant",
    email: "tenant@m5.test",
    password: "m5-tenant-password-123",
    organizationId: org.id,
    role: "owner",
  });
const tenant = await login("tenant@m5.test", "m5-tenant-password-123"),
  t = (method, path, body) => api(tenant.key, method, path, body);
const domain = "tenant.m5-proof.test";
let site = (await t("GET", "/sites")).items.find((s) => s.domains.includes(domain));
if (!site)
  site = (
    await t("POST", "/sites", {
      name: "M5 proof",
      domains: [domain],
      origins: [{ address: "whoami" }],
    })
  ).site;
const proofs = await t("GET", `/sites/${site.id}/ownership`);
if (proofs[0]?.verified) await t("DELETE", `/sites/${site.id}/ownership/${proofs[0].domain}`);
let proof = (await t("POST", `/sites/${site.id}/ownership`))[0];
assert.ok(proof?.txtValue);
async function synced() {
  await waitFor("node revision applied", async () => {
    const c = await a("GET", `/clusters/${cluster.id}`);
    const n = (await a("GET", "/nodes")).find((n) => n.id === edge.id);
    return (
      n?.online && n.appliedRevision === c.latestRevision.revision && n.applyState === "applied"
    );
  });
}
await synced();
assert.equal(await request(domain), 404);
await fixture("/txt", { name: proof.txtName, values: [proof.txtValue] });
proof = await t("POST", `/sites/${site.id}/ownership/verify`, { domain: proof.domain });
assert.equal(proof.verified, true);
await synced();
assert.equal(await request(domain, "/m5-proof"), 200);
console.log(
  "PASS unverified tenant domain is absent from node routing; real TXT lookup enables it",
);
let provider = (await a("GET", "/dns/providers")).items.find((p) => p.name === "E2E DNS");
if (!provider)
  provider = await a("POST", "/dns/providers", {
    name: "E2E DNS",
    provider: "test",
    zone: "cdn.m5.test",
    credentials: { api_token: "e2e-dns-token" },
  });
const nodeContainer = (await run([...compose, "ps", "-q", "node"])).trim();
const info = JSON.parse(await run(["inspect", nodeContainer]))[0];
const network = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
  name.endsWith("_default"),
);
assert.ok(network);
const address = network[1].IPAddress;
const before = (await a("GET", `/clusters/${cluster.id}`)).latestRevision.revision;
await a("PUT", "/dns/config", {
  enabled: true,
  providerId: provider.id,
  cnameSuffix: "edge.cdn.m5.test",
  ttl: 60,
  lines: [
    {
      name: "default",
      nodeGroupId: edge.nodeGroupId,
      overrides: [{ nodeId: edge.id, addresses: [address] }],
    },
  ],
});
await fixture("/dns/append", {
  zone: provider.zone,
  records: [{ name: "unrelated", type: "TXT", data: "preserve", ttl: 600 }],
});
await a("POST", "/dns/reconcile");
await waitFor(
  "DNS published",
  async () => (await a("GET", "/dns/config")).revision?.status === "applied",
);
assert.equal((await a("GET", `/clusters/${cluster.id}`)).latestRevision.revision, before);
let target = await t("GET", `/sites/${site.id}/cname`);
assert.equal(target.published, true);
assert.equal(target.healthy, true);
const records = async () => (await (await fetch(mock + "/records")).json())[provider.zone] ?? [];
assert.ok((await records()).some((r) => r.type === "CNAME" && r.name === `${site.id}.edge`));
assert.ok((await records()).some((r) => r.type === "A" && r.data === address));
console.log(
  "PASS DNS records published by the real Go helper; DNS revisions are independent from node revisions",
);
const aRecords = (await records()).filter((r) => r.type === "A");
await fixture("/dns/delete", { zone: provider.zone, records: aRecords });
await a("POST", "/dns/reconcile");
assert.equal((await records()).filter((r) => r.type === "A").length, aRecords.length);
console.log("PASS DNS record drift repaired without touching unrelated records");
let channel = (await a("GET", "/alerts/channels")).find((c) => c.name === "E2E webhook");
if (!channel)
  channel = await a("POST", "/alerts/channels", {
    name: "E2E webhook",
    availableToTenants: true,
    platform: false,
    config: { kind: "webhook", url: "http://mock-services:8080/webhook" },
  });
await t("POST", "/alerts/subscriptions", {
  siteId: site.id,
  channelId: channel.id,
  kinds: ["node_offline"],
});
await a("PUT", "/alerts/policy", { nodeOfflineSeconds: 45 });
try {
  await run([...compose, "stop", "node"]);
  await waitFor(
    "node offline",
    async () => !(await a("GET", "/nodes")).find((n) => n.id === edge.id)?.online,
    90,
  );
  await a("POST", "/dns/reconcile");
  assert.equal((await records()).filter((r) => r.type === "A" && r.data === address).length, 0);
  console.log("PASS offline node addresses withdrawn from DNS");
  await waitFor(
    "real offline webhook",
    async () => {
      const events = await (await fetch(mock + "/events")).json();
      return events.some(
        (event) =>
          event.siteId === site.id &&
          event.resourceId === edge.id &&
          event.kind === "node_offline" &&
          event.status === "firing",
      );
    },
    120,
  );
  console.log("PASS subscribed tenant received its node-offline alert at the local webhook sink");
} finally {
  await run([...compose, "start", "node"]);
}
await synced();
await a("POST", "/dns/reconcile");
target = await t("GET", `/sites/${site.id}/cname`);
assert.equal(target.healthy, true);
assert.ok((await records()).some((r) => r.name === "unrelated" && r.data === "preserve"));
console.log("PASS recovered node addresses restored");
for (let i = 0; i < 10; i++) assert.equal(await request(domain, "/m5-popular"), 200);
await waitFor(
  "statistics including bounded Top URL",
  async () =>
    (await t("GET", `/analytics/top-requests?siteId=${site.id}&range=1h&by=url`)).items.some(
      (item) => item.value === "/m5-popular",
    ),
  150,
);
assert.ok((await t("GET", `/analytics/traffic?siteId=${site.id}&range=1h`)).totals.requests >= 10);
console.log("PASS real node sequenced statistics and approximate Top URL reach the console");
await mkdir(".e2e", { recursive: true });
await writeFile(
  ".e2e/m5-state.json",
  JSON.stringify({
    siteId: site.id,
    nodeId: edge.id,
    providerId: provider.id,
    organizationId: org.id,
    domain,
  }),
);
for (const session of [tenant, admin]) {
  if (!session.id) continue;
  const response = await fetch(`${base}/api/auth/api-key/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie: session.cookie },
    body: JSON.stringify({ keyId: session.id }),
  });
  assert.equal(response.status, 200);
}
console.log("M5 E2E OK");
