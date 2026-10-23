// Node logs (ADR-0050) of the core node edge-e2e-1, which runs
// `edgeweir-node supervise --manage-nginx` (the supervisor runs OpenResty and
// keeps its error log for the agent):
//   a. the node reports node-logs-v1; its log holds the agent's
//      config_applied event and the supervisor's engine_started event
//   b. a site whose origin name does not resolve: requests with a token and
//      a signature in the query string mark the origin down; within 60 s the
//      Lua warning is in the API (source lua, level warn) with the request
//      context and the query string removed; the secrets are nowhere in the
//      API's answers or in node_log_entry
//   d. debug logs (debug-logs-v1): a pull of the node's debug log buffer
//      succeeds within 60 s with the agent's debug records (status reported)
//      and the Lua warning of b without its query string; a pull filtered to
//      a component no record has succeeds empty; the secrets are nowhere in
//      the API's answers or in node_debug_log; the pull is audited
//   c. retention 1 day and 1,000 entries per node: backdated rows and rows
//      over the limit, inserted into the database, are deleted by the prune
//      the console runs at its start (the console restarts); the newest stay;
//      the setting is restored
// The site stays for apps/console/e2e/node-logs.spec.ts
// (.e2e/node-logs-state.json); `node scripts/e2e-node-logs.mjs --cleanup`
// deletes it.
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass, stack, waitFor as waitUntil } from "./e2e-lib.mjs";

const nodePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const { compose, run, psql } = stack({ maxBuffer: 16 * 1024 * 1024 });
const STATE = ".e2e/node-logs-state.json";
const NODE = "edge-e2e-1";
const HOST = "logs.node-logs.e2e.test";
const ORIGIN = "no-such-origin.node-logs.e2e.test";
// Different every run: a match can only come from this run.
const SECRET = `e2e-node-logs-${Date.now().toString(36)}`;
const SIGNATURE = `sig${Date.now().toString(36)}`;

const waitFor = (label, fn, seconds = 120, interval = 1000, detail) =>
  waitUntil(label, fn, seconds, interval, detail);

/** The operator with an AccessKey for /api/v1. */
async function operator() {
  const response = await waitFor(
    "sign in",
    async () => {
      const r = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
      return r.status === 200 ? r : null;
    },
    60,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "node-logs-e2e" })).key;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, json: text ? JSON.parse(text) : null };
  };
  return {
    call,
    ok: async (method, path, body) => {
      const r = await call(method, path, body);
      assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
      return r.json;
    },
  };
}

/** GET through the node's published HTTP port with a Host header. */
const get = (path, host = HOST) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: nodePort, path, headers: { host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("node timeout")));
    req.end();
  });

const admin = await operator();
const node = (await admin.ok("GET", "/nodes")).find((n) => n.name === NODE);
assert.ok(node, `${NODE} is not enrolled`);
const logs = (query = "") => admin.ok("GET", `/nodes/${node.id}/logs?limit=200${query}`);
const findSite = async () =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(HOST)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(HOST),
  );

async function cleanup() {
  const site = await findSite();
  if (site) await admin.ok("DELETE", `/sites/${site.id}`);
  await rm(STATE, { force: true });
  pass(`node logs cleanup: ${site ? 1 : 0} site removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

// ------------------------------------------------------------------ a. events
await waitFor("node-logs-v1", async () =>
  (await admin.ok("GET", `/nodes/${node.id}`)).supportedFeatures.includes("node-logs-v1"),
);
const events = await waitFor(
  "config_applied and engine_started",
  async () => {
    const page = await logs("&minLevel=info");
    const applied = page.entries.find((e) => e.event === "config_applied");
    const engine = page.entries.find((e) => e.event === "engine_started");
    return applied && engine ? { applied, engine, page } : null;
  },
  60,
);
assert.equal(events.page.supported, true);
assert.equal(events.applied.source, "agent");
assert.equal(events.applied.level, "info");
assert.match(events.applied.fields.revision ?? "", /^\d+$/);
assert.equal(events.engine.source, "supervisor");
pass("the node reports node-logs-v1 with the agent's and the supervisor's events");

// ------------------------------------------------------- b. a known warning
const old = await findSite();
if (old) await admin.ok("DELETE", `/sites/${old.id}`);
const { site } = await admin.ok("POST", "/sites", {
  name: "node-logs-e2e",
  domains: [HOST],
  origins: [{ address: ORIGIN, port: 80 }],
  clusterId: node.clusterId,
});
const latest = (await admin.ok("GET", `/clusters/${node.clusterId}`)).latestRevision.revision;
await waitFor(`${NODE} applied #${latest}`, async () => {
  const n = await admin.ok("GET", `/nodes/${node.id}`);
  return n.online && n.applyState === "applied" && n.appliedRevision >= latest;
});
const started = Date.now();
const statuses = [];
for (let i = 0; i < 6; i++)
  statuses.push(await get(`/probe/${i}?token=${SECRET}&X-Amz-Signature=${SIGNATURE}`));
