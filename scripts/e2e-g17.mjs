// Site parity G17 end to end (tags, batch operations, copying settings and
// cloning), after the G14 step. `node` and `node-upgrade-peer` serve the
// default cluster; every request goes from client-a to one of them by name.
// Origins g15-origin-a and g15-origin-b answer "<name> <method> <path>".
//   a. sites: src.g17.test (origin a, origin b in group "b") with cache
//      rules, a cache key that ignores the query and rules (a block, an
//      origin rule to group "b", a response header); t1 and t2 (origins a
//      and b, no rules or cache rules); bad.g17.test (origin a only). Tags:
//      t1 and t2 get "g17-copy" in one batch; the list filters by it (any
//      and all)
//   b. before the copy, on both nodes, t1 and t2 pass /blocked to the
//      origin, send /b/ to origin a and cache nothing
//   c. the preview: t1 and t2 change their cache rules, cache key and rules;
//      bad fails with ORIGIN_GROUP_UNKNOWN; nothing changed
//   d. copying rules, cache rules and cache key to t1, t2 and bad: t1 and t2
//      copied (audited with the source), bad failed and unchanged
//   e. on both nodes t1 and t2 serve the copied settings: /blocked 403,
//      /b/ from origin b, x-g17 on responses, /static/ cached with the query
//      left out of the key; bad still passes /blocked
//   f. clone.g17.test, a clone of src: the same behaviour, the tags of src
//   g. batch: turning t1 and t2 off publishes the cluster once and both
//      nodes answer them with the disabled page (503 site-disabled); on
//      again, they are served
// The sites stay for apps/console/e2e/g17.spec.ts (.e2e/g17-state.json);
// `node scripts/e2e-g17.mjs --cleanup` removes them and the G17 tags.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g17-state.json";

const HOST = {
  src: "src.g17.test",
  t1: "t1.g17.test",
  t2: "t2.g17.test",
  bad: "bad.g17.test",
  clone: "clone.g17.test",
};
const TAGS = ["g17-copy", "g17-source"];
const NODES = ["node", "node-upgrade-peer"];
const PARTS = ["cacheRules", "cacheKey", "rules"];

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

