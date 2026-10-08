// Site parity G11 end to end (several certificates, client certificates,
// TLS session resumption, ACME certificate authorities), after G10. `node`
// and `node-upgrade-peer` serve the default cluster; client-a sends HTTPS
// requests (Node.js, with client certificates) and node-upgrade-peer runs
// `openssl s_client` (OpenSSL 3) against both nodes.
//   a. both nodes report multi-certificate-v1 and client-cert-v1; the
//      console has no EDGEWEIR_ACME_* variable: Pebble is the custom ACME
//      directory of the system settings (scripts/e2e.sh)
//   b. several certificates: g11-multi (a, b and c.g11.test) is refused
//      with a.g11.test's certificate alone and with a and b (c uncovered),
//      accepted with *.g11.test first and a, b and an RSA certificate added;
//      on both nodes SNI a and b get their exact ECDSA certificates over the
//      wildcard, c the wildcard; an RSA-only client (TLS 1.2 with RSA
//      ciphers and signatures, TLS 1.3 with RSA-PSS) gets the RSA 2048
//      certificate; more than four certificates are refused
//   c. client certificates on g11-mtls (m.g11.test): required answers 403
//      client-cert-required without a certificate, with another CA's and
//      over plain HTTP, and 200 with the CA's client certificate, the origin
//      seeing X-Client-Verify SUCCESS, its SHA-256, subject and serial and
//      never the visitor's own X-Client-* headers (on this site and on
//      g11-multi); optional answers 200 without (NONE) and with another
//      CA's (FAILED), and rules on tls.client.verified, cert_sha256 and
//      subject block and pass; HTTP/3 together and an invalid CA are refused
//   d. session resumption (openssl s_client -sess_out/-sess_in): TLS 1.2
//      session ID (node cache) and ticket, TLS 1.3 ticket reused on the same
//      node; tickets reused on the other node (the cluster's ticket keys, the
//      same files on both nodes), session IDs not; a.g11.test's session with
//      m.g11.test's SNI (another site) is new in TLS 1.2 and 1.3; early data
//      is off: the tickets allow none and is never accepted
//   e. ACME: Pebble from the system settings issues an RSA 2048 certificate
//      for acme.g11.test (HTTP-01 against node), bound to g11-acme, whose
//      handshake presents it; the account is listed with the directory, its
//      email and certificate count, and cannot be deleted while in use
// The G11 sites stay for apps/console/e2e/g11.spec.ts (.e2e/g11-state.json);
// `node scripts/e2e-g11.mjs --cleanup` removes them (and the spec's g11-ui),
// their certificates and the unused G11 ACME account.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml", "--profile", "upgrades"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const pass = (message) => console.log(`PASS ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = ".e2e/g11-state.json";

const A = "a.g11.test";
const B = "b.g11.test";
const C = "c.g11.test";
const M = "m.g11.test";
/** A network alias of `node` (compose.e2e.yml): Pebble validates HTTP-01 there. */
const ACME = "acme.g11.test";
const ACME_EMAIL = "acme-g11@e2e.test";
const PEBBLE = "https://pebble:14000/dir";
const SITES = {
  multi: { name: "g11-multi", domains: [A, B, C] },
  mtls: { name: "g11-mtls", domains: [M] },
  acme: { name: "g11-acme", domains: [ACME] },
};
const NODES = ["node", "node-upgrade-peer"];
/** Created by apps/console/e2e/g11.spec.ts. */
const UI_SITE = "g11-ui";

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

