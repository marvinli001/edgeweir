import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { signInWithAccessKey } from "./e2e-auth.mjs";

const execute = promisify(execFile);

const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edge = `http://localhost:${process.env.E2E_NODE_PORT ?? 18080}`;
const tlsPort = Number(process.env.E2E_NODE_TLS_PORT ?? 18443);
const domain = "https.m3.test";
const compose = ["compose", "-f", "compose.e2e.yml"];
async function run(command, args, options = {}) {
  const { stdout } = await execute(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

const session = await signInWithAccessKey(
  base,
  "admin@e2e.test",
  "e2e-admin-password-123",
  "m3-e2e",
);
const { key } = session;
async function api(method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function waitFor(label, fn, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}
const clusters = await api("GET", "/clusters");
const cluster = clusters.find((c) => c.name === "default") ?? clusters[0];
assert.ok(cluster);
if (process.env.E2E_FORCE_ENROLL === "1") {
  const token = await api("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: "edge-e2e-1",
    ttlMinutes: 15,
  });
  // A running node refuses `enroll --force`: enroll in a one-off container
  // on the node's volumes while it is stopped.
  await run("docker", [...compose, "stop", "node"]);
  await run(
    "docker",
    [
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-e",
      "EDGEWEIR_TOKEN",
      "--entrypoint",
      "edgeweir-node",
      "node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
      "--force",
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  await run("docker", [...compose, "start", "node"]);
}
await waitFor("capable online node", async () =>
  (await api("GET", "/nodes")).find(
    (n) => n.clusterId === cluster.id && n.online && n.supportedFeatures.includes("http3-v1"),
  ),
);
let site = (await api("GET", "/sites")).items.find((s) => s.domains.includes(domain));
if (!site)
  site = (
    await api("POST", "/sites", {
      name: "M3 HTTPS",
      clusterId: cluster.id,
      domains: [domain],
      origins: [{ address: "whoami" }],
    })
  ).site;
// One-click HTTPS: the check finds nothing in the way and the certificate
// is bound to the site once issued (a site bound by an earlier run keeps
// its certificate).
const unbound = !(await api("GET", `/sites/${site.id}/https`)).certificateId;
const check = await api("GET", `/sites/${site.id}/https/check`);
assert.deepEqual(check.blockers, [], `HTTPS blockers: ${JSON.stringify(check.blockers)}`);
assert.deepEqual(check.request.names, [domain]);
assert.equal(check.request.challenge, "http01");
const requested = await api("POST", "/certificates/request", {
  name: "Pebble M3",
  names: check.request.names,
  email: "acme@e2e.test",
  challenge: check.request.challenge,
  ...(unbound ? { bindSiteId: site.id } : {}),
});
let certificate = await waitFor("real Pebble HTTP-01 issuance", async () => {
  const cert = (await api("GET", "/certificates")).find((c) => c.id === requested.id);
  if (cert?.status === "error") throw new Error(`issuance failed: ${cert.lastError}`);
  return cert?.status === "ready" ? cert : false;
});
console.log("PASS real HTTP-01 issuance through the edge node");
if (unbound) {
  const bound = await api("GET", `/sites/${site.id}/https`);
  assert.equal(bound.certificateId, certificate.id);
  assert.equal(bound.forceHttps, true);
  assert.equal(certificate.bindSiteId, null);
  console.log("PASS one-click HTTPS binds the issued certificate with an HTTPS redirect");
}
const settings = await api("PUT", `/sites/${site.id}/https`, {
  settings: {
    certificateId: certificate.id,
    forceHttps: true,
    hstsMaxAge: 3600,
    http2: true,
    http3: true,
    gzip: true,
  },
});
await waitFor("HTTPS policy applied", async () => {
  const c = await api("GET", `/clusters/${cluster.id}`);
  return (await api("GET", "/nodes")).some(
    (n) =>
      n.clusterId === cluster.id &&
      n.online &&
      n.appliedRevision === c.latestRevision.revision &&
      n.applyState === "applied",
  );
});
const ca = await run("curl", [
  "-fsS",
  "--cacert",
  "docker/e2e/pebble/test-only.crt",
  `https://localhost:${process.env.E2E_ACME_MGMT_PORT ?? 15000}/roots/0`,
]);
await mkdir(".e2e", { recursive: true });
await writeFile(".e2e/m3-root.crt", ca);
function handshake(options = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: tlsPort,
      servername: domain,
      ca,
      ALPNProtocols: ["h2", "http/1.1"],
      ...options,
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS timeout")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      resolve({
        fingerprint: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
        alpn: socket.alpnProtocol,
      });
      socket.end();
    });
  });
}
const first = await handshake();
assert.equal(first.fingerprint, certificate.fingerprint);
assert.equal(first.alpn, "h2");
const redirect = await run("curl", [
  "-sS",
  "-D",
  "-",
  "-o",
  "/dev/null",
  "-H",
  `Host: ${domain}`,
  `${edge}/m3-path`,
]);
assert.match(redirect, /HTTP\/1\.1 301/);
assert.ok(redirect.includes(`Location: https://${domain}/m3-path`));

