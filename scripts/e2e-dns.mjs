// Cluster DNS bindings and automatic records end to end, after G1. Uses the
// real edgeweir-certd with the local test provider (two accounts) and the
// Custom HTTP provider (signed webhook) of docker/e2e/mock-services:
//   1. cluster A (node + node-upgrade-peer, one line) on account A
//      (cdn.m5.test) and cluster B (node-dns) on account B (cdn-b.dns.test):
//      zones listed and the connection tested through the API; each cluster
//      publishes one address set and one CNAME per site
//   2. the peer goes offline: only cluster A drops its address; back online,
//      it returns; cluster B is untouched
//   3. account A's provider is down: cluster B still publishes; A recovers
//   4. cluster B in manual mode: nothing is written, the BIND zone file lists
//      the records
//   5. a tenant links its zone (Custom HTTP) with automatic records: the
//      ownership TXT and CNAME are written, an existing A record is kept
//      until the tenant confirms, the domain verifies by itself and the TXT
//      goes, removing a domain removes only the console's own record
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades", "--profile", "dns"];
const run = async (args, env) =>
  (await execute("docker", args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEBHOOK = { url: "http://mock-services:8080/dns-hook", secret: "e2e-webhook-secret-0123" };

async function waitFor(label, fn, seconds = 180, interval = 1500) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label}`);
}

/** A signed-in user whose AccessKey is replaced every 400 calls (request limit). */
async function actor(email, password) {
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
  const createKey = async () => {
    const created = await fetch(`${base}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ name: "dns-e2e" }),
    });
    assert.equal(created.status, 200);
    return (await created.json()).key;
  };
  let key = await createKey(),
    calls = 0;
  const raw = async (method, path, body) => {
    if (++calls % 400 === 0) key = await createKey();
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  return async (method, path, body) => {
    const result = await raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
}

const fixture = async (path, body) => {
  const res = await fetch(`${mock}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer e2e-dns-token" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `${path}: ${await res.text()}`);
};
const zone = async (name) =>
  ((await (await fetch(`${mock}/records`)).json())[name] ?? [])
    .map((r) => `${r.name} ${r.type} ${r.data}`)
    .sort();
const containerIp = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  const info = JSON.parse(await run(["inspect", id]))[0];
  const network = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert.ok(network, `${service} has no default network`);
  return network[1].IPAddress;
};

const a = await actor("admin@e2e.test", "e2e-admin-password-123");
const m5 = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const clusterA = upgrade.clusterId;
const edgeId = upgrade.nodeId,
  peerId = upgrade.peerId;
const node = (id) => a("GET", `/nodes/${id}`);
const ready = async (id) => {
  const n = await node(id);
  const cluster = await a("GET", `/clusters/${n.clusterId}`);
  return (
    n.online &&
    n.dataPlaneHealthy &&
    n.applyState === "applied" &&
    n.appliedRevision >= (n.targetRevision ?? cluster.latestRevision?.revision ?? 0)
  );
};
await a("PUT", "/dns/protection", { massRemovalRatio: 0.5 });

// ---------------------------------------------------------------- 1. two clusters, two accounts
const groupsA = await a("GET", `/node-groups?clusterId=${clusterA}`);
const defaultA = groupsA.find((g) => g.isDefault);
// Both nodes of cluster A in one line, so one of them going offline leaves the set non-empty.
await a("PATCH", `/nodes/${edgeId}`, { nodeGroupId: defaultA.id });
const edgeIp = await containerIp("node"),
  peerIp = await containerIp("node-upgrade-peer");
const bindingA = {
  mode: "auto",
  providerId: m5.providerId,
  domain: "edge.cdn.m5.test",
  ttl: 60,
  lines: [
    {
      name: "default",
      nodeGroupId: defaultA.id,
      overrides: [
        { nodeId: edgeId, addresses: [edgeIp] },
        { nodeId: peerId, addresses: [peerIp] },
      ],
    },
  ],
};
await a("PUT", `/clusters/${clusterA}/dns`, { binding: bindingA });

let clusterB = (await a("GET", "/clusters")).find((c) => c.name === "dns-b");
if (!clusterB) clusterB = await a("POST", "/clusters", { name: "dns-b" });
const defaultB = (await a("GET", `/node-groups?clusterId=${clusterB.id}`)).find((g) => g.isDefault);
let nodeB = (await a("GET", `/nodes?clusterId=${clusterB.id}`)).find(
  (n) => n.name === "edge-dns-b",
);
if (!nodeB) {
  const token = await a("POST", "/enrollment-tokens", {
    clusterId: clusterB.id,
    nodeGroupId: defaultB.id,
    nodeName: "edge-dns-b",
    ttlMinutes: 15,
  });
  const id = (await run([...compose, "ps", "-q", "node-dns"])).trim();
  assert.ok(id, "node-dns is not running");
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
  nodeB = await waitFor("node-dns enrolled", async () =>
    (await a("GET", `/nodes?clusterId=${clusterB.id}`)).find((n) => n.name === "edge-dns-b"),
  );
}
const nodeBIp = await containerIp("node-dns");
let siteB = (await a("GET", `/sites?search=dns-b-site&pageSize=50`)).items.find(
  (s) => s.name === "dns-b-site",
);
if (!siteB)
  siteB = (
    await a("POST", "/sites", {
      name: "dns-b-site",
      domains: ["b.dns-e2e.test"],
      origins: [{ address: "whoami" }],
      clusterId: clusterB.id,
    })
  ).site;
await waitFor("node-dns applied its configuration", () => ready(nodeB.id));

const credentialsB = { api_token: "e2e-dns-token-b" };
assert.deepEqual(await a("POST", "/dns/zones", { provider: "test", credentials: credentialsB }), {
  zones: ["cdn-b.dns.test"],
});
const probe = await a("POST", "/dns/test", {
  provider: "test",
  credentials: credentialsB,
  zone: "cdn-b.dns.test",
});
assert.equal(probe.ok, true);
let accountB = (await a("GET", "/dns/providers")).items.find((p) => p.name === "E2E DNS B");
if (!accountB)
  accountB = await a("POST", "/dns/providers", {
    name: "E2E DNS B",
    provider: "test",
    zone: "cdn-b.dns.test",
    credentials: credentialsB,
  });
const bindingB = {
  mode: "auto",
  providerId: accountB.id,
  domain: "edge.cdn-b.dns.test",
  ttl: 60,
  lines: [
    {
      name: "west",
      nodeGroupId: defaultB.id,
      overrides: [{ nodeId: nodeB.id, addresses: [nodeBIp] }],
    },
  ],
};
await a("PUT", `/clusters/${clusterB.id}/dns`, { binding: bindingB });
const applied = async (clusterId) => (await a("GET", `/clusters/${clusterId}/dns`)).applied;
await a("POST", "/dns/reconcile", {});
await waitFor("both bindings applied", async () => {
  await a("POST", "/dns/reconcile", {});
  return (await applied(clusterA)) && (await applied(clusterB.id));
});
const zoneA = await zone("cdn.m5.test"),
  zoneB = await zone("cdn-b.dns.test");
for (const record of [
  `all.edge A ${edgeIp}`,
  `all.edge A ${peerIp}`,
  `default.edge A ${edgeIp}`,
  `default.edge A ${peerIp}`,
  `${m5.siteId}.edge CNAME all.edge.cdn.m5.test`,
])
  assert.ok(zoneA.includes(record), `${record} in ${JSON.stringify(zoneA)}`);
assert.deepEqual(
  zoneB,
  [
    `all.edge A ${nodeBIp}`,
    `${siteB.id}.edge CNAME all.edge.cdn-b.dns.test`,
    `west.edge A ${nodeBIp}`,
  ].sort(),
);
// One address set per cluster: four A records however many sites cluster A has.
const sitesA = zoneA.filter((r) => r.includes(" CNAME all.edge.cdn.m5.test")).length;
assert.equal(zoneA.filter((r) => / A /.test(r)).length, 4);
const targetB = await a("GET", `/sites/${siteB.id}/cname`);
assert.deepEqual(targetB, {
  target: `${siteB.id}.edge.cdn-b.dns.test`,
  mode: "auto",
  published: true,
  healthy: true,
  lines: [{ name: "west", target: "west.edge.cdn-b.dns.test" }],
});
pass(
  `two clusters on two accounts and domains: cluster A ${sitesA} site CNAMEs + 4 address records, cluster B ${zoneB.length} records; zones listed and connection tested through certd`,
);

// ---------------------------------------------------------------- 2. offline node
try {
  await run([...compose, "stop", "node-upgrade-peer"]);
  await waitFor("peer offline", async () => !(await node(peerId)).online, 120);
  await a("POST", "/dns/reconcile", { clusterId: clusterA });
  const withoutPeer = await zone("cdn.m5.test");
  assert.ok(!withoutPeer.some((r) => r.endsWith(` A ${peerIp}`)), JSON.stringify(withoutPeer));
  assert.ok(withoutPeer.includes(`all.edge A ${edgeIp}`));
  await a("POST", "/dns/reconcile", {});
  assert.deepEqual(await zone("cdn-b.dns.test"), zoneB);
  pass("the offline peer left cluster A's records only; cluster B's records unchanged");
} finally {
  await run([...compose, "start", "node-upgrade-peer"]);
}
await waitFor("peer back", () => ready(peerId), 180);
await waitFor("peer's address restored", async () => {
  await a("POST", "/dns/reconcile", { clusterId: clusterA });
  return (await zone("cdn.m5.test")).includes(`all.edge A ${peerIp}`);
});
pass("the recovered peer is back in cluster A's records");

// ---------------------------------------------------------------- 3. provider outage
await fixture("/fail", { token: "e2e-dns-token", down: true });
try {
  await a("PUT", `/clusters/${clusterA}/dns`, { binding: { ...bindingA, ttl: 120 } });
  await a("PUT", `/clusters/${clusterB.id}/dns`, { binding: { ...bindingB, ttl: 120 } });
  await a("POST", "/dns/reconcile", {});
  const failed = await a("GET", `/clusters/${clusterA}/dns`);
  assert.equal(failed.revision.status, "failed");
  assert.equal(failed.revision.lastError, "dns_provider_unreachable");
  assert.equal(await applied(clusterB.id), true);
  assert.ok((await zone("cdn-b.dns.test")).length === 3);
  const b = (await (await fetch(`${mock}/records`)).json())["cdn-b.dns.test"];
  assert.ok(b.every((r) => r.ttl === 120));
  pass(
    "account A down: cluster A failed (dns_provider_unreachable), cluster B published its change",
  );
} finally {
  await fixture("/fail", { token: "e2e-dns-token", down: false });
}
await waitFor("cluster A recovers", async () => {
  await a("POST", "/dns/reconcile", { clusterId: clusterA });
  return applied(clusterA);
});
pass("account A back: cluster A applied");

// ---------------------------------------------------------------- 4. manual mode
await a("PUT", `/clusters/${clusterB.id}/dns`, {
  binding: { ...bindingB, ttl: 120, mode: "manual" },
});
const beforeManual = await zone("cdn-b.dns.test");
await a("POST", "/dns/reconcile", {});
await a("POST", "/dns/reconcile", { clusterId: clusterB.id });
assert.deepEqual(await zone("cdn-b.dns.test"), beforeManual);
const exported = await a("GET", `/clusters/${clusterB.id}/dns/export`);
const lines = exported.zoneFile.trim().split("\n");
assert.deepEqual(lines.slice(0, 2), ["$ORIGIN cdn-b.dns.test.", "$TTL 120"]);
assert.deepEqual(
  lines
    .slice(2)
    .map((l) => l.split(/\s+/).join(" "))
    .sort(),
  [
    `all.edge 120 IN A ${nodeBIp}`,
    `${siteB.id}.edge 120 IN CNAME all.edge.cdn-b.dns.test.`,
    `west.edge 120 IN A ${nodeBIp}`,
  ].sort(),
);
assert.equal((await a("GET", `/sites/${siteB.id}/cname`)).mode, "manual");
await mkdir(".e2e", { recursive: true });
await writeFile(".e2e/dns-cluster-b.zone", exported.zoneFile);
pass(
  "manual mode: no provider writes; the zone file lists the cluster's records (.e2e/dns-cluster-b.zone)",
);

// ---------------------------------------------------------------- 5. tenant zone automatic records
const tenantEmail = "owner@dns-e2e.test",
  tenantPassword = "dns-e2e-owner-password-123";
let org = (await a("GET", "/organizations")).find((o) => o.name === "DNS Tenant");
if (!org) {
  org = await a("POST", "/organizations", { name: "DNS Tenant", defaultClusterId: clusterA });
  await a("POST", "/users", {
    name: "DNS Tenant Owner",
    email: tenantEmail,
    password: tenantPassword,
    organizationId: org.id,
    role: "owner",
  });
}
const t = await actor(tenantEmail, tenantPassword);
assert.deepEqual(
  await t("POST", "/dns-credentials/zones", { provider: "webhook", credentials: WEBHOOK }),
  { zones: ["tenant.dns.test"] },
);
await fixture("/dns/append", {
  zone: "tenant.dns.test",
  records: [
    { name: "shop", type: "A", data: "192.0.2.44", ttl: 300 },
    { name: "keep", type: "TXT", data: "unrelated", ttl: 300 },
  ],
});
assert.deepEqual(
  await t("POST", "/dns-credentials/test", {
    provider: "webhook",
    credentials: WEBHOOK,
    zone: "tenant.dns.test",
  }),
  { ok: true, records: 2 },
);
if (!(await t("GET", "/dns-credentials")).some((c) => c.name === "Tenant zone"))
  await t("POST", "/dns-credentials", {
    name: "Tenant zone",
    provider: "webhook",
    zone: "tenant.dns.test",
    credentials: WEBHOOK,
    autoRecords: true,
  });
const site = (
  await t("POST", "/sites", {
    name: "dns-tenant-site",
    domains: ["www.tenant.dns.test", "shop.tenant.dns.test"],
    origins: [{ address: "whoami" }],
  })
).site;
const target = `${site.id}.edge.cdn.m5.test`;
let records = await t("POST", `/sites/${site.id}/dns-records/sync`);
const proof = (await t("GET", `/sites/${site.id}/ownership`)).find(
  (p) => p.domain === "tenant.dns.test",
);
let tenantZone = await zone("tenant.dns.test");
assert.ok(
  tenantZone.includes(`_edgeweir-verification TXT ${proof.txtValue}`),
  JSON.stringify(tenantZone),
);
assert.ok(tenantZone.includes(`www CNAME ${target}`));
assert.ok(tenantZone.includes("shop A 192.0.2.44"));
assert.ok(!tenantZone.includes(`shop CNAME ${target}`));
const shop = records.items.find((r) => r.name === "shop.tenant.dns.test");
assert.equal(shop.status, "conflict");
assert.deepEqual(shop.conflicts, [{ type: "A", data: "192.0.2.44" }]);
pass(
  "automatic records: ownership TXT and www CNAME written through the signed webhook; shop's A record kept as a conflict",
);

// Verification (the mock authority answers TXT from the zone), then the TXT goes.
await waitFor(
  "domain verified by the written TXT",
  async () => {
    await t("POST", `/sites/${site.id}/dns-records/sync`);
    return (await t("GET", `/sites/${site.id}/ownership`)).every((p) => p.verified);
  },
  60,
  6000,
);
await t("POST", `/sites/${site.id}/dns-records/sync`);
tenantZone = await zone("tenant.dns.test");
assert.ok(
  !tenantZone.some((r) => r.startsWith("_edgeweir-verification")),
  JSON.stringify(tenantZone),
);
pass("the domain verified through the written TXT, which was then removed");

records = await t("POST", `/sites/${site.id}/dns-records/${shop.id}/confirm`);
assert.equal(records.items.find((r) => r.id === shop.id).status, "written");
tenantZone = await zone("tenant.dns.test");
assert.ok(tenantZone.includes(`shop CNAME ${target}`));
assert.ok(!tenantZone.includes("shop A 192.0.2.44"));
pass("after the tenant's confirmation the CNAME replaced shop's A record");

await t("PATCH", `/sites/${site.id}`, { domains: ["shop.tenant.dns.test"] });
await t("POST", `/sites/${site.id}/dns-records/sync`);
tenantZone = await zone("tenant.dns.test");
assert.deepEqual(tenantZone, [`keep TXT unrelated`, `shop CNAME ${target}`].sort());
const audit = await a("GET", "/audit-logs?action=dns_record.overwrite");
assert.equal(audit.items[0]?.organizationId, org.id);
pass(
  "removing www removed only its CNAME; unrelated records stay; changes audited for the organization",
);

await writeFile(
  ".e2e/dns-state.json",
  JSON.stringify({
    clusterA,
    clusterB: clusterB.id,
    siteB: siteB.id,
    tenantSite: site.id,
    accountB: accountB.id,
    tenantEmail,
    tenantPassword,
  }),
);
console.log("DNS E2E OK");
