// Two edge nodes for the TLS handshake comparison of scripts/bench.sh
// (BENCH_SCENARIO=tls and tls-resume), on a compose.e2e stack after the full
// e2e (or after setup). Each is the only node of its own cluster serving one
// site with a cache rule on / and a self-signed ECDSA P-256 certificate:
//   g11-bench-base  edgeweir-node:pre-g11 (the node before G11, built from
//                   E2E_PRE_G11_COMMIT when missing), base.tls-bench.g11.test,
//                   :443 on 127.0.0.1:${E2E_G11_BENCH_BASE_PORT:-18943}
//   g11-bench-new   the image of this stack (edgeweir-node:${E2E_TAG}),
//                   new.tls-bench.g11.test, 127.0.0.1:${E2E_G11_BENCH_NEW_PORT:-18944}
// `--multi` gives the new node's site four certificates (its own ECDSA one
// first, then an RSA 2048 one for the same name, a wildcard and another
// name's), `--single` goes back to one; `--cleanup` removes both nodes,
// clusters, sites and certificates. Prints the bench.sh variables of each.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const nodeContext = process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node";
/** The node before G11: no multi-certificate-v1, client-cert-v1 or session ticket keys. */
const OLD_IMAGE = process.env.E2E_PRE_G11_IMAGE ?? "edgeweir-node:pre-g11";
/** Last edgeweir-node commit before G11 (proto v0.25.0); builds OLD_IMAGE when it is missing. */
const OLD_COMMIT = process.env.E2E_PRE_G11_COMMIT ?? "56d7d0e";
const NEW_IMAGE = `edgeweir-node:${process.env.E2E_TAG ?? "e2e"}`;
const compose = ["compose", "-f", "compose.e2e.yml"];
const run = async (args, opts = {}) =>
  (await execute("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BENCH = {
  base: {
    cluster: "g11-bench-base",
    host: "base.tls-bench.g11.test",
    image: OLD_IMAGE,
    port: Number(process.env.E2E_G11_BENCH_BASE_PORT ?? 18943),
  },
  new: {
    cluster: "g11-bench-new",
    host: "new.tls-bench.g11.test",
    image: NEW_IMAGE,
    port: Number(process.env.E2E_G11_BENCH_NEW_PORT ?? 18944),
  },
};

async function waitFor(label, fn, seconds = 180, interval = 1000) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`timeout: ${label}`);
}

const response = await waitFor("sign in", async () => {
  const r = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
  return r.status === 200 ? r : null;
});
const cookie = response.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const key = (await rpc(base, cookie, "accessKeys/create", { name: "g11-bench" })).key;
async function api(method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const consoleId = (await run([...compose, "ps", "-q", "console"])).trim();
assert.ok(consoleId, "console is not running");
const project = JSON.parse(await run(["inspect", consoleId]))[0].Config.Labels[
  "com.docker.compose.project"
];
const LABEL = `dev.edgeweir.g11-bench=${project}`;
const container = (which) => `${project}-g11-bench-${which}`;
const clusterNamed = async (name) => (await api("GET", "/clusters")).find((c) => c.name === name);
const siteOf = async (host) =>
  (await api("GET", `/sites?search=${encodeURIComponent(host)}&pageSize=100`)).items.find((s) =>
    s.domains.includes(host),
  );

async function cleanup() {
  const ids = (await run(["ps", "-aq", "--filter", `label=${LABEL}`])).split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  for (const bench of Object.values(BENCH)) {
    const site = await siteOf(bench.host);
    if (site) await api("DELETE", `/sites/${site.id}`);
    const cluster = await clusterNamed(bench.cluster);
    if (cluster) {
      for (const node of await api("GET", `/nodes?clusterId=${cluster.id}`))
        await api("DELETE", `/nodes/${node.id}`);
      await api("DELETE", `/clusters/${cluster.id}`);
    }
  }
  for (const cert of await api("GET", "/certificates"))
    if (cert.name.startsWith("g11-bench-")) await api("DELETE", `/certificates/${cert.id}`);
  console.log(`g11 bench nodes removed (${ids.length} container(s))`);
}

/** Self-signed certificates (host openssl), uploaded once by name. */
async function certificate(name, names, rsa = false) {
  const existing = (await api("GET", "/certificates")).find((c) => c.name === name);
  if (existing) return existing;
  const dir = await mkdtemp(join(tmpdir(), "g11-bench-"));
  const cnf = join(dir, "leaf.cnf");
  await writeFile(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = leaf",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[leaf]",
      "basicConstraints = critical,CA:FALSE",
      `subjectAltName = ${names.map((n) => `DNS:${n}`).join(",")}`,
      "",
    ].join("\n"),
  );
  await execute("openssl", [
    "req",
    "-x509",
    ...(rsa
      ? ["-newkey", "rsa:2048"]
      : [
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-pkeyopt",
          "ec_param_enc:named_curve",
        ]),
    "-nodes",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-days",
    "30",
    "-config",
    cnf,
  ]);
  const cert = await api("POST", "/certificates/upload", {
    name,
    chainPem: await readFile(join(dir, "cert.pem"), "utf8"),
    privateKeyPem: await readFile(join(dir, "key.pem"), "utf8"),
  });
  await rm(dir, { recursive: true, force: true });
  return cert;
}

