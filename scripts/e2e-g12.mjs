// Site parity G12 end to end (access authentication, ADR-0038), after G11.
// `node` and `node-upgrade-peer` serve the default cluster; client-a sends
// the requests; whoami echoes the request line and headers it receives;
// g12-auth is the forward authentication service (docker/e2e/g12-auth).
//   a. both nodes report access-auth-v1; the sites' features allow it
//   b. Basic on g12-basic (/private/): 401 with WWW-Authenticate and the
//      401 page without or with wrong credentials, 200 with them (the origin
//      gets X-Auth-User and no Authorization, the visitor's own X-Auth-User
//      replaced), a cache hit answered 401 without credentials, a changed
//      password replacing the old one; nothing outside the scope checked;
//      no password, hash or key in audit entries or API answers
//   c. signed URLs on g12-url: A (.mp4), B (/b/), C (/c/), D (the rest),
//      signed by the console's generator and by hand: valid 200 with the
//      signature removed before the origin, expired 403 auth-expired, wrong
//      403 auth-denied, the backup key accepted, two signatures of one URL
//      the same cached object (HIT)
//   d. forward authentication on g12-fwd: refused 401 passed on (status,
//      WWW-Authenticate, body), allowed 200 with the service's X-Auth-User
//      at the origin (the visitor's replaced, X-Auth-Other not copied), the
//      service getting the forwarded and X-Original-* headers only, answers
//      cached (the service not asked again), /login/ 302 passed on, /down/
//      503 auth-unavailable, /slow/ (500 ms timeout) 503, /open/ let through
//   e. failures counted per site (GET /sites/{id}/auth-rules/failures)
// The G12 sites stay for apps/console/e2e/g12.spec.ts (.e2e/g12-state.json);
// `node scripts/e2e-g12.mjs --cleanup` removes them (and the spec's g12-ui).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash("md5").update(s).digest("hex");
const STATE = ".e2e/g12-state.json";

const HOST = { basic: "basic.g12.test", url: "url.g12.test", fwd: "fwd.g12.test" };
const SITES = { basic: "g12-basic", url: "g12-url", fwd: "g12-fwd" };
const NODES = ["node", "node-upgrade-peer"];
/** Created by apps/console/e2e/g12.spec.ts. */
const UI_SITE = "g12-ui";
const PASSWORD = "g12-correct-password";
const KEY = `g12-${randomBytes(12).toString("hex")}`;
const BACKUP = `g12-backup-${randomBytes(8).toString("hex")}`;

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

async function call(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

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
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "g12-e2e" })).key;
  const user = { cookie, key };
  user.raw = (method, path, body) => call(user.key, method, path, body);
  user.ok = async (method, path, body) => {
    const result = await user.raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  return user;
}

const containerId = async (service) => {
  const id = (await run([...compose, "ps", "-q", service])).trim();
  assert.ok(id, `${service} is not running`);
  return id;
};

/** Runs `node -e script` in a compose service with `input` on stdin; resolves stdout. */
async function nodeIn(service, script, input) {
  const id = await containerId(service);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", id, "node", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(out).toString("utf8"))
        : reject(new Error(`${service}: ${Buffer.concat(err).toString("utf8")}`)),
    );
    child.stdin.end(input ?? "");
  });
}

/** Sequential HTTP requests from a client (no redirects followed). */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path ?? "/",
        method: r.method ?? "GET", headers, agent: false, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message, headers: {}, body: "" }));
      req.end();
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list, client = "client-a") =>
  list.length ? JSON.parse(await nodeIn(client, REQUESTS, JSON.stringify(list))) : [];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
/** A request header the whoami origin echoed, or undefined. */
const echoed = (r, name) => r.body.match(new RegExp(`^${name}: (.*?)\\r?$`, "im"))?.[1];
/** The request line whoami echoed. */
const requestLine = (r) => r.body.match(/^(GET|HEAD) (\S+) HTTP\/1\.1\r?$/m)?.[2];
const basicAuth = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
/** What the g12-auth service saw last, and how many requests it answered. */
const authSeen = async () =>
  JSON.parse(
    await nodeIn(
      "client-a",
      `fetch("http://g12-auth:8080/_seen").then(r => r.text()).then(t => process.stdout.write(t))`,
    ),
  );

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
const everyNode = (label, check, ids = [edgeId, peerId], seconds = 120) =>
  waitFor(
    label,
    async () => {
      lastNodes = await Promise.all(ids.map(nodeById));
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
          message: n.applyMessage,
        })),
      ),
  );
