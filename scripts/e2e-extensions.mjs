// Node extensions (ADR-0071, docs/reference/extensions.md) on the core node
// edge-e2e-1, with the example hello-header of the edgeweir-node checkout:
//   a. the node reports extensions-v1
//   b. `edgeweir-node extension keygen / pack / sign / verify` in the node
//      container sign the example with a fresh publisher key
//   c. the console refuses the package while no key is trusted
//      (EXTENSION_KEY_UNTRUSTED), a changed signature
//      (EXTENSION_SIGNATURE_INVALID) and changed package bytes; trusting the
//      key, verify shows the manifest and stores nothing
//   d. install (disabled), enable with a global greeting, turn it on for a
//      site: the node loads it (state loaded on the extension page) and the
//      site's responses carry the greeting header; a request with
//      X-No-Greeting does not; the deny path answers 403 extension-denied;
//      the endpoint answers pong and the asset is served; another site
//      without the extension gets none of it
//   e. the access hook throwing: failure mode open serves the request
//      without the header, closed answers 503 X-Edgeweir-Error: extension;
//      the node reports the faults
//   f. the kill switch stops it everywhere and back
//   g. off for the site: no header; uninstall: the trusted key can be
//      removed only afterwards, and the node deletes the unpacked package
// `node scripts/e2e-extensions.mjs --cleanup` removes the sites, the
// extension and the key.
import assert from "node:assert/strict";
import http from "node:http";
import { actor, pass, stack, waitFor } from "./e2e-lib.mjs";

const nodePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const NODE_CONTEXT = process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node";
const { run, containerId } = stack();
const NODE = "edge-e2e-1";
const ID = "hello-header";
const HOST = "hello.extensions.e2e.test";
const OTHER = "plain.extensions.e2e.test";
const PUBLISHER = "example.org";
const WORK = "/tmp/ewx-e2e";

/** GET through the node's published HTTP port: { status, headers, body }. */
const get = (path, host = HOST, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: nodePort, path, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("node timeout")));
    req.end();
  });

const admin = await actor("admin@e2e.test", "e2e-admin-password-123", "extensions-e2e");
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