async function synced(cluster) {
  const latest = (await api("GET", `/clusters/${cluster.id}`)).latestRevision.revision;
  await waitFor(`${cluster.name} applies #${latest}`, async () =>
    (await api("GET", `/nodes?clusterId=${cluster.id}`)).every(
      (n) => n.online && n.applyState === "applied" && n.appliedRevision >= latest,
    ),
  );
}

/** The new node's site: one certificate, or four with --multi. */
async function newSiteCertificates(multi) {
  const site = await siteOf(BENCH.new.host);
  const own = await certificate("g11-bench-new", [BENCH.new.host]);
  const additional = multi
    ? [
        (await certificate("g11-bench-new-rsa", [BENCH.new.host], true)).id,
        (await certificate("g11-bench-wild", ["*.tls-bench.g11.test"])).id,
        (await certificate("g11-bench-other", ["other.tls-bench.g11.test"])).id,
      ]
    : [];
  await api("PUT", `/sites/${site.id}/https`, {
    settings: { certificateId: own.id, additionalCertificateIds: additional },
  });
  await synced(await clusterNamed(BENCH.new.cluster));
  console.log(`${BENCH.new.host}: ${1 + additional.length} certificate(s)`);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
  process.exit(0);
}
if (process.argv.includes("--multi") || process.argv.includes("--single")) {
  await newSiteCertificates(process.argv.includes("--multi"));
  process.exit(0);
}

await cleanup();
try {
  await run(["image", "inspect", OLD_IMAGE]);
} catch {
  console.log(`building ${OLD_IMAGE} from edgeweir-node ${OLD_COMMIT}`);
  await execute(
    "sh",
    [
      "-c",
      'git -C "$1" archive "$2" | docker build -q -t "$3" -',
      "sh",
      nodeContext,
      OLD_COMMIT,
      OLD_IMAGE,
    ],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
const network = Object.keys(
  JSON.parse(await run(["inspect", consoleId]))[0].NetworkSettings.Networks,
).find((name) => name.endsWith("_default"));
for (const [which, bench] of Object.entries(BENCH)) {
  const cluster = await api("POST", "/clusters", { name: bench.cluster });
  await run([
    "run",
    "-d",
    "--name",
    container(which),
    "--label",
    LABEL,
    "--hostname",
    `edge-g11-bench-${which}`,
    "--network",
    network,
    "-p",
    `127.0.0.1:${bench.port}:443`,
    "-v",
    `${project}_geoip-test-data:/etc/edgeweir-geoip:ro`,
    "-e",
    "EDGEWEIR_GEOIP_IPINFO=/etc/edgeweir-geoip/ipinfo_lite.mmdb",
    bench.image,
  ]);
  const token = await api("POST", "/enrollment-tokens", {
    clusterId: cluster.id,
    nodeName: `edge-g11-bench-${which}`,
    ttlMinutes: 15,
  });
  await execute(
    "docker",
    [
      "exec",
      "-e",
      "EDGEWEIR_TOKEN",
      container(which),
      "edgeweir-node",
      "enroll",
      "--server",
      token.serverUrl,
      "--ca-sha256",
      token.caSha256,
    ],
    { env: { ...process.env, EDGEWEIR_TOKEN: token.token } },
  );
  await waitFor(`edge-g11-bench-${which} online`, async () =>
    (await api("GET", `/nodes?clusterId=${cluster.id}`)).some((n) => n.online),
  );
  const { site } = await api("POST", "/sites", {
    name: bench.cluster,
    clusterId: cluster.id,
    domains: [bench.host],
    origins: [{ address: "whoami" }],
    cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 3600, originCacheControl: "override" }],
  });
  const cert = await certificate(`g11-bench-${which}`, [bench.host]);
  await api("PUT", `/sites/${site.id}/https`, { settings: { certificateId: cert.id } });
  await synced(cluster);
  const node = (await api("GET", `/nodes?clusterId=${cluster.id}`))[0];
  console.log(
    `${which}: BENCH_URL=https://127.0.0.1:${bench.port}/bench-cache.txt BENCH_HOST=${bench.host} BENCH_NODE_CONTAINER=${container(which)} (${bench.image}, ${node.version ?? "?"}, features ${node.supportedFeatures.filter((f) => /certificate|cert-/.test(f)).join(",") || "-"})`,
  );
}
