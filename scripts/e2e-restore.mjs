// Restore only the disposable compose.e2e database; the original database is retained.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile),
  base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const compose = ["compose", "-f", "compose.e2e.yml"];
const state = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const run = async (args) => (await execute("docker", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const login = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
assert.equal(login.status, 200);
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const created = await fetch(`${base}/api/auth/api-key/create`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie },
  body: JSON.stringify({ name: "restore-e2e" }),
});
assert.equal(created.status, 200);
const { key } = await created.json();
async function api(method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
async function wait(label, fn) {
  for (let i = 0; i < 120; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}
const node = await api("GET", `/nodes/${state.nodeId}`);
const clusterPath = `/clusters/${node.clusterId}`;
const settings = `/sites/${state.siteId}/logs/settings`;
await api("PUT", settings, { sampleRate: 10000 });
const backupRevision = (await api("GET", clusterPath)).latestRevision.revision;
const database = `edgeweir_restore_${Date.now()}`;
// The dump stays inside the disposable postgres container, mode 0600.
await run([
  ...compose,
  "exec",
  "-T",
  "postgres",
  "sh",
  "-c",
  "umask 077; pg_dump -U edgeweir -d edgeweir -Fc -f /tmp/m6-restore.dump",
]);
await api("PUT", settings, { sampleRate: 1000 });
const ahead = (await api("GET", clusterPath)).latestRevision.revision;
assert.ok(ahead > backupRevision);
await wait(
  "node ahead of backup",
  async () => (await api("GET", `/nodes/${node.id}`)).appliedRevision === ahead,
);
await run([...compose, "exec", "-T", "postgres", "createdb", "-U", "edgeweir", database]);
await run([
  ...compose,
  "exec",
  "-T",
  "postgres",
  "pg_restore",
  "-U",
  "edgeweir",
  "--exit-on-error",
  "-d",
  database,
  "/tmp/m6-restore.dump",
]);
const override = ".e2e/restore-override.yml";
await writeFile(
  override,
  `services:\n  console:\n    environment:\n      DATABASE_URL: postgres://edgeweir:e2e-only-password@postgres:5432/${database}\n`,
  { mode: 0o600 },
);
let switched = false;
try {
  await run([...compose, "-f", override, "up", "-d", "--no-deps", "console"]);
  switched = true;
  await wait(
    "restored console",
    async () => (await api("GET", clusterPath)).latestRevision.revision === backupRevision,
  );
  await wait(
    "fresh heartbeat above restored revision",
    async () => (await api("GET", `/nodes/${node.id}`)).appliedRevision === ahead,
  );
  // The restored content is unchanged. D3 still has to publish above the node's LKG.
  await api("PUT", settings, { sampleRate: 10000 });
  const revision = (await api("GET", clusterPath)).latestRevision;
  assert.ok(revision.revision > ahead);
  await wait("restored config applied", async () => {
    const n = await api("GET", `/nodes/${node.id}`);
    return (
      n.online &&
      n.dataPlaneHealthy &&
      n.appliedRevision === revision.revision &&
      n.appliedContentHash === revision.contentHash
    );
  });
  const result = {
    backupRevision,
    nodeBeforeRestore: ahead,
    restoredRevision: revision.revision,
    database,
  };
  await writeFile(".e2e/restore-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log("RESTORE E2E OK", JSON.stringify(result));
} finally {
  if (switched) {
    await run([...compose, "up", "-d", "--no-deps", "console"]);
    await wait("original database console", async () => !!(await api("GET", clusterPath)).id);
    // Bring the original test database above the revision served during the drill as well.
    await wait(
      "heartbeat on original database",
      async () => (await api("GET", `/nodes/${node.id}`)).appliedRevision > ahead,
    );
    await api("PUT", settings, { sampleRate: 10000 });
  }
}
