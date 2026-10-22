// Enrolled nodes follow the node channel URL (profile channel, ADR-0046).
// channel-relay relays channel-old.e2e.test:8443 to the console at layer 4;
// channel.e2e.test is a second name of the console; node-channel trusts
// wss-proxy's test CA (SSL_CERT_DIR).
//   a. node-channel enrolls with https://channel-old.e2e.test:8443, the URL
//      saved then; it reports channel-follow-v1 and the URL it uses
//   b. https://channel.e2e.test:8443 saved: node-channel and the core node
//      check it and switch without a restart, the old URL kept as fallback;
//      the settings show every node switched and the old name unused
//   c. the old address goes away (relay stopped): node-channel stays online
//      and applies a revision; the old name leaves the certificate
//   d. node-channel restarts and connects to the new URL
//   e. an unreachable URL saved: nobody switches, node-channel reports
//      unreachable and stays online; saving the new URL again clears it
//   f. https -> wss -> https: node-channel moves to wss://wss.e2e.test (the
//      core node, without the proxy's CA, reports tls_untrusted and stays)
//      and back; then the WebSocket entry closes
//   g. a lost node (restarted with its URL and fallback unreachable) stays offline;
//      set-server refuses an unreachable URL without changing identity.json
//      and brings the node back with the new URL, same identity
// `node scripts/e2e-channel.mjs --cleanup` deletes the node, its site and
// cluster, saves the URL in effect before again and waits for the core node
// to be back on it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass, stack, waitFor as waitUntil } from "./e2e-lib.mjs";

const execute = promisify(execFile);
const run = async (args, env) =>
  (await execute("docker", args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 })).stdout;
const { compose, containerId } = stack({ profiles: ["channel"], run });
const STATE = ".e2e/channel-state.json";
const OLD = "https://channel-old.e2e.test:8443";
const NEW = "https://channel.e2e.test:8443";
const DEAD = "https://channel-dead.e2e.test:8443";
const WSS = "wss://wss.e2e.test";
const CLUSTER = "channel-e2e";
const NODE = "edge-channel";
const CORE_NODE = "edge-e2e-1";
const SITE = { name: "channel-site", domain: "channel-site.e2e.test" };
const IDENTITY = "/var/lib/edgeweir-node/identity.json";

const waitFor = (label, fn, seconds = 120, interval = 1000) =>
  waitUntil(label, fn, seconds, interval);

/** The operator with an AccessKey created over the console's RPC. */
async function operator(email, password) {
  const response = await waitFor(`sign in ${email}`, async () => {
    const r = await signInResponse(base, email, password);
    return r.status === 200 ? r : null;
  });
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const key = await rpc(base, cookie, "accessKeys/create", { name: "channel-e2e" });
  const raw = async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": key.key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const ok = async (method, path, body) => {
    const result = await raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  ok.raw = raw;
  return ok;
}