assert.ok(
  statuses.every((s) => s >= 500),
  `requests to an origin that does not resolve: ${statuses}`,
);
let lastPage;
const warning = await waitFor(
  "the origin's warning in the node log",
  async () => {
    lastPage = await logs("&source=lua&minLevel=warn");
    return lastPage.entries.find(
      (e) => e.message.includes(`of site ${site.id} marked down`) && e.fields.host === HOST,
    );
  },
  60,
  1000,
  () => JSON.stringify(lastPage?.entries.slice(0, 3)),
);
const seconds = (Date.now() - started) / 1000;
assert.equal(warning.level, "warn");
assert.equal(warning.kind, "entry");
assert.match(warning.message, new RegExp(`could not be resolved|${ORIGIN}`));
assert.match(warning.fields.request ?? "", /^GET \/probe\/\d\?\[redacted\] HTTP\/1\.1$/);
assert.ok(warning.fields.client, "client address kept");
pass(`the Lua warning arrived in ${seconds.toFixed(1)} s with its query string removed`);

for (const query of [
  "",
  "&source=lua",
  "&minLevel=warn",
  `&q=${encodeURIComponent("marked down")}`,
]) {
  const text = JSON.stringify(await logs(query));
  assert.ok(!text.includes(SECRET) && !text.includes(SIGNATURE), `secret in the API (${query})`);
}
const stored = await psql(
  `select count(*) from node_log_entry where message like '%${SECRET}%' or fields::text like '%${SECRET}%' or message like '%${SIGNATURE}%' or fields::text like '%${SIGNATURE}%'`,
);
assert.equal(stored, "0", "secrets stored in node_log_entry");
// The filters find it.
assert.ok(
  (await logs(`&q=${encodeURIComponent("MARKED DOWN")}`)).entries.some((e) => e.id === warning.id),
);
assert.ok((await logs("&minLevel=error")).entries.every((e) => e.level === "error"));
pass("no secret in the API or the database; the filters find the warning");

await writeFile(
  STATE,
  JSON.stringify({ nodeId: node.id, clusterId: node.clusterId, siteId: site.id, secret: SECRET }),
);

// ------------------------------------------------------------- d. debug logs
assert.ok(
  (await admin.ok("GET", `/nodes/${node.id}`)).supportedFeatures.includes("debug-logs-v1"),
  "the node reports debug-logs-v1",
);
const pullAndWait = async (body) => {
  const pull = await admin.ok("POST", `/nodes/${node.id}/debug-logs`, body);
  assert.equal(pull.state, "pending");
  return waitFor(
    "the debug log pull",
    async () => {
      const got = await admin.ok("GET", `/nodes/${node.id}/debug-logs/${pull.id}`);
      return got.state === "succeeded" || got.state === "failed" ? got : null;
    },
    60,
  );
};
const pulledAt = Date.now();
const debug = await pullAndWait({ from: new Date(started - 60_000).toISOString() });
assert.equal(
  debug.state,
  "succeeded",
  `pull: ${debug.errorCode} ${JSON.stringify(debug.errorParams)}`,
);
assert.equal(debug.entryCount, debug.entries.length);
assert.equal(debug.supervisorMissing, false);
assert.ok(
  debug.entries.some(
    (e) => e.level === "debug" && e.source === "agent" && e.message === "status reported",
  ),
  "the agent's debug records",
);
const debugWarning = debug.entries.find(
  (e) => e.source === "lua" && e.message.includes(`of site ${site.id} marked down`),
);
assert.ok(debugWarning, "the Lua warning in the debug logs");
assert.match(debugWarning.fields.request ?? "", /^GET \/probe\/\d\?\[redacted\] HTTP\/1\.1$/);
const debugText =
  JSON.stringify(await admin.ok("GET", `/nodes/${node.id}/debug-logs`)) + JSON.stringify(debug);