async function createKey(cookie) {
  return (await rpc(base, cookie, "accessKeys/create", { name: "g11-e2e" })).key;
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

/**
 * Sequential HTTP(S) requests from a client, with a client certificate when
 * `cert` and `key` are set; the presented certificate's subject CN comes
 * back as `cert`.
 */
const REQUESTS = `
const http = require("node:http");
const https = require("node:https");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const out = [];
  for (const r of JSON.parse(input)) {
    out.push(await new Promise((resolve) => {
      const headers = { ...(r.headers ?? {}) };
      if (r.host) headers.host = r.host;
      const lib = r.tls ? https : http;
      const req = lib.request({ host: r.target, port: r.port ?? (r.tls ? 443 : 80), path: r.path ?? "/",
        method: r.method ?? "GET", headers, agent: false, timeout: 20000,
        servername: r.tls ? r.servername ?? r.host : undefined, rejectUnauthorized: false,
        cert: r.cert, key: r.key }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const peer = r.tls ? res.socket.getPeerCertificate?.() : null;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"),
            cert: peer?.subject?.CN ?? "" });
        });
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
const request = async (r, client) => (await requests([r], client))[0];
const summary = (r) =>
  `${r.status} ${r.headers["x-edgeweir-error"] ?? "-"}${r.error ? ` ${r.error}` : ""}`;
/** A request header the whoami origin echoed, or undefined. */
const echoed = (r, name) => r.body.match(new RegExp(`^${name}: (.*?)\\r?$`, "im"))?.[1];

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
const accountsOf = async () =>
  (await admin.ok("GET", "/acme-accounts")).filter(
    (a) => a.email === ACME_EMAIL && a.directoryUrl === PEBBLE,
  );

async function cleanup() {
  let removed = 0;
  for (const name of [...Object.values(SITES).map((s) => s.name), UI_SITE]) {
    const site = await siteNamed(name);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  let certificates = 0;
  for (const cert of await admin.ok("GET", "/certificates"))
    if (cert.name.startsWith("g11-")) {
      await admin.ok("DELETE", `/certificates/${cert.id}`);
      certificates++;
    }
  // Unused once its certificate is gone: deleting it is the accounts list's own check.
  let accounts = 0;
  for (const account of await accountsOf()) {
    assert.equal(account.certificates, 0, `${account.email}: ${account.certificates} certificates`);
    await admin.ok("DELETE", `/acme-accounts/${account.id}`);
    accounts++;
  }
  try {
    await run(["exec", await containerId("node-upgrade-peer"), "sh", "-c", "rm -f /tmp/g11-*"]);
  } catch {
    // The peer may be gone already.
  }
  pass(
    `G11 cleanup: ${removed} site(s), ${certificates} certificate(s), ${accounts} unused ACME account(s) removed`,
  );
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}

async function createSite(key) {
  const { name, domains } = SITES[key];
  const old = await siteNamed(name);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    domains,
    origins: [{ address: "whoami" }],
    clusterId,
  });
  return site;
}

// ------------------------------------------------------- certificates (host openssl)
const work = await mkdtemp(join(tmpdir(), "g11-"));
let serials = 0;
// Every signature is SHA-256: macOS LibreSSL signs with SHA-1 by default, which
// the node's OpenSSL refuses in client certificate chains ("ca md too weak").
async function openssl(...args) {
  await execute("openssl", args, { cwd: work });
}
async function config(name, lines) {
  const path = join(work, `${name}.cnf`);
  await writeFile(path, [...lines, ""].join("\n"));
  return path;
}
const newKey = (rsa) =>
  rsa
    ? ["-newkey", "rsa:2048"]
    : [
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-pkeyopt",
        "ec_param_enc:named_curve",
      ];
async function pem(name) {
  return {
    chainPem: await readFile(join(work, `${name}.pem`), "utf8"),
    privateKeyPem: await readFile(join(work, `${name}.key`), "utf8"),
  };
}

/** A self-signed server certificate: subject CN `name`, the given DNS names. */
async function serverCertificate(name, names, { rsa = false } = {}) {
  const cnf = await config(name, [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = leaf",
    "prompt = no",
    "[dn]",
    `CN = ${name}`,
    "[leaf]",
    "basicConstraints = critical,CA:FALSE",
    `subjectAltName = ${names.map((n) => `DNS:${n}`).join(",")}`,
  ]);
  await openssl(
    "req",
    "-x509",
    ...newKey(rsa),
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
    "-sha256",
    "-days",
    "7",
    "-config",
    cnf,
  );
  return pem(name);
}

/** A self-signed client CA. */
async function clientCa(name) {
  const cnf = await config(name, [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = ca",
    "prompt = no",
    "[dn]",
    `CN = ${name}`,
    "[ca]",
    "basicConstraints = critical,CA:TRUE",
    "keyUsage = critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier = hash",
  ]);
  await openssl(
    "req",
    "-x509",
    ...newKey(false),
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
    "-sha256",
    "-days",
    "7",
    "-config",
    cnf,
  );
  return pem(name);
}

/** A client certificate (O=g11, CN=`name`) the CA `ca` signs. */
async function clientCertificate(name, ca) {
  const ext = await config(`${name}-ext`, [
    "[client]",
    "basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature",
    "extendedKeyUsage = clientAuth",
  ]);
  await openssl(
    "req",
    "-new",
    ...newKey(false),
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/O=g11/CN=${name}`,
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${ca}.pem`,
    "-CAkey",
    `${ca}.key`,
    "-set_serial",
    `0x${(0x6a11c0de + ++serials).toString(16)}`,
    "-sha256",
    "-days",
    "7",
    "-extfile",
    ext,
    "-extensions",
    "client",
    "-out",
    `${name}.pem`,
  );
  return pem(name);
}

const upload = async (name, cert) => admin.ok("POST", "/certificates/upload", { name, ...cert });

// ----------------------------------------------------------- openssl s_client (peer)
const peer = await containerId("node-upgrade-peer");
const inPeer = async (script) => {
  try {
    return await run(["exec", peer, "sh", "-c", script]);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}\nexit ${error.code}`;
  }
};
/**
 * One handshake and a HEAD request from node-upgrade-peer to `target`:443.
 * Resolves the presented certificate's CN and key size, New or Reused, the
 * protocol and the raw output.
 */