/** `sh -c script` in the proxy container (it has openssl); stdout. */
const inProxy = async (script) => run(["exec", await containerId("wss-proxy"), "sh", "-c", script]);
/** Runs a command in node-channel as its user; { code, out }. */
async function inNode(args) {
  try {
    const { stdout, stderr } = await execute("docker", [
      "exec",
      await containerId("node-channel"),
      ...args,
    ]);
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
/** The SAN of the node channel certificate a node asking for `name` gets. */
const certificateNames = (name) =>
  inProxy(
    `openssl s_client -connect console:8443 -servername ${name} </dev/null 2>/dev/null |
     openssl x509 -noout -ext subjectAltName 2>/dev/null`,
  );

const a = await operator("admin@e2e.test", "e2e-admin-password-123");
const nodeNamed = async (name) => (await a("GET", "/nodes")).find((n) => n.name === name);
const setUrl = (url) => a("PUT", "/settings/node-channel", { url });

/** Deletes the section's cluster with its node and site. */
async function removeCluster() {
  const cluster = (await a("GET", "/clusters")).find((c) => c.name === CLUSTER);
  if (!cluster) return;
  for (const node of await a("GET", `/nodes?clusterId=${cluster.id}`))
    await a("DELETE", `/nodes/${node.id}`);
  for (const site of (await a("GET", `/sites?search=${SITE.name}&pageSize=100`)).items)
    if (site.clusterId === cluster.id) await a("DELETE", `/sites/${site.id}`);
  await a("DELETE", `/clusters/${cluster.id}`);
}

async function cleanup() {
  await removeCluster();
  let previous = "";
  try {
    previous = JSON.parse(await readFile(STATE, "utf8")).previousUrl;
  } catch {}
  const restored = await setUrl(previous);
  assert.equal(restored.url, previous);
  // The core node moves back to the URL in effect again (later sections enroll with it).
  const core = await waitFor(
    `${CORE_NODE} back on ${restored.effectiveUrl}`,
    async () => {
      const n = await nodeNamed(CORE_NODE);
      return n?.channel?.url === restored.effectiveUrl && !n.channel.onFallback ? n : null;
    },
    120,
    2000,
  );
  await run([...compose, "rm", "-sfv", "node-channel", "channel-relay", "wss-proxy"]).catch(
    () => "",
  );
  await run([
    "volume",
    "rm",
    "-f",
    // The stack's project name, as compose resolves it.
    `${JSON.parse(await run([...compose, "config", "--format", "json"])).name}_node-channel-state`,
  ]).catch(() => "");
  await rm(STATE, { force: true });
  pass(
    `channel cleanup: ${NODE}, ${SITE.name} and ${CLUSTER} removed; node channel URL ${restored.effectiveUrl} (${restored.source}) again, ${core.name} on it`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

// What a run left behind (an interrupted one) goes first; its saved URL stays the one to restore.
const before = await a("GET", "/settings/node-channel");
let state = { previousUrl: before.url };
try {
  state = JSON.parse(await readFile(STATE, "utf8"));
} catch {}
await writeFile(STATE, JSON.stringify(state));
await removeCluster();

let node;
const fresh = async () => (node = await a("GET", `/nodes/${node.id}`));
/** Waits until node-channel uses `url` (not on its fallback). */
const switchedTo = (url, extra = () => true) =>
  waitFor(
    `${NODE} on ${url}`,
    async () => {
      const n = await fresh();
      return n.online && n.channel?.url === url && !n.channel.onFallback && extra(n) ? n : null;
    },
    90,
  );

// ----------------------------------------------- a. enrollment with the old URL
async function checks() {
  const saved = await setUrl(OLD);
  assert.equal(saved.effectiveUrl, OLD);
  await waitFor("the certificate names channel-old.e2e.test", async () =>
    (await certificateNames("channel-old.e2e.test")).includes("DNS:channel-old.e2e.test"),
  );
  const cluster = await a("POST", "/clusters", { name: CLUSTER });
  const { site } = await a("POST", "/sites", {
    name: SITE.name,
    clusterId: cluster.id,
    domains: [SITE.domain],
    origins: [{ address: "whoami" }],
  });
  const token = await a("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: NODE,
    ttlMinutes: 15,
  });
  assert.equal(token.serverUrl, OLD);
  await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      await containerId("node-channel"),
      "edgeweir-node",
      "enroll",
      "--server",
      OLD,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  node = await waitFor(`${NODE} online`, async () => {
    const n = (await a("GET", `/nodes?clusterId=${cluster.id}`)).find((x) => x.name === NODE);
    return n?.online && n.channel?.url ? n : null;
  });
  assert.ok(node.supportedFeatures.includes("channel-follow-v1"), node.supportedFeatures.join());
  assert.equal(node.channel.url, OLD);
  assert.equal(node.channel.source, "enroll");
  assert.equal(node.channel.observedServerName, "channel-old.e2e.test");
  const enrolled = { id: node.id, fingerprint: node.certFingerprint };
  pass(`${NODE} enrolled with ${OLD}, reports channel-follow-v1 and the URL it uses`);

  // --------------------------------------------- b. the new URL
  const t0 = Date.now();
  await setUrl(NEW);
  await switchedTo(
    NEW,
    (n) =>
      n.channel.fallbackUrl === OLD &&
      n.channel.source === "console" &&
      n.channel.observedServerName === "channel.e2e.test",
  );
  const switchSeconds = Math.round((Date.now() - t0) / 1000);
  const core = await waitFor(`${CORE_NODE} on ${NEW}`, async () => {
    const n = await nodeNamed(CORE_NODE);
    return n?.channel?.url === NEW ? n : null;
  });
  assert.ok(core.online);
  const settings = await waitFor("every reporting node switched", async () => {
    const s = await a("GET", "/settings/node-channel");
    const old = s.previousNames.find((p) => p.name === "channel-old.e2e.test");
    return old && old.nodes === 0 && s.adoption.nodesCurrent >= 2 ? s : null;
  });
  pass(
    `${NEW} saved: ${NODE} switched in ${switchSeconds} s (fallback ${OLD}), ${CORE_NODE} too; nodes switched ${settings.adoption.nodesCurrent}/${settings.adoption.nodes}, channel-old.e2e.test unused`,
  );

  // --------------------------------------------- c. the old address goes away
  await run([...compose, "stop", "channel-relay"]);
  const revision = (
    await a("PATCH", `/sites/${site.id}`, { domains: [SITE.domain, `www.${SITE.domain}`] })
  ).revision;
  await waitFor(`${NODE} applies #${revision.revision} without the old address`, async () => {
    const n = await fresh();
    return n.online && n.appliedRevision === revision.revision && n.applyState === "applied";
  });
  const seen = node.lastSeenAt;
  await waitFor(
    `${NODE} keeps sending heartbeats`,
    async () => {
      const n = await fresh();
      assert.ok(n.online, `${NODE} went offline: ${JSON.stringify(n.channel)}`);
      return Date.parse(n.lastSeenAt) - Date.parse(seen) >= 30_000;
    },
    90,
    2000,
  );
  const removed = await a("DELETE", "/settings/node-channel/names/channel-old.e2e.test");
  assert.ok(!removed.previousNames.some((p) => p.name === "channel-old.e2e.test"));
  await waitFor("the certificate no longer names channel-old.e2e.test", async () => {
    const san = await certificateNames("channel.e2e.test");
    return san.includes("DNS:channel.e2e.test") && !san.includes("channel-old.e2e.test");
  });
  pass(
    `old address offline: ${NODE} stayed online and applied #${revision.revision}; channel-old.e2e.test removed from the certificate`,
  );

  // --------------------------------------------- d. restart
  await run([...compose, "restart", "node-channel"]);
  // The restarted agent loads the identity with the new URL (only a start logs this line)...
  await waitFor(`${NODE} starts with ${NEW}`, async () =>
    /node identity loaded[^\n]*server=https:\/\/channel\.e2e\.test:8443/.test(
      await run([...compose, "logs", "--since", "5m", "node-channel"]),
    ),
  );
  // ...and its heartbeats arrive: one newer than any before it.
  const lastBefore = (await fresh()).lastSeenAt;
  await waitFor(`${NODE} back after a restart`, async () => {
    const n = await fresh();
    return n.online && n.lastSeenAt > lastBefore && n.channel?.url === NEW ? n : null;
  });
  assert.equal(node.channel.observedServerName, "channel.e2e.test");
  pass(`${NODE} restarted and connected to ${NEW}`);

  // --------------------------------------------- e. an unreachable URL
  await setUrl(DEAD);
  await waitFor(`${NODE} reports ${DEAD} unreachable`, async () => {
    const n = await fresh();
    return n.channel?.error?.url === DEAD && n.channel.error.code === "unreachable";
  });
  assert.equal(node.channel.url, NEW);
  assert.ok(node.online);
  const failedSettings = await a("GET", "/settings/node-channel");
  assert.equal(failedSettings.adoption.nodesCurrent, 0);
  await setUrl(NEW);
  await switchedTo(NEW, (n) => n.channel.error === null);
  pass(`${DEAD} saved: ${NODE} stayed on ${NEW} and reported unreachable; ${NEW} again cleared it`);

  // --------------------------------------------- f. https -> wss -> https
  await setUrl(WSS);
  await switchedTo(WSS, (n) => n.channel.observedWebSocket === true);
  const coreRefused = await waitFor(`${CORE_NODE} refuses ${WSS}`, async () => {
    const n = await nodeNamed(CORE_NODE);
    return n?.channel?.error?.url === WSS ? n : null;
  });
  assert.equal(coreRefused.channel.url, NEW);
  assert.equal(coreRefused.channel.error.code, "tls_untrusted");
  await setUrl(NEW);
  await switchedTo(
    NEW,
    (n) => n.channel.observedWebSocket === false && n.channel.fallbackUrl === WSS,
  );
  const entry = await waitFor("the WebSocket entry unused", async () => {
    const s = await a("GET", "/settings/node-channel");
    return s.webSocket.closable && s.webSocket.nodes === 0 ? s : null;
  });
  const closed = await a("DELETE", "/settings/node-channel/websocket");
  assert.equal(closed.webSocket.open, false);
  const notFound = await waitFor(
    "the entry answers 404",
    async () => {
      const out = await inProxy(
        `printf 'GET /node-channel HTTP/1.1\\r\\nHost: wss.e2e.test\\r\\nConnection: close\\r\\n\\r\\n' |
       openssl s_client -quiet -connect wss.e2e.test:443 -servername wss.e2e.test 2>/dev/null | head -n 1`,
      );
      return /^HTTP\/1\.1 404 /.test(out) ? out.trim() : null;
    },
    60,
  );
  pass(
    `${NODE} moved to ${WSS} and back (${CORE_NODE} refused it: tls_untrusted); WebSocket entry (${entry.webSocket.nodes} nodes) closed: ${notFound}`,
  );

  // --------------------------------------------- g. set-server
  const lose = `sed -i -e 's#"server_url": "[^"]*"#"server_url": "${DEAD}"#' -e 's#"fallback_server_url": "[^"]*"#"fallback_server_url": "${DEAD}"#' ${IDENTITY}`;
  // Both addresses went away while the agent was down: it starts without a reachable one (a
  // running agent would move to the console's address it last heard of).
  await run([...compose, "stop", "node-channel"]);
  await run([
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "sh",
    "node-channel",
    "-c",
    lose,
  ]);
  await run([...compose, "start", "node-channel"]);
  await waitFor(`${NODE} offline`, async () => !(await fresh()).online, 120, 2000);
  const identity = (await inNode(["cat", IDENTITY])).out;
  const refused = await inNode([
    "edgeweir-node",
    "set-server",
    "--server",
    DEAD,
    "--timeout",
    "10s",
  ]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /\(unreachable\).*nothing changed/s);
  assert.equal(
    (await inNode(["cat", IDENTITY])).out,
    identity,
    "a failed check changed identity.json",
  );
  const recovered = await inNode(["edgeweir-node", "set-server", "--server", NEW]);
  assert.equal(recovered.code, 0, recovered.out);
  assert.match(recovered.out, /now https:\/\/channel\.e2e\.test:8443/);
  await switchedTo(NEW, (n) => n.channel.source === "command");
  assert.equal(node.id, enrolled.id);
  assert.equal(node.certFingerprint, enrolled.fingerprint);
  pass(
    `lost ${NODE} (URL and fallback unreachable) went offline; set-server refused ${DEAD} without changes and brought it back on ${NEW} with its identity`,
  );
}
try {
  await checks();
} catch (error) {
  console.error(await run([...compose, "logs", "--tail", "60", "node-channel"]).catch(() => ""));
  throw error;
} finally {
  await setUrl(state.previousUrl).catch(() => {});
}
console.log("CHANNEL E2E OK");