assert.ok(
  !debugText.includes(SECRET) && !debugText.includes(SIGNATURE),
  "secret in the debug logs",
);
assert.equal(
  await psql(
    `select count(*) from node_debug_log where entries::text like '%${SECRET}%' or entries::text like '%${SIGNATURE}%'`,
  ),
  "0",
  "secrets stored in node_debug_log",
);
const empty = await pullAndWait({ components: ["no-such-component"] });
assert.equal(empty.state, "succeeded");
assert.equal(empty.entryCount, 0);
assert.ok(
  Number(await psql(`select count(*) from audit_log where action = 'node.debug_logs_pull'`)) >= 2,
  "debug log pulls audited",
);
pass(
  `debug logs pulled in ${((Date.now() - pulledAt) / 1000).toFixed(1)} s: ${debug.entryCount} entries, no secrets`,
);

// ---------------------------------------------------------------- c. retention
const saved = await admin.ok("GET", "/settings/node-log-retention");
assert.deepEqual(saved, { days: 7, perNode: 10000 });
assert.equal(
  (await admin.call("PUT", "/settings/node-log-retention", { days: 31, perNode: 10000 })).status,
  400,
);
await admin.ok("PUT", "/settings/node-log-retention", { days: 1, perNode: 1000 });
// 1,100 rows from an hour ago and two from two days ago, in batches no node uses.
await psql(`
  insert into node_log_entry (node_id, sequence, idx, time, level, source, message)
  select '${node.id}', 9000000000000, g, now() - interval '1 hour' + g * interval '1 ms', 'warn', 'agent', 'e2e bulk ' || g
  from generate_series(1, 1100) g;
  insert into node_log_entry (node_id, sequence, idx, time, level, source, message)
  values ('${node.id}', 9000000000001, 0, now() - interval '2 days', 'warn', 'agent', 'e2e backdated'),
         ('${node.id}', 9000000000001, 1, now() - interval '2 days', 'warn', 'agent', 'e2e backdated')`);
const count = async () =>
  Number(await psql(`select count(*) from node_log_entry where node_id = '${node.id}'`));
assert.ok((await count()) > 1100);
await run([...compose, "restart", "console"]);
await waitFor("console back", async () => {
  try {
    return (await fetch(`${base}/api/v1/nodes/${node.id}`)).status === 401;
  } catch {
    return false;
  }
});
await waitFor(
  "prune at the console's start",
  async () => (await count()) <= 1000,
  120,
  2000,
  () => `${NODE} has rows`,
);
assert.equal(
  await psql(`select count(*) from node_log_entry where message = 'e2e backdated'`),
  "0",
);
assert.equal(
  await psql(
    `select count(*) from node_log_entry where node_id = '${node.id}' and message = 'e2e bulk 1100'`,
  ),
  "1",
  "the newest bulk row stays",
);
assert.equal(
  await psql(`select count(*) from node_log_entry where message = 'e2e bulk 1'`),
  "0",
  "the oldest bulk row goes",
);
// The warning of b is newer than every bulk row.
const after = await logs("&source=lua");
assert.ok(
  after.entries.some((e) => e.id === warning.id),
  "the newest entries stay",
);
const audit = await psql(
  `select count(*) from audit_log where action = 'system.node_log_retention_update'`,
);
assert.ok(Number(audit) >= 1, "retention change audited");
await admin.ok("PUT", "/settings/node-log-retention", saved);
pass("retention: backdated rows and rows over 1,000 per node deleted at the console's start");
