import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { signInResponse } from "./e2e-auth.mjs";

const execute = promisify(execFile);
const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const domain = "rules.m4.test";
const compose = ["compose", "-f", "compose.e2e.yml"];
async function run(args) {
  return (await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
}
const login = await signInResponse(base, "admin@e2e.test", "e2e-admin-password-123");
assert.equal(login.status, 200);
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
const keyResponse = await fetch(`${base}/api/auth/api-key/create`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie },
  body: JSON.stringify({ name: "m4-e2e" }),
});
assert.equal(keyResponse.status, 200);
const { key, id: keyId } = await keyResponse.json();
async function api(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.ok(res.ok, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(label, fn) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout: ${label}`);
}
function request(path, host = domain, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: edgePort, path, headers: { host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("edge timeout")));
    req.on("error", reject);
    req.end();
  });
}
const cluster = (await api("GET", "/clusters")).find((c) => c.name === "default");
assert.ok(cluster);
await waitFor("M4 node capabilities", async () =>
  (await api("GET", "/nodes")).some(
    (n) =>
      n.online &&
      n.supportedFeatures.includes("rules-v1") &&
      n.supportedFeatures.includes("geoip-city-v1") &&
      n.supportedFeatures.includes("geoip-asn-v1"),
  ),
);
let site = (await api("GET", "/sites")).items.find((s) => s.domains.includes(domain));
if (!site)
  site = (
    await api("POST", "/sites", {
      name: "M4 rules",
      domains: [domain],
      origins: [{ address: "whoami" }],
      cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 60, originCacheControl: "override" }],
    })
  ).site;
let second = (await api("GET", "/sites")).items.find((s) => s.domains.includes("second.m4.test"));
if (!second)
  second = (
    await api("POST", "/sites", {
      name: "M4 second",
      domains: ["second.m4.test"],
      origins: [{ address: "whoami" }],
    })
  ).site;
async function synced() {
  return waitFor("rule revision applied", async () => {
    const c = await api("GET", `/clusters/${cluster.id}`);
    return (await api("GET", "/nodes")).some(
      (n) =>
        n.online &&
        n.clusterId === cluster.id &&
        n.appliedRevision === c.latestRevision.revision &&
        n.applyState === "applied",
    );
  });
}
async function save(rules) {
  await api("PUT", `/sites/${site.id}/rules`, { rules });
  await synced();
}
const rule = (name, phase, expression, action) => ({ name, phase, expression, action });
await save([]);
await api("PUT", "/platform-rules", { rules: [] });
let global = (await api("GET", "/platform-ip-lists")).find((l) => l.name === "m4_global");
if (global) await api("PUT", `/platform-ip-lists/${global.id}`, { entries: [], kind: "block" });
const before = await run([...compose, "logs", "--no-color", "node"]);
const reloads = (logs) => (logs.match(/reconfiguring/g) ?? []).length;
let list = (await api("GET", "/ip-lists")).find((l) => l.name === "m4_blocked");
if (!list) list = await api("POST", "/ip-lists", { name: "m4_blocked", entries: [] });
await api("PUT", `/ip-lists/${list.id}`, { entries: ["0.0.0.0/0", "::/0"], kind: "collection" });
await save([rule("IP block", "waf-custom", "ip.src in $m4_blocked", { kind: "block" })]);
assert.equal((await request("/ip-block")).status, 403);
await api("PUT", `/ip-lists/${list.id}`, { entries: [], kind: "collection" });
await synced();
assert.equal((await request("/ip-block")).status, 200);
assert.equal(reloads(await run([...compose, "logs", "--no-color", "node"])), reloads(before));
console.log("PASS IP list blocks and hot update restores requests without nginx reload");
if (!global)
  global = await api("POST", "/platform-ip-lists", {
    name: "m4_global",
    entries: [],
    kind: "block",
  });
await api("PUT", `/platform-ip-lists/${global.id}`, {
  entries: ["0.0.0.0/0", "::/0"],
  kind: "block",
});
await synced();
assert.equal((await request("/platform")).status, 403);
assert.equal((await request("/platform", "second.m4.test")).status, 403);
await api("PUT", `/platform-ip-lists/${global.id}`, { entries: [], kind: "collection" });
await synced();
console.log("PASS platform IP list applies to both sites");
await save([
  rule("Log only", "waf-custom", 'http.request.uri.path eq "/log-only"', { kind: "log" }),
]);
assert.equal((await request("/log-only")).status, 200);
assert.match(await run([...compose, "logs", "--no-color", "node"]), /WAF match site=/);
await save([
  rule("Rewrite", "request-transform", 'http.request.uri.path eq "/rewrite"', {
    kind: "rewrite",
    value: "/rewritten",
  }),
  rule("Request header", "request-transform", "true", {
    kind: "request_header",
    header: "x-m4-request",
    value: "yes",
  }),
  rule("Redirect", "redirect", 'http.request.uri.path eq "/old"', {
    kind: "redirect",
    value: "/new",
    statusCode: 301,
  }),
  rule("Bypass", "config", 'http.request.uri.path eq "/uncached"', {
    kind: "config",
    cacheBypass: true,
  }),
  rule("Block", "waf-custom", 'http.request.uri.path eq "/blocked"', { kind: "block" }),
  rule("Rate", "ratelimit", 'http.request.uri.path eq "/rate"', {
    kind: "rate_limit",
    limit: 2,
    windowSeconds: 60,
    key: "ip.src",
  }),
  rule("Response header", "response-transform", "http.response.code eq 200", {
    kind: "response_header",
    header: "x-m4-response",
    value: "yes",
  }),
]);
assert.equal((await request("/blocked")).status, 403);
const redirected = await request("/old");
assert.equal(redirected.status, 301);
assert.ok(redirected.headers.location.endsWith("/new"));
for (let i = 0; i < 2; i++) {
  const uncached = await request("/uncached");
  assert.notEqual(uncached.headers["x-cache"], "HIT");
}
const rewritten = await request("/rewrite");
assert.match(rewritten.body, /GET \/rewritten HTTP/);
assert.match(rewritten.body, /X-M4-Request: yes/i);
assert.equal(rewritten.headers["x-m4-response"], "yes");
const nonce = Date.now();
await request(`/cached?nonce=${nonce}`);
assert.equal((await request(`/cached?nonce=${nonce}`)).headers["x-cache"], "HIT");
assert.equal((await request("/rate")).status, 200);
assert.equal((await request("/rate")).status, 200);
assert.equal((await request("/rate")).status, 429);
console.log(
  "PASS WAF log/block, cache override, redirect, rewrite, request/response headers, rate limit",
);
await save([
  rule(
    "Synthetic GeoIP",
    "waf-custom",
    'ip.geoip.country eq "NZ" and ip.geoip.subdivision eq "AUK" and ip.geoip.asnum eq 64512',
    { kind: "block" },
  ),
]);
const geoStatus = (
  await run([
    ...compose,
    "exec",
    "-T",
    "console",
    "node",
    "--input-type=module",
    "-e",
    `import http from "node:http";http.get({hostname:"node",path:"/geo",headers:{host:"${domain}"}},res=>{console.log(res.statusCode);res.resume()});`,
  ])
).trim();
assert.equal(geoStatus, "403");
console.log("PASS local City/ASN MMDB lookup participates in WAF rules");
await save([]);
await api("DELETE", `/ip-lists/${list.id}`);
await api("DELETE", `/platform-ip-lists/${global.id}`);
if (keyId) {
  const revoke = await fetch(`${base}/api/auth/api-key/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify({ keyId }),
  });
  assert.equal(revoke.status, 200);
}
console.log("M4 E2E OK");
