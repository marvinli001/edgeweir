// Core gaps G1 end to end (dynamic bans and kernel bans), after the P0 step.
// Both nodes of the upgrade cluster serve the P0 site (X, organization
// "P0 Org") and the M5 site (Y, another organization). client-a and
// client-b sit on the default network and reach `node` by its container
// address, so the node sees their own addresses:
//   a. both nodes report bans-v1 and kernel-ban-v1
//   c. a site ban answers 403 ip-banned to client-a on X only: client-a
//      still gets 200 from Y, client-b from X
//   f. every node applies the ban's sequence (and the unban's) and holds it
//      (unapplied 0)
//   b. delivery latency: bans and unbans, from the API response until
//      client-a sees the effect; p95 <= 5 s
//   d. a platform ban drops client-a in nftables (TCP connect times out,
//      no refusal, no 403) while client-b is served; kernelEntries >= 1; the
//      unban lets client-a back in
//   e. short prefixes, protected addresses, tenants on /admin/bans, sites
//      of other organizations and maxBans are refused
// Every ban is lifted at the end.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ban + unban rounds of the latency test; each round gives two samples. */
const ROUNDS = 20;
const P95_LIMIT_MS = 5000;

async function waitFor(label, fn, seconds = 180, interval = 1000, detail = () => "") {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  const why = detail();
  throw new Error(`timeout: ${label}${why ? ` (last: ${why})` : ""}`);
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

async function createKey(cookie) {
  const created = await fetch(`${base}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify({ name: "g1-e2e" }),
  });
  assert.equal(created.status, 200);
  return (await created.json()).key;
}

/**
 * A signed-in user with an AccessKey. An AccessKey allows 600 requests until
 * it has been idle for 60 seconds; the polling below runs longer than that,
 * so every 500 calls move to a fresh key.
 */
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
  const user = { cookie, key: await createKey(cookie) };
  let calls = 0;
  user.raw = async (method, path, body) => {
    if (++calls % 500 === 0) user.key = await createKey(user.cookie);
    return call(user.key, method, path, body);
  };
  user.ok = async (method, path, body) => {
    const result = await user.raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  return user;
}

/** Asserts an error response: status, code and (optionally) its data. */
function refused(result, status, code, data) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.code, code, result.text);
  if (data !== undefined) assert.deepEqual(result.json.data, data, result.text);
  return result.json;
}

/** GET through the real edge node (host port, not a banned address), returns the status. */
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

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};
const containerIp = async (service) => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const network = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert.ok(network, `${service} has no default network`);
  return network[1].IPAddress;
};

// Runs inside a client container (node:24-alpine) and answers one JSON line
// per command. Every HTTP request opens its own connection (agent: false).
//   {op:"get", host, target?, timeoutMs}      -> {status, error} | {failure}
//   {op:"connect", target?, timeoutMs}        -> {connect: "connected" | "timeout" | "refused" | code}
//   {op:"until", host, status, error?, timeoutMs, intervalMs, requestTimeoutMs}
//                                             -> {ok, attempts, last}
const PROBE = String.raw`
const http = require("node:http");
const net = require("node:net");
const readline = require("node:readline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(target, host, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.get(
      { host: target, port: 80, path: "/g1-probe", headers: { host }, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => finish({ status: res.statusCode, error: res.headers["x-edgeweir-error"] || null }));
        res.on("error", (e) => finish({ failure: e.code || e.message }));
      },
    );
    timer = setTimeout(() => {
      finish({ failure: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", (e) => finish({ failure: e.code === "ECONNREFUSED" ? "refused" : e.code || e.message }));
  });
}
function connect(target, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target, port: 80 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      resolve(e.code === "ECONNREFUSED" ? "refused" : e.code || e.message);
    });
  });
}
async function until(c) {
  const deadline = Date.now() + c.timeoutMs;
  let attempts = 0;
  for (;;) {
    const started = Date.now();
    attempts++;
    const last = await get(c.target, c.host, c.requestTimeoutMs);
    if (last.status === c.status && (c.error === undefined || last.error === c.error))
      return { ok: true, attempts, last };
    if (Date.now() >= deadline) return { ok: false, attempts, last };
    await sleep(Math.max(0, c.intervalMs - (Date.now() - started)));
  }
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const c = JSON.parse(line);
  c.target = c.target || process.env.TARGET;
  const result =
    c.op === "get"
      ? await get(c.target, c.host, c.timeoutMs)
      : c.op === "connect"
        ? { connect: await connect(c.target, c.timeoutMs) }
        : await until(c);
  process.stdout.write(JSON.stringify({ id: c.id, ...result }) + "\n");
});
lines.on("close", () => process.exit(0));
`;

/** A long-running probe inside a client container (docker exec), aimed at `target` by default. */
async function probe(service, target) {
  const child = spawn(
    "docker",
    ["exec", "-i", "-e", `TARGET=${target}`, await containerId(service), "node", "-e", PROBE],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdin.on("error", () => {});
  const waiting = new Map();
  let next = 0;
  let exited = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  child.on("exit", (code) => {
    exited = { exited: code };
    for (const resolve of waiting.values()) resolve(exited);
    waiting.clear();
  });
  const send = (command) =>
    new Promise((resolve) => {
      if (exited) return resolve(exited);
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  return {
    name: service,
    get: (host, { timeoutMs = 3000, target: to } = {}) =>
      send({ op: "get", host, target: to, timeoutMs }),
    connect: ({ timeoutMs = 3000, target: to } = {}) =>
      send({ op: "connect", target: to, timeoutMs }),
    /** Polls every 100 ms (1 s per request) until the status (and X-Edgeweir-Error) matches. */
    until: (host, want, timeoutMs = 60_000) =>
      send({ op: "until", host, ...want, timeoutMs, intervalMs: 100, requestTimeoutMs: 1000 }),
    close: () => child.stdin.end(),
  };
}

// ---------------------------------------------------------------- setup
const p0 = JSON.parse(await readFile(".e2e/p0-state.json", "utf8"));
const m5 = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const owner = await actor("owner@p0.test", "p0-owner-password-123");
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
const nodes = async () => [await nodeById(edgeId), await nodeById(peerId)];
let lastNodes = [];
const nodeSummary = () =>
  JSON.stringify(
    lastNodes.map((n) => ({
      name: n.name,
      online: n.online,
      features: n.supportedFeatures,
      banStatus: n.banStatus,
    })),
  );
/** Waits until `check` holds for both nodes; returns them. */
const everyNode = (label, check, seconds = 90) =>
  waitFor(
    label,
    async () => {
      lastNodes = await nodes();
      return lastNodes.every(check) ? lastNodes : null;
    },
    seconds,
    1000,
    nodeSummary,
  );
const appliedAtLeast = (seq) => (n) =>
  !!n.banStatus && BigInt(n.banStatus.appliedSequence) >= BigInt(seq);

await everyNode(
  "nodes online on their target revision",
  (n) =>
    n.online &&
    n.dataPlaneHealthy &&
    n.applyState === "applied" &&
    n.appliedRevision >= (n.targetRevision ?? 0),
  180,
);

/** Lifts every active ban (admin view covers all scopes and organizations). */
async function clearBans() {
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const page = await admin.ok("GET", "/admin/bans?pageSize=100");
    if (page.items.length === 0) return removed;
    for (const ban of page.items) {
      const result = await admin.raw("DELETE", `/admin/bans/${ban.id}`);
      assert.ok(result.status === 200 || result.status === 404, result.text);
      removed++;
    }
  }
  throw new Error("bans keep appearing");
}
const leftovers = await clearBans();

// Site X (P0 Org, the tenant owner's) and site Y (M5's organization), same cluster.
const siteX = await owner.ok("GET", `/sites/${p0.siteId}`);
const siteY = await admin.ok("GET", `/sites/${m5.siteId}`);
assert.equal(siteX.organizationId, p0.organizationId);
assert.notEqual(siteY.organizationId, siteX.organizationId);
assert.equal(siteY.clusterId, siteX.clusterId, "X and Y must be served by the same nodes");
for (const site of [siteX, siteY]) assert.ok(site.enabled && !site.suspended, site.name);
const hostX = siteX.domains[0];
const hostY = siteY.domains[0];
assert.ok(hostX && hostY);

const edgeIp = await containerIp("node");
const peerIp = await containerIp("node-upgrade-peer");
const clientA = await containerIp("client-a");
const clientB = await containerIp("client-b");
const a = await probe("client-a", edgeIp);
const b = await probe("client-b", edgeIp);
console.log(
  `node ${edgeIp}, peer ${peerIp}, client-a ${clientA}, client-b ${clientB}; X ${hostX} (${siteX.name}), Y ${hostY} (${siteY.name}); ${leftovers} leftover ban(s) lifted`,
);

async function served(client, host, target) {
  const result = await client.get(host, { target });
  assert.equal(result.status, 200, `${client.name} -> ${host}: ${JSON.stringify(result)}`);
}
async function banned(client, host, target) {
  const result = await client.get(host, { target });
  assert.equal(result.status, 403, `${client.name} -> ${host}: ${JSON.stringify(result)}`);
  assert.equal(result.error, "ip-banned", `${client.name} -> ${host}: ${JSON.stringify(result)}`);
}
/** Waits (polling from the client) until the host answers 200, e.g. once an unban arrived. */
async function servedSoon(client, host, target) {
  const result = await client.until(host, { status: 200, target });
  assert.ok(result.ok, `${client.name} -> ${host}: ${JSON.stringify(result)}`);
}
/** Waits (polling from the client) until the host answers 403 ip-banned. */
async function bannedSoon(client, host, target) {
  const result = await client.until(host, { status: 403, error: "ip-banned", target });
  assert.ok(result.ok, `${client.name} -> ${host}: ${JSON.stringify(result)}`);
}

let finished = false;
try {
  for (const client of [a, b]) for (const host of [hostX, hostY]) await servedSoon(client, host);

  // -------------------------------------------------------------- a. capabilities
  const featured = await everyNode(
    "both nodes report bans-v1 and kernel-ban-v1",
    (n) =>
      n.online &&
      n.supportedFeatures.includes("bans-v1") &&
      n.supportedFeatures.includes("kernel-ban-v1") &&
      !!n.banStatus,
  );
  assert.ok(featured[0].ipAddresses.includes(edgeIp), JSON.stringify(featured[0].ipAddresses));
  pass(
    `${featured.map((n) => `${n.name} (capacity ${n.banStatus.capacity}, kernel entries ${n.banStatus.kernelEntries})`).join(" and ")} report bans-v1 and kernel-ban-v1`,
  );

  // -------------------------------------------------------------- c. site ban
  const siteBan = await owner.ok("POST", "/bans", {
    siteId: siteX.id,
    cidr: clientA,
    reason: "abuse",
    durationSeconds: 3600,
  });
  assert.equal(siteBan.cidr, `${clientA}/32`);
  assert.equal(siteBan.scope, "site");
  assert.equal(siteBan.source, "manual");
  assert.equal(siteBan.siteId, siteX.id);
  assert.equal(siteBan.organizationId, siteX.organizationId);
  assert.equal(siteBan.distributed, true);
  assert.equal(
    Math.round((Date.parse(siteBan.expiresAt) - Date.parse(siteBan.createdAt)) / 1000),
    3600,
  );
  await bannedSoon(a, hostX);
  await banned(a, hostX);
  await served(a, hostY);
  await served(b, hostX);
  assert.equal(await edge(hostX, "/g1-host"), 200);
  // The peer holds the same site ban.
  await bannedSoon(a, hostX, peerIp);
  await served(a, hostY, peerIp);
  await served(b, hostX, peerIp);
  pass(
    `site ban ${siteBan.cidr} on ${hostX}: client-a gets 403 ip-banned from both nodes, 200 from ${hostY}; client-b and other addresses get 200 from ${hostX}`,
  );

  // -------------------------------------------------------------- f. sequence and status
  const applied = await everyNode(
    `nodes apply ban sequence ${siteBan.seq}`,
    (n) =>
      appliedAtLeast(siteBan.seq)(n) &&
      n.banStatus.unapplied === 0 &&
      n.banStatus.unappliedIds.length === 0 &&
      n.banStatus.entries >= 1,
  );
  const listed = (await admin.ok("GET", `/admin/bans?siteId=${siteX.id}`)).items.find(
    (x) => x.id === siteBan.id,
  );
  assert.equal(listed?.unappliedNodes, 0, JSON.stringify(listed));
  assert.ok((await owner.ok("GET", "/bans")).items.some((x) => x.id === siteBan.id));
  await owner.ok("DELETE", `/bans/${siteBan.id}`);
  await servedSoon(a, hostX);
  await servedSoon(a, hostX, peerIp);
  const removedSeq = await psql(
    `select seq::text from ip_ban where id = '${siteBan.id}' and removed_at is not null`,
  );
  assert.ok(BigInt(removedSeq) > BigInt(siteBan.seq), `removal sequence ${removedSeq}`);
  await everyNode(
    `nodes apply the unban (sequence ${removedSeq})`,
    (n) => appliedAtLeast(removedSeq)(n) && n.banStatus.unapplied === 0,
  );
  pass(
    `ban sequence ${siteBan.seq} and unban ${removedSeq} applied by ${applied.map((n) => `${n.name} (${n.banStatus.entries} entries)`).join(", ")}; 0 unapplied`,
  );

  // -------------------------------------------------------------- b. delivery latency
  const samples = { ban: [], unban: [] };
  for (let round = 1; round <= ROUNDS; round++) {
    const ban = await owner.ok("POST", "/bans", {
      siteId: siteX.id,
      cidr: clientA,
      reason: "attack",
      durationSeconds: 600,
    });
    let started = performance.now();
    const on = await a.until(hostX, { status: 403, error: "ip-banned" });
    samples.ban.push(performance.now() - started);
    assert.ok(on.ok, `round ${round}: the ban never reached client-a: ${JSON.stringify(on)}`);
    await owner.ok("DELETE", `/bans/${ban.id}`);
    started = performance.now();
    const off = await a.until(hostX, { status: 200 });
    samples.unban.push(performance.now() - started);
    assert.ok(off.ok, `round ${round}: the unban never reached client-a: ${JSON.stringify(off)}`);
  }
  const percentile = (values, p) => {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    ];
  };
  const ms = (value) => `${Math.round(value)} ms`;
  const stats = (values) =>
    `p50 ${ms(percentile(values, 50))}, p95 ${ms(percentile(values, 95))}, max ${ms(Math.max(...values))}`;
  const all = [...samples.ban, ...samples.unban];
  console.log(`ban   (${samples.ban.length}): ${stats(samples.ban)}`);
  console.log(`unban (${samples.unban.length}): ${stats(samples.unban)}`);
  assert.ok(
    percentile(all, 95) <= P95_LIMIT_MS,
    `delivery p95 ${ms(percentile(all, 95))} exceeds ${P95_LIMIT_MS} ms (${stats(all)})`,
  );
  pass(
    `delivery latency over ${all.length} samples (${ROUNDS} bans, ${ROUNDS} unbans; API response -> client-a sees 403 / 200): ${stats(all)} (p95 <= ${P95_LIMIT_MS} ms)`,
  );

  // -------------------------------------------------------------- d. platform ban in the kernel
  await served(a, hostX);
  const platformBan = await admin.ok("POST", "/admin/bans", {
    scope: "platform",
    cidr: clientA,
    reason: "attack",
    durationSeconds: 3600,
  });
  const platformAt = performance.now();
  assert.equal(platformBan.scope, "platform");
  assert.equal(platformBan.cidr, `${clientA}/32`);
  assert.equal(platformBan.siteId, null);
  assert.equal(platformBan.organizationId, null);
  let droppedAfter = 0;
  const attempts = [];
  await waitFor(
    "the kernel drops client-a",
    async () => {
      const started = performance.now();
      const result = await a.connect({ timeoutMs: 3000 });
      attempts.push(result.connect);
      if (result.connect === "timeout") {
        droppedAfter = started - platformAt;
        return true;
      }
      // Until nftables has it, the connection opens (and L7 answers 403); never a refusal.
      assert.equal(result.connect, "connected", JSON.stringify(result));
      return false;
    },
    60,
    200,
    () => attempts.join(","),
  );
  assert.equal((await a.connect({ timeoutMs: 3000 })).connect, "timeout");
  const dropped = await a.get(hostX, { timeoutMs: 3000 });
  assert.equal(dropped.failure, "timeout", `client-a -> ${hostX}: ${JSON.stringify(dropped)}`);
  const kernel = await everyNode(
    "nodes hold the platform ban in nftables",
    (n) =>
      appliedAtLeast(platformBan.seq)(n) &&
      n.banStatus.kernelEntries >= 1 &&
      n.banStatus.unapplied === 0,
  );
  // Reported after the nftables sync, so the peer drops client-a too.
  assert.equal((await a.connect({ timeoutMs: 3000, target: peerIp })).connect, "timeout");
  for (const host of [hostX, hostY]) {
    await served(b, host);
    await served(b, host, peerIp);
  }
  assert.equal(await edge(hostX, "/g1-host"), 200);
  // Tenants neither see nor lift platform bans.
  assert.ok(!(await owner.ok("GET", "/bans")).items.some((x) => x.id === platformBan.id));
  refused(await owner.raw("DELETE", `/bans/${platformBan.id}`), 404, "BAN_NOT_FOUND");
  assert.ok(
    (await admin.ok("GET", "/admin/bans?scope=platform")).items.some(
      (x) => x.id === platformBan.id,
    ),
  );
  await admin.ok("DELETE", `/admin/bans/${platformBan.id}`);
  const liftedAt = performance.now();
  const back = await a.until(hostX, { status: 200 });
  assert.ok(back.ok, `client-a still dropped after the unban: ${JSON.stringify(back)}`);
  const backAfter = performance.now() - liftedAt;
  assert.equal((await a.connect({ timeoutMs: 3000 })).connect, "connected");
  await served(a, hostY);
  await servedSoon(a, hostX, peerIp);
  await everyNode("nftables is empty again", (n) => n.banStatus?.kernelEntries === 0);
  pass(
    `platform ban ${platformBan.cidr}: TCP connect from client-a times out on both nodes (${ms(droppedAfter)} after the API answered; ${attempts.length} attempt(s)), client-b gets 200 from X and Y; kernel entries ${kernel.map((n) => n.banStatus.kernelEntries).join("/")}; unban: client-a gets 200 again after ${ms(backAfter)}`,
  );

  // -------------------------------------------------------------- e. refusals
  refused(
    await admin.raw("POST", "/admin/bans", {
      scope: "platform",
      cidr: "10.0.0.0/8",
      reason: "attack",
      durationSeconds: 3600,
    }),
    400,
    "BAN_PREFIX_TOO_SHORT",
    { min: 16 },
  );
  refused(
    await owner.raw("POST", "/bans", {
      siteId: siteX.id,
      cidr: "2001:db8::/32",
      reason: "attack",
      durationSeconds: 3600,
    }),
    400,
    "BAN_PREFIX_TOO_SHORT",
    { min: 48 },
  );
  refused(
    await admin.raw("POST", "/admin/bans", {
      scope: "platform",
      cidr: edgeIp,
      reason: "attack",
      durationSeconds: 3600,
    }),
    400,
    "BAN_PROTECTED_ADDRESS",
    { address: edgeIp },
  );
  const net24 = edgeIp.split(".").slice(0, 3).join(".");
  const subnet = `${net24}.0/24`;
  const covered = refused(
    await owner.raw("POST", "/bans", {
      siteId: siteX.id,
      cidr: subnet,
      reason: "attack",
      durationSeconds: 3600,
    }),
    400,
    "BAN_PROTECTED_ADDRESS",
  );
  assert.ok(covered.data.address.startsWith(`${net24}.`), covered.data.address);
  refused(
    await admin.raw("POST", "/admin/bans", {
      scope: "platform",
      cidr: "127.0.0.1",
      reason: "attack",
      durationSeconds: 3600,
    }),
    400,
    "BAN_PROTECTED_ADDRESS",
    { address: "127.0.0.0/8" },
  );
  refused(
    await owner.raw("POST", "/bans", {
      siteId: siteX.id,
      cidr: "198.51.100.1",
      reason: "attack",
      durationSeconds: 30,
    }),
    400,
    "BAN_EXPIRY_OUT_OF_RANGE",
  );
  pass(
    `refused: /8 and IPv6 /32 (BAN_PREFIX_TOO_SHORT /16, /48), the node ${edgeIp}, ${subnet} (covers ${covered.data.address}) and 127.0.0.1 (BAN_PROTECTED_ADDRESS), 30 s (BAN_EXPIRY_OUT_OF_RANGE)`,
  );

  const platformInput = {
    scope: "platform",
    cidr: "198.51.100.30",
    reason: "other",
    durationSeconds: 3600,
  };
  assert.equal((await owner.raw("POST", "/admin/bans", platformInput)).status, 403);
  assert.equal((await owner.raw("GET", "/admin/bans")).status, 403);
  const tenantRpc = await fetch(`${base}/rpc/admin/bans/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "orpc",
      origin: base,
      cookie: owner.cookie,
    },
    body: JSON.stringify({ json: platformInput }),
  });
  assert.equal(tenantRpc.status, 403, await tenantRpc.text());
  refused(
    await owner.raw("POST", "/bans", {
      siteId: siteY.id,
      cidr: "198.51.100.31",
      reason: "abuse",
      durationSeconds: 3600,
    }),
    404,
    "SITE_NOT_FOUND",
  );
  // A ban on another organization's site stays out of the tenant's reach.
  const foreign = await admin.ok("POST", "/admin/bans", {
    scope: "site",
    siteId: siteY.id,
    cidr: "198.51.100.32",
    reason: "scanner",
    durationSeconds: 3600,
  });
  assert.equal(foreign.organizationId, siteY.organizationId);
  assert.ok(!(await owner.ok("GET", "/bans")).items.some((x) => x.id === foreign.id));
  refused(await owner.raw("DELETE", `/bans/${foreign.id}`), 404, "BAN_NOT_FOUND");
  await admin.ok("DELETE", `/admin/bans/${foreign.id}`);
  assert.equal((await admin.ok("GET", "/admin/bans")).total, 0, "a refused request left a ban");
  pass(
    `tenant AccessKey and session on /admin/bans: 403; a ban on another organization's site: SITE_NOT_FOUND; another organization's ban: invisible, BAN_NOT_FOUND`,
  );

  const limitsPath = `/admin/organizations/${siteX.organizationId}/limits`;
  const before = await admin.ok("GET", limitsPath);
  try {
    await admin.ok("PUT", limitsPath, { limits: { ...before.limits, bans: 1 } });
    const input = {
      siteId: siteX.id,
      cidr: "198.51.100.10",
      reason: "spam",
      durationSeconds: 3600,
    };
    const first = await owner.ok("POST", "/bans", input);
    refused(
      await owner.raw("POST", "/bans", { ...input, cidr: "198.51.100.11" }),
      409,
      "ORG_LIMIT_EXCEEDED",
      { resource: "bans", limit: 1, current: 1 },
    );
    // Banning the same address again renews it and does not count twice.
    const renewed = await owner.ok("POST", "/bans", {
      ...input,
      reason: "abuse",
      durationSeconds: 7200,
    });
    assert.equal(renewed.id, first.id);
    assert.equal(renewed.reason, "abuse");
    assert.ok(BigInt(renewed.seq) > BigInt(first.seq));
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt));
    assert.equal((await admin.ok("GET", limitsPath)).usage.bans, 1);
    // Platform bans do not count against organizations.
    const platform = await admin.ok("POST", "/admin/bans", platformInput);
    await admin.ok("DELETE", `/admin/bans/${platform.id}`);
    await owner.ok("DELETE", `/bans/${first.id}`);
    assert.equal((await admin.ok("GET", limitsPath)).usage.bans, 0);
  } finally {
    await admin.ok("PUT", limitsPath, { limits: before.limits });
  }
  assert.deepEqual((await admin.ok("GET", limitsPath)).limits, before.limits);
  pass(
    `maxBans=1: the second ban is refused (409 ORG_LIMIT_EXCEEDED bans 1/1), banning the same address again renews it; limits restored`,
  );

  // -------------------------------------------------------------- cleanup
  const lastLifted = await clearBans();
  assert.equal((await admin.ok("GET", "/admin/bans")).total, 0);
  for (const host of [hostX, hostY]) {
    await servedSoon(a, host);
    await servedSoon(b, host);
  }
  pass(`every ban lifted (${lastLifted} left at the end); both clients get 200 from X and Y`);
  finished = true;
} finally {
  a.close();
  b.close();
  if (!finished) await clearBans().catch((error) => console.error(`cleanup: ${error.message}`));
}

await writeFile(
  ".e2e/g1-state.json",
  `${JSON.stringify(
    {
      siteId: siteX.id,
      siteName: siteX.name,
      organizationId: siteX.organizationId,
      organizationName: siteX.organizationName,
    },
    null,
    2,
  )}\n`,
);
console.log("G1 E2E OK");
