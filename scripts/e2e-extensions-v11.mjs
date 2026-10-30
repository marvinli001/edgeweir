// Node extensions version 1.1 (docs/reference/extensions.md) on the core node
// edge-e2e-1 with two real packages as fixtures, signed in the node
// container with a fresh key trusted for the publisher edgeweir-official:
//   a. the node reports extensions-v2 (Lua API 2)
//   b. Precursor (E2E_PRECURSOR_PACKAGE: its package/ directory), Lua API 2
//      with a console secret: enforce mode shows the interstitial with a
//      token signed by the secret; a report with the proof of work gets a
//      session cookie that lets the browser through; a report with the
//      webdriver flag gets a session that is denied (403 extension-denied);
//      rotating the secret keeps the old session valid once (previous
//      secret) and ends it after the second rotation; the node reports no
//      faults
//   c. edge-compute (E2E_EDGE_COMPUTE_PACKAGE: its package/ directory;
//      E2E_EDGE_COMPUTE_BUILD: ew-compute for linux-amd64 and the
//      components fn-hello-v1.wasm, fn-rewrite-v1.wasm, fn-probe-v1.wasm),
//      a sidecar with per-site data: functions and deploy.json uploaded as
//      site data, the node runs the sidecar as edgeweir-sidecar and reports
//      it running; a function answers, a function fetching the site reaches
//      the origin through the origin socket, passThroughOnException falls
//      through to the origin on an open route and is served through the
//      origin socket on a closed one; new data (deploy.json) reaches the
//      sidecar; with the sidecar down a closed route answers 502 and an open
//      one the origin, and the node restarts it; off for the site the
//      origin answers; uninstalled, the node stops the sidecar and deletes
//      its directory
// A part whose fixture variable is unset is skipped. The packages live in
// the private edgeweir-cloud repository (extensions/precursor,
// extensions/edge-compute); ew-compute and the components are built there.
// `node scripts/e2e-extensions-v11.mjs --cleanup` removes what it created.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { actor, pass, sleep, stack, waitFor } from "./e2e-lib.mjs";

const nodePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const PRECURSOR = process.env.E2E_PRECURSOR_PACKAGE;
const COMPUTE = process.env.E2E_EDGE_COMPUTE_PACKAGE;
const COMPUTE_BUILD = process.env.E2E_EDGE_COMPUTE_BUILD;
const { run, containerId } = stack({ maxBuffer: 64 * 1024 * 1024 });
const NODE = "edge-e2e-1";
const PUBLISHER = "edgeweir-official";
const LABEL = "extensions-v11-e2e";
const P_HOST = "precursor.extensions.e2e.test";
const C_HOST = "compute.extensions.e2e.test";
const WORK = "/tmp/ewx-v11-e2e";
const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NAV = {
  "user-agent": BROWSER,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip",
};

/** A request through the node's published HTTP port: { status, headers, body }. */
const request = (method, path, host, headers = {}, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: nodePort, method, path, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            // Precursor scores a browser without Accept-Encoding lower.
            body: (res.headers["content-encoding"] === "gzip"
              ? gunzipSync(Buffer.concat(chunks))
              : Buffer.concat(chunks)
            ).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("node timeout")));
    req.end(body);
  });
const get = (path, host, headers) => request("GET", path, host, headers);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const admin = await actor("admin@e2e.test", "e2e-admin-password-123", LABEL);
const node = (await admin.ok("GET", "/nodes")).find((n) => n.name === NODE);
assert.ok(node, `${NODE} is not enrolled`);
const nodeContainer = await containerId("node");
const exec = (...args) => run(["exec", nodeContainer, ...args]);
// Files `docker cp` puts in the container belong to the copying user.
const rootExec = (...args) => run(["exec", "-u", "0", nodeContainer, ...args]);

const findSite = async (host) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(host)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(host),
  );

/** Waits until the node applied the cluster's latest revision. */
async function applied() {
  const latest = (await admin.ok("GET", `/clusters/${node.clusterId}`)).latestRevision.revision;
  await waitFor(`${NODE} applied #${latest}`, async () => {
    const n = await admin.ok("GET", `/nodes/${node.id}`);
    return n.online && n.applyState === "applied" && n.appliedRevision >= latest;
  });
}