const curl = process.env.E2E_CURL ?? "curl";
const response = await run(curl, [
  "-fsS",
  "--noproxy",
  "*",
  "--http2",
  "--resolve",
  `${domain}:${tlsPort}:127.0.0.1`,
  "--cacert",
  ".e2e/m3-root.crt",
  "-D",
  "-",
  `https://${domain}:${tlsPort}/`,
]);
assert.match(response, /HTTP\/2 200/);
assert.match(response, /strict-transport-security: max-age=3600/i);
const architecture = (await run("docker", ["info", "--format", "{{.Architecture}}"])).trim();
const goarch = ["aarch64", "arm64"].includes(architecture) ? "arm64" : "amd64";
const probe = resolve(".e2e/http3probe");
await run("go", ["build", "-o", probe, "."], {
  cwd: resolve("helpers/http3probe"),
  env: { ...process.env, GOOS: "linux", GOARCH: goarch, CGO_ENABLED: "0" },
});
const consoleId = (await run("docker", [...compose, "ps", "-q", "console"])).trim();
const network = (
  await run("docker", [
    "inspect",
    consoleId,
    "--format",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}",
  ])
).trim();
assert.equal(
  (
    await run("docker", [
      "run",
      "--rm",
      "--network",
      network,
      "--user",
      "65534:65534",
      "--mount",
      `type=bind,source=${probe},target=/probe,readonly`,
      "--mount",
      `type=bind,source=${resolve(".e2e/m3-root.crt")},target=/ca.crt,readonly`,
      "--entrypoint",
      "/probe",
      `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`,
      "-address",
      "node:443",
      "-url",
      `https://${domain}/`,
      "-ca",
      "/ca.crt",
    ])
  ).trim(),
  "3",
);

console.log("PASS trusted HTTPS, redirect, HSTS, HTTP/2 and HTTP/3");
const since = new Date().toISOString();
await api("POST", `/certificates/${certificate.id}/renew`, {});
certificate = await waitFor("certificate rotation", async () => {
  const c = (await api("GET", "/certificates")).find((c) => c.id === certificate.id);
  if (c?.status === "error") throw new Error(c.lastError);
  return c?.status === "ready" && c.fingerprint !== first.fingerprint ? c : false;
});
await waitFor("rotated certificate served", async () => {
  try {
    return (await handshake()).fingerprint === certificate.fingerprint;
  } catch {
    return false;
  }
});
const logs = await run("docker", [...compose, "logs", "--since", since, "node"]);
assert.ok(
  !logs.includes("nginx configuration installed and reloaded"),
  "renewal must not reload nginx",
);
console.log("PASS renewal rotates the served certificate without nginx reload");
await api("PUT", `/sites/${site.id}/https`, { settings: { ...settings, minimumVersion: "1.3" } });
await waitFor("TLS 1.2 rejected", async () => {
  try {
    await handshake({ minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
    return false;
  } catch {
    return true;
  }
});
assert.ok(await handshake({ minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }));
console.log("PASS per-site TLS minimum is enforced");
console.log("M3 E2E OK");