const latestRevision = async () =>
  (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
async function synced(label) {
  const latest = await latestRevision();
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
  );
  return latest;
}
const siteNamed = async (name) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(name)}&pageSize=100`)).items.find(
    (s) => s.name === name,
  );

async function cleanup() {
  let removed = 0;
  for (const name of [...Object.values(SITES), UI_SITE]) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  console.log(`G12 cleanup: ${removed} site(s)`);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const cacheAll = [{ pathPrefixes: ["/"], edgeTtlSeconds: 60, originCacheControl: "override" }];
async function createSite(name, domain) {
  const old = await siteNamed(name);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains: [domain],
    origins: [{ address: "whoami" }],
    clusterId,
    cacheRules: cacheAll,
  });
  return site;
}
const scope = (extra = {}) => ({
  domains: [],
  pathPrefixes: [],
  extensions: [],
  excludePathPrefixes: [],
  ...extra,
});
const saveRules = (siteId, rules) => admin.ok("PUT", `/sites/${siteId}/auth-rules`, { rules });
const both = (r) => requests(NODES.map((target) => ({ target, ...r })));

let finished = false;
try {
  // ---------------------------------------------------------------- a
  const nodes = await everyNode("nodes report access-auth-v1", (n) =>
    n.supportedFeatures.includes("access-auth-v1"),
  );
  const sites = {
    basic: await createSite(SITES.basic, HOST.basic),
    url: await createSite(SITES.url, HOST.url),
    fwd: await createSite(SITES.fwd, HOST.fwd),
  };
  const features = await admin.ok("GET", `/sites/${sites.basic.id}/features`);
  assert.deepEqual(features.accessAuth, { available: true, reason: null });
  pass(`a. ${nodes.map((n) => n.name).join(" and ")} report access-auth-v1`);

  // ---------------------------------------------------------------- b
  const basicRules = await saveRules(sites.basic.id, [
    {
      kind: "basic",
      scope: scope({ pathPrefixes: ["/private/"] }),
      basic: {
        realm: "G12 private",
        userHeader: true,
        users: [
          { name: "alice", password: PASSWORD },
          { name: "bob", password: `${PASSWORD}-bob` },
        ],
      },
    },
  ]);
  assert.deepEqual(basicRules.rules[0].basic.users, [{ name: "alice" }, { name: "bob" }]);
  assert.doesNotMatch(JSON.stringify(basicRules), /pbkdf2|g12-correct/);
  await synced("g12-basic with Basic");
  for (const [r, target] of (await both({ host: HOST.basic, path: "/private/a" })).map((r, i) => [
    r,
    NODES[i],
  ])) {
    assert.equal(r.status, 401, `${target}: ${summary(r)}`);
    assert.equal(r.headers["www-authenticate"], 'Basic realm="G12 private", charset="UTF-8"');
    assert.equal(r.headers["x-edgeweir-error"], "auth-required");
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(r.body, /401/);
  }
  const good = { authorization: basicAuth("alice", PASSWORD), "x-auth-user": "mallory" };
  for (const [index, r] of (
    await requests([
      { target: "node", host: HOST.basic, path: "/private/cached", headers: good },
      { target: "node", host: HOST.basic, path: "/private/cached", headers: good },
      { target: "node", host: HOST.basic, path: "/private/cached" },
      {
        target: "node",
        host: HOST.basic,
        path: "/private/cached",
        headers: { authorization: basicAuth("alice", "wrong-password") },
      },
      { target: "node", host: HOST.basic, path: "/public/x" },
    ])
  ).entries()) {
    if (index < 2) {
      assert.equal(r.status, 200, summary(r));
      assert.equal(echoed(r, "X-Auth-User"), "alice", r.body);
      assert.equal(echoed(r, "Authorization"), undefined, "Authorization reached the origin");
      assert.equal(r.headers["x-cache"], index === 0 ? "MISS" : "HIT");
    } else if (index < 4) {
      assert.equal(r.status, 401, `cached object, request ${index}: ${summary(r)}`);
    } else {
      assert.equal(r.status, 200, `outside the scope: ${summary(r)}`);
    }
  }
  // A new password for alice; bob's stays.
  await saveRules(sites.basic.id, [
    {
      id: basicRules.rules[0].id,
      kind: "basic",
      scope: scope({ pathPrefixes: ["/private/"] }),
      basic: {
        realm: "G12 private",
        userHeader: true,
        users: [{ name: "alice", password: `${PASSWORD}-new` }, { name: "bob" }],
      },
    },
  ]);
  await synced("g12-basic with alice's new password");
  const [oldPassword, newPassword, bob] = await requests([
    { target: "node-upgrade-peer", host: HOST.basic, path: "/private/b", headers: good },
    {
      target: "node-upgrade-peer",
      host: HOST.basic,
      path: "/private/b",
      headers: { authorization: basicAuth("alice", `${PASSWORD}-new`) },
    },
    {
      target: "node-upgrade-peer",
      host: HOST.basic,
      path: "/private/b",
      headers: { authorization: basicAuth("bob", `${PASSWORD}-bob`) },
    },
  ]);
  assert.deepEqual(
    [oldPassword.status, newPassword.status, bob.status],
    [401, 200, 200],
    `${summary(oldPassword)} / ${summary(newPassword)} / ${summary(bob)}`,
  );
  const audit = await admin.ok("GET", "/audit-logs?action=site.auth_update&limit=50");
  assert.ok(audit.items.length >= 2, JSON.stringify(audit).slice(0, 300));
  assert.doesNotMatch(JSON.stringify(audit), /g12-correct|pbkdf2/);
  pass(
    "b. Basic: 401 with the challenge and the page without or with a wrong password, 200 with it (X-Auth-User alice at the origin, no Authorization), a cache hit refused without credentials, outside the scope served; alice's new password replaces the old, bob's kept; no password or hash in audit entries",
  );

  // ---------------------------------------------------------------- c
  const urlRules = await saveRules(sites.url.id, [
    {
      kind: "url_a",
      scope: scope({ extensions: ["mp4"] }),
      url: { primaryKey: KEY, backupKey: BACKUP },
    },
    { kind: "url_b", scope: scope({ pathPrefixes: ["/b/"] }), url: { primaryKey: KEY } },
    { kind: "url_c", scope: scope({ pathPrefixes: ["/c/"] }), url: { primaryKey: KEY } },
    { kind: "url_d", url: { primaryKey: KEY, validitySeconds: 600, skewSeconds: 0 } },
  ]);
  assert.doesNotMatch(JSON.stringify(urlRules), new RegExp(KEY));
  await synced("g12-url with signed URLs A-D");
  const [ruleA, ruleB, ruleC, ruleD] = urlRules.rules;
  const sign = (rule, url, validitySeconds) =>
    admin.ok("POST", `/sites/${sites.url.id}/auth-rules/${rule.id}/sign`, {
      url,
      ...(validitySeconds ? { validitySeconds } : {}),
    });
  const a1 = await sign(ruleA, "/v/movie.mp4?q=1");
  const a2 = await sign(ruleA, `http://${HOST.url}/v/movie.mp4?q=1`, 60);
  assert.notEqual(a1.url, new URL(a2.url).pathname + new URL(a2.url).search);
  const b = await sign(ruleB, "/b/doc.txt");
  const c = await sign(ruleC, "/c/doc.txt?x=2");
  const d = await sign(ruleD, "/d/doc.txt");
  const now = Math.floor(Date.now() / 1000);
  const old = now - 4000;
  const results = await requests([
    { target: "node", host: HOST.url, path: a1.url },
    { target: "node-upgrade-peer", host: HOST.url, path: a1.url },
    { target: "node", host: HOST.url, path: new URL(a2.url).pathname + new URL(a2.url).search },
    { target: "node", host: HOST.url, path: b.url },
    { target: "node", host: HOST.url, path: c.url },
    { target: "node", host: HOST.url, path: d.url },
    // Signed by hand: expired, wrong key, backup key, none.
    {
      target: "node",
      host: HOST.url,
      path: `/v/old.mp4?sign=${old}-r1-${md5(`/v/old.mp4@${old}@r1@${KEY}`)}`,
    },
    {
      target: "node",
      host: HOST.url,
      path: `/v/x.mp4?sign=${now}-r1-${md5(`/v/x.mp4@${now}@r1@not-the-key-123456`)}`,
    },
    {
      target: "node",
      host: HOST.url,
      path: `/v/y.mp4?sign=${now}-r1-${md5(`/v/y.mp4@${now}@r1@${BACKUP}`)}`,
    },
    { target: "node", host: HOST.url, path: "/b/doc.txt" },
    {
      target: "node",
      host: HOST.url,
      path: `/${old}/${md5(`/b/doc.txt@${old}@${KEY}`)}/b/doc.txt`,
    },
  ]);
  const [okA, okAPeer, hitA, okB, okC, okD, expired, wrong, backup, missing, expiredB] = results;
  for (const [label, r, line] of [
    ["A", okA, "/v/movie.mp4?q=1"],
    ["A (peer)", okAPeer, "/v/movie.mp4?q=1"],
    ["B", okB, "/b/doc.txt"],
    ["C", okC, "/c/doc.txt?x=2"],
    ["D", okD, "/d/doc.txt"],
  ]) {
    assert.equal(r.status, 200, `${label}: ${summary(r)}`);
    assert.equal(requestLine(r), line, `${label}: the origin got ${requestLine(r)}`);
  }
  assert.equal(hitA.status, 200, summary(hitA));
  assert.equal(hitA.headers["x-cache"], "HIT", "another signature of the same URL is a cache hit");
  assert.equal(`${expired.status} ${expired.headers["x-edgeweir-error"]}`, "403 auth-expired");
  assert.equal(`${wrong.status} ${wrong.headers["x-edgeweir-error"]}`, "403 auth-denied");
  assert.equal(backup.status, 200, `backup key: ${summary(backup)}`);
  assert.equal(`${missing.status} ${missing.headers["x-edgeweir-error"]}`, "403 auth-denied");
  assert.equal(`${expiredB.status} ${expiredB.headers["x-edgeweir-error"]}`, "403 auth-expired");
  assert.ok(Math.abs(Date.parse(a2.expiresAt) - Date.now() - 60_000) < 10_000, a2.expiresAt);
  // Every kind, expired and wrong (D's rule: 600 s, no skew).
  const oldD = now - 700;
  const [expiredC, expiredD, wrongB, wrongC, wrongD] = await requests(
    [
      { path: `/${md5(`/c/doc.txt@${old}@${KEY}`)}/${old}/c/doc.txt` },
      { path: `/d/doc.txt?sign=${md5(`/d/doc.txt@${oldD}@${KEY}`)}&t=${oldD}` },
      { path: `/${now}/${md5(`/b/doc.txt@${now}@not-the-key-123456`)}/b/doc.txt` },
      { path: `/${md5(`/c/doc.txt@${now}@not-the-key-123456`)}/${now}/c/doc.txt` },
      { path: `/d/doc.txt?sign=${md5(`/d/doc.txt@${now}@not-the-key-123456`)}&t=${now}` },
    ].map((r) => ({ target: "node-upgrade-peer", host: HOST.url, ...r })),
  );
  for (const [label, r, code] of [
    ["C expired", expiredC, "auth-expired"],
    ["D expired", expiredD, "auth-expired"],
    ["B wrong", wrongB, "auth-denied"],
    ["C wrong", wrongC, "auth-denied"],
    ["D wrong", wrongD, "auth-denied"],
  ])
    assert.equal(`${r.status} ${r.headers["x-edgeweir-error"]}`, `403 ${code}`, label);
  pass(
    `c. signed URLs signed by the console: A ${a1.url.replace(/[0-9a-f]{32}/, "…")}, B, C and D answer 200 on both nodes with the signature removed before the origin; another signature of the same URL is a cache HIT; every kind expired 403 auth-expired and signed with another key 403 auth-denied, none 403 auth-denied, the backup key accepted; a URL signed for 60 s expires at ${a2.expiresAt}`,
  );

  // ---------------------------------------------------------------- d
  const forward = (path, extra = {}) => ({
    url: `http://g12-auth:8080${path}`,
    timeoutMs: 2000,
    requestHeaders: ["authorization", "cookie"],
    responseHeaders: ["x-auth-user", "x-auth-groups"],
    ...extra,
  });
  await saveRules(sites.fwd.id, [
    {
      kind: "forward",
      scope: scope({ pathPrefixes: ["/login/"] }),
      forward: forward("/login", { passRedirects: true }),
    },
    { kind: "forward", scope: scope({ pathPrefixes: ["/down/"] }), forward: forward("/fail") },
    {
      kind: "forward",
      scope: scope({ pathPrefixes: ["/slow/"] }),
      forward: forward("/slow", { timeoutMs: 500 }),
    },
    {
      kind: "forward",
      scope: scope({ pathPrefixes: ["/open/"] }),
      forward: forward("/fail", { allowUnavailable: true }),
    },
    { kind: "forward", forward: forward("/check", { cacheSeconds: 30 }) },
  ]);
  await synced("g12-fwd with forward authentication");
  const [refused] = await requests([
    { target: "node", host: HOST.fwd, path: "/app/x", headers: { cookie: "sid=bad" } },
  ]);
  assert.equal(refused.status, 401, summary(refused));
  assert.equal(refused.headers["www-authenticate"], 'Bearer realm="g12"');
  assert.equal(refused.headers["x-edgeweir-error"], "auth-denied");
  assert.equal(refused.body, '{"error":"login required"}');
  const allowedHeaders = {
    cookie: "sid=good",
    "x-auth-user": "mallory",
    "x-auth-other": "spoofed",
    "x-secret": "no",
  };
  const [allowed] = await requests([
    { target: "node-upgrade-peer", host: HOST.fwd, path: "/app/x?q=1", headers: allowedHeaders },
  ]);
  assert.equal(allowed.status, 200, summary(allowed));
  assert.equal(echoed(allowed, "X-Auth-User"), "alice");
  assert.equal(echoed(allowed, "X-Auth-Groups"), "ops");
  assert.equal(
    echoed(allowed, "X-Auth-Other"),
    "spoofed",
    "headers outside the list stay the visitor's",
  );
  const seen = await authSeen();
  assert.equal(seen.seen.uri, "/check");
  assert.equal(seen.seen.method, "GET");
  assert.equal(seen.seen.headers.host, "g12-auth:8080");
  assert.equal(seen.seen.headers["x-original-uri"], "/app/x?q=1");
  assert.equal(seen.seen.headers["x-original-method"], "GET");
  assert.equal(seen.seen.headers["x-original-host"], HOST.fwd);
  assert.ok(seen.seen.headers["x-real-ip"], JSON.stringify(seen.seen.headers));
  assert.ok(seen.seen.headers["x-forwarded-for"], JSON.stringify(seen.seen.headers));
  assert.equal(seen.seen.headers.cookie, "sid=good");
  for (const name of [
    "x-secret",
    "x-auth-user",
    "user-agent",
    "accept-encoding",
    "x-edgeweir-site",
  ])
    assert.equal(seen.seen.headers[name], undefined, `${name} reached the service`);
  const calls = seen.calls;
  const [cached] = await requests([
    {
      target: "node-upgrade-peer",
      host: HOST.fwd,
      path: "/app/y",
      headers: { cookie: "sid=good" },
    },
  ]);
  assert.equal(cached.status, 200, summary(cached));
  assert.equal((await authSeen()).calls, calls, "the cached answer was asked for again");
  const [login, down, slow, open] = await requests([
    { target: "node", host: HOST.fwd, path: "/login/page" },
    { target: "node", host: HOST.fwd, path: "/down/x" },
    { target: "node", host: HOST.fwd, path: "/slow/x" },
    { target: "node", host: HOST.fwd, path: "/open/x" },
  ]);
  assert.equal(login.status, 302, summary(login));
  assert.equal(login.headers.location, "https://login.g12.test/?rd=/login/page");
  assert.equal(`${down.status} ${down.headers["x-edgeweir-error"]}`, "503 auth-unavailable");
  assert.equal(`${slow.status} ${slow.headers["x-edgeweir-error"]}`, "503 auth-unavailable");
  assert.equal(open.status, 200, summary(open));
  pass(
    "d. forward authentication: refused 401 passed on with the service's challenge and body; allowed 200 with X-Auth-User and X-Auth-Groups from the service at the origin (the visitor's replaced); the service got the cookie and X-Original-URI/Method/Host, X-Real-IP, X-Forwarded-For only; a cached answer not asked again; /login/ 302 passed on, /down/ and /slow/ (500 ms) 503 auth-unavailable, /open/ let through",
  );

  // ---------------------------------------------------------------- e
  const failures = await waitFor(
    "failures counted",
    async () => {
      const f = await admin.ok("GET", `/sites/${sites.basic.id}/auth-rules/failures?range=1h`);
      return f.requests >= 4 ? f : null;
    },
    240,
    5000,
  );
  assert.equal(failures.unsupportedNodes, 0);
  pass(`e. g12-basic counts ${failures.requests} refused requests in the last hour`);

  await mkdir(".e2e", { recursive: true });
  await writeFile(
    STATE,
    JSON.stringify(
      { clusterId, basicSiteId: sites.basic.id, urlSiteId: sites.url.id, fwdSiteId: sites.fwd.id },
      null,
      2,
    ),
  );
  finished = true;
  console.log("G12 OK");
} finally {
  if (!finished)
    console.error("G12 failed; `node scripts/e2e-g12.mjs --cleanup` removes its sites");
}
