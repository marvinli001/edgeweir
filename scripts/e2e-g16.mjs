// Site parity G16 end to end (access logs and statistics, ADR-0041), after
// G14. `node` and `node-upgrade-peer` serve the default cluster; client-a and
// client-b send the requests (the GeoIP fixture puts the e2e network in NZ,
// AS64513 "Synthetic AS64513"); whoami is the origin.
//   a. both nodes report access-logs-v2 and stats-dims-v1; the site's
//      features allow the log options
//   b. g16-logs (sample 100%, query string and X-Trace-Id recorded, cached):
//      a line carries User-Agent, Referer without its query, HTTP 1.1, http,
//      NZ / AS64513 with its name, the query string and the header, request
//      bytes, text/plain and the origin (address, 200, time) on the MISS; the
//      HIT names no origin
//   c. g16-block samples nothing: a request a rule blocks leaves no line
//      while blocked requests are not logged; once they are, a blocked
//      request (403, reason rule with the rule id) and a rate limited one
//      (429, reason rate_limit) get lines with sample rate 100%, a request
//      that passes does not
//   d. every new filter: Host, method, status class, cache status, block
//      reason (and any), country, ASN, User-Agent and Referer contain,
//      minimum duration, CIDR
//   e. retention: 1 PostgreSQL day leaves only today's and tomorrow's
//      partitions within the minute's maintenance; 7 brings the week back
//   f. `edgeweir-node accesslog --json --site <g16-block>` prints the
//      requests of that site while it runs (none sampled), not another
//      site's; the text form prints them too; nothing is collected after it
//      exits
//   g. statistics dimensions appear after the traffic: NZ, AS64513 with its
//      name, the referring host, chrome / windows / desktop, HTTP 1.1, no
//      TLS, block reasons rule and rate_limit; the overview's countries
//      include NZ
// `node scripts/e2e-g16.mjs --cleanup` removes its sites and those
// apps/console/e2e/g16.spec.ts leaves (g16-ui-*) and resets the retention.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = { logs: "logs.g16.test", block: "block.g16.test" };
const SITES = { logs: "g16-logs", block: "g16-block" };
const G16_FEATURES = ["access-logs-v2", "stats-dims-v1"];
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const REFERER = "https://ref.g16.example/from?secret=g16";
const RUN = Date.now().toString(36);

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
  const key = (await rpc(base, cookie, "accessKeys/create", { name: "g16-e2e" })).key;
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
const request = async (r, client = "client-a") => (await requests([r], client))[0];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
const clientAddress = async (client) =>
  (
    await nodeIn(
      client,
      `const a = Object.values(require("node:os").networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal); process.stdout.write(a.address);`,
    )
  ).trim();
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
  for (const name of Object.values(SITES)) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  // apps/console/e2e/g16.spec.ts leaves g16-ui-<run>.
  for (const site of (await admin.ok("GET", "/sites?search=g16-ui-&pageSize=100")).items)
    if (site.name.startsWith("g16-ui-")) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  await admin.ok("PUT", "/settings/log-retention", { postgresDays: 7, clickhouseDays: 7 });
  console.log(`G16 cleanup: ${removed} site(s), log retention 7 / 7 days`);
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
const logsOf = async (siteId, filter = {}) => {
  const query = new URLSearchParams({
    from: new Date(Date.now() - 600_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    limit: "1000",
    ...filter,
  });
  return (await admin.ok("GET", `/sites/${siteId}/logs?${query}`)).entries;
};
/** Waits until the site's log has `count` lines of `path`. */
const linesOf = async (siteId, path, count = 1) => {
  let entries = [];
  await waitFor(
    `access log of ${path}`,
    async () => {
      entries = (await logsOf(siteId, { path })).filter((e) => e.path === path);
      return entries.length >= count;
    },
    120,
    2000,
    () => `${entries.length} line(s)`,
  );
  return entries;
};

let finished = false;
try {
  // ---------------------------------------------------------------- a
  const nodes = await everyNode("nodes report the G16 features", (n) =>
    G16_FEATURES.every((f) => n.supportedFeatures.includes(f)),
  );
  const sites = {
    logs: await createSite(SITES.logs, HOST.logs),
    block: await createSite(SITES.block, HOST.block),
  };
  const features = await admin.ok("GET", `/sites/${sites.logs.id}/features`);
  assert.deepEqual(features.accessLogsV2, { available: true, reason: null });
  pass(
    `a. ${nodes.map((n) => n.name).join(", ")} report ${G16_FEATURES.join(", ")}; the log options are available`,
  );

  // ---------------------------------------------------------------- b
  await admin.ok("PUT", `/sites/${sites.logs.id}/logs/settings`, {
    sampleRate: 10000,
    logQuery: true,
    logHeaders: ["X-Trace-Id"],
  });
  await synced("g16-logs samples every request");
  const fieldsPath = `/fields-${RUN}`;
  const headers = { "user-agent": CHROME, referer: REFERER, "x-trace-id": `t-${RUN}` };
  const [miss, hit] = await requests([
    { target: "node", host: HOST.logs, path: `${fieldsPath}?x=1`, headers },
    { target: "node", host: HOST.logs, path: `${fieldsPath}?x=1`, headers },
  ]);
  assert.equal(miss.status, 200, summary(miss));
  assert.equal(hit.status, 200, summary(hit));
  const fieldLines = await linesOf(sites.logs.id, fieldsPath, 2);
  const missLine = fieldLines.find((e) => e.cacheStatus === "MISS");
  const hitLine = fieldLines.find((e) => e.cacheStatus === "HIT");
  assert.ok(missLine && hitLine, JSON.stringify(fieldLines.map((e) => e.cacheStatus)));
  assert.equal(missLine.userAgent, CHROME);
  assert.equal(missLine.referer, "https://ref.g16.example/from");
  assert.ok(!JSON.stringify(fieldLines).includes("secret=g16"));
  assert.equal(missLine.httpVersion, "1.1");
  assert.equal(missLine.scheme, "http");
  assert.equal(missLine.tlsVersion, "");
  assert.equal(missLine.country, "NZ");
  assert.equal(missLine.asn, 64513);
  assert.equal(missLine.asName, "Synthetic AS64513");
  assert.equal(missLine.query, "x=1");
  assert.deepEqual(missLine.headers, { "x-trace-id": `t-${RUN}` });
  assert.ok(missLine.requestBytes > 0, `request bytes ${missLine.requestBytes}`);
  assert.equal(missLine.contentType, "text/plain");
  assert.equal(missLine.upstreamStatus, 200);
  assert.match(missLine.upstreamAddr, /:80$/);
  assert.ok(missLine.upstreamMs >= 0);
  assert.equal(missLine.blockReason, "");
  assert.equal(hitLine.upstreamStatus, 0);
  assert.equal(hitLine.upstreamAddr, "");
  pass(
    `b. g16-logs: UA, Referer ${missLine.referer}, HTTP/${missLine.httpVersion} ${missLine.scheme}, ${missLine.country} AS${missLine.asn} ${missLine.asName}, query ${missLine.query}, x-trace-id, ${missLine.requestBytes} B in, ${missLine.contentType}; MISS from ${missLine.upstreamAddr} ${missLine.upstreamStatus} in ${missLine.upstreamMs} ms, HIT without origin`,
  );

  // ---------------------------------------------------------------- c
  const [blockRule, limitRule] = await rules(sites.block.id, [
    [
      "g16 block",
      "waf-custom",
      'starts_with(http.request.uri.path, "/blocked")',
      { kind: "block" },
    ],
    [
      "g16 limit",
      "ratelimit",
      'starts_with(http.request.uri.path, "/limited")',
      { kind: "rate_limit", statusCode: 429, limit: 1, windowSeconds: 60 },
    ],
  ]);
  await synced("g16-block with a block and a rate limit rule");
  const before = await request({
    target: "node",
    host: HOST.block,
    path: `/blocked-before-${RUN}`,
  });
  assert.equal(before.status, 403, summary(before));
  await admin.ok("PUT", `/sites/${sites.block.id}/logs/settings`, { logBlocked: true });
  await synced("g16-block logs blocked requests");
  const blockedPath = `/blocked-${RUN}`;
  const limitedPath = `/limited-${RUN}`;
  const passedPath = `/passed-${RUN}`;
  const burst = await requests([
    {
      target: "node",
      host: HOST.block,
      path: blockedPath,
      headers: { "user-agent": "curl/8.9.1" },
    },
    { target: "node", host: HOST.block, path: limitedPath },
    { target: "node", host: HOST.block, path: limitedPath },
    { target: "node", host: HOST.block, path: passedPath },
  ]);
  assert.deepEqual(
    burst.map((r) => r.status),
    [403, 200, 429, 200],
    burst.map(summary).join(", "),
  );
  const [blockedLine] = await linesOf(sites.block.id, blockedPath);
  assert.equal(blockedLine.status, 403);
  assert.equal(blockedLine.blockReason, "rule");
  assert.equal(blockedLine.blockRuleId, blockRule.id);
  assert.equal(blockedLine.sampleRate, 10000);
  const limitedLines = await linesOf(sites.block.id, limitedPath);
  assert.equal(limitedLines.length, 1, "only the refused request is logged");
  assert.equal(limitedLines[0].status, 429);
  assert.equal(limitedLines[0].blockReason, "rate_limit");
  assert.equal(limitedLines[0].blockRuleId, limitRule.id);
  const blockLog = await logsOf(sites.block.id);
  assert.ok(!blockLog.some((e) => e.path === passedPath), "a request that passes is not logged");
  assert.ok(
    !blockLog.some((e) => e.path === `/blocked-before-${RUN}`),
    "blocked before the option: no line",
  );
  pass(
    `c. g16-block (sample rate 0): no line before the option; then 403 rule ${blockRule.id.slice(0, 8)}… and 429 rate_limit logged at 100%, the passing request not`,
  );

  // ---------------------------------------------------------------- d
  const clientA = await clientAddress("client-a");
  const ids = async (siteId, filter) =>
    (await logsOf(siteId, filter))
      .filter((e) => e.path.endsWith(RUN) || e.path.includes(`-${RUN}`))
      .map((e) => e.path)
      .sort();
  const checks = [
    [sites.logs.id, { host: HOST.logs.toUpperCase() }, [fieldsPath, fieldsPath]],
    [sites.logs.id, { method: "post" }, []],
    [sites.logs.id, { method: "get", cacheStatus: "HIT" }, [fieldsPath]],
    [sites.block.id, { statusClass: "4xx" }, [blockedPath, limitedPath]],
    [sites.block.id, { statusClass: "4xx", status: "429" }, [limitedPath]],
    [sites.block.id, { blockReason: "any" }, [blockedPath, limitedPath]],
    [sites.block.id, { blockReason: "rate_limit" }, [limitedPath]],
    [sites.logs.id, { country: "nz", asn: "64513" }, [fieldsPath, fieldsPath]],
    [sites.logs.id, { country: "AU" }, []],
    [sites.logs.id, { ua: "CHROME/129" }, [fieldsPath, fieldsPath]],
    [sites.block.id, { ua: "curl" }, [blockedPath]],
    [sites.logs.id, { referer: "REF.g16.example" }, [fieldsPath, fieldsPath]],
    [sites.logs.id, { minDuration: "86400000" }, []],
    [sites.logs.id, { minDuration: "0", cidr: `${clientA}/32` }, [fieldsPath, fieldsPath]],
    [sites.logs.id, { cidr: "10.0.0.0/8" }, []],
  ];
  for (const [siteId, filter, expected] of checks)
    assert.deepEqual(await ids(siteId, filter), [...expected].sort(), JSON.stringify(filter));
  const badCidr = await admin.raw(
    "GET",
    `/sites/${sites.logs.id}/logs?${new URLSearchParams({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString(), cidr: "10.0.0.0/33" })}`,
  );
  assert.equal(badCidr.status, 400);
  pass(`d. ${checks.length} filter combinations match; an invalid CIDR is 400`);

  // ---------------------------------------------------------------- e
  const partitions = async () =>
    (
      await psql(
        "select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='access_log'::regclass order by 1",
      )
    )
      .split("\n")
      .filter(Boolean);
  const day = (offset) =>
    `access_log_${new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "")}`;
  const week = await partitions();
  assert.ok(week.includes(day(-6)) && week.includes(day(1)), week.join(" "));
  await admin.ok("PUT", "/settings/log-retention", { postgresDays: 1, clickhouseDays: 7 });
  const one = await waitFor(
    "partitions follow 1 day",
    async () => {
      const list = await partitions();
      return list.length === 2 && list[0] === day(0) && list[1] === day(1) ? list : null;
    },
    150,
    5000,
  );
  await admin.ok("PUT", "/settings/log-retention", { postgresDays: 7, clickhouseDays: 7 });
  const back = await waitFor(
    "partitions follow 7 days",
    async () => {
      const list = await partitions();
      return list.includes(day(-6)) ? list : null;
    },
    150,
    5000,
  );
  pass(`e. retention 1 day keeps ${one.join(", ")}; 7 days brings back ${back.length} partitions`);

  // ---------------------------------------------------------------- f
  const node = await containerId("node");
  /** Runs `edgeweir-node accesslog ...args` in `node` for `ms` while `during` runs; stdout. */
  const tap = (args, ms, during) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("docker", ["exec", "-i", node, "edgeweir-node", "accesslog", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", reject);
      child.on("close", () =>
        resolvePromise({
          out: Buffer.concat(out).toString("utf8"),
          err: Buffer.concat(err).toString("utf8"),
        }),
      );
      setTimeout(async () => {
        try {
          await during();
          await sleep(ms);
        } finally {
          // SIGINT reaches the CLI through docker exec -i.
          child.kill("SIGINT");
          setTimeout(() => child.kill("SIGKILL"), 5000);
        }
      }, 1500);
    });
  const tapPath = `/tap-${RUN}`;
  const json = await tap(["--json", "--site", sites.block.id], 2500, async () => {
    const r = await requests([
      { target: "node", host: HOST.block, path: `${tapPath}-1`, headers: { "user-agent": CHROME } },
      { target: "node", host: HOST.block, path: `${tapPath}-2` },
      { target: "node", host: HOST.logs, path: `${tapPath}-other` },
    ]);
    assert.deepEqual(
      r.map((x) => x.status),
      [200, 200, 200],
    );
  });
  const tapped = json.out
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
  const tappedPaths = tapped.map((e) => e.path);
  assert.ok(
    tappedPaths.includes(`${tapPath}-1`) && tappedPaths.includes(`${tapPath}-2`),
    json.out + json.err,
  );
  assert.ok(!tappedPaths.includes(`${tapPath}-other`), "another site's request");
  const first = tapped.find((e) => e.path === `${tapPath}-1`);
  assert.equal(first.status, 200);
  assert.equal(first.site_id ?? first.siteId, sites.block.id);
  assert.equal(first.user_agent ?? first.userAgent, CHROME);
  const text = await tap(["--site", sites.block.id], 2000, async () => {
    await request({ target: "node", host: HOST.block, path: `${tapPath}-text` });
  });
  const textLine = text.out.split("\n").find((l) => l.includes(`${tapPath}-text`));
  assert.ok(textLine, text.out + text.err);
  assert.match(textLine, / 200 /);
  // g16-block samples nothing: none of these reached the access log.
  await sleep(12_000);
  assert.ok(!(await logsOf(sites.block.id)).some((e) => e.path.startsWith(tapPath)));
  pass(
    `f. accesslog --json --site printed ${tapped.length} request(s) of g16-block (not g16-logs); text: ${textLine.trim().slice(0, 100)}; none sampled`,
  );

  // ---------------------------------------------------------------- g
  let dims;
  await waitFor(
    "statistics dimensions after the traffic",
    async () => {
      dims = await admin.ok("GET", `/analytics/dimensions?range=1h&siteId=${sites.logs.id}`);
      return (
        dims.countries.some((c) => c.country === "NZ") &&
        dims.asns.some((a) => a.asn === 64513) &&
        dims.referers.some((r) => r.host === "ref.g16.example") &&
        dims.browsers.some((b) => b.key === "chrome")
      );
    },
    200,
    5000,
    () => JSON.stringify(dims),
  );
  assert.equal(dims.asns.find((a) => a.asn === 64513).name, "Synthetic AS64513");
  assert.ok(
    dims.oses.some((o) => o.key === "windows"),
    JSON.stringify(dims.oses),
  );
  assert.ok(
    dims.devices.some((d) => d.key === "desktop"),
    JSON.stringify(dims.devices),
  );
  assert.ok(
    dims.httpVersions.some((v) => v.key === "1.1"),
    JSON.stringify(dims.httpVersions),
  );
  assert.ok(
    dims.tlsVersions.some((v) => v.key === "none"),
    JSON.stringify(dims.tlsVersions),
  );
  assert.ok(dims.countries.find((c) => c.country === "NZ").bytesSent > 0);
  assert.equal(dims.unsupportedNodes, 0);
  let blockDims;
  await waitFor(
    "block reasons in the statistics",
    async () => {
      blockDims = await admin.ok("GET", `/analytics/dimensions?range=1h&siteId=${sites.block.id}`);
      const keys = blockDims.blockReasons.map((r) => r.key);
      return keys.includes("rule") && keys.includes("rate_limit");
    },
    200,
    5000,
    () => JSON.stringify(blockDims?.blockReasons),
  );
  const overview = await admin.ok("GET", "/analytics/dimensions?range=1h");
  assert.ok(overview.countries.some((c) => c.country === "NZ"));
  pass(
    `g. dimensions: ${dims.countries.map((c) => `${c.country || "?"} ${c.requests}`).join(", ")}; AS64513 ${dims.asns[0]?.name}; referrer ${dims.referers[0]?.host}; ${dims.browsers.map((b) => b.key).join("/")}; block reasons ${blockDims.blockReasons.map((r) => `${r.key} ${r.requests}`).join(", ")}; overview NZ`,
  );

  finished = true;
  console.log("G16 OK");
} finally {
  if (!finished)
    console.error("G16 failed; `node scripts/e2e-g16.mjs --cleanup` removes its sites");
}