async function cleanup() {
  let removed = 0;
  for (const host of [HOST, OTHER]) {
    const site = await findSite(host);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  const installed = await admin.raw("GET", `/extensions/${ID}`);
  if (installed.status === 200) await admin.ok("DELETE", `/extensions/${ID}`);
  for (const key of await admin.ok("GET", "/extension-keys")) {
    if (key.label === "extensions-e2e") await admin.ok("DELETE", `/extension-keys/${key.kid}`);
  }
  await admin.ok("PUT", "/extensions/settings", { disabled: false });
  pass(`extensions cleanup: ${removed} sites removed`);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}
await cleanup();

// --------------------------------------------------------------- a. feature
await waitFor("extensions-v1", async () =>
  (await admin.ok("GET", `/nodes/${node.id}`)).supportedFeatures.includes("extensions-v1"),
);
pass("the node reports extensions-v1");

// -------------------------------------------------------------- b. the CLI
await rootExec("rm", "-rf", WORK);
await exec("mkdir", "-p", WORK);
await run([
  "cp",
  `${NODE_CONTEXT}/examples/extensions/hello-header`,
  `${nodeContainer}:${WORK}/src`,
]);
const keygen = await exec("edgeweir-node", "extension", "keygen", "--out", `${WORK}/publisher.jwk`);
const publicKey = keygen.match(/^public key: (\{.*\})$/m)?.[1];
const kid = keygen.match(/^kid: ([A-Za-z0-9_-]{43})$/m)?.[1];
assert.ok(publicKey && kid, `keygen output: ${keygen}`);
await exec("sh", "-c", `printf '%s\\n' '${publicKey}' > ${WORK}/publisher.pub.jwk`);
await exec("edgeweir-node", "extension", "pack", "--out", `${WORK}/hello.ewx`, `${WORK}/src`);
await exec(
  "edgeweir-node",
  "extension",
  "sign",
  "--key",
  `${WORK}/publisher.jwk`,
  "--publisher",
  PUBLISHER,
  `${WORK}/hello.ewx`,
);
const verified = await exec(
  "edgeweir-node",
  "extension",
  "verify",
  "--pubkey",
  `${WORK}/publisher.pub.jwk`,
  "--publisher",
  PUBLISHER,
  `${WORK}/hello.ewx`,
);
assert.match(
  verified,
  new RegExp(`^ok ${ID} 1\\.0\\.0 ${PUBLISHER} sha256:[0-9a-f]{64} kid:${kid}`),
);
const packageB64 = (await exec("base64", "-w0", `${WORK}/hello.ewx`)).trim();
const signature = (await exec("cat", `${WORK}/hello.ewx.sig`)).trim();
await rootExec("rm", "-rf", WORK);
pass("keygen, pack, sign and verify in the node container");

// ---------------------------------------------------------- c. verification
const untrusted = await admin.raw("POST", "/extensions/verify", { package: packageB64, signature });
assert.equal(untrusted.json?.code, "EXTENSION_KEY_UNTRUSTED", untrusted.text);
const key = await admin.ok("POST", "/extension-keys", {
  publisher: PUBLISHER,
  key: publicKey,
  label: "extensions-e2e",
});
assert.equal(key.kid, kid);
const [header, payload, sig] = signature.split(".");
const flipped = `${sig.slice(0, -2)}${sig.at(-2) === "A" ? "B" : "A"}${sig.at(-1)}`;
const badSignature = await admin.raw("POST", "/extensions/verify", {
  package: packageB64,
  signature: `${header}.${payload}.${flipped}`,
});
assert.equal(badSignature.json?.code, "EXTENSION_SIGNATURE_INVALID", badSignature.text);
const bytes = Buffer.from(packageB64, "base64");
bytes[bytes.length - 10] ^= 1;
const badPackage = await admin.raw("POST", "/extensions/verify", {
  package: bytes.toString("base64"),
  signature,
});
assert.ok(
  ["EXTENSION_SIGNATURE_INVALID", "EXTENSION_PACKAGE_INVALID"].includes(badPackage.json?.code),
  badPackage.text,
);
const preview = await admin.ok("POST", "/extensions/verify", { package: packageB64, signature });
assert.equal(preview.manifest.id, ID);
assert.equal(preview.key.kid, kid);
assert.equal((await admin.raw("GET", `/extensions/${ID}`)).status, 404, "verify stored nothing");
pass("untrusted keys, changed signatures and changed bytes are refused; verify shows the manifest");

// --------------------------------------------------- d. install and enable
const installed = await admin.ok("POST", "/extensions", { package: packageB64, signature });
assert.equal(installed.enabled, false, "a new extension starts disabled");
await admin.ok("PATCH", `/extensions/${ID}`, { enabled: true, config: { greeting: "hi e2e" } });
const { site } = await admin.ok("POST", "/sites", {
  name: "extensions-e2e",
  domains: [HOST],
  origins: [{ address: "whoami" }],
  clusterId: node.clusterId,
});
const { site: other } = await admin.ok("POST", "/sites", {
  name: "extensions-plain-e2e",
  domains: [OTHER],
  origins: [{ address: "whoami" }],
  clusterId: node.clusterId,
});
const siteConfig = { header: "X-Hello", deny_path: "/blocked", inject: false, fail: false };
await admin.ok("PUT", `/sites/${site.id}/extensions/${ID}`, { enabled: true, config: siteConfig });
await applied();
await waitFor("the node loads the extension", async () => {
  const detail = await admin.ok("GET", `/extensions/${ID}`);
  return detail.nodes.find((n) => n.nodeId === node.id && n.state === "loaded");
});
const greeted = await waitFor("the greeting header", async () => {
  const r = await get("/");
  return r.headers["x-hello"] === "hi e2e from the edge" ? r : null;
});
assert.equal(greeted.status, 200);
assert.equal((await get("/", HOST, { "x-no-greeting": "1" })).headers["x-hello"], undefined);
const blocked = await get("/blocked");
assert.equal(blocked.status, 403);
assert.equal(blocked.headers["x-edgeweir-error"], "extension-denied");
const ping = await get(`/.edgeweir/ext/${ID}/ping`);
assert.equal(ping.status, 200);
assert.equal(ping.body, "pong\n");
const asset = await get(`/.edgeweir/ext/${ID}/assets/hello.js`);
assert.equal(asset.status, 200);
assert.match(asset.headers["content-type"], /^text\/javascript/);
assert.equal(asset.headers["x-content-type-options"], "nosniff");
const plain = await get("/", OTHER);
assert.equal(plain.headers["x-hello"], undefined);
assert.equal((await get(`/.edgeweir/ext/${ID}/ping`, OTHER)).status, 404);
pass(
  "installed, loaded and on for one site: header, deny verdict, endpoint and asset; the other site is untouched",
);

// ------------------------------------------------------- e. failure modes
await admin.ok("PUT", `/sites/${site.id}/extensions/${ID}`, {
  enabled: true,
  config: { ...siteConfig, fail: true },
});
await applied();
const open = await waitFor("fails open", async () => {
  const r = await get("/");
  return r.status === 200 && r.headers["x-hello"] === undefined ? r : null;
});
assert.equal(open.status, 200);
await admin.ok("PATCH", `/extensions/${ID}`, { failureMode: "closed" });
await applied();
const closed = await waitFor("fails closed", async () => {
  const r = await get("/");
  return r.status === 503 ? r : null;
});
assert.equal(closed.headers["x-edgeweir-error"], "extension");
await waitFor("faults reported", async () => {
  const detail = await admin.ok("GET", `/extensions/${ID}`);
  return detail.nodes.find((n) => n.nodeId === node.id && n.faults > 0);
});
await admin.ok("PATCH", `/extensions/${ID}`, { failureMode: "open" });
await admin.ok("PUT", `/sites/${site.id}/extensions/${ID}`, { enabled: true, config: siteConfig });
await applied();
await waitFor(
  "back to normal",
  async () => (await get("/")).headers["x-hello"] === "hi e2e from the edge",
);
pass("a throwing access hook fails open, or closed with 503 extension; faults are reported");

// --------------------------------------------------------- f. kill switch
await admin.ok("PUT", "/extensions/settings", { disabled: true });
await applied();
await waitFor("kill switch", async () => (await get("/")).headers["x-hello"] === undefined);
assert.equal((await get("/blocked")).status, 200, "no verdicts while killed");
await admin.ok("PUT", "/extensions/settings", { disabled: false });
await applied();
await waitFor(
  "kill switch off",
  async () => (await get("/")).headers["x-hello"] === "hi e2e from the edge",
);
pass("the kill switch stops the extension and lets it back");

// ------------------------------------------------------ g. off and removal
await admin.ok("PUT", `/sites/${site.id}/extensions/${ID}`, { enabled: false, config: siteConfig });
await applied();
await waitFor("off for the site", async () => (await get("/")).headers["x-hello"] === undefined);
const keyInUse = await admin.raw("DELETE", `/extension-keys/${kid}`);
assert.equal(keyInUse.json?.code, "EXTENSION_KEY_IN_USE", keyInUse.text);
await admin.ok("DELETE", `/extensions/${ID}`);
await admin.ok("DELETE", `/extension-keys/${kid}`);
// The previous configuration keeps the package until one more revision.
await admin.ok("PATCH", `/sites/${other.id}`, { name: "extensions-plain-e2e-2" });
await applied();
await waitFor("the node deletes the package", async () => {
  const listing = await exec(
    "sh",
    "-c",
    "ls -A /var/lib/edgeweir-node/extensions 2>/dev/null || true",
  );
  return listing.trim() === "";
});
assert.equal((await get(`/.edgeweir/ext/${ID}/ping`)).status, 404);
pass("off for the site, uninstalled, key removed after the extension; the node is clean");

await cleanup();
