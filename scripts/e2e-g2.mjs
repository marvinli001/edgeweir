// Core gaps G2 end to end (challenges, Under Attack, tiered CC, JA4), after
// the G1 step. Both nodes of the default cluster (`node` and
// `node-upgrade-peer`) serve the sites below. The host reaches `node` through
// its published ports, so the node sees the default network's gateway, in
// the same /24 as client-a and client-b; client-c sits on the isolated
// network only (another /24).
//   a. a headless Chromium passes the js and then the pow challenge of an
//      Under Attack site (ua.g2.test -> whoami), ends on the origin and holds
//      an HttpOnly __ew_pass bound to the site, the /24 and its User-Agent
//   b. the other node accepts that pass from client-a (same /24, same
//      User-Agent); client-c, another User-Agent, a lower level and forged
//      or tampered passes are challenged again; POST without a pass gets 403
//      X-Edgeweir-Challenge: required; /.edgeweir/<other> is 404 at the edge
//      and never reaches the origin (access log of the files origin)
//   e. an allow rule exempts a path from Under Attack; a challenge rule (pow
//      on /login) challenges only that path; platform Under Attack
//      challenges a site without its own and is turned off again; a pass
//      lives as long as the site says (Max-Age) and its token is redeemed once
//   c. CC on the bench site: ~35 req/s from client-a on one path (urlQps 20)
//      escalates that path only (client-b is challenged there and served
//      elsewhere; the node and the console show the escalated path, a
//      path_level event and no site_level one); a flood over ipQps 50 bans
//      client-a (403 ip-banned, auto ban cc_ip_rate shared with the peer,
//      ip_banned event) while client-b is served; the ban is lifted, CC off
//   d. JA4 over the M3 HTTPS site: logJa4 and full sampling give the JA4 of
//      curl and of Node's TLS client from the node's sampled logs; a block
//      rule on curl's JA4 answers 403 to curl and 200 to Node, a challenge
//      rule on Node's JA4 challenges Node only, a rate limit keyed by
//      tls.ja4 counts each client apart; rules, sampling and JA4 restored
// Everything is cleaned up except the bench site ua-bench.test (whoami,
// cache rule on /, Under Attack js, no CC, no rules), which scripts/bench.sh
// uses for BENCH_SCENARIO=pass|challenge; .e2e/g2-state.json names it for
// apps/console/e2e/g2.spec.ts.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const { chromium } = createRequire(resolve("apps/console/package.json"))("@playwright/test");
const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const tlsPort = Number(process.env.E2E_NODE_TLS_PORT ?? 18443);
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const HOST_UA = "ua.g2.test";
const HOST_FILES = "files.g2.test";
const HOST_BENCH = "ua-bench.test";
const M3_HOST = "https.m3.test";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) edgeweir-e2e-g2 HeadlessChrome";
const CLIENT_UA = "edgeweir-e2e-g2-client";
const PASS_TTL = 600;
const POW_BITS = 14;
/** CC policy of part c; thresholds are per node. */
const CC = {
  enabled: true,
  followTemplate: false,
  maxLevel: "js",
  highPowInsteadOfCaptcha: false,
  windowSeconds: 5,
  siteQps: 0,
  urlQps: 20,
  ipQps: 50,
  ipBanSeconds: 600,
  originErrorPercent: 0,
  originErrorMinRequests: 0,
  escalateAfterSeconds: 2,
  cooldownSeconds: 10,
};
/** Requests per second of the path load: over urlQps, well under ipQps. */
const LOAD_QPS = 35;

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
async function call(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
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
    body: JSON.stringify({ name: "g2-e2e" }),
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

/** A request from the host to the edge node's HTTP port: { status, headers, body }. */
function edge(host, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: edgePort,
        path,
        method,
        headers: { host, ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("edge timeout")));
    req.end(body);
  });
}
const challengeOf = (r) => r.headers["x-edgeweir-challenge"] ?? null;
const passCookie = (r) =>
  [r.headers["set-cookie"] ?? []]
    .flat()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("__ew_pass="))
    ?.slice("__ew_pass=".length) ?? null;

/** Fields of a pass cookie value (v1.<kid>.<payload>.<signature>). */
function passFields(value) {
  const [version, kid, payload, signature] = value.split(".");
  const [site, level, prefix, ua, iat, exp] = Buffer.from(payload, "base64url")
    .toString("utf8")
    .split("|");
  return {
    version,
    kid,
    payload,
    signature,
    site,
    level: Number(level),
    prefix,
    ua,
    iat: Number(iat),
    exp: Number(exp),
  };
}

