// Usage protection end to end (ADR-0049), after the M6 upgrade step: four
// sites of the upgrade cluster (`node` and `node-upgrade-peer`) behind the
// whoami origin, with daily UTC guards and tiny limits, and a webhook channel
// subscribed to their usage alerts (mock-services records what it receives).
// Nodes report statistics every minute and the worker evaluates every minute,
// so each step waits up to a few minutes; the sites go through them together.
//   a. guards: A requests 20 (warning 50%, maintenance, manual), B bytes sent
//      50 kB (disable, auto), C bandwidth 0.01 Mbps (alert only), D requests 5
//      (maintenance, manual)
//   b. first traffic: A's warning reaches the webhook; B is disabled (503
//      site-disabled at both nodes), C's bandwidth alert reaches the webhook
//      without an action, D goes into maintenance (503 maintenance)
//   c. A over its limit: the limit alert reaches the webhook, maintenance is
//      on at both nodes (503 maintenance), audited as the system, revision
//      reason usage_limit_reached; the time from the request to the edge's 503
//      is reported
//   d. a higher limit for B lifts the action (auto): enabled again, 200
//   e. A restored by hand: maintenance off, 200, and the next evaluation does
//      not turn it on again (paused until the period ends)
// The next period is not waited for: unit tests cover period boundaries.
// Sites A and D stay for apps/console/e2e/usage-guard.spec.ts
// (.e2e/usage-guard-state.json, D still in maintenance);
// `node scripts/e2e-usage-guard.mjs --cleanup` removes the sites and the channel.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, call, pass, stack, waitFor as waitUntil } from "./e2e-lib.mjs";

const mock = `http://localhost:${process.env.E2E_MOCK_PORT ?? 19090}`;
const { nodeIn, psql } = stack({
  profiles: ["upgrades"],
  maxBuffer: 16 * 1024 * 1024,
});
const STATE = ".e2e/usage-guard-state.json";
const PREFIX = "ug-";
const DOMAIN = (name) => `${PREFIX}${name}.usage.test`;
const NODES = ["node", "node-upgrade-peer"];
const ORIGIN = [{ address: "whoami", port: 80 }];
const CHANNEL = "E2E usage webhook";
const DAILY = { period: "day", timeZone: "UTC" };

const waitFor = (label, fn, seconds = 300, interval = 2000, detail) =>
  waitUntil(label, fn, seconds, interval, detail);

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
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "usage-guard-e2e" })).key;
  const user = {};
  user.raw = (method, path, body) => call(key, method, path, body);
  user.ok = async (method, path, body) => {
    const result = await user.raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  return user;
}

/** Sequential GETs from client-a (no Accept-Encoding: bodies are sent as they are). */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const req = http.request({ host: r.target, port: 80, path: r.path, method: "GET",
        headers: { host: r.host }, agent: false, timeout: 30000 }, (res) => {
        let length = 0;
        res.on("data", (d) => (length += d.length));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, length }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, length: 0 }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list) =>
  JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
const repeat = (count, target, host, path) =>
  Array.from({ length: count }, (_, i) => ({ target, host, path: path ?? `/ug-${i}` }));
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"} ${r.length}B${r.error ? ` ${r.error}` : ""}`;

/** What the webhook sink received. */
const webhooks = async () => (await fetch(`${mock}/events`)).json();
const received = async (siteId, kind, resourceId) =>
  (await webhooks()).find(
    (e) =>
      e.siteId === siteId &&
      e.kind === kind &&
      e.resourceId === resourceId &&
      e.status === "firing",
  );

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const nodeIds = [upgrade.nodeId, upgrade.peerId];

let lastNodes = [];
async function synced(label = "nodes on the latest revision") {
  const latest = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
  await waitFor(
    `${label} (#${latest})`,
    async () => {
      lastNodes = await Promise.all(nodeIds.map((id) => admin.ok("GET", `/nodes/${id}`)));
      return lastNodes.every(
        (n) =>
          n.online &&
          n.dataPlaneHealthy &&
          n.applyState === "applied" &&
          n.appliedRevision >= latest,
      );
    },
    120,
    1000,
    () => JSON.stringify(lastNodes.map((n) => [n.name, n.appliedRevision, n.applyState])),
  );
  return latest;
}
const sitesByPrefix = async () =>
  (await admin.ok("GET", `/sites?search=${PREFIX}&pageSize=100`)).items.filter((s) =>
    s.name.startsWith(PREFIX),
  );

