// Site parity G14 end to end (WAF actions, request body fields, CRS by path,
// verified crawlers and challenge additions, ADR-0040), after G13. `node`
// and `node-upgrade-peer` serve the default cluster; node-g14 (profile g14)
// is the only node of the cluster "g14-bots" and resolves through g14-dns,
// which answers the PTR and A records the test sets. client-a and client-b
// send the requests; whoami and g15-origin-a are the origins (g15-origin-a
// answers POST /form with "received <n> bytes").
//   a. every node reports waf-v2, rules-body-v1 and challenge-v2; the sites'
//      features allow them
//   b. ban action on g14-ban: /trap bans client-a (403 ip-banned there and,
//      once shared, on the other node for every path); the ban list shows
//      source rule, reason waf_rule and the rule; client-b unaffected;
//      lifting it lets client-a in again
//   c. on g14-act: a custom JSON response (status, type, body, no-store, no
//      body for HEAD), an error page response (418, the built-in page),
//      close (no response at all), and a log rule writing an access log line
//      of a site that samples nothing, with the rule id
//   d. CRS on g14-crs (block): the XSS payload blocked on /other; passed on
//      the path a skip rule exempts from CRS, on the path a config rule turns
//      CRS off for and the one it sets to detect; /api/ with the matched rules
//      excluded by path passes, /apix and /api/../other (normalized) are
//      blocked; /login with the rules excluded for ARGS:q only passes for q,
//      not for another argument nor /login/x; the origin never sees
//      X-Edgeweir-*
//   e. body fields on g14-body (limit 1024): a JSON field, a form field and a
//      multipart file name block (403); harmless bodies reach the origin
//      whole; a body over the limit is truncated (422 from a respond rule)
//   f. rate limit ban on g14-rate: the 4th request 429, the next 403
//      ip-banned; the ban list shows reason rate_limit with the rule
//   g. crawlers on g14-bots (node-g14, Under Attack js, verified crawlers
//      allowed): client-a claiming Googlebot with matching PTR and A records
//      passes (and the rule fields read true/googlebot), client-b claiming
//      Googlebot with a PTR whose A record names another address is
//      challenged, client-a without the claim is challenged
//   h. challenge page texts (Chinese and English, escaped)
//   i. challenge failures on g14-fail: three failed answers ban client-a (403
//      ip-banned, ban reason challenge_failures)
//   j. the payload's rules reach g14-crs's top CRS rules (g14.spec.ts uses
//      them)
// `node scripts/e2e-g14.mjs --cleanup` removes its sites and those
// apps/console/e2e/g14.spec.ts leaves (g14-ui-*).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades", "--profile", "g14"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = {
  ban: "ban.g14.test",
  act: "act.g14.test",
  crs: "crs.g14.test",
  body: "body.g14.test",
  rate: "rate.g14.test",
  bots: "bots.g14.test",
  fail: "fail.g14.test",
};
const SITES = Object.fromEntries(Object.keys(HOST).map((k) => [k, `g14-${k}`]));
const NODES = ["node", "node-upgrade-peer"];
const G14_FEATURES = ["waf-v2", "rules-body-v1", "challenge-v2"];
const BOT_CLUSTER = "g14-bots";
const BOT_NODE = "edge-g14";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64) G14Browser/1.0";
const XSS = "<script>alert(1)</script>";
const XSS_QUERY = `q=${encodeURIComponent(XSS)}`;
/**
 * Detection rules the payload matches at paranoia level 1: those of scripts/e2e-g3.mjs and the
 * JavaScript method rule 941390 (alert).
 */
const XSS_DETECTION = [941100, 941110, 941160, 941390];

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
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "g14-e2e" })).key;
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

/**
 * Sequential HTTP requests from a client (no redirects followed): target, port, host, path
 * (sent as is), method, headers and an optional body (a string, sent with Content-Length).
 * A connection closed without a response resolves with status 0 and the error.
 */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      const body = r.body === undefined ? undefined : Buffer.from(r.body, "utf8");
      if (body) headers["content-length"] = String(body.length);
      const req = http.request({ host: r.target, port: r.port ?? 80, path: r.path ?? "/",
        method: r.method ?? "GET", headers, agent: false, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.code ?? e.message, headers: {}, body: "" }));
      req.end(body);
    }));
  }
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list, client = "client-a") =>
  list.length ? JSON.parse(await nodeIn(client, REQUESTS, JSON.stringify(list))) : [];