/** The node's state of an extension. */
const nodeState = async (id) =>
  (await admin.ok("GET", `/extensions/${id}`)).nodes.find((n) => n.nodeId === node.id);

async function cleanup() {
  let removed = 0;
  for (const host of [P_HOST, C_HOST]) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  for (const id of ["precursor", "edge-compute"]) {
    const installed = await admin.raw("GET", `/extensions/${id}`);
    if (installed.status === 200) await admin.ok("DELETE", `/extensions/${id}`);
  }
  for (const key of await admin.ok("GET", "/extension-keys")) {
    if (key.label === LABEL) await admin.ok("DELETE", `/extension-keys/${key.kid}`);
  }
  await rootExec("rm", "-rf", WORK);
  pass(`extensions 1.1 cleanup: ${removed} sites removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}
if (!PRECURSOR && !COMPUTE) {
  console.log(
    "SKIP extensions 1.1: E2E_PRECURSOR_PACKAGE and E2E_EDGE_COMPUTE_PACKAGE are not set",
  );
  process.exit(0);
}
await cleanup();

// --------------------------------------------------------------- a. feature
await waitFor("extensions-v2", async () =>
  (await admin.ok("GET", `/nodes/${node.id}`)).supportedFeatures.includes("extensions-v2"),
);
pass("the node reports extensions-v2");

// A publisher key for edgeweir-official, made and trusted for this run.
await exec("mkdir", "-p", WORK);
const keygen = await exec("edgeweir-node", "extension", "keygen", "--out", `${WORK}/publisher.jwk`);
const publicKey = keygen.match(/^public key: (\{.*\})$/m)?.[1];
const kid = keygen.match(/^kid: ([A-Za-z0-9_-]{43})$/m)?.[1];
assert.ok(publicKey && kid, `keygen output: ${keygen}`);
await admin.ok("POST", "/extension-keys", { publisher: PUBLISHER, key: publicKey, label: LABEL });

/**
 * Packs and signs the directory `src` (on this host) in the node container:
 * { packageB64, signature }.
 */
async function signed(name, src) {
  await run(["cp", src, `${nodeContainer}:${WORK}/${name}`]);
  await exec(
    "edgeweir-node",
    "extension",
    "pack",
    "--out",
    `${WORK}/${name}.ewx`,
    `${WORK}/${name}`,
  );
  await exec(
    "edgeweir-node",
    "extension",
    "sign",
    "--key",
    `${WORK}/publisher.jwk`,
    "--publisher",
    PUBLISHER,
    `${WORK}/${name}.ewx`,
  );
  const out = mkdtempSync(join(tmpdir(), "ewx-v11-"));
  try {
    await run(["cp", `${nodeContainer}:${WORK}/${name}.ewx`, join(out, "p.ewx")]);
    const packageB64 = readFileSync(join(out, "p.ewx")).toString("base64");
    const signature = (await exec("cat", `${WORK}/${name}.ewx.sig`)).trim();
    return { packageB64, signature };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------- b. Precursor
if (PRECURSOR) {
  const { packageB64, signature } = await signed("precursor", PRECURSOR);
  const installed = await admin.ok("POST", "/extensions", { package: packageB64, signature });
  assert.equal(installed.manifest.requires.lua_api, 2);
  assert.ok(installed.secretVersion >= 1, "secret: true gets a console secret");
  await admin.ok("PATCH", "/extensions/precursor", { enabled: true });
  const { site } = await admin.ok("POST", "/sites", {
    name: "precursor-e2e",
    domains: [P_HOST],
    origins: [{ address: "whoami" }],
    clusterId: node.clusterId,
  });
  const siteConfig = {
    mode: "enforce",
    interstitial: true,
    automated_action: "deny",
    inject: true,
  };
  await admin.ok("PUT", `/sites/${site.id}/extensions/precursor`, {
    enabled: true,
    config: siteConfig,
  });
  await applied();
  await waitFor(
    "the node loads Precursor",
    async () => (await nodeState("precursor"))?.state === "loaded",
  );

  /** The interstitial's token (signed with the current secret). */
  const interstitialToken = async (headers = {}) => {
    const r = await get("/", P_HOST, { ...NAV, ...headers });
    if (r.status !== 403 || r.headers["x-edgeweir-challenge"] !== "session") return null;
    return r.body.match(/[?&]t=([A-Za-z0-9_.-]+)/)?.[1] ?? null;
  };
  const token1 = await waitFor("the interstitial", () => interstitialToken(), 180, 1000, async () => {
    const r = await get("/", P_HOST, NAV);
    return `${r.status} ${JSON.stringify(r.headers)} ${r.body.slice(0, 300)}`;
  });
  const page = await get("/", P_HOST, NAV);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  const kid1 = token1.split(".")[0];

  /** Reports to the endpoint with the proof of work: the session cookie. */
  const report = async (token, flags) => {
    let n = 0;
    for (; ; n++) {
      const d = createHash("sha256").update(`${token}:${n}`).digest();
      if (d[0] === 0 && d[1] < 0x40) break; // 10 leading zero bits
    }
    const r = await request(
      "POST",
      "/.edgeweir/ext/precursor/c",
      P_HOST,
      { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" },
      `t=${encodeURIComponent(token)}&n=${n}&f=${flags}`,
    );
    assert.equal(r.status, 204, `report: ${r.status} ${r.body}`);
    const cookie = String(r.headers["set-cookie"] ?? "").match(/__ew_pc=([^;]+)/)?.[1];
    assert.ok(cookie?.startsWith(`v1.${kid1}.`), `session cookie: ${r.headers["set-cookie"]}`);
    return `__ew_pc=${cookie}`;
  };
  const human = await report(token1, 32);
  const through = await get("/", P_HOST, { ...NAV, cookie: human });
  assert.equal(through.status, 200, through.body.slice(0, 200));
  const automated = await report(await interstitialToken(), 1);
  const denied = await get("/", P_HOST, { ...NAV, cookie: automated });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers["x-edgeweir-error"], "extension-denied");
  assert.equal(
    (await get("/.edgeweir/ext/precursor/c", P_HOST, NAV)).status,
    405,
    "the endpoint takes POST only",
  );
  pass(
    "Precursor: the interstitial carries a token signed with the console secret; a report with the proof of work gets a session; webdriver sessions are denied",
  );

  // Rotation: the previous secret still verifies sessions, then it is gone.
  const rotated = await admin.ok("POST", "/extensions/precursor/rotate-secret");
  assert.equal(rotated.secretVersion, installed.secretVersion + 1);
  const kid2 = await waitFor("the rotated secret reaches the node", async () => {
    const k = (await interstitialToken())?.split(".")[0];
    return k && k !== kid1 ? k : null;
  });
  assert.equal((await get("/", P_HOST, { ...NAV, cookie: human })).status, 200, "previous secret");
  await admin.ok("POST", "/extensions/precursor/rotate-secret");
  await waitFor("the second rotation reaches the node", async () => {
    const k = (await interstitialToken())?.split(".")[0];
    return k && k !== kid1 && k !== kid2;
  });
  const expired = await get("/", P_HOST, { ...NAV, cookie: human });
  assert.equal(expired.status, 403);
  assert.equal(expired.headers["x-edgeweir-challenge"], "session");
  const state = await nodeState("precursor");
  assert.equal(state.faults, 0, `faults: ${JSON.stringify(state)}`);
  await admin.ok("PUT", `/sites/${site.id}/extensions/precursor`, {
    enabled: true,
    config: { ...siteConfig, mode: "monitor" },
  });
  await applied();
  await waitFor("monitor mode", async () => (await get("/", P_HOST, NAV)).status === 200);
  pass(
    "Precursor: a rotated secret keeps sessions of the previous one, the next rotation ends them; monitor mode serves",
  );
  await admin.ok("DELETE", `/sites/${site.id}`);
  await admin.ok("DELETE", "/extensions/precursor");
}

// ----------------------------------------------------------- c. edge-compute
if (COMPUTE) {
  assert.ok(COMPUTE_BUILD, "E2E_EDGE_COMPUTE_BUILD is not set");
  const arch = (await exec("uname", "-m")).trim();
  assert.equal(arch, "x86_64", "the fixture ships ew-compute for linux-amd64 only");
  const stage = mkdtempSync(join(tmpdir(), "ewx-v11-"));
  let pkg;
  try {
    cpSync(COMPUTE, join(stage, "edge-compute"), { recursive: true });
    mkdirSync(join(stage, "edge-compute", "sidecar", "linux-amd64"), { recursive: true });
    const bin = join(stage, "edge-compute", "sidecar", "linux-amd64", "ew-compute");
    cpSync(join(COMPUTE_BUILD, "ew-compute"), bin);
    chmodSync(bin, 0o755);
    pkg = await signed("edge-compute", join(stage, "edge-compute"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const installed = await admin.ok("POST", "/extensions", {
    package: pkg.packageB64,
    signature: pkg.signature,
  });
  assert.equal(installed.manifest.sidecar.binary, "ew-compute");
  await admin.ok("PATCH", "/extensions/edge-compute", { enabled: true });
  const { site } = await admin.ok("POST", "/sites", {
    name: "compute-e2e",
    domains: [C_HOST],
    origins: [{ address: "whoami" }],
    clusterId: node.clusterId,
  });
  const views = await admin.ok("GET", `/sites/${site.id}/extensions`);
  assert.equal(views.find((v) => v.id === "edge-compute").dataLimits.maxItems, 32);

  const wasm = {};
  for (const name of ["hello", "rewrite", "probe"]) {
    const bytes = readFileSync(join(COMPUTE_BUILD, `fn-${name}-v1.wasm`));
    wasm[name] = { name: `fn-${name}-v1.wasm`, bytes, sha256: sha256(bytes) };
    const item = await admin.ok(
      "PUT",
      `/sites/${site.id}/extensions/edge-compute/data/${wasm[name].name}`,
      { content: bytes.toString("base64") },
    );
    assert.equal(item.sha256, wasm[name].sha256);
  }
  const deploy = async (revision, greeting) => {
    const fn = (name, vars = {}) => ({
      version: 1,
      artifact: wasm[name].name,
      sha256: wasm[name].sha256,
      limits: { cpu_ms: 200, wall_ms: 10000 },
      vars,
    });
    const doc = {
      format: "edgeweir-edge-compute-v1",
      revision,
      hosts: [C_HOST],
      routes: [
        { id: "hello", function: "hello" },
        { id: "rw", function: "rewrite" },
        { id: "po", function: "probe" },
        { id: "pc", function: "probe" },
      ],
      functions: {
        hello: fn("hello", { GREETING: greeting }),
        rewrite: fn("rewrite", { TAG: "e2e" }),
        probe: fn("probe"),
      },
    };
    await admin.ok("PUT", `/sites/${site.id}/extensions/edge-compute/data/deploy.json`, {
      content: Buffer.from(JSON.stringify(doc)).toString("base64"),
    });
  };
  await deploy(1, "one");
  const items = await admin.ok("GET", `/sites/${site.id}/extensions/edge-compute/data`);
  assert.deepEqual(items.map((i) => i.name).sort(), [
    "deploy.json",
    "fn-hello-v1.wasm",
    "fn-probe-v1.wasm",
    "fn-rewrite-v1.wasm",
  ]);
  const siteConfig = {
    routes: [
      `hello closed ${C_HOST}/hello*`,
      `rw closed ${C_HOST}/rw*`,
      `po open ${C_HOST}/open*`,
      `pc closed ${C_HOST}/closed*`,
    ],
  };
  await admin.ok("PUT", `/sites/${site.id}/extensions/edge-compute`, {
    enabled: true,
    config: siteConfig,
  });
  await applied();
  const running = await waitFor(
    "the sidecar runs",
    async () => {
      const s = await nodeState("edge-compute");
      return s?.state === "loaded" && s.details?.sidecar?.state === "running" ? s : null;
    },
    240,
    2000,
    async () => JSON.stringify(await nodeState("edge-compute")),
  );
  const owner = await rootExec("stat", "-c", "%U", `/proc/${running.details.sidecar.pid}`);
  assert.equal(owner.trim(), "edgeweir-sidecar", "the sidecar runs as its own user");

  const hello = await waitFor(
    "a function answers",
    async () => {
      const r = await get("/hello/x", C_HOST);
      return r.status === 200 && r.body.startsWith("hello from hello@1") ? r : null;
    },
    120,
    2000,
  );
  assert.match(hello.body, /\/hello\/x one/);
  assert.ok(hello.headers["x-client-ip"], "the node's client address reaches the function");
  assert.equal(
    hello.headers["x-edgeweir-ext-outcome"],
    undefined,
    "the sidecar's headers are removed",
  );
  const rewritten = await get("/rw/y", C_HOST);
  assert.equal(rewritten.status, 200, rewritten.body.slice(0, 300));
  assert.equal(rewritten.headers["x-rewritten"], "e2e");
  assert.match(rewritten.body, /X-From-Function: 1/i, "the origin saw the function's subrequest");
  const fellThrough = await get("/open?case=passthrough", C_HOST);
  assert.equal(fellThrough.status, 200);
  assert.match(fellThrough.body, /GET \/open\?case=passthrough/, "open: the origin answers");
  const viaSocket = await get("/closed?case=passthrough", C_HOST);
  assert.equal(viaSocket.status, 200);
  assert.match(
    viaSocket.body,
    /GET \/closed\?case=passthrough/,
    "closed: through the origin socket",
  );
  const plain = await get("/elsewhere", C_HOST);
  assert.equal(plain.status, 200);
  assert.match(plain.body, /GET \/elsewhere/);
  pass(
    "edge-compute: the sidecar runs as edgeweir-sidecar; functions answer, reach the origin through the origin socket and fall through",
  );

  await deploy(2, "two");
  await waitFor(
    "new site data reaches the sidecar",
    async () => (await get("/hello/x", C_HOST)).body.includes("/hello/x two"),
    120,
    2000,
  );
  pass("edge-compute: a new deploy.json reaches the sidecar");

  // Down: kill it until the restart backoff leaves a window of seconds.
  let pid = running.details.sidecar.pid;
  for (let i = 0; i < 3; i++) {
    await rootExec("sh", "-c", `kill -9 ${pid}`); // no /bin/kill in the image
    if (i === 2) break;
    pid = await waitFor(
      "a restarted sidecar",
      async () => {
        const s = (await nodeState("edge-compute")).details?.sidecar;
        return s?.state === "running" && s.pid !== pid ? s.pid : null;
      },
      60,
      200,
    );
  }
  await sleep(300);
  const [closed, open] = await Promise.all([get("/hello/x", C_HOST), get("/open/z", C_HOST)]);
  assert.equal(closed.status, 502, `closed route with the sidecar down: ${closed.status}`);
  assert.equal(open.status, 200);
  assert.match(open.body, /GET \/open\/z/, "open route with the sidecar down: the origin");
  const back = await waitFor(
    "the node restarts the sidecar",
    async () => {
      const s = await nodeState("edge-compute");
      const d = s.details?.sidecar;
      return d?.state === "running" && d.restarts >= 3 ? d : null;
    },
    60,
  );
  assert.ok(back.status?.functions >= 1, `GET /status of the sidecar: ${JSON.stringify(back)}`);
  await waitFor("served again", async () => (await get("/hello/x", C_HOST)).status === 200, 60);
  pass(
    "edge-compute: with the sidecar down closed routes answer 502 and open ones the origin; the node restarts it",
  );

  await admin.ok("PUT", `/sites/${site.id}/extensions/edge-compute`, {
    enabled: false,
    config: siteConfig,
  });
  await applied();
  await waitFor("off for the site", async () =>
    /GET \/hello\/x/.test((await get("/hello/x", C_HOST)).body),
  );
  await admin.ok("DELETE", `/sites/${site.id}`);
  await admin.ok("DELETE", "/extensions/edge-compute");
  await applied();
  await waitFor("the node stops the sidecar and deletes its directory", async () => {
    const listing = await exec(
      "sh",
      "-c",
      'ls -A /var/lib/edgeweir-node-sidecar 2>/dev/null; for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = ew-compute ] && echo running; done; true',
    );
    return listing.trim() === "";
  });
  pass(
    "edge-compute: off for the site the origin answers; uninstalled, the sidecar stops and its directory is gone",
  );
}

await cleanup();