async function cleanup() {
  let removed = 0;
  for (const site of await sitesByPrefix()) {
    await admin.ok("DELETE", `/sites/${site.id}`);
    removed++;
  }
  const channel = (await admin.ok("GET", "/alerts/channels")).find((c) => c.name === CHANNEL);
  if (channel) await admin.ok("DELETE", `/alerts/channels/${channel.id}`);
  pass(`usage protection cleanup: ${removed} site(s)${channel ? " and the channel" : ""} removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

// A run that failed before its cleanup leaves sites with these names.
for (const left of await sitesByPrefix()) await admin.ok("DELETE", `/sites/${left.id}`);
const sites = {};
for (const name of ["a", "b", "c", "d"]) {
  const created = await admin.ok("POST", "/sites", {
    name: `${PREFIX}${name}`,
    domains: [DOMAIN(name)],
    origins: ORIGIN,
    clusterId,
  });
  sites[name] = created.site.id;
}
await synced("the four sites published");
for (const name of ["a", "b", "c", "d"])
  for (const target of NODES) {
    const [r] = await requests([{ target, host: DOMAIN(name), path: "/" }]);
    assert.equal(r.status, 200, `${name} at ${target}: ${summary(r)}`);
  }
let channel = (await admin.ok("GET", "/alerts/channels")).find((c) => c.name === CHANNEL);
if (!channel)
  channel = await admin.ok("POST", "/alerts/channels", {
    name: CHANNEL,
    platform: false,
    config: { kind: "webhook", url: "http://mock-services:8080/webhook" },
  });
await admin.ok("POST", "/alerts/subscriptions", {
  channelId: channel.id,
  kinds: ["usage_warning", "usage_limit"],
  siteIds: Object.values(sites),
});
pass("four sites at both nodes; webhook channel subscribed to their usage alerts");

// ---------------------------------------------------------------- a. guards
const guard = (name, settings) =>
  admin.ok("PUT", `/sites/${sites[name]}/usage-guard`, { ...DAILY, ...settings });
await guard("a", {
  requestsLimit: "20",
  warnPercent: 50,
  action: "maintenance",
  recovery: "manual",
});
await guard("b", { bytesLimit: "50000", warnPercent: null, action: "disable", recovery: "auto" });
await guard("c", { bandwidthBps: 10_000, action: "alert" });
await guard("d", { requestsLimit: "5", action: "maintenance", recovery: "manual" });
const shown = await admin.ok("GET", `/sites/${sites.a}/usage-guard`);
assert.equal(shown.settings.requestsLimit, "20");
assert.ok(shown.period && shown.usage, JSON.stringify(shown));
pass(`guards saved; A's period ${shown.period.start} - ${shown.period.end}`);

// ---------------------------------------------------------------- b. first traffic
const sentAt = Date.now();
// A: 8 more (10 with the checks above); D: 6 more; B: 60 kB; C: 400 kB.
await requests([
  ...repeat(8, "node", DOMAIN("a")),
  ...repeat(6, "node-upgrade-peer", DOMAIN("d")),
  { target: "node", host: DOMAIN("b"), path: "/data?size=60&unit=KB" },
  ...repeat(4, "node-upgrade-peer", DOMAIN("c"), "/data?size=100&unit=KB"),
]);
const guardOf = (name) => admin.ok("GET", `/sites/${sites[name]}/usage-guard`);
await waitFor("A's warning at the webhook", () => received(sites.a, "usage_warning", "requests"));
const warned = Math.round((Date.now() - sentAt) / 1000);
await waitFor("B disabled", async () => (await guardOf("b")).held?.action === "disable");
assert.equal((await admin.ok("GET", `/sites/${sites.b}`)).enabled, false);
await waitFor("C's bandwidth alert at the webhook", () =>
  received(sites.c, "usage_limit", "bandwidth"),
);
const c = await guardOf("c");
assert.equal(c.held, null, "alert only holds no action");
assert.ok(c.usage.bandwidthPeakBps >= 10_000, JSON.stringify(c.usage));
await waitFor("D in maintenance", async () => (await guardOf("d")).held?.action === "maintenance");
await synced("B disabled, D in maintenance");
for (const target of NODES) {
  const [b, d] = await requests([
    { target, host: DOMAIN("b"), path: "/" },
    { target, host: DOMAIN("d"), path: "/" },
  ]);
  assert.equal(b.status, 503, `disabled B at ${target}: ${summary(b)}`);
  assert.equal(b.headers["x-edgeweir-error"], "site-disabled", `B at ${target}: ${summary(b)}`);
  assert.equal(d.status, 503, `D at ${target}: ${summary(d)}`);
  assert.equal(d.headers["x-edgeweir-error"], "maintenance", `D at ${target}: ${summary(d)}`);
}
pass(
  `A warned (${warned} s after the traffic); B disabled at both nodes (503 site-disabled); C's bandwidth alert (peak ${Math.round(c.usage.bandwidthPeakBps)} bps, no action); D 503 maintenance at both nodes`,
);

// ---------------------------------------------------------------- c. A over its limit
const crossedAt = Date.now();
await requests(repeat(10, "node", DOMAIN("a")));
await waitFor("A's limit alert at the webhook", () => received(sites.a, "usage_limit", "requests"));
await waitFor("A in maintenance", async () => (await guardOf("a")).held?.action === "maintenance");
await synced("A in maintenance");
const edge503 = await waitFor(
  "503 maintenance for A at both nodes",
  async () => {
    const replies = await requests(
      NODES.map((target) => ({ target, host: DOMAIN("a"), path: "/" })),
    );
    return replies.every((r) => r.status === 503 && r.headers["x-edgeweir-error"] === "maintenance")
      ? Date.now()
      : null;
  },
  60,
);
const applied = (
  await admin.ok("GET", "/audit-logs?action=site.usage_guard_apply&limit=50")
).items.find((e) => e.targetId === sites.a);
assert.ok(applied, "no site.usage_guard_apply for A");
assert.equal(applied.actorType, "system");
assert.equal(applied.metadata.metric, "requests");
const revision = (await admin.ok("GET", `/clusters/${clusterId}/revisions`)).find(
  (r) => r.revision === applied.metadata.revision,
);
assert.equal(revision?.reasonCode, "usage_limit_reached");
const events = await admin.ok("GET", `/alerts/events?siteId=${sites.a}`);
assert.ok(events.some((e) => e.kind === "usage_limit" && e.status === "firing"));
pass(
  `A over its limit: webhook alert, 503 maintenance at both nodes ${Math.round((edge503 - crossedAt) / 1000)} s after the request; audited by the system with revision #${revision.revision} (usage_limit_reached)`,
);

// ---------------------------------------------------------------- d. B's higher limit
await guard("b", {
  bytesLimit: "10000000",
  warnPercent: null,
  action: "disable",
  recovery: "auto",
});
await waitFor("B enabled again", async () => (await admin.ok("GET", `/sites/${sites.b}`)).enabled);
assert.equal((await guardOf("b")).held, null);
await synced("B enabled");
for (const target of NODES) {
  const [b] = await requests([{ target, host: DOMAIN("b"), path: "/" }]);
  assert.equal(b.status, 200, `B at ${target}: ${summary(b)}`);
}
const released = (
  await admin.ok("GET", "/audit-logs?action=site.usage_guard_release&limit=50")
).items.find((e) => e.targetId === sites.b);
assert.equal(released?.actorType, "system");
pass(
  "a higher limit lifted B's action (auto): enabled and 200 at both nodes, audited by the system",
);

// ---------------------------------------------------------------- e. A restored
const restoredAt = await psql("select now()");
const restored = await admin.ok("POST", `/sites/${sites.a}/usage-guard/restore`);
assert.equal(restored.held, null);
assert.ok(restored.pausedUntil, JSON.stringify(restored));
await synced("A restored");
await waitFor(
  "an evaluation after the restore",
  async () =>
    (await psql(
      `select evaluated_at > '${restoredAt}'::timestamptz from site_usage_guard where site_id = '${sites.a}'`,
    )) === "t",
  150,
);
assert.equal((await guardOf("a")).held, null, "A was held again");
for (const target of NODES) {
  const [a] = await requests([{ target, host: DOMAIN("a"), path: "/" }]);
  assert.equal(a.status, 200, `A at ${target}: ${summary(a)}`);
}
pass(`A restored by hand: 200 at both nodes, paused until ${restored.pausedUntil}`);

await writeFile(STATE, `${JSON.stringify({ a: sites.a, d: sites.d, clusterId }, null, 2)}\n`);
pass(`state for the browser checks in ${STATE}`);