/** Solves a js challenge from the host: the page's token, sha256 hex, verify. */
async function solveJs(host, path, ua) {
  const page = await edge(host, path, { headers: { "user-agent": ua } });
  assert.equal(page.status, 403, page.body.slice(0, 200));
  assert.equal(challengeOf(page), "js");
  const token = /name="t" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(token, "no token on the js page");
  const form = new URLSearchParams({ t: token, a: sha256(token), r: path }).toString();
  const verify = () =>
    edge(host, "/.edgeweir/challenge/verify", {
      method: "POST",
      headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  return { page, token, verified: await verify(), again: verify };
}

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};
const containerIp = async (service, network = "_default") => {
  const info = JSON.parse(await run(["inspect", await containerId(service)]))[0];
  const found = Object.entries(info.NetworkSettings.Networks).find(([name]) =>
    name.endsWith(network),
  );
  assert.ok(found, `${service} is not on the ${network.slice(1)} network`);
  return found[1].IPAddress;
};
const withoutIds = (rules) => rules.map(({ id: _id, ...rule }) => rule);
const prefix24 = (ip) => ip.split(".").slice(0, 3).join(".");

/** The data plane's challenge and CC state of `node` (edgeweir-node security). */
async function nodeSecurity() {
  return JSON.parse(await run([...compose, "exec", "-T", "node", "edgeweir-node", "security"]));
}

// Runs inside a client container (node:24-alpine) and answers one JSON line
// per command; every request opens its own connection unless an agent is used.
//   {op:"req", host, path, method?, headers?, data?, target?}
//        -> {status, headers, body} | {failure}
//   {op:"load", name, host, path, qps, durationMs, headers?}
//        steady rate until durationMs or {op:"stop", name} -> {sent, counts}
//   {op:"flood", host, path, concurrency, max, headers?}
//        as fast as possible until 403 ip-banned or max -> {sent, counts, banned, ms}
const PROBE = String.raw`
const http = require("node:http");
const readline = require("node:readline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Map();
function request(c, agent) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const headers = Object.assign({ host: c.host }, c.headers || {});
    const req = http.request(
      { host: c.target, port: 80, method: c.method || "GET", path: c.path || "/", headers, agent: agent || false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (d) => {
          if (size < 65536) chunks.push(d);
          size += d.length;
        });
        res.on("end", () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8").slice(0, 16384) }));
        res.on("error", (e) => finish({ failure: e.code || e.message }));
      },
    );
    timer = setTimeout(() => {
      finish({ failure: "timeout" });
      req.destroy();
    }, c.timeoutMs || 5000);
    req.on("error", (e) => finish({ failure: e.code === "ECONNREFUSED" ? "refused" : e.code || e.message }));
    req.end(c.data);
  });
}
const key = (r) => (r.status ? r.status + (r.headers["x-edgeweir-error"] ? " " + r.headers["x-edgeweir-error"] : "") + (r.headers["x-edgeweir-challenge"] ? " " + r.headers["x-edgeweir-challenge"] : "") : r.failure);
async function load(c) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const state = { stopped: false };
  running.set(c.name, state);
  const counts = {};
  let sent = 0;
  let pending = 0;
  const end = Date.now() + c.durationMs;
  const interval = 1000 / c.qps;
  let next = Date.now();
  while (!state.stopped && Date.now() < end) {
    sent++;
    pending++;
    request(Object.assign({}, c, { timeoutMs: 3000 }), agent).then((r) => {
      counts[key(r)] = (counts[key(r)] || 0) + 1;
      pending--;
    });
    next += interval;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
  }
  while (pending > 0) await sleep(20);
  agent.destroy();
  running.delete(c.name);
  return { sent, counts };
}
async function flood(c) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: c.concurrency });
  const counts = {};
  let sent = 0;
  let banned = false;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: c.concurrency }, async () => {
      while (!banned && sent < c.max) {
        sent++;
        const r = await request(Object.assign({}, c, { timeoutMs: 3000 }), agent);
        counts[key(r)] = (counts[key(r)] || 0) + 1;
        if (r.status === 403 && r.headers["x-edgeweir-error"] === "ip-banned") banned = true;
      }
    }),
  );
  agent.destroy();
  return { sent, counts, banned, ms: Date.now() - started };
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const c = JSON.parse(line);
  c.target = c.target || process.env.TARGET;
  let result;
  if (c.op === "req") result = await request(c);
  else if (c.op === "load") result = await load(c);
  else if (c.op === "flood") result = await flood(c);
  else if (c.op === "stop") {
    const state = running.get(c.name);
    if (state) state.stopped = true;
    result = { stopped: !!state };
  }
  process.stdout.write(JSON.stringify(Object.assign({ id: c.id }, result)) + "\n");
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
    for (const done of waiting.values()) done(exited);
    waiting.clear();
  });
  const send = (command) =>
    new Promise((done) => {
      if (exited) return done(exited);
      const id = ++next;
      waiting.set(id, done);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  return {
    name: service,
    req: (host, path, options = {}) => send({ op: "req", host, path, ...options }),
    load: (options) => send({ op: "load", ...options }),
    flood: (options) => send({ op: "flood", ...options }),
    stop: (name) => send({ op: "stop", name }),
    close: () => child.stdin.end(),
  };
}

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
/** Waits until `check` holds for both nodes; returns them. */
const everyNode = (label, check, seconds = 120) =>
  waitFor(
    label,
    async () => {
      lastNodes = [await nodeById(edgeId), await nodeById(peerId)];
      return lastNodes.every(check) ? lastNodes : null;
    },
    seconds,
    1000,
    () =>
      JSON.stringify(
        lastNodes.map((n) => ({
          name: n.name,
          online: n.online,
          applied: n.appliedRevision,
          state: n.applyState,
        })),
      ),
  );
/** Waits until both nodes run the cluster's latest revision. */
async function synced(label = "nodes on the latest revision") {
  const latest = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
  );
  return latest;
}
const protect = (siteId, patch) => admin.ok("PATCH", `/sites/${siteId}/protection`, patch);
const setRules = (siteId, rules) => admin.ok("PUT", `/sites/${siteId}/rules`, { rules });

/** Lifts every active ban (the admin view covers all scopes and organizations). */
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

const findSite = async (domain) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(domain)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(domain),
  );
/** Creates a site in the default cluster (after deleting one left by an earlier run). */
async function createSite(name, domain, origin, cacheRules = []) {
  const old = await findSite(domain);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    clusterId,
    domains: [domain],
    origins: [{ address: origin }],
    cacheRules,
  });
  for (const proof of await admin.ok("GET", `/sites/${site.id}/ownership`))
    if (!proof.verified)
      await admin.ok("POST", `/sites/${site.id}/ownership/approve`, { domain: proof.domain });
  return site;
}

await everyNode(
  "nodes online with challenge-v1 and ja4-v1",
  (n) =>
    n.online &&
    n.dataPlaneHealthy &&
    n.supportedFeatures.includes("challenge-v1") &&
    n.supportedFeatures.includes("ja4-v1"),
  180,
);
const platformBefore = await admin.ok("GET", "/settings/protection");
if (platformBefore.underAttack)
  await admin.ok("PUT", "/settings/protection", { ...platformBefore, underAttack: false });
const leftovers = await clearBans();

const siteUa = await createSite("g2-ua", HOST_UA, "whoami");
const siteFiles = await createSite("g2-files", HOST_FILES, "files");
const siteBench = await createSite("g2-bench", HOST_BENCH, "whoami", [
  { pathPrefixes: ["/"], edgeTtlSeconds: 300, originCacheControl: "override" },
]);
await synced("g2 sites published");
for (const [host, path] of [
  [HOST_UA, "/g2-ready"],
  [HOST_FILES, "/static/a.txt"],
  [HOST_BENCH, "/g2-ready"],
])
  await waitFor(`${host} served`, async () => (await edge(host, path)).status === 200, 60);

const edgeIp = await containerIp("node");
const peerIp = await containerIp("node-upgrade-peer");
const peerIsolatedIp = await containerIp("node-upgrade-peer", "_isolated");
const clientA = await containerIp("client-a");
const clientB = await containerIp("client-b");
const clientC = await containerIp("client-c", "_isolated");
const seen = /^X-Real-Ip: (.+)$/m.exec((await edge(HOST_UA, "/g2-seen")).body)?.[1]?.trim();
assert.ok(seen, "whoami did not echo X-Real-Ip");
assert.equal(prefix24(seen), prefix24(clientA), `the node sees the host as ${seen}`);
assert.notEqual(prefix24(clientC), prefix24(seen));
console.log(
  `node ${edgeIp}, peer ${peerIp} (isolated ${peerIsolatedIp}); the node sees the host as ${seen}; client-a ${clientA}, client-b ${clientB}, client-c ${clientC}; ${leftovers} leftover ban(s) lifted`,
);
const a = await probe("client-a", peerIp);
const b = await probe("client-b", edgeIp);
const c = await probe("client-c", peerIsolatedIp);

const m3 = await findSite(M3_HOST);
assert.ok(m3, "the M3 site is missing");
const m3Before = {
  protection: await admin.ok("GET", `/sites/${m3.id}/protection`),
  rules: await admin.ok("GET", `/sites/${m3.id}/rules`),
  logs: await admin.ok("GET", `/sites/${m3.id}/logs/settings`),
};

let finished = false;
try {
  // -------------------------------------------------------------- a. browser passes js and pow
  const uaProtection = await protect(siteUa.id, {
    underAttack: true,
    underAttackChallenge: "js",
    passTtlSeconds: PASS_TTL,
    powDifficulty: POW_BITS,
  });
  assert.equal(uaProtection.underAttack, true);
  assert.equal(uaProtection.passTtlSeconds, PASS_TTL);
  await synced("Under Attack js published");
  const zh = await edge(HOST_UA, "/g2-page", {
    headers: { "user-agent": CLIENT_UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.5" },
  });
  assert.equal(zh.status, 403);
  assert.equal(challengeOf(zh), "js");
  assert.match(zh.headers["content-security-policy"], /^default-src 'none'; script-src 'nonce-/);
  assert.match(zh.headers["cache-control"], /no-store/);
  assert.ok(zh.body.includes('<html lang="zh-CN">') && zh.body.includes("安全检查"));
  assert.ok(!/https?:\/\//.test(zh.body), "the challenge page references another URL");
  const en = await edge(HOST_UA, "/g2-page", {
    method: "HEAD",
    headers: { "user-agent": CLIENT_UA, "accept-language": "en" },
  });
  assert.equal(en.status, 403);
  assert.equal(challengeOf(en), "js");
  assert.equal(en.body, "");

  const browser = await chromium.launch({
    args: ["--no-proxy-server", `--host-resolver-rules=MAP ${HOST_UA} 127.0.0.1`],
  });
  const origin = `http://${HOST_UA}:${edgePort}`;
  let jsPass;
  let powPass;
  try {
    const context = await browser.newContext({ userAgent: BROWSER_UA, locale: "zh-CN" });
    const page = await context.newPage();
    const responses = [];
    const cspErrors = [];
    page.on("response", (r) => {
      const url = new URL(r.url());
      responses.push({
        method: r.request().method(),
        path: url.pathname + url.search,
        status: r.status(),
        challenge: r.headers()["x-edgeweir-challenge"] ?? null,
      });
    });
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/i.test(m.text()))
        cspErrors.push(m.text());
    });
    page.on("pageerror", (e) => cspErrors.push(e.message));
    const pass_ = async () =>
      (await context.cookies(origin)).find((cookie) => cookie.name === "__ew_pass");
    /** Opens the path, lets the page solve its challenge and waits for the origin's answer. */
    async function solve(path, type) {
      responses.length = 0;
      const url = `${origin}${path}`;
      const final = page.waitForResponse((r) => r.url() === url && r.status() === 200, {
        timeout: 60_000,
      });
      const started = performance.now();
      const first = await page.goto(url);
      assert.equal(first.status(), 403);
      assert.equal(first.headers()["x-edgeweir-challenge"], type);
      await final;
      await page.locator("body", { hasText: `GET ${path} ` }).waitFor({ timeout: 30_000 });
      const text = await page.locator("body").innerText();
      assert.match(text, /^Hostname: /m, "the page did not come from whoami");
      assert.ok(text.includes(`X-Real-Ip: ${seen}`), text);
      const verify = responses.find(
        (r) => r.method === "POST" && r.path === "/.edgeweir/challenge/verify",
      );
      assert.equal(verify?.status, 303, JSON.stringify(responses));
      assert.deepEqual(cspErrors, []);
      return { ms: Math.round(performance.now() - started), steps: responses.length };
    }

    const js = await solve("/g2-browser?step=js", "js");
    const jsCookie = await pass_();
    assert.ok(jsCookie, "no __ew_pass after the js challenge");
    assert.equal(jsCookie.httpOnly, true);
    assert.equal(jsCookie.sameSite, "Lax");
    assert.equal(jsCookie.secure, false);
    assert.equal(jsCookie.path, "/");
    assert.ok(Math.abs(jsCookie.expires - (Date.now() / 1000 + PASS_TTL)) < 60, jsCookie.expires);
    assert.ok(!(await page.evaluate(() => document.cookie)).includes("__ew_pass"));
    jsPass = jsCookie.value;
    const jsFields = passFields(jsPass);
    assert.equal(jsFields.site, siteUa.id);
    assert.equal(jsFields.level, 2);
    assert.equal(jsFields.prefix, `4:${prefix24(seen)}`);
    assert.equal(jsFields.ua, sha256(BROWSER_UA).slice(0, 16));
    assert.equal(jsFields.exp - jsFields.iat, PASS_TTL);
    // With the pass, the next page goes straight to the origin.
    const direct = await page.goto(`${origin}/g2-browser?step=again`);
    assert.equal(direct.status(), 200);
    pass(
      `Chromium passed the js challenge of ${HOST_UA} in ${js.ms} ms (403 js -> POST verify 303 -> 200 from whoami; no CSP errors) and holds __ew_pass: HttpOnly, SameSite=Lax, Max-Age ${PASS_TTL}, level 2, bound to ${jsFields.prefix} and its User-Agent; the next page is served directly`,
    );

    await protect(siteUa.id, { underAttackChallenge: "pow" });
    await synced("Under Attack pow published");
    const powPage = await edge(HOST_UA, "/g2-pow-page", { headers: { "user-agent": CLIENT_UA } });
    assert.equal(challengeOf(powPage), "pow");
    assert.ok(powPage.body.includes(`data-d="${POW_BITS}"`), "pow page without the difficulty");
    const pow = await solve("/g2-browser?step=pow", "pow");
    assert.ok(
      responses.some((r) => r.path === "/.edgeweir/challenge/worker.js" && r.status === 200),
      JSON.stringify(responses),
    );
    const powCookie = await pass_();
    assert.ok(powCookie?.httpOnly);
    powPass = powCookie.value;
    assert.notEqual(powPass, jsPass);
    const powFields = passFields(powPass);
    assert.equal(powFields.level, 3);
    assert.equal(powFields.prefix, `4:${prefix24(seen)}`);
    assert.equal(powFields.ua, jsFields.ua);
    pass(
      `Chromium passed the pow challenge (${POW_BITS} bits, data-d on the page, Web Worker /.edgeweir/challenge/worker.js) in ${pow.ms} ms; the js pass (level 2) was not enough, the new HttpOnly pass has level 3`,
    );
  } finally {
    await browser.close();
  }

  // -------------------------------------------------------------- b. the pass on the other node
  const withPass = (value, ua = BROWSER_UA) => ({
    "user-agent": ua,
    cookie: `__ew_pass=${value}`,
  });
  const onPeer = await a.req(HOST_UA, "/g2-peer", { headers: withPass(powPass) });
  assert.equal(onPeer.status, 200, JSON.stringify(onPeer).slice(0, 300));
  assert.equal(challengeOf(onPeer), null);
  assert.ok(onPeer.body.includes("GET /g2-peer ") && onPeer.body.includes(`X-Real-Ip: ${clientA}`));
  const onEdge = await a.req(HOST_UA, "/g2-edge", { headers: withPass(powPass), target: edgeIp });
  assert.equal(onEdge.status, 200);
  const challenged = async (probeClient, headers, what, options = {}) => {
    const r = await probeClient.req(HOST_UA, "/g2-peer", { headers, ...options });
    assert.equal(r.status, 403, `${what}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(challengeOf(r), "pow", what);
    return r;
  };
  await challenged(c, withPass(powPass), "client-c (another /24) with the pass");
  await challenged(a, withPass(powPass, `${BROWSER_UA} other`), "another User-Agent");
  await challenged(a, { "user-agent": BROWSER_UA }, "no pass");
  await challenged(a, withPass(jsPass), "the js pass (level 2)");
  const fields = passFields(powPass);
  const flipped = fields.signature.endsWith("A") ? "B" : "A";
  const tampered = {
    signature: `v1.${fields.kid}.${fields.payload}.${fields.signature.slice(0, -1)}${flipped}`,
    level: `v1.${fields.kid}.${Buffer.from(
      [fields.site, 4, fields.prefix, fields.ua, fields.iat, fields.exp].join("|"),
    ).toString("base64url")}.${fields.signature}`,
    forged: `v1.${fields.kid}.${fields.payload}.${createHash("sha256")
      .update("forged")
      .digest("base64url")}`,
    kid: `v1.forged-key.${fields.payload}.${fields.signature}`,
  };
  for (const [what, value] of Object.entries(tampered))
    await challenged(a, withPass(value), `tampered pass (${what})`);
  const post = await a.req(HOST_UA, "/g2-form", {
    method: "POST",
    headers: { "user-agent": BROWSER_UA, "content-type": "application/x-www-form-urlencoded" },
    data: "x=1",
  });
  assert.equal(post.status, 403);
  assert.equal(challengeOf(post), "required");
  assert.ok(!post.body.includes("<html"), "POST without a pass got a challenge page");
  const postWithPass = await a.req(HOST_UA, "/g2-form", {
    method: "POST",
    headers: { ...withPass(powPass), "content-type": "application/x-www-form-urlencoded" },
    data: "x=1",
  });
  assert.equal(postWithPass.status, 200);
  assert.ok(postWithPass.body.includes("POST /g2-form "));

  const nonce = randomUUID().slice(0, 8);
  const reserved = await edge(HOST_FILES, `/.edgeweir/other-${nonce}`);
  assert.equal(reserved.status, 404);
  assert.equal(reserved.headers["x-edgeweir-error"], "not-found");
  const reservedUa = await edge(HOST_UA, `/.edgeweir/other-${nonce}`, {
    headers: { "user-agent": CLIENT_UA },
  });
  assert.equal(reservedUa.status, 404, "the reserved prefix was challenged on the UA site");
  assert.equal(reservedUa.headers["x-edgeweir-error"], "not-found");
  const worker = await edge(HOST_UA, "/.edgeweir/challenge/worker.js");
  assert.equal(worker.status, 200);
  assert.match(worker.headers["content-type"], /javascript/);
  const control = await edge(HOST_FILES, `/g2-control-${nonce}`);
  assert.equal(control.status, 404);
  assert.equal(control.headers["x-edgeweir-error"], undefined);
  const originLog = await waitFor(
    "the control request in the files access log",
    async () => {
      const log = await run([...compose, "exec", "-T", "files", "cat", "/tmp/access.log"]);
      return log.includes(`GET /g2-control-${nonce} `) ? log : null;
    },
    15,
  );
  assert.ok(!originLog.includes("/.edgeweir/"), "a reserved path reached the origin");
  pass(
    `the level-3 pass from the browser (${seen}) is accepted by the peer and the edge node from client-a (${clientA}, same /24, same User-Agent); challenged again (403 pow): client-c (${clientC}), another User-Agent, no pass, the js pass (level 2), a flipped signature, a raised level, a forged signature, an unknown key; POST without a pass 403 X-Edgeweir-Challenge: required (no page), with the pass 200; /.edgeweir/other 404 not-found at the edge (even under Attack) and absent from the origin's access log, while /g2-control reached it`,
  );

  // -------------------------------------------------------------- e. rules, platform Under Attack, lifetime
  await setRules(siteUa.id, [
    {
      name: "g2 public",
      phase: "waf-custom",
      expression: 'http.request.uri.path eq "/public"',
      action: { kind: "allow" },
    },
  ]);
  await synced("allow rule published");
  const allowed = await edge(HOST_UA, "/public", { headers: { "user-agent": CLIENT_UA } });
  assert.equal(allowed.status, 200);
  assert.ok(allowed.body.includes("GET /public "));
  const still = await edge(HOST_UA, "/private", { headers: { "user-agent": CLIENT_UA } });
  assert.equal(still.status, 403);
  assert.equal(challengeOf(still), "pow");

  await protect(siteUa.id, { underAttack: false });
  await setRules(siteUa.id, [
    {
      name: "g2 login",
      phase: "waf-custom",
      expression: 'http.request.uri.path eq "/login"',
      action: { kind: "challenge", type: "pow" },
    },
  ]);
  await synced("challenge rule published");
  const login = await edge(HOST_UA, "/login", { headers: { "user-agent": CLIENT_UA } });
  assert.equal(login.status, 403);
  assert.equal(challengeOf(login), "pow");
  assert.equal(
    (await edge(HOST_UA, "/other", { headers: { "user-agent": CLIENT_UA } })).status,
    200,
  );
  const loginWithPow = await edge(HOST_UA, "/login", {
    headers: { "user-agent": BROWSER_UA, cookie: `__ew_pass=${powPass}` },
  });
  assert.equal(loginWithPow.status, 200);
  const loginWithJs = await edge(HOST_UA, "/login", {
    headers: { "user-agent": BROWSER_UA, cookie: `__ew_pass=${jsPass}` },
  });
  assert.equal(challengeOf(loginWithJs), "pow");
  pass(
    `an allow rule on /public exempts it from Under Attack (200 without a pass, /private 403 pow); a challenge rule (pow) on /login challenges /login only (/other 200) and accepts the level-3 pass but not the level-2 one`,
  );

  const settings = await admin.ok("GET", "/settings/protection");
  try {
    await admin.ok("PUT", "/settings/protection", {
      ...settings,
      underAttack: true,
      underAttackChallenge: "js",
    });
    await synced("platform Under Attack published");
    const platform = await edge(HOST_FILES, "/static/a.txt", {
      headers: { "user-agent": CLIENT_UA },
    });
    assert.equal(platform.status, 403);
    assert.equal(challengeOf(platform), "js");
    const filesProtection = await admin.ok("GET", `/sites/${siteFiles.id}/protection`);
    assert.equal(filesProtection.underAttack, false);
    assert.equal(filesProtection.platformUnderAttack, true);
  } finally {
    await admin.ok("PUT", "/settings/protection", { ...settings, underAttack: false });
  }
  await synced("platform Under Attack off");
  const platformOff = await edge(HOST_FILES, "/static/a.txt", {
    headers: { "user-agent": CLIENT_UA },
  });
  assert.equal(platformOff.status, 200);

  await protect(siteUa.id, { underAttack: true, underAttackChallenge: "js", passTtlSeconds: 300 });
  await setRules(siteUa.id, []);
  await synced("Under Attack js with 5-minute passes");
  const lifetime = await solveJs(HOST_UA, "/g2-lifetime?x=1", CLIENT_UA);
  assert.equal(lifetime.verified.status, 303);
  assert.equal(lifetime.verified.headers.location, `http://${HOST_UA}/g2-lifetime?x=1`);
  const setCookie = [lifetime.verified.headers["set-cookie"]].flat()[0];
  assert.match(setCookie, /^__ew_pass=v1\.[^;]+; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax$/);
  const short = passFields(passCookie(lifetime.verified));
  assert.equal(short.exp - short.iat, 300);
  const replay = await lifetime.again();
  assert.equal(replay.status, 303);
  assert.equal(passCookie(replay), null, "a redeemed token bought a second pass");
  const withShort = await edge(HOST_UA, "/g2-lifetime?x=1", {
    headers: { "user-agent": CLIENT_UA, cookie: `__ew_pass=${passCookie(lifetime.verified)}` },
  });
  assert.equal(withShort.status, 200);
  pass(
    `platform Under Attack (settings) challenges ${HOST_FILES}, which has none (403 js), and serves it again once off; passTtlSeconds 300 -> Set-Cookie Max-Age=300 (exp - iat = 300 s), the token is redeemed once (a replay gets no pass)`,
  );

  // -------------------------------------------------------------- c. tiered CC on the bench site
  const ccSaved = await protect(siteBench.id, { cc: CC });
  assert.deepEqual(ccSaved.effectiveCc, {
    maxLevel: CC.maxLevel,
    highPowInsteadOfCaptcha: false,
    windowSeconds: CC.windowSeconds,
    siteQps: 0,
    urlQps: CC.urlQps,
    ipQps: CC.ipQps,
    ipBanSeconds: CC.ipBanSeconds,
    originErrorPercent: 0,
    originErrorMinRequests: 0,
    escalateAfterSeconds: CC.escalateAfterSeconds,
    cooldownSeconds: CC.cooldownSeconds,
  });
  await synced("CC policy published");
  const benchCc = () =>
    nodeSecurity().then((s) => s.cc.sites.find((x) => x.site_id === siteBench.id));
  await waitFor("the node holds the CC policy", async () => !!(await benchCc()), 30);
  const loadA = await probe("client-a", edgeIp);
  const loadDone = loadA.load({
    name: "path",
    host: HOST_BENCH,
    path: "/g2-attacked",
    qps: LOAD_QPS,
    durationMs: 120_000,
    headers: { "user-agent": CLIENT_UA },
  });
  let escalated;
  let loadResult;
  try {
    escalated = await waitFor(
      "/g2-attacked escalated to js on the node",
      async () => {
        const s = await benchCc();
        return s?.paths.some((p) => p.path === "/g2-attacked" && p.level === "js") ? s : null;
      },
      60,
    );
    assert.equal(escalated.level, "normal", JSON.stringify(escalated));
    assert.equal(escalated.escalated_paths, 1, JSON.stringify(escalated));
    const attacked = await b.req(HOST_BENCH, "/g2-attacked", {
      headers: { "user-agent": CLIENT_UA },
    });
    assert.equal(attacked.status, 403, JSON.stringify(attacked).slice(0, 300));
    assert.equal(challengeOf(attacked), "js");
    for (const path of ["/g2-other", "/g2-attacked/sub", "/"]) {
      const other = await b.req(HOST_BENCH, path, { headers: { "user-agent": CLIENT_UA } });
      assert.equal(other.status, 200, `${path}: ${JSON.stringify(other).slice(0, 300)}`);
    }
    // The console: the node's escalated path (heartbeat) and the path_level events.
    const state = await waitFor(
      "the console shows the node's escalated path",
      async () => {
        const s = await admin.ok("GET", `/sites/${siteBench.id}/security`);
        const node = s.nodes.find((n) => n.id === edgeId);
        return node?.escalatedPaths >= 1 ? s : null;
      },
      60,
      2000,
    );
    const stateNode = state.nodes.find((n) => n.id === edgeId);
    assert.equal(stateNode.level, "normal");
    assert.equal(stateNode.online, true);
    assert.equal(state.nodes.find((n) => n.id === peerId)?.escalatedPaths, 0);
    const pathEvents = await waitFor(
      "path_level events in the console",
      async () => {
        const list = await admin.ok(
          "GET",
          `/sites/${siteBench.id}/security/events?kind=path_level`,
        );
        return list.items.some((e) => e.level === "js") ? list : null;
      },
      60,
      2000,
    );
    const first = pathEvents.items.find((e) => e.previousLevel === "normal");
    assert.ok(first, JSON.stringify(pathEvents.items));
    assert.equal(first.path, "/g2-attacked");
    assert.equal(first.level, "cookie302");
    assert.equal(first.metric, "url_qps");
    assert.equal(first.threshold, CC.urlQps);
    assert.ok(first.observed > CC.urlQps, JSON.stringify(first));
    assert.deepEqual(first.node, { id: edgeId, name: stateNode.name });
    assert.ok(pathEvents.items.every((e) => e.path === "/g2-attacked"));
    const siteEvents = await admin.ok(
      "GET",
      `/sites/${siteBench.id}/security/events?kind=site_level`,
    );
    assert.equal(siteEvents.total, 0, JSON.stringify(siteEvents.items));
    pass(
      `${LOAD_QPS} req/s from client-a on /g2-attacked (urlQps ${CC.urlQps}, ipQps ${CC.ipQps}, window ${CC.windowSeconds} s) escalated that path to js on ${stateNode.name} (edgeweir-node security: site normal, 1 escalated path): client-b gets 403 js there and 200 on /g2-other, /g2-attacked/sub and /; the console shows ${stateNode.name} normal with ${stateNode.escalatedPaths} escalated path and ${pathEvents.total} path_level event(s) (normal -> cookie302 by url_qps ${first.observed.toFixed(1)} / ${first.threshold}, then js), no site_level event`,
    );
  } finally {
    await loadA.stop("path");
    loadResult = await loadDone;
    loadA.close();
  }
  assert.ok(
    !Object.keys(loadResult.counts).some((k) => k.includes("ip-banned")),
    `the path load was banned: ${JSON.stringify(loadResult)}`,
  );
  console.log(`path load: ${JSON.stringify(loadResult)}`);

  const floodA = await probe("client-a", edgeIp);
  const flood = await floodA.flood({
    host: HOST_BENCH,
    path: "/g2-flood",
    concurrency: 16,
    max: 5000,
    headers: { "user-agent": CLIENT_UA },
  });
  floodA.close();
  assert.ok(flood.banned, `client-a was not banned: ${JSON.stringify(flood)}`);
  const clientBServed = await b.req(HOST_BENCH, "/g2-other", { target: edgeIp });
  assert.equal(clientBServed.status, 200, "client-b must be served");
  const banned = await a.req(HOST_BENCH, "/g2-other", { target: edgeIp });
  assert.equal(banned.status, 403);
  assert.equal(banned.headers["x-edgeweir-error"], "ip-banned");
  const autoBan = await waitFor(
    "the console lists the automatic ban",
    async () =>
      (await admin.ok("GET", `/admin/bans?siteId=${siteBench.id}&source=auto`)).items.find(
        (x) => x.cidr === `${clientA}/32`,
      ),
    60,
    2000,
  );
  assert.equal(autoBan.source, "auto");
  assert.equal(autoBan.reason, "cc_ip_rate");
  assert.equal(autoBan.scope, "site");
  assert.equal(autoBan.siteId, siteBench.id);
  assert.equal(autoBan.node?.id, edgeId);
  assert.equal(autoBan.trigger?.metric, "ip_qps");
  assert.equal(autoBan.trigger?.threshold, CC.ipQps);
  assert.equal(autoBan.trigger?.windowSeconds, CC.windowSeconds);
  assert.ok(autoBan.trigger.observed > CC.ipQps, JSON.stringify(autoBan.trigger));
  const banSeconds = (Date.parse(autoBan.expiresAt) - Date.parse(autoBan.createdAt)) / 1000;
  assert.ok(Math.abs(banSeconds - CC.ipBanSeconds) <= 10, `ban lasts ${banSeconds} s`);
  assert.equal(autoBan.distributed, true);
  const ipEvent = await waitFor(
    "an ip_banned event",
    async () =>
      (await admin.ok("GET", `/sites/${siteBench.id}/security/events?kind=ip_banned`)).items.find(
        (e) => e.address === clientA,
      ),
    60,
    2000,
  );
  assert.equal(ipEvent.metric, "ip_qps");
  assert.equal(ipEvent.node?.id, edgeId);
  assert.equal(ipEvent.threshold, CC.ipQps);
  const top = await admin.ok("GET", `/sites/${siteBench.id}/security`);
  assert.ok(
    top.topIps.some((t) => t.value === clientA),
    JSON.stringify(top.topIps),
  );
  assert.ok(
    top.topPaths.some((t) => t.value === "/g2-attacked"),
    JSON.stringify(top.topPaths),
  );
  // Shared in the cluster: the peer bans client-a as well; client-b stays served there.
  await waitFor(
    "the peer holds the shared automatic ban",
    async () => {
      const r = await a.req(HOST_BENCH, "/g2-other");
      return r.status === 403 && r.headers["x-edgeweir-error"] === "ip-banned";
    },
    60,
  );
  assert.equal((await b.req(HOST_BENCH, "/g2-other", { target: peerIp })).status, 200);
  pass(
    `a flood from client-a (${flood.sent} requests in ${flood.ms} ms, ${JSON.stringify(flood.counts)}) crossed ipQps ${CC.ipQps}: 403 ip-banned for client-a, 200 for client-b; the console lists an automatic ban ${autoBan.cidr} (source auto, reason cc_ip_rate, node ${autoBan.node.name}, ip_qps ${autoBan.trigger.observed.toFixed(1)} / ${autoBan.trigger.threshold} over ${autoBan.trigger.windowSeconds} s, ${Math.round(banSeconds)} s), shared with the peer (client-a 403 there too), an ip_banned event, and client-a / /g2-attacked among the top IPs and paths`,
  );

  await admin.ok("DELETE", `/admin/bans/${autoBan.id}`);
  for (const target of [edgeIp, peerIp])
    await waitFor(
      `client-a served again by ${target}`,
      async () => (await a.req(HOST_BENCH, "/g2-other", { target })).status === 200,
      60,
    );
  const off = await protect(siteBench.id, { cc: { enabled: false } });
  assert.equal(off.cc.enabled, false);
  assert.equal(off.effectiveCc, null);
  await synced("CC off");
  await waitFor("the node dropped the CC policy", async () => !(await benchCc()), 30);
  assert.equal((await admin.ok("GET", "/admin/bans?source=auto")).total, 0);
  pass(
    "the automatic ban lifted in the console: client-a is served by both nodes again; CC turned off",
  );

  // -------------------------------------------------------------- d. JA4 in rules
  const m3Ca = await readFile(".e2e/m3-root.crt", "utf8");
  async function viaCurl(path) {
    const { stdout } = await execute("curl", [
      "-sS",
      "--noproxy",
      "*",
      "--resolve",
      `${M3_HOST}:${tlsPort}:127.0.0.1`,
      "--cacert",
      ".e2e/m3-root.crt",
      "-A",
      CLIENT_UA,
      "-o",
      "/dev/null",
      "-D",
      "-",
      `https://${M3_HOST}:${tlsPort}${path}`,
    ]);
    const lines = stdout.trim().split(/\r?\n/);
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status: Number(lines[0].split(" ")[1]), headers };
  }
  function viaNode(path) {
    return new Promise((resolvePromise, reject) => {
      const req = https.get(
        {
          host: "127.0.0.1",
          port: tlsPort,
          servername: M3_HOST,
          path,
          ca: m3Ca,
          headers: { host: M3_HOST, "user-agent": CLIENT_UA },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("TLS request timeout")));
    });
  }
  const clients = { curl: viaCurl, node: viaNode };

  await protect(m3.id, { logJa4: true });
  await admin.ok("PUT", `/sites/${m3.id}/logs/settings`, { sampleRate: 10000 });
  await synced("JA4 logging published");
  /** The JA4 the node logged for a request of the client (sampled log of a unique path). */
  async function loggedJa4(name) {
    const path = `/g2-ja4-${name}-${randomUUID().slice(0, 8)}`;
    let entries = [];
    await waitFor(
      `sampled log with the JA4 of ${name}`,
      async () => {
        const r = await clients[name](path);
        assert.equal(r.status, 200, `${name} ${path}: ${r.status}`);
        const query = new URLSearchParams({
          from: new Date(Date.now() - 300_000).toISOString(),
          to: new Date(Date.now() + 60_000).toISOString(),
          path,
          limit: "100",
        });
        entries = (await admin.ok("GET", `/sites/${m3.id}/logs?${query}`)).entries;
        return entries.length > 0;
      },
      90,
      1000,
    );
    const values = new Set(entries.map((e) => e.ja4));
    assert.equal(values.size, 1, `${name}: ${[...values]}`);
    const [ja4] = values;
    assert.match(ja4, /^t13d\d{4}[0-9a-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/, `${name}: ${ja4}`);
    return ja4;
  }
  const ja4 = { curl: await loggedJa4("curl"), node: await loggedJa4("node") };
  assert.notEqual(ja4.curl, ja4.node);
  assert.equal(await loggedJa4("curl"), ja4.curl, "curl's JA4 is not stable");

  /** Waits until each client gets the status (and challenge) it should. */
  const expectClients = (label, want) =>
    waitFor(
      label,
      async () => {
        for (const [name, [status, challenge]] of Object.entries(want)) {
          const r = await clients[name](`/g2-ja4-rule-${name}`);
          if (r.status !== status || (challenge && challengeOf(r) !== challenge)) return false;
        }
        return true;
      },
      30,
    );
  await setRules(m3.id, [
    ...m3Before.rules,
    {
      name: "g2 ja4 block",
      phase: "waf-custom",
      expression: `tls.ja4 eq "${ja4.curl}"`,
      action: { kind: "block", statusCode: 403 },
    },
  ]);
  await synced("JA4 block rule published");
  await expectClients("curl blocked by JA4, Node served", { curl: [403], node: [200] });
  const blocked = await viaCurl("/g2-ja4-blocked");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers["x-edgeweir-error"], "policy-denied");

  await setRules(m3.id, [
    ...m3Before.rules,
    {
      name: "g2 ja4 challenge",
      phase: "waf-custom",
      expression: `tls.ja4 eq "${ja4.node}" and http.request.uri.path contains "/g2-ja4"`,
      action: { kind: "challenge", type: "js" },
    },
  ]);
  await synced("JA4 challenge rule published");
  await expectClients("Node challenged by JA4, curl served", { curl: [200], node: [403, "js"] });

  await setRules(m3.id, [
    ...m3Before.rules,
    {
      name: "g2 ja4 rate",
      phase: "ratelimit",
      expression: 'http.request.uri.path contains "/g2-ja4-rate"',
      action: { kind: "rate_limit", limit: 3, windowSeconds: 60, key: "tls.ja4", statusCode: 429 },
    },
  ]);
  await synced("JA4 rate limit published");
  const statuses = [];
  for (let i = 0; i < 8 && !statuses.includes(429); i++)
    statuses.push((await viaCurl(`/g2-ja4-rate-${i}`)).status);
  assert.ok(statuses.includes(429), `curl never hit the JA4 rate limit: ${statuses}`);
  const nodeRate = (await viaNode("/g2-ja4-rate-node")).status;
  assert.equal(nodeRate, 200, "Node shares curl's JA4 rate limit counter");
  pass(
    `JA4 from the node's sampled logs over HTTPS (${M3_HOST}): curl ${ja4.curl}, Node ${ja4.node} (stable per client); a waf-custom block rule on curl's JA4 answers 403 policy-denied to curl and 200 to Node, a challenge rule on Node's JA4 answers 403 js to Node and 200 to curl, a rate limit keyed by tls.ja4 (3/min) limits curl (${statuses.join(",")}) while Node gets ${nodeRate}`,
  );

  // -------------------------------------------------------------- bench site and cleanup
  await setRules(m3.id, m3Before.rules);
  await protect(m3.id, { logJa4: m3Before.protection.logJa4 });
  await admin.ok("PUT", `/sites/${m3.id}/logs/settings`, {
    sampleRate: m3Before.logs.sampleRate,
  });
  await admin.ok("DELETE", `/sites/${siteUa.id}`);
  await admin.ok("DELETE", `/sites/${siteFiles.id}`);
  const bench = await protect(siteBench.id, { underAttack: true, underAttackChallenge: "js" });
  assert.equal(bench.cc.enabled, false);
  assert.deepEqual(await admin.ok("GET", `/sites/${siteBench.id}/rules`), []);
  await synced("cleanup and the bench site published");
  const m3After = await admin.ok("GET", `/sites/${m3.id}/protection`);
  assert.equal(m3After.logJa4, m3Before.protection.logJa4);
  assert.deepEqual(
    withoutIds(await admin.ok("GET", `/sites/${m3.id}/rules`)),
    withoutIds(m3Before.rules),
  );
  assert.equal((await edge(HOST_UA, "/")).status, 404);
  const benchChallenge = await edge(HOST_BENCH, "/bench-cache.txt", {
    headers: { "user-agent": "edgeweir-bench" },
  });
  assert.equal(challengeOf(benchChallenge), "js");
  const benchPass = passCookie(
    (await solveJs(HOST_BENCH, "/bench-cache.txt", "edgeweir-bench")).verified,
  );
  const cached = [];
  for (let i = 0; i < 2; i++) {
    const r = await edge(HOST_BENCH, "/bench-cache.txt", {
      headers: { "user-agent": "edgeweir-bench", cookie: `__ew_pass=${benchPass}` },
    });
    assert.equal(r.status, 200);
    cached.push(r.headers["x-cache"]);
  }
  assert.equal(cached[1], "HIT");
  assert.equal((await admin.ok("GET", "/settings/protection")).underAttack, false);
  assert.equal((await admin.ok("GET", "/admin/bans")).total, 0);
  pass(
    `cleaned up: g2-ua and g2-files deleted, ${M3_HOST} rules, sampling and JA4 logging restored, platform Under Attack off, no bans; ${HOST_BENCH} stays for bench.sh (Under Attack js, cache rule, CC off): 403 js without a pass, 200 X-Cache ${cached.join(" then ")} with one`,
  );
  finished = true;
} finally {
  a.close();
  b.close();
  c.close();
  if (!finished) {
    await admin
      .ok("PUT", "/settings/protection", { ...platformBefore, underAttack: false })
      .catch((error) => console.error(`cleanup: ${error.message}`));
    await clearBans().catch((error) => console.error(`cleanup: ${error.message}`));
    await setRules(m3.id, m3Before.rules).catch((e) => console.error(`cleanup: ${e.message}`));
    await protect(m3.id, { logJa4: m3Before.protection.logJa4 }).catch((e) =>
      console.error(`cleanup: ${e.message}`),
    );
    await admin
      .ok("PUT", `/sites/${m3.id}/logs/settings`, { sampleRate: m3Before.logs.sampleRate })
      .catch((e) => console.error(`cleanup: ${e.message}`));
  }
}

await writeFile(
  ".e2e/g2-state.json",
  `${JSON.stringify(
    {
      benchSiteId: siteBench.id,
      benchSiteName: siteBench.name,
      benchHost: HOST_BENCH,
      bannedAddress: clientA,
      attackedPath: "/g2-attacked",
    },
    null,
    2,
  )}\n`,
);
console.log("G2 E2E OK");