const request = async (r, client = "client-a") => (await requests([r], client))[0];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
/** Asserts status (and X-Edgeweir-Error) of a request on both nodes. */
async function expectBoth(r, status, error, client) {
  const results = await requests(
    NODES.map((target) => ({ target, ...r })),
    client,
  );
  for (const [i, res] of results.entries()) {
    assert.equal(res.status, status, `${NODES[i]} ${r.host}${r.path ?? "/"}: ${summary(res)}`);
    if (error) assert.equal(res.headers["x-edgeweir-error"], error, `${NODES[i]}: ${summary(res)}`);
  }
  return results;
}
const clientAddress = async (client) =>
  (
    await nodeIn(
      client,
      `const a = Object.values(require("node:os").networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal); process.stdout.write(a.address);`,
    )
  ).trim();

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
const latestRevision = async (id = clusterId) =>
  (await admin.ok("GET", `/clusters/${id}`)).latestRevision.revision;
async function synced(label, ids = [edgeId, peerId], cluster = clusterId) {
  const latest = await latestRevision(cluster);
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
    ids,
  );
  return latest;
}
const siteNamed = async (name) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(name)}&pageSize=100`)).items.find(
    (s) => s.name === name,
  );
const bansOf = async (query) => (await admin.ok("GET", `/bans?pageSize=100&${query}`)).items;

async function cleanup() {
  let removed = 0;
  for (const name of Object.values(SITES)) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  // apps/console/e2e/g14.spec.ts leaves g14-ui-<run>.
  for (const site of (await admin.ok("GET", "/sites?search=g14-ui-&pageSize=100")).items)
    if (site.name.startsWith("g14-ui-")) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  // Platform rules and bans the spec or this script may leave.
  const platform = (await admin.ok("GET", "/platform-rules")).filter(
    (r) => !r.name.startsWith("g14-"),
  );
  await admin.ok("PUT", "/platform-rules", { rules: platform });
  let lifted = 0;
  for (const ban of await bansOf("source=rule"))
    if (!ban.siteId || ban.siteName?.startsWith("g14-")) {
      await admin.raw("DELETE", `/bans/${ban.id}`);
      lifted++;
    }
  console.log(`G14 cleanup: ${removed} site(s), ${lifted} rule ban(s)`);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const cacheAll = [{ pathPrefixes: ["/"], edgeTtlSeconds: 60, originCacheControl: "override" }];
async function createSite(name, domain, extra = {}) {
  const old = await siteNamed(name);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains: [domain],
    origins: [{ address: "whoami" }],
    clusterId,
    cacheRules: cacheAll,
    ...extra,
  });
  return site;
}
const rules = (siteId, list) =>
  admin.ok("PUT", `/sites/${siteId}/rules`, {
    rules: list.map(([name, phase, expression, action]) => ({
      name,
      phase,
      expression,
      enabled: true,
      action,
    })),
  });
const sampledLogs = async (siteId, path, count = 1) => {
  let entries = [];
  await waitFor(
    `access log of ${path}`,
    async () => {
      const query = new URLSearchParams({
        from: new Date(Date.now() - 600_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        path,
        limit: "100",
      });
      entries = (await admin.ok("GET", `/sites/${siteId}/logs?${query}`)).entries.filter(
        (e) => e.path === path,
      );
      return entries.length >= count;
    },
    120,
    2000,
  );
  return entries;
};

let finished = false;
try {
  // ---------------------------------------------------------------- a
  const nodes = await everyNode("nodes report the G14 features", (n) =>
    G14_FEATURES.every((f) => n.supportedFeatures.includes(f)),
  );
  await cleanup();
  const sites = {};
  for (const key of ["ban", "act", "crs", "rate", "fail"])
    sites[key] = await createSite(SITES[key], HOST[key]);
  sites.body = await createSite(SITES.body, HOST.body, {
    origins: [{ address: "g15-origin-a", port: 8080 }],
  });
  const features = await admin.ok("GET", `/sites/${sites.ban.id}/features`);
  for (const key of ["wafV2", "rulesBody", "challengeV2"])
    assert.deepEqual(features[key], { available: true, reason: null }, key);
  pass(`a. ${nodes.map((n) => n.name).join(" and ")} report ${G14_FEATURES.join(", ")}`);

  const [addressA, addressB] = [await clientAddress("client-a"), await clientAddress("client-b")];
  assert.notEqual(addressA, addressB);

  // ---------------------------------------------------------------- b
  const [trap] = await rules(sites.ban.id, [
    [
      "g14 trap",
      "waf-custom",
      'http.request.uri.path eq "/trap"',
      { kind: "ban", banSeconds: 600 },
    ],
  ]);
  await synced("g14-ban with the ban action");
  await expectBoth({ host: HOST.ban, path: "/before" }, 200, undefined, "client-a");
  const trapped = await request({ target: "node", host: HOST.ban, path: "/trap" });
  assert.equal(summary(trapped), "403 ip-banned", `the trap: ${summary(trapped)}`);
  const after = await request({ target: "node", host: HOST.ban, path: "/after" });
  assert.equal(summary(after), "403 ip-banned", `after the trap: ${summary(after)}`);
  // Already banned: a second trap request is refused before the rules and writes nothing.
  await request({ target: "node", host: HOST.ban, path: "/trap" });
  const ruleBan = await waitFor("the rule ban in the ban list", async () => {
    const list = await bansOf(`source=rule&siteId=${sites.ban.id}`);
    return list.length ? list : null;
  });
  assert.equal(ruleBan.length, 1, JSON.stringify(ruleBan));
  assert.equal(ruleBan[0].cidr, `${addressA}/32`);
  assert.equal(ruleBan[0].reason, "waf_rule");
  assert.deepEqual(ruleBan[0].rule, { id: trap.id, name: "g14 trap", platform: false });
  await waitFor("the shared ban on the other node", async () => {
    const r = await request({ target: "node-upgrade-peer", host: HOST.ban, path: "/elsewhere" });
    return r.status === 403 && r.headers["x-edgeweir-error"] === "ip-banned";
  });
  await expectBoth({ host: HOST.ban, path: "/other" }, 200, undefined, "client-b");
  await admin.ok("DELETE", `/bans/${ruleBan[0].id}`);
  await waitFor("client-a let in again on both nodes", async () => {
    const results = await requests(
      NODES.map((target) => ({ target, host: HOST.ban, path: "/again" })),
    );
    return results.every((r) => r.status === 200);
  });
  pass(
    `b. g14-ban: /trap banned ${addressA} (403 ip-banned there, then every path, shared to the other node); ban list: one entry, source rule, reason waf_rule, rule "g14 trap"; client-b 200; lifted -> 200 on both nodes`,
  );

  // ---------------------------------------------------------------- c
  const actRules = await rules(sites.act.id, [
    [
      "g14 json",
      "waf-custom",
      'http.request.uri.path eq "/json"',
      { kind: "respond", statusCode: 200, contentType: "application/json", body: '{"ok":true}' },
    ],
    [
      "g14 teapot",
      "waf-custom",
      'http.request.uri.path eq "/teapot"',
      { kind: "respond", statusCode: 418, errorPage: true },
    ],
    ["g14 drop", "waf-custom", 'http.request.uri.path eq "/drop"', { kind: "close" }],
    [
      "g14 audit",
      "waf-custom",
      'http.request.uri.path eq "/audit"',
      { kind: "log", accessLog: true },
    ],
  ]);
  await synced("g14-act with respond, close and log rules");
  for (const target of NODES) {
    const [json, head, teapot, drop] = await requests([
      { target, host: HOST.act, path: "/json" },
      { target, host: HOST.act, path: "/json", method: "HEAD" },
      { target, host: HOST.act, path: "/teapot", headers: { "accept-language": "en" } },
      { target, host: HOST.act, path: "/drop" },
    ]);
    assert.equal(json.status, 200, `${target} /json: ${summary(json)}`);
    assert.equal(json.headers["content-type"], "application/json");
    assert.equal(json.headers["cache-control"], "no-store");
    assert.equal(json.body, '{"ok":true}');
    assert.equal(json.headers["x-edgeweir-error"], undefined);
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(teapot.status, 418, `${target} /teapot: ${summary(teapot)}`);
    assert.equal(teapot.headers["x-edgeweir-error"], "rule-response");
    assert.match(teapot.headers["content-type"], /^text\/html/);
    assert.match(teapot.body, /<html/i);
    assert.equal(drop.status, 0, `${target} /drop must get no response: ${summary(drop)}`);
  }
  await request({ target: "node", host: HOST.act, path: "/audit" });
  const [audited] = await sampledLogs(sites.act.id, "/audit");
  const auditRule = actRules.find((r) => r.name === "g14 audit");
  assert.deepEqual(audited.ruleIds, [auditRule.id]);
  assert.equal(audited.sampleRate, 10000);
  pass(
    `c. g14-act on both nodes: /json 200 application/json {"ok":true} no-store (HEAD without body); /teapot 418 rule-response with the error page; /drop closed without a response (${(await request({ target: "node", host: HOST.act, path: "/drop" })).error}); /audit logged with rule ${auditRule.id} although the site samples nothing`,
  );

  // ---------------------------------------------------------------- d
  await admin.ok("PUT", `/sites/${sites.crs.id}/logs/settings`, { sampleRate: 10000 });
  await rules(sites.crs.id, [
    [
      "g14 skip crs",
      "waf-custom",
      'starts_with(http.request.uri.path, "/skip/")',
      { kind: "skip", skip: ["crs"] },
    ],
    [
      "g14 crs off",
      "config",
      'starts_with(http.request.uri.path, "/off/")',
      { kind: "config", crs: "off" },
    ],
    [
      "g14 crs detect",
      "config",
      'starts_with(http.request.uri.path, "/detect/")',
      { kind: "config", crs: "detect" },
    ],
  ]);
  const waf = await admin.ok("PATCH", `/sites/${sites.crs.id}/waf`, {
    mode: "block",
    exclusions: [
      { path: "/api/", ruleIds: XSS_DETECTION },
      { path: "/login", exact: true, ruleIds: XSS_DETECTION, targets: ["ARGS:q"] },
    ],
  });
  assert.equal(waf.exclusions.length, 2);
  await synced("g14-crs blocking with skip, overrides and exclusions");
  const crsCase = async (path, status) => {
    for (const target of NODES) {
      const r = await request({ target, host: HOST.crs, path });
      assert.equal(r.status, status, `${target} ${path}: ${summary(r)}`);
      if (status === 403) assert.equal(r.headers["x-edgeweir-error"], "waf-blocked");
      if (status === 200)
        assert.doesNotMatch(r.body, /x-edgeweir/i, `${path}: the origin saw X-Edgeweir-*`);
    }
  };
  const rid = Date.now().toString(36);
  await crsCase(`/other-${rid}?${XSS_QUERY}`, 403);
  await crsCase(`/skip/a-${rid}?${XSS_QUERY}`, 200);
  await crsCase(`/off/a-${rid}?${XSS_QUERY}`, 200);
  await crsCase(`/detect/a-${rid}?${XSS_QUERY}`, 200);
  await crsCase(`/api/a-${rid}?${XSS_QUERY}`, 200);
  await crsCase(`/apix-${rid}?${XSS_QUERY}`, 403);
  await crsCase(`/api/../other2-${rid}?${XSS_QUERY}`, 403);
  await crsCase(`/login?${XSS_QUERY}&n=${rid}`, 200);
  await crsCase(`/login?r=${encodeURIComponent(XSS)}&n=${rid}`, 403);
  await crsCase(`/login/x-${rid}?${XSS_QUERY}`, 403);
  const [detected] = await sampledLogs(sites.crs.id, `/detect/a-${rid}`);
  assert.ok(detected.wafRuleIds.includes(941100), `detect logged ${detected.wafRuleIds}`);
  assert.equal(detected.wafBlocked, false);
  pass(
    "d. g14-crs (block) on both nodes: the payload 403 on /other, 200 under /skip/ (skip crs), /off/ (crs off) and /detect/ (logged, not blocked); /api/ with 941100, 941110, 941160, 941390 excluded 200, /apix and /api/../other 403; /login with them excluded for ARGS:q only 200 for q, 403 for r and /login/x; the origin never saw X-Edgeweir-*",
  );

  // ---------------------------------------------------------------- e
  const siteBody = await admin.ok("GET", `/sites/${sites.body.id}`);
  await admin.ok("PATCH", `/sites/${sites.body.id}`, {
    contentSettings: { ...siteBody.contentSettings, rulesBodyLimit: 1024 },
  });
  await rules(sites.body.id, [
    ["g14 json cmd", "waf-custom", 'json_value("cmd") eq "rm"', { kind: "block", statusCode: 403 }],
    [
      "g14 form user",
      "waf-custom",
      'form_value("user") eq "admin"',
      { kind: "block", statusCode: 403 },
    ],
    [
      "g14 php upload",
      "waf-custom",
      'http.request.body.filenames contains ".php"',
      { kind: "block", statusCode: 403 },
    ],
    [
      "g14 truncated",
      "waf-custom",
      'http.request.method eq "POST" and http.request.body.truncated eq true',
      { kind: "respond", statusCode: 422, contentType: "text/plain", body: "truncated" },
    ],
  ]);
  await synced("g14-body with body rules and a 1 KiB limit");
  const json = (cmd) => JSON.stringify({ cmd, pad: "x".repeat(20) });
  const multipart = (name) =>
    `--b1\r\nContent-Disposition: form-data; name="f"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\ndata\r\n--b1--\r\n`;
  const big = `blob=${"y".repeat(2000)}`;
  for (const target of NODES) {
    const post = (body, type) => ({
      target,
      host: HOST.body,
      path: "/form",
      method: "POST",
      headers: { "content-type": type },
      body,
    });
    const [rm, ls, admin1, bob, php, png, truncated] = await requests([
      post(json("rm"), "application/json"),
      post(json("ls"), "application/json"),
      post("user=admin&x=1", "application/x-www-form-urlencoded"),
      post("user=bob&x=1", "application/x-www-form-urlencoded"),
      post(multipart("shell.php"), "multipart/form-data; boundary=b1"),
      post(multipart("a.png"), "multipart/form-data; boundary=b1"),
      post(big, "application/x-www-form-urlencoded"),
    ]);
    for (const [label, r] of Object.entries({ rm, admin1, php }))
      assert.equal(r.status, 403, `${target} ${label}: ${summary(r)}`);
    for (const [label, r, body] of [
      ["ls", ls, json("ls")],
      ["bob", bob, "user=bob&x=1"],
      ["png", png, multipart("a.png")],
    ]) {
      assert.equal(r.status, 200, `${target} ${label}: ${summary(r)}`);
      assert.match(
        r.body,
        new RegExp(`received ${Buffer.byteLength(body)} bytes`),
        `${target} ${label}: ${r.body}`,
      );
    }
    assert.equal(truncated.status, 422, `${target} truncated: ${summary(truncated)}`);
    assert.equal(truncated.body, "truncated");
  }
  pass(
    "e. g14-body (limit 1024) on both nodes: JSON cmd=rm, form user=admin and a .php upload 403; the harmless bodies reached the origin whole; a 2 KB body counts as truncated (422)",
  );

  // ---------------------------------------------------------------- f
  const [limitRule] = await rules(sites.rate.id, [
    [
      "g14 login limit",
      "ratelimit",
      'http.request.uri.path eq "/login"',
      { kind: "rate_limit", statusCode: 429, limit: 3, windowSeconds: 60, banSeconds: 120 },
    ],
  ]);
  await synced("g14-rate with a rate limit ban");
  const burst = await requests(
    Array.from({ length: 5 }, () => ({ target: "node", host: HOST.rate, path: "/login" })),
  );
  assert.deepEqual(
    burst.map((r) => r.status),
    [200, 200, 200, 429, 403],
    burst.map(summary).join(", "),
  );
  assert.equal(burst[4].headers["x-edgeweir-error"], "ip-banned");
  const rateBan = await waitFor("the rate limit ban in the ban list", async () => {
    const list = await bansOf(`source=rule&siteId=${sites.rate.id}`);
    return list.length ? list : null;
  });
  assert.equal(rateBan[0].reason, "rate_limit");
  assert.equal(rateBan[0].rule.id, limitRule.id);
  assert.equal(rateBan[0].trigger.threshold, 3);
  for (const ban of rateBan) await admin.ok("DELETE", `/bans/${ban.id}`);
  pass(
    `f. g14-rate: ${burst.map(summary).join(", ")}; the ban list shows reason rate_limit, rule "g14 login limit", threshold 3`,
  );

  // ---------------------------------------------------------------- g
  await run([...compose, "up", "-d", "g14-dns", "node-g14"]);
  let botCluster = (await admin.ok("GET", "/clusters")).find((c) => c.name === BOT_CLUSTER);
  if (!botCluster) botCluster = await admin.ok("POST", "/clusters", { name: BOT_CLUSTER });
  let botNode = (await admin.ok("GET", `/nodes?clusterId=${botCluster.id}`)).find(
    (n) => n.name === BOT_NODE,
  );
  if (!botNode) {
    const group = (await admin.ok("GET", `/node-groups?clusterId=${botCluster.id}`)).find(
      (g) => g.isDefault,
    );
    const token = await admin.ok("POST", "/enrollment-tokens", {
      clusterId: botCluster.id,
      nodeGroupId: group.id,
      nodeName: BOT_NODE,
      ttlMinutes: 15,
    });
    await run(
      [
        "exec",
        "-e",
        "EDGEWEIR_TOKEN",
        await containerId("node-g14"),
        "edgeweir-node",
        "enroll",
        "--server",
        token.serverUrl,
        "--ca-sha256",
        token.caSha256,
      ],
      { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
    );
    botNode = await waitFor("node-g14 enrolled", async () =>
      (await admin.ok("GET", `/nodes?clusterId=${botCluster.id}`)).find((n) => n.name === BOT_NODE),
    );
  } else {
    // A node-g14 of an earlier run remembers its crawler checks; a restart starts it empty.
    await run([...compose, "restart", "node-g14"]);
    await waitFor(
      "node-g14 serving again",
      async () => (await request({ target: "node-g14", host: HOST.bots, path: "/" })).status > 0,
    );
  }
  await everyNode(
    "node-g14 reports challenge-v2",
    (n) => n.supportedFeatures.includes("challenge-v2"),
    [botNode.id],
  );
  const dashed = (ip) => ip.replaceAll(".", "-");
  const records = {
    ptr: {
      [addressA]: `crawl-${dashed(addressA)}.googlebot.com`,
      // client-b's PTR claims Googlebot, but the name points elsewhere.
      [addressB]: `crawl-${dashed(addressB)}.googlebot.com`,
    },
    a: {
      [`crawl-${dashed(addressA)}.googlebot.com`]: [addressA],
      [`crawl-${dashed(addressB)}.googlebot.com`]: ["192.0.2.1"],
    },
  };
  await nodeIn(
    "client-a",
    `fetch("http://g14-dns:8053/records", { method: "PUT", body: process.argv[1] ?? require("fs").readFileSync(0, "utf8") }).then((r) => { if (r.status !== 204) process.exit(1); });`,
    JSON.stringify(records),
  );
  const oldBots = await siteNamed(SITES.bots);
  if (oldBots) await admin.ok("DELETE", `/sites/${oldBots.id}`);
  const { site: bots } = await admin.ok("POST", "/sites", {
    name: SITES.bots,
    domains: [HOST.bots],
    origins: [{ address: "whoami" }],
    clusterId: botCluster.id,
  });
  sites.bots = bots;
  await rules(bots.id, [
    [
      "g14 bot fields",
      "request-transform",
      "true",
      {
        kind: "request_header",
        header: "x-g14-bot",
        expression: 'concat(to_string(http.request.bot.verified), "/", http.request.bot.name)',
      },
    ],
  ]);
  await admin.ok("PATCH", `/sites/${bots.id}/protection`, {
    underAttack: true,
    underAttackChallenge: "js",
    allowVerifiedBots: true,
    challengeText: {
      titleZh: "<访问验证>",
      hintZh: "请稍候 & 继续",
      titleEn: "Checking <you>",
      hintEn: "One moment",
    },
  });
  await synced("g14-bots on node-g14", [botNode.id], botCluster.id);
  const botTarget = "node-g14";
  const [verified] = await requests([
    { target: botTarget, host: HOST.bots, path: "/crawl", headers: { "user-agent": GOOGLEBOT } },
  ]);
  assert.equal(
    verified.status,
    200,
    `verified Googlebot: ${summary(verified)} ${verified.body.slice(0, 200)}`,
  );
  assert.match(verified.body, /X-G14-Bot: true\/googlebot/i, verified.body);
  const fake = await request(
    { target: botTarget, host: HOST.bots, path: "/crawl", headers: { "user-agent": GOOGLEBOT } },
    "client-b",
  );
  assert.equal(fake.status, 403, `fake Googlebot must be challenged: ${summary(fake)}`);
  assert.equal(fake.headers["x-edgeweir-challenge"], "js");
  const human = await request({
    target: botTarget,
    host: HOST.bots,
    path: "/crawl",
    headers: { "user-agent": BROWSER },
  });
  assert.equal(human.status, 403);
  assert.equal(human.headers["x-edgeweir-challenge"], "js");
  const asked = JSON.parse(
    await nodeIn(
      "client-a",
      `fetch("http://g14-dns:8053/queries").then((r) => r.text()).then((t) => process.stdout.write(t));`,
    ),
  );
  assert.ok(
    asked.some((q) => q.type === 12 && q.values[0] === records.ptr[addressA]),
    JSON.stringify(asked),
  );
  pass(
    `g. g14-bots on node-g14 (Under Attack js, verified crawlers allowed): ${addressA} claiming Googlebot with PTR ${records.ptr[addressA]} and its A record 200 (fields true/googlebot); ${addressB} claiming Googlebot, PTR to a name pointing at 192.0.2.1 -> 403 challenge; ${addressA} as a browser -> 403 challenge`,
  );

  // ---------------------------------------------------------------- h
  const [zh, en] = await requests([
    {
      target: botTarget,
      host: HOST.bots,
      path: "/page",
      headers: { "accept-language": "zh-CN", "user-agent": BROWSER },
    },
    {
      target: botTarget,
      host: HOST.bots,
      path: "/page",
      headers: { "accept-language": "en", "user-agent": BROWSER },
    },
  ]);
  assert.match(zh.body, /<title>&lt;访问验证&gt;<\/title>/, zh.body.slice(0, 400));
  assert.ok(zh.body.includes("请稍候 &amp; 继续"), "the Chinese hint, escaped");
  assert.match(en.body, /<title>Checking &lt;you&gt;<\/title>/);
  assert.ok(en.body.includes("One moment"));
  assert.ok(!zh.body.includes("<访问验证>"), "texts must be escaped");
  pass("h. g14-bots challenge pages: the Chinese and English titles and hints, HTML-escaped");

  // ---------------------------------------------------------------- i
  await admin.ok("PATCH", `/sites/${sites.fail.id}/protection`, {
    underAttack: true,
    underAttackChallenge: "js",
    failureBan: { enabled: true, threshold: 3, banSeconds: 120 },
  });
  await synced("g14-fail with challenge failure bans");
  const verify = {
    target: "node",
    host: HOST.fail,
    path: "/.edgeweir/challenge/verify",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "t=forged.token.value&a=0&r=%2F",
  };
  const attempts = await requests([verify, verify, verify]);
  const banned = await request({ target: "node", host: HOST.fail, path: "/" });
  assert.equal(summary(banned), "403 ip-banned", `after three failures: ${summary(banned)}`);
  const failureBan = await waitFor("the challenge failure ban in the ban list", async () => {
    const list = (await bansOf(`siteId=${sites.fail.id}&source=auto`)).filter(
      (b) => b.reason === "challenge_failures",
    );
    return list.length ? list : null;
  });
  assert.equal(failureBan[0].trigger.threshold, 3);
  for (const ban of failureBan) await admin.ok("DELETE", `/bans/${ban.id}`);
  pass(
    `i. g14-fail: three failed answers (${attempts.map((r) => r.status).join(", ")}) banned ${addressA} (403 ip-banned; reason challenge_failures, threshold 3)`,
  );

  // ---------------------------------------------------------------- j
  // The top CRS rules of g14-crs come with the nodes' minute reports;
  // apps/console/e2e/g14.spec.ts excludes one by path from that list.
  let top = [];
  await waitFor(
    "the payload's rules in g14-crs's top CRS rules",
    async () => {
      top = (await admin.ok("GET", `/sites/${sites.crs.id}/waf/rules?range=1h`)).items;
      return XSS_DETECTION.every((rule) => top.some((item) => item.ruleId === rule));
    },
    240,
    5000,
    () => JSON.stringify(top),
  );
  pass(`j. g14-crs top CRS rules: ${top.map((t) => `${t.ruleId}×${t.requests}`).join(", ")}`);

  finished = true;
  console.log("G14 OK");
} finally {
  if (!finished)
    console.error("G14 failed; `node scripts/e2e-g14.mjs --cleanup` removes its sites");
}
