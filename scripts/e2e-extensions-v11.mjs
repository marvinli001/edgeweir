// Lua API 2 package delivery and secret rotation through the public console API.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actor, pass, stack, waitFor } from "./e2e-lib.mjs";

const builtin = fileURLToPath(new URL("./fixtures/extensions/api-v2-probe", import.meta.url));
const sources = process.env.E2E_EXTENSION_PACKAGES
  ? [builtin, ...JSON.parse(process.env.E2E_EXTENSION_PACKAGES)]
  : [builtin];
const packages = sources.map((source) => ({
  source: resolve(source),
  manifest: JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")),
}));
const LABEL = "extensions-v11-e2e";
const WORK = "/tmp/ewx-v11-e2e";
const { run, containerId } = stack({ maxBuffer: 64 * 1024 * 1024 });
const admin = await actor("admin@e2e.test", "e2e-admin-password-123", LABEL);
const node = (await admin.ok("GET", "/nodes")).find((item) => item.name === "edge-e2e-1");
assert.ok(node, "edge-e2e-1 is not enrolled");
const nodeContainer = await containerId("node");
const exec = (...args) => run(["exec", nodeContainer, ...args]);
const rootExec = (...args) => run(["exec", "-u", "0", nodeContainer, ...args]);
const hostFor = (id) => `${id}.extensions.e2e.test`;
const nodeState = async (id) =>
  (await admin.ok("GET", `/extensions/${id}`)).nodes.find((item) => item.nodeId === node.id);

async function applied() {
  const revision = (await admin.ok("GET", `/clusters/${node.clusterId}`)).latestRevision.revision;
  await waitFor(`node applied #${revision}`, async () => {
    const current = await admin.ok("GET", `/nodes/${node.id}`);
    return (
      current.online && current.applyState === "applied" && current.appliedRevision >= revision
    );
  });
}

async function cleanup() {
  for (const { manifest } of packages) {
    const host = hostFor(manifest.id);
    const sites = await admin.ok("GET", `/sites?search=${host}&pageSize=100`);
    for (const site of sites.items.filter((item) => item.domains.includes(host))) {
      await admin.ok("DELETE", `/sites/${site.id}`);
    }
    if ((await admin.raw("GET", `/extensions/${manifest.id}`)).status === 200) {
      await admin.ok("DELETE", `/extensions/${manifest.id}`);
    }
  }
  for (const key of await admin.ok("GET", "/extension-keys")) {
    if (key.label === LABEL) await admin.ok("DELETE", `/extension-keys/${key.kid}`);
  }
  await rootExec("rm", "-rf", WORK);
}

const probe = (id) =>
  new Promise((resolveProbe, reject) => {
    const req = http.get(
      {
        host: "localhost",
        port: Number(process.env.E2E_NODE_PORT ?? 18080),
        path: `/.edgeweir/ext/${id}/state`,
        headers: { host: hostFor(id) },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) return resolveProbe(response.statusCode);
          resolveProbe(Buffer.concat(chunks).toString("utf8").split(":"));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("node timeout")));
  });

await cleanup();
if (process.argv.includes("--cleanup")) process.exit(0);
await waitFor("extensions-v2", async () =>
  (await admin.ok("GET", `/nodes/${node.id}`)).supportedFeatures.includes("extensions-v2"),
);
try {
  await exec("mkdir", "-p", WORK);
  for (const { source, manifest } of packages) {
    const { id, publisher } = manifest;
    assert.equal(manifest.requires.lua_api, 2);
    const keyFile = `${WORK}/${id}.jwk`;
    const keygen = await exec("edgeweir-node", "extension", "keygen", "--out", keyFile);
    const publicKey = keygen.match(/^public key: (\{.*\})$/m)?.[1];
    assert.ok(publicKey, "keygen did not return a public key");
    await admin.ok("POST", "/extension-keys", { publisher, key: publicKey, label: LABEL });
    await run(["cp", source, `${nodeContainer}:${WORK}/${id}`]);
    const archive = `${WORK}/${id}.ewx`;
    await exec("edgeweir-node", "extension", "pack", "--out", archive, `${WORK}/${id}`);
    await exec(
      "edgeweir-node",
      "extension",
      "sign",
      "--key",
      keyFile,
      "--publisher",
      publisher,
      archive,
    );
    const packageB64 = (await exec("base64", "-w0", archive)).trim();
    const signature = (await exec("cat", `${archive}.sig`)).trim();
    await admin.ok("POST", "/extensions", { package: packageB64, signature });
    await admin.ok("PATCH", `/extensions/${id}`, { enabled: true });
    const site = await admin.ok("POST", "/sites", {
      name: id,
      domains: [hostFor(id)],
      clusterId: node.clusterId,
      origins: [{ address: "origin", port: 80, protocol: "http", weight: 1 }],
    });
    await admin.ok("PUT", `/sites/${site.id}/extensions/${id}`, { enabled: true, config: {} });
    await applied();
    await waitFor(`${id} loaded`, async () => (await nodeState(id))?.state === "loaded");
    if (source === builtin) {
      const first = await waitFor("initial secret", async () => {
        const value = await probe(id);
        return value?.[0]?.length === 64 && value[1] === "" ? value : null;
      });
      for (let rotation = 1, previous = first[0]; rotation <= 2; rotation++) {
        const result = await admin.ok("POST", `/extensions/${id}/rotate-secret`);
        assert.equal(result.secretVersion, rotation + 1);
        await applied();
        const current = await waitFor("rotated secret", async () => {
          const value = await probe(id);
          return value?.[0]?.length === 64 && value[0] !== previous && value[1] === previous
            ? value[0]
            : null;
        });
        previous = current;
      }
      pass("Lua API 2 secrets rotate and retain only the previous generation");
    }
    await admin.ok("PUT", `/sites/${site.id}/extensions/${id}`, { enabled: false, config: {} });
    await applied();
    if (source === builtin) assert.equal(await probe(id), 404);
    await admin.ok("DELETE", `/sites/${site.id}`);
    await admin.ok("DELETE", `/extensions/${id}`);
    await applied();
    pass(`${id}: signed package installed, loaded, disabled and removed`);
  }
} finally {
  await cleanup();
}