async function sClient(target, servername, args = []) {
  const out = await inPeer(
    `printf 'HEAD / HTTP/1.1\\r\\nHost: ${servername}\\r\\nConnection: close\\r\\n\\r\\n' | ` +
      `timeout 20 openssl s_client -connect ${target}:443 -servername ${servername} -ign_eof ${args.join(" ")} 2>&1`,
  );
  const session = out.match(/^(New|Reused), (TLSv1\.[23])/m);
  return {
    out,
    cn: out.match(/^subject=.*?CN\s?=\s?([^,/\n]+)/m)?.[1]?.trim() ?? "",
    bits: Number(out.match(/Server public key is (\d+) bit/)?.[1] ?? 0),
    session: session?.[1] ?? "",
    version: session?.[2] ?? "",
  };
}
const brief = (r) => `${r.session || "?"} ${r.version || "?"} cn=${r.cn || "?"} bits=${r.bits}`;
const RSA_ONLY = {
  "TLS 1.2": [
    "-tls1_2",
    "-cipher",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "-sigalgs",
    "rsa_pss_rsae_sha256:RSA+SHA256",
  ],
  "TLS 1.3": ["-tls1_3", "-sigalgs", "rsa_pss_rsae_sha256:rsa_pss_rsae_sha384"],
};