/** Raw /api/v1 call: { status, json, text }. */
async function call(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function createKey(cookie) {
  return (await rpc(base, cookie, "accessKeys/create", { name: "g17-e2e" })).key;
}

/** The signed-in operator with an AccessKey, renewed every 500 calls (600 per idle minute). */
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

/** Sequential HTTP GETs from client-a: status, headers and body of each. */
const REQUESTS = `
const http = require("node:http");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const list = JSON.parse(input);
  const one = (r) => new Promise((resolve) => {
    const req = http.request({ host: r.target, port: 80, path: r.path, method: "GET",
      headers: { host: r.host }, agent: false, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
    req.end();
  });
  const out = [];
  for (const r of list) out.push(await one(r));
  process.stdout.write(JSON.stringify(out));
});`;
const requests = async (list) =>
  JSON.parse(await nodeIn("client-a", REQUESTS, JSON.stringify(list)));
const summary = (r) =>
  `${r.status} ${r.headers["x-cache"] ?? "-"} ${r.headers["x-edgeweir-error"] ?? "-"} ${r.headers["x-g17"] ?? "-"}${r.error ? ` ${r.error}` : ""} ${JSON.stringify(r.body.slice(0, 80))}`;

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
const latestRevision = async () =>
  (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
async function synced(label = "nodes on the latest revision") {
  const latest = await latestRevision();
  await waitFor(
    `${label} (#${latest})`,
    async () => {
      lastNodes = [await nodeById(edgeId), await nodeById(peerId)];
      return lastNodes.every(
        (n) =>
          n.online &&
          n.dataPlaneHealthy &&
          n.applyState === "applied" &&
          n.appliedRevision >= latest,
      );
    },
    180,
    1000,
    () =>
      JSON.stringify(
        lastNodes.map((n) => ({ name: n.name, applied: n.appliedRevision, state: n.applyState })),
      ),
  );
  return latest;
}
const findSite = async (domain) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(domain)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(domain),
  );
const tagsByName = async () =>
  new Map((await admin.ok("GET", "/site-tags")).map((tag) => [tag.name, tag]));

async function cleanup() {
  let removed = 0;
  const ids = [];
  for (const host of Object.values(HOST)) {
    const site = await findSite(host);
    if (site) ids.push(site.id);
  }
  if (ids.length) {
    await admin.ok("POST", "/sites/batch/delete", { ids });
    removed = ids.length;
  }
  const tags = await tagsByName();
  for (const name of TAGS) {
    const tag = tags.get(name);
    if (tag) await admin.ok("DELETE", `/site-tags/${tag.id}`);
  }
  pass(`G17 cleanup: ${removed} site(s) and the G17 tags removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

const originA = { address: "g15-origin-a", port: 8080 };
const originB = { address: "g15-origin-b", port: 8080, group: "b" };
async function createSite(name, domain, origins, extra = {}) {
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains: [domain],
    origins,
    clusterId,
    ...extra,
  });
  return site;
}
/** A request per node, all to `host`. */
const onEveryNode = (host, path) => requests(NODES.map((target) => ({ target, host, path })));

let finished = false;
try {
  // -------------------------------------------------------------- a. sites and tags
  for (const host of Object.values(HOST)) {
    const stale = await findSite(host);
    if (stale) await admin.ok("DELETE", `/sites/${stale.id}`);
  }
  const src = await createSite("g17-src", HOST.src, [originA, originB], {
    cacheRules: [
      { pathPrefixes: ["/static/"], edgeTtlSeconds: 600, originCacheControl: "override" },
    ],
    cacheSettings: { cacheKey: { query: "ignore" } },
    tags: ["g17-source"],
  });
  await admin.ok("PUT", `/sites/${src.id}/rules`, {
    rules: [
      {
        name: "blocked",
        phase: "waf-custom",
        enabled: true,
        expression: 'starts_with(http.request.uri.path, "/blocked")',
        action: { kind: "block" },
      },
      {
        name: "to-b",
        phase: "origin",
        enabled: true,
        expression: 'starts_with(http.request.uri.path, "/b/")',
        action: { kind: "origin", originGroup: "b" },
      },
      {
        name: "marker",
        phase: "response-transform",
        enabled: true,
        expression: "true",
        action: { kind: "response_header", header: "x-g17", value: "copied" },
      },
    ],
  });
  const t1 = await createSite("g17-t1", HOST.t1, [originA, originB]);
  const t2 = await createSite("g17-t2", HOST.t2, [originA, originB]);
  const bad = await createSite("g17-bad", HOST.bad, [originA]);
  const tagged = await admin.ok("POST", "/sites/batch/tags", {
    ids: [t1.id, t2.id],
    add: ["g17-copy"],
  });
  assert.equal(tagged.changed.length, 2);
  const tags = await tagsByName();
  const copyTag = tags.get("g17-copy");
  const sourceTag = tags.get("g17-source");
  assert.ok(copyTag && sourceTag, "tags missing");
  const listed = await admin.ok("GET", `/sites?tagIds[]=${copyTag.id}&pageSize=100`);
  assert.deepEqual(listed.items.map((s) => s.id).sort(), [t1.id, t2.id].sort());
  const both = await admin.ok(
    "GET",
    `/sites?tagIds[]=${copyTag.id}&tagIds[]=${sourceTag.id}&tagMatch=all&pageSize=100`,
  );
  assert.equal(both.items.length, 0);
  pass("t1 and t2 tagged g17-copy in one batch; the list filters by the tag (any and all)");

  // -------------------------------------------------------------- b. before the copy
  await synced("the G17 sites");
  for (const host of [HOST.t1, HOST.t2]) {
    for (const r of await onEveryNode(host, "/blocked"))
      assert.equal(r.status, 200, `${host} /blocked before the copy: ${summary(r)}`);
    for (const r of await onEveryNode(host, "/b/x"))
      assert.match(r.body, /^a GET \/b\/x/, `${host} /b/x before the copy: ${summary(r)}`);
    for (const target of NODES) {
      const pair = await requests([
        { target, host, path: "/static/before?v=1" },
        { target, host, path: "/static/before?v=1" },
      ]);
      for (const r of pair) {
        assert.notEqual(r.headers["x-cache"], "HIT", `${host} on ${target}: ${summary(r)}`);
        assert.equal(r.headers["x-g17"], undefined, `${host} on ${target}: ${summary(r)}`);
      }
    }
  }
  pass(
    "before the copy t1 and t2 pass /blocked, send /b/ to origin a and add no x-g17 on both nodes",
  );

  // -------------------------------------------------------------- c. preview
  const revisionBefore = await latestRevision();
  const query = [t1.id, t2.id, bad.id].map((id) => `targetIds[]=${id}`).join("&");
  const preview = await admin.ok(
    "GET",
    `/sites/${src.id}/copy-settings?${query}&${PARTS.map((p) => `parts[]=${p}`).join("&")}`,
  );
  const [p1, p2, pBad] = preview.targets;
  for (const target of [p1, p2]) {
    assert.equal(target.error, null);
    assert.deepEqual(
      target.changes.map((c) => [c.part, c.changed, c.before, c.after]),
      [
        ["cacheRules", true, 0, 1],
        ["cacheKey", true, null, null],
        ["rules", true, 0, 3],
      ],
    );
  }
  assert.equal(pBad.error.code, "ORIGIN_GROUP_UNKNOWN");
  assert.deepEqual(pBad.error.data, { group: "b", rule: "to-b" });
  assert.equal(await latestRevision(), revisionBefore, "the preview published");
  pass(
    `preview: t1 and t2 cache rules 0 → 1, cache key, rules 0 → 3; bad fails (${pBad.error.code} ${JSON.stringify(pBad.error.data)}); nothing published`,
  );

  // -------------------------------------------------------------- d. copy
  const copied = await admin.ok("POST", `/sites/${src.id}/copy-settings`, {
    targetIds: [t1.id, t2.id, bad.id],
    parts: PARTS,
  });
  assert.deepEqual(
    copied.targets.map((t) => [t.name, t.ok, t.error?.code ?? null]),
    [
      ["g17-t1", true, null],
      ["g17-t2", true, null],
      ["g17-bad", false, "ORIGIN_GROUP_UNKNOWN"],
    ],
  );
  for (const target of [t1, t2]) {
    const audit = await admin.ok("GET", "/audit-logs?action=site.settings_copied&limit=20");
    const entry = audit.items.find((e) => e.targetId === target.id);
    assert.ok(entry, `no site.settings_copied entry for ${target.name}`);
    assert.deepEqual(entry.metadata.source, { id: src.id, name: "g17-src" });
    assert.deepEqual(entry.metadata.changed, PARTS);
  }
  const badRules = await admin.ok("GET", `/sites/${bad.id}/rules`);
  assert.equal(badRules.length, 0, "bad got rules");
  assert.equal(
    (await admin.ok("GET", `/sites/${bad.id}`)).cacheRules.length,
    0,
    "bad got cache rules",
  );
  pass(
    "copied to t1 and t2 (audited with the source and the parts); bad failed and kept its settings",
  );

  // -------------------------------------------------------------- e. nodes serve the copy
  await synced("the copied settings");
  const servesCopy = async (host) => {
    for (const r of await onEveryNode(host, "/blocked"))
      assert.equal(r.status, 403, `${host} /blocked: ${summary(r)}`);
    for (const r of await onEveryNode(host, "/b/x")) {
      assert.match(r.body, /^b GET \/b\/x/, `${host} /b/x: ${summary(r)}`);
      assert.equal(r.headers["x-g17"], "copied", `${host} /b/x: ${summary(r)}`);
    }
    for (const target of NODES) {
      const [first, second] = await requests([
        { target, host, path: "/static/page?v=1" },
        { target, host, path: "/static/page?v=2" },
      ]);
      assert.equal(first.status, 200, `${host} on ${target}: ${summary(first)}`);
      assert.equal(
        second.headers["x-cache"],
        "HIT",
        `${host} on ${target}, query ignored: ${summary(second)}`,
      );
    }
  };
  await servesCopy(HOST.t1);
  await servesCopy(HOST.t2);
  for (const r of await onEveryNode(HOST.bad, "/blocked"))
    assert.equal(r.status, 200, `bad /blocked: ${summary(r)}`);
  pass(
    "both nodes serve t1 and t2 with the copied settings: /blocked 403, /b/ from origin b, x-g17, /static/ cached with the query left out; bad unchanged",
  );

  // -------------------------------------------------------------- f. clone
  const cloned = await admin.ok("POST", `/sites/${src.id}/clone`, { domains: [HOST.clone] });
  assert.deepEqual(
    cloned.site.tags.map((t) => t.name),
    ["g17-source"],
  );
  assert.equal(cloned.revision.reasonCode, "site_cloned");
  await synced("the clone");
  await servesCopy(HOST.clone);
  pass(
    `clone.g17.test (${cloned.site.name}) carries src's tags and serves its settings on both nodes`,
  );

  // -------------------------------------------------------------- g. batch on / off
  const before = await latestRevision();
  const off = await admin.ok("POST", "/sites/batch/enabled", {
    ids: [t1.id, t2.id],
    enabled: false,
  });
  assert.equal(off.changed.length, 2);
  assert.deepEqual(
    off.revisions.map((r) => [r.clusterId, r.revision]),
    [[clusterId, before + 1]],
  );
  assert.equal(await latestRevision(), before + 1, "more than one revision for the batch");
  await synced("t1 and t2 off");
  for (const host of [HOST.t1, HOST.t2])
    for (const r of await onEveryNode(host, "/x")) {
      assert.equal(r.status, 503, `${host} off: ${summary(r)}`);
      assert.equal(r.headers["x-edgeweir-error"], "site-disabled", `${host} off: ${summary(r)}`);
    }
  await admin.ok("POST", "/sites/batch/enabled", { ids: [t1.id, t2.id], enabled: true });
  await synced("t1 and t2 on");
  for (const host of [HOST.t1, HOST.t2])
    for (const r of await onEveryNode(host, "/blocked"))
      assert.equal(r.status, 403, `${host} on again: ${summary(r)}`);
  pass(
    "batch: t1 and t2 off in one revision (503 site-disabled on both nodes), on again and served",
  );

  await writeFile(
    STATE,
    JSON.stringify({ src: src.id, t1: t1.id, t2: t2.id, bad: bad.id, clone: cloned.site.id }),
  );
  finished = true;
  pass("G17 end-to-end checks passed");
} finally {
  if (!finished)
    console.error("G17 failed: the sites stay for inspection (--cleanup removes them)");
}
