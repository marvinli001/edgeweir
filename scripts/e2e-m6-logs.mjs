import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const state = JSON.parse(await readFile(".e2e/m5-state.json", "utf8"));
const login = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email: "admin@e2e.test", password: "e2e-admin-password-123" }),
});
assert.equal(login.status, 200);
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const created = await fetch(`${base}/api/auth/api-key/create`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie },
  body: JSON.stringify({ name: "m6-e2e-control" }),
});
assert.equal(created.status, 200);
const { key } = await created.json();
async function call(method, path, body, credential = key) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": credential },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
await call("PUT", `/sites/${state.siteId}/logs/settings`, { sampleRate: 10000 });
let online = false;
for (let i = 0; i < 60; i++) {
  const node = await call("GET", `/nodes/${state.nodeId}`);
  if (node.applyState === "applied" && node.dataPlaneHealthy) {
    online = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(online);
const path = `/m6-logs-${Date.now()}`;
const http = await import("node:http");
const request = () =>
  new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "localhost",
        port: process.env.E2E_NODE_PORT ?? 18080,
        path: path + "?token=never-store-this",
        headers: { host: state.domain },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
  });
let found;
for (let i = 0; i < 60; i++) {
  await request();
  const filters = new URLSearchParams({
    from: new Date(Date.now() - 300000).toISOString(),
    to: new Date(Date.now() + 60000).toISOString(),
    path,
    status: "200",
    limit: "100",
  });
  found = await call("GET", `/sites/${state.siteId}/logs?${filters}`);
  if (found.entries.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(found.entries.length > 0, "no sampled log arrived");
assert.ok(found.entries.every((l) => l.path === path && l.status === 200));
assert.ok(!JSON.stringify(found).includes("never-store"));
const read = await call("POST", "/access-keys", { name: "m6-readonly", scope: "read" });
let response = await fetch(`${base}/api/v1/sites/${state.siteId}/logs/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", "x-api-key": read.key },
  body: JSON.stringify({ sampleRate: 0 }),
});
assert.equal(response.status, 403);
await call("DELETE", `/access-keys/${read.id}`);
response = await fetch(`${base}/api/v1/sites`, { headers: { "x-api-key": read.key } });
assert.equal(response.status, 401);
await writeFile(".e2e/m6-logs-state.json", JSON.stringify({ siteId: state.siteId, path }));
console.log(
  "M6 LOGS E2E OK: real node request -> sampled log -> status/path filter, no query secrets; read-only 403 and revoked 401",
);