let finished = false;
try {
  // -------------------------------------------------------------- a. features and CA source
  await everyNode("both nodes report multi-certificate-v1 and client-cert-v1", (n) =>
    ["multi-certificate-v1", "client-cert-v1"].every((f) => n.supportedFeatures.includes(f)),
  );
  const env = await run(["exec", await containerId("console"), "printenv"]);
  assert.deepEqual(
    env.split("\n").filter((line) => line.startsWith("EDGEWEIR_ACME_")),
    [],
    "the console has no EDGEWEIR_ACME_* variable",
  );
  const directory = await admin.ok("GET", "/settings/acme-directory");
  assert.equal(directory.effectiveUrl, PEBBLE);
  assert.equal(directory.source, "setting");
  assert.equal(directory.caSource, "setting");
  assert.equal((await admin.ok("GET", "/certificates/settings")).acmeDirectory, PEBBLE);
  pass(
    `a. both nodes report multi-certificate-v1 and client-cert-v1; no EDGEWEIR_ACME_* in the console, ${PEBBLE} and its CA from the system settings`,
  );

  // -------------------------------------------------------------- b. several certificates
  const sites = {};
  for (const key of Object.keys(SITES)) sites[key] = await createSite(key);
  const certs = {
    a: await upload("g11-a", await serverCertificate("g11-a", [A])),
    b: await upload("g11-b", await serverCertificate("g11-b", [B])),
    wild: await upload("g11-wild", await serverCertificate("g11-wild", ["*.g11.test"])),
    // Exact names win over the wildcard before the key type: the RSA certificate leaves C to it.
    rsa: await upload("g11-rsa", await serverCertificate("g11-rsa", [A, B], { rsa: true })),
    m: await upload("g11-m", await serverCertificate("g11-m", [M])),
  };
  const https = (id, settings) => admin.raw("PUT", `/sites/${id}/https`, { settings });
  for (const [label, settings, missing] of [
    ["a alone", { certificateId: certs.a.id }, [B, C]],
    ["a and b", { certificateId: certs.a.id, additionalCertificateIds: [certs.b.id] }, [C]],
  ]) {
    const refused = await https(sites.multi.id, settings);
    assert.equal(refused.status, 400, `${label}: ${refused.text}`);
    assert.equal(refused.json.code, "CERTIFICATE_DOMAIN_MISMATCH", label);
    for (const name of missing) assert.ok(refused.text.includes(name), `${label}: ${refused.text}`);
  }
  const five = await https(sites.multi.id, {
    certificateId: certs.wild.id,
    additionalCertificateIds: [certs.a.id, certs.b.id, certs.rsa.id, certs.m.id],
  });
  assert.equal(five.status, 400, `five certificates: ${five.text}`);
  const multi = await https(sites.multi.id, {
    certificateId: certs.wild.id,
    additionalCertificateIds: [certs.a.id, certs.b.id, certs.rsa.id],
  });
  assert.equal(multi.status, 200, multi.text);
  assert.deepEqual(multi.json.additionalCertificateIds, [certs.a.id, certs.b.id, certs.rsa.id]);
  await synced("g11-multi with four certificates");
  for (const target of NODES) {
    for (const [servername, cn] of [
      [A, "g11-a"],
      [B, "g11-b"],
      [C, "g11-wild"],
    ])
      for (const version of ["-tls1_2", "-tls1_3"]) {
        const r = await sClient(target, servername, [version]);
        assert.equal(r.cn, cn, `${target} ${servername} ${version}: ${brief(r)}\n${r.out}`);
        assert.equal(r.bits, 256, `${target} ${servername} ${version}: ECDSA P-256`);
      }
    for (const [label, args] of Object.entries(RSA_ONLY)) {
      const r = await sClient(target, A, args);
      assert.equal(r.cn, "g11-rsa", `${target} RSA-only ${label}: ${brief(r)}\n${r.out}`);
      assert.equal(r.bits, 2048, `${target} RSA-only ${label}`);
    }
  }
  pass(
    `b. union coverage: a alone and a+b refused (CERTIFICATE_DOMAIN_MISMATCH: ${C} uncovered), five refused; *.g11.test + a, b, RSA on both nodes: ${A} -> g11-a, ${B} -> g11-b (exact over wildcard), ${C} -> g11-wild (ECDSA P-256, TLS 1.2 and 1.3); RSA-only TLS 1.2 and TLS 1.3 clients -> g11-rsa (RSA 2048)`,
  );

  // -------------------------------------------------------------- c. client certificates
  const ca = await clientCa("g11-client-ca");
  const otherCa = await clientCa("g11-other-ca");
  const client = await clientCertificate("g11-client", "g11-client-ca");
  const stranger = await clientCertificate("g11-stranger", "g11-other-ca");
  const x509 = new X509Certificate(client.chainPem);
  const sha256 = x509.fingerprint256.replaceAll(":", "").toLowerCase();
  const serial = x509.serialNumber.replace(/^0+/, "").toUpperCase();
  const mtls = (clientCertificate, extra = {}) =>
    https(sites.mtls.id, { certificateId: certs.m.id, clientCertificate, ...extra });
  const required = { mode: "required", caPem: ca.chainPem, depth: 2, forwardHeaders: true };
  const http3 = await mtls(required, { http3: true });
  assert.equal(http3.status, 400, http3.text);
  assert.equal(http3.json.code, "CLIENT_CERTIFICATE_HTTP3");
  for (const [label, caPem] of [
    ["not PEM", "not a certificate"],
    ["a leaf", client.chainPem],
  ]) {
    const invalid = await mtls({ ...required, caPem });
    assert.equal(invalid.status, 400, `${label}: ${invalid.text}`);
    assert.equal(invalid.json.code, "CLIENT_CA_INVALID", label);
  }
  const saved = await mtls(required);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.clientCertificate.mode, "required");
  await synced("g11-mtls requires client certificates");
  const forged = {
    "x-client-verify": "SUCCESS",
    "x-client-cert-sha256": "f".repeat(64),
    "x-client-cert-subject": "CN=forged",
    "x-client-cert-serial": "DEADBEEF",
  };
  const withClient = { cert: client.chainPem, key: client.privateKeyPem };
  const withStranger = { cert: stranger.chainPem, key: stranger.privateKeyPem };
  for (const target of NODES) {
    const [none, foreign, plain, ok] = await requests([
      { target, host: M, tls: true, path: "/none" },
      { target, host: M, tls: true, path: "/foreign", ...withStranger },
      { target, host: M, path: "/plain" },
      { target, host: M, tls: true, path: "/ok", headers: forged, ...withClient },
    ]);
    for (const [label, r] of [
      ["without a certificate", none],
      ["another CA's certificate", foreign],
      ["plain HTTP", plain],
    ]) {
      assert.equal(r.status, 403, `${target} ${label}: ${summary(r)}`);
      assert.equal(r.headers["x-edgeweir-error"], "client-cert-required", `${target} ${label}`);
    }
    assert.equal(ok.status, 200, `${target} with the client certificate: ${summary(ok)}`);
    assert.equal(echoed(ok, "X-Client-Verify"), "SUCCESS", ok.body);
    assert.equal(echoed(ok, "X-Client-Cert-Sha256"), sha256, ok.body);
    assert.match(echoed(ok, "X-Client-Cert-Subject") ?? "", /CN=g11-client/, ok.body);
    assert.equal(
      (echoed(ok, "X-Client-Cert-Serial") ?? "").replace(/^0+/, "").toUpperCase(),
      serial,
      ok.body,
    );
    // The visitor's own X-Client-* never reach an origin, on any site.
    const other = await request({ target, host: A, tls: true, headers: forged });
    assert.equal(other.status, 200, `${target} ${A}: ${summary(other)}`);
    for (const name of Object.keys(forged))
      assert.equal(echoed(other, name), undefined, `${target} ${A} forwarded ${name}`);
  }
  // Optional: no certificate and another CA's go on, rules read the outcome.
  const optional = await mtls({ ...required, mode: "optional" });
  assert.equal(optional.status, 200, optional.text);
  await admin.ok("PUT", `/sites/${sites.mtls.id}/rules`, {
    rules: [
      {
        name: "g11 members",
        phase: "waf-custom",
        enabled: true,
        expression: 'http.request.uri.path eq "/members" and tls.client.verified eq false',
        action: { kind: "block", statusCode: 403 },
      },
      {
        name: "g11 vip",
        phase: "waf-custom",
        enabled: true,
        expression: `http.request.uri.path eq "/vip" and (tls.client.cert_sha256 ne "${sha256}" or not (tls.client.subject contains "CN=g11-client"))`,
        action: { kind: "block", statusCode: 403 },
      },
    ],
  });
  await synced("g11-mtls optional with rules on tls.client.*");
  for (const target of NODES) {
    const [none, foreign, members, member, vip, vipStranger] = await requests([
      { target, host: M, tls: true, path: "/open" },
      { target, host: M, tls: true, path: "/open", ...withStranger },
      { target, host: M, tls: true, path: "/members" },
      { target, host: M, tls: true, path: "/members", ...withClient },
      { target, host: M, tls: true, path: "/vip", ...withClient },
      { target, host: M, tls: true, path: "/vip", ...withStranger },
    ]);
    assert.equal(none.status, 200, `${target} optional without: ${summary(none)}`);
    assert.equal(echoed(none, "X-Client-Verify"), "NONE");
    assert.equal(echoed(none, "X-Client-Cert-Sha256"), undefined);
    assert.equal(foreign.status, 200, `${target} optional, another CA: ${summary(foreign)}`);
    assert.equal(echoed(foreign, "X-Client-Verify"), "FAILED");
    assert.equal(members.status, 403, `${target} /members without: ${summary(members)}`);
    assert.equal(member.status, 200, `${target} /members with: ${summary(member)}`);
    assert.equal(vip.status, 200, `${target} /vip with: ${summary(vip)}`);
    assert.equal(vipStranger.status, 403, `${target} /vip another CA: ${summary(vipStranger)}`);
  }
  pass(
    `c. ${M} required on both nodes: 403 client-cert-required without a certificate, with another CA's and over plain HTTP; 200 with the CA's, the origin sees X-Client-Verify SUCCESS, X-Client-Cert-SHA256 ${sha256.slice(0, 12)}…, subject CN=g11-client, serial ${serial}, never the visitor's forged X-Client-* (also on ${A}); optional: NONE and FAILED go on, tls.client.verified / cert_sha256 / subject rules block and pass; HTTP/3 together (CLIENT_CERTIFICATE_HTTP3) and invalid CAs (CLIENT_CA_INVALID) refused`,
  );

  // -------------------------------------------------------------- d. session resumption
  const sess = (name) => `/tmp/g11-${name}.sess`;
  await inPeer("rm -f /tmp/g11-*");
  const resumption = [];
  for (const [label, args] of [
    ["TLS 1.2 session ID", ["-tls1_2", "-no_ticket"]],
    ["TLS 1.2 ticket", ["-tls1_2"]],
    ["TLS 1.3 ticket", ["-tls1_3"]],
  ]) {
    const file = sess(label.replaceAll(" ", "-").replaceAll(".", ""));
    const first = await sClient("node", A, [...args, "-sess_out", file]);
    assert.equal(first.session, "New", `${label} first: ${brief(first)}\n${first.out}`);
    const again = await sClient("node", A, [...args, "-sess_in", file]);
    assert.equal(again.session, "Reused", `${label} again: ${brief(again)}\n${again.out}`);
    assert.equal(again.version, label.includes("1.3") ? "TLSv1.3" : "TLSv1.2");
    // Tickets are the cluster's: the other node resumes them; session IDs
    // live in each node's cache.
    const other = await sClient("node-upgrade-peer", A, [...args, "-sess_in", file]);
    assert.equal(
      other.session,
      label.includes("ticket") ? "Reused" : "New",
      `${label} on node-upgrade-peer: ${brief(other)}\n${other.out}`,
    );
    // Another site's SNI with a.g11.test's session: a new session.
    const foreign = await sClient("node", M, [...args, "-sess_in", file]);
    assert.equal(foreign.session, "New", `${label} with ${M}: ${brief(foreign)}\n${foreign.out}`);
    resumption.push(
      `${label}: ${again.session} on node, ${other.session} on the peer, ${foreign.session} with ${M}`,
    );
  }
  // Early data: the tickets allow none and the node never accepts it.
  const ticket13 = sess("TLS-13-ticket");
  const details = await inPeer(`openssl sess_id -in ${ticket13} -noout -text`);
  assert.match(details, /Max Early Data: 0\b/, details);
  await inPeer(
    `printf 'GET / HTTP/1.1\\r\\nHost: ${A}\\r\\nConnection: close\\r\\n\\r\\n' > /tmp/g11-early.txt`,
  );
  const early = await sClient("node", A, [
    "-tls1_3",
    "-sess_in",
    ticket13,
    "-early_data",
    "/tmp/g11-early.txt",
  ]);
  assert.match(early.out, /Early data was (not sent|rejected)/, early.out);
  assert.doesNotMatch(early.out, /Early data was accepted/);
  // The same ticket keys on both nodes, in the order current, previous, next.
  const ticketFiles = {};
  for (const target of NODES) {
    const id = await containerId(target);
    const conf = await run(["exec", id, "cat", "/var/lib/edgeweir-node/nginx/conf/nginx.conf"]);
    assert.match(conf, /ssl_session_cache shared:edgeweir_tls:16m;/);
    assert.match(conf, /ssl_session_timeout 1h;/);
    assert.match(conf, /ssl_early_data off;/);
    assert.doesNotMatch(conf, /ssl_early_data on/);
    const paths = [...conf.matchAll(/ssl_session_ticket_key (\S+);/g)].map((m) => m[1]);
    assert.ok(paths.length >= 1 && paths.length <= 3, `${target} ticket keys: ${paths}`);
    const sums = await run([
      "exec",
      id,
      "sh",
      "-c",
      `stat -c %s ${paths.join(" ")} && sha256sum ${paths.join(" ")} | cut -d' ' -f1`,
    ]);
    const lines = sums.trim().split("\n");
    assert.deepEqual(
      lines.slice(0, paths.length),
      paths.map(() => "80"),
      `${target}: ${sums}`,
    );
    ticketFiles[target] = lines.slice(paths.length);
  }
  assert.deepEqual(
    ticketFiles.node,
    ticketFiles["node-upgrade-peer"],
    "the same ticket keys on both nodes",
  );
  pass(
    `d. openssl s_client -sess_out/-sess_in for ${A}: ${resumption.join("; ")}; both nodes hold the same ${ticketFiles.node.length} ticket key(s) (80 bytes); early data off (Max Early Data: 0, "${early.out.match(/Early data was [a-z ]+/)?.[0]}")`,
  );

  // -------------------------------------------------------------- e. ACME from the custom directory
  const check = await admin.ok("GET", `/sites/${sites.acme.id}/https/check?ca=custom`);
  assert.deepEqual(check.blockers, [], `HTTPS blockers: ${JSON.stringify(check.blockers)}`);
  const requested = await admin.ok("POST", "/certificates/request", {
    name: "g11-acme",
    names: [ACME],
    email: ACME_EMAIL,
    ca: "custom",
    keyType: "rsa2048",
    challenge: "http01",
    bindSiteId: sites.acme.id,
  });
  const issued = await waitFor(
    "Pebble issues g11-acme",
    async () => {
      const cert = (await admin.ok("GET", "/certificates")).find((c) => c.id === requested.id);
      assert.notEqual(cert?.status, "error", `issuance failed: ${cert?.lastError}`);
      return cert?.status === "ready" ? cert : null;
    },
    240,
    2000,
  );
  await waitFor("g11-acme bound", async () => {
    const bound = await admin.ok("GET", `/sites/${sites.acme.id}/https`);
    return bound.certificateId === issued.id ? bound : null;
  });
  await synced("g11-acme with Pebble's certificate");
  for (const target of NODES) {
    const r = await sClient(target, ACME, ["-tls1_3"]);
    assert.equal(r.bits, 2048, `${target} ${ACME}: ${brief(r)}\n${r.out}`);
    assert.match(r.out, /issuer=.*Pebble/i, r.out);
  }
  const [account] = await accountsOf();
  assert.ok(account, "the Pebble account is listed");
  assert.equal(account.ca, "custom");
  assert.equal(account.eabKid, "");
  assert.ok(account.certificates >= 1, JSON.stringify(account));
  const inUse = await admin.raw("DELETE", `/acme-accounts/${account.id}`);
  assert.equal(inUse.status, 409, inUse.text);
  assert.equal(inUse.json.code, "ACME_ACCOUNT_IN_USE");
  pass(
    `e. Pebble (custom directory, system settings) issued g11-acme by HTTP-01 with an RSA 2048 key; both nodes present it for ${ACME}; account ${account.email} at ${account.directoryUrl} with ${account.certificates} certificate(s), deleting it refused (ACME_ACCOUNT_IN_USE)`,
  );

  await mkdir(".e2e", { recursive: true });
  await writeFile(
    STATE,
    JSON.stringify(
      {
        clusterId,
        multiSiteId: sites.multi.id,
        mtlsSiteId: sites.mtls.id,
        acmeSiteId: sites.acme.id,
        clientCaPem: ca.chainPem,
        otherCaPem: otherCa.chainPem,
        acmeEmail: ACME_EMAIL,
        pebble: PEBBLE,
      },
      null,
      2,
    ),
  );
  finished = true;
  console.log("G11 OK");
} finally {
  await rm(work, { recursive: true, force: true });
  if (!finished)
    console.error("G11 failed; `node scripts/e2e-g11.mjs --cleanup` removes its sites");
}
