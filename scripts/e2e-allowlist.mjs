// Login IP allow list (ADR-0047). The host reaches the console through the
// published port, so the console sees a Docker gateway (or VM) address for it,
// read from the settings rather than assumed; client-a sits on the default
// network with an address of its own.
//   a. the host signs in; the settings show its address X (with the proxy
//      hint: a private address); a list without X is refused
//      (LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP); [X] is saved and the host
//      still signs in
//   b. client-a saves [Y], its own address, with an AccessKey over /api/v1
//   c. from the host: sign-in answers 403 LOGIN_IP_NOT_ALLOWED for the right
//      and a wrong password; the earlier session cookie gets 403 on /rpc and
//      /api/auth/get-session but may sign out; the AccessKey still reads
//      /api/v1; system.status answers; the demo account signs in and reads,
//      seeing the list cut to /24; the console logs the refusals
//   d. client-a, on the list, signs in
//   e. recover.js --clear-login-allowlist in the console container: the host
//      signs in again, the old cookie is signed out, account.recover records
//      the cleared range
// `node scripts/e2e-allowlist.mjs --cleanup` clears the list, puts the demo
// switch back and revokes the AccessKey.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass, stack } from "./e2e-lib.mjs";

const { compose, run } = stack();
const STATE = ".e2e/allowlist-state.json";
const ADMIN = { email: "admin@e2e.test", password: "e2e-admin-password-123" };
const DEMO = { email: "demo@edgeweir.com", password: "demo" };

const cookieOf = (response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");

async function signIn({ email, password }) {
  const response = await signInResponse(base, email, password);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    cookie: cookieOf(response),
  };
}

/** An /rpc call as the web UI makes it: status and JSON, without throwing. */
async function rpcRaw(cookie, path, input) {
  const response = await fetch(`${base}/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "orpc", cookie },
    body: JSON.stringify({ json: input }),
  });
  const body = await response.json();
  return { status: response.status, json: body.json };
}

async function v1(key, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** A fetch made inside client-a (its own address); the console is http://console:3000 there. */
const CLIENT_FETCH = `
const r = await fetch("http://console:3000" + process.env.P, {
  method: process.env.M,
  headers: JSON.parse(process.env.H),
  body: process.env.B || undefined,
});
const t = await r.text();
console.log(JSON.stringify({ status: r.status, json: t ? JSON.parse(t) : null }));
`;
async function fromClientA(method, path, headers, body) {
  const out = await run([
    ...compose,
    "exec",
    "-T",
    "-e",
    `M=${method}`,
    "-e",
    `P=${path}`,
    "-e",
    `H=${JSON.stringify(headers)}`,
    "-e",
    `B=${body === undefined ? "" : JSON.stringify(body)}`,
    "client-a",
    "node",
    "--input-type=module",
    "-e",
    CLIENT_FETCH,
  ]);
  return JSON.parse(out.trim().split("\n").at(-1));
}

async function recover() {
  return run([
    ...compose,
    "exec",
    "-T",
    "console",
    "node",
    "dist/server/recover.js",
    "--clear-login-allowlist",
  ]);
}

if (process.argv.includes("--cleanup")) {
  let state = null;
  try {
    state = JSON.parse(await readFile(STATE, "utf8"));
  } catch {}
  // An empty list passes the lockout check from anywhere, and keys are not limited.
  if (state?.key)
    assert.equal(
      (await v1(state.key, "PUT", "/settings/login-allow-list", { cidrs: [] })).status,
      200,
    );
  const admin = await signIn(ADMIN);
  if (admin.status !== 200) {
    // No key to clear the list with: the server-side recovery does it.
    await recover();
  }
  const { cookie } = admin.status === 200 ? admin : await signIn(ADMIN);
  if (state) {
    await rpc(base, cookie, "settings/setDemo", { enabled: state.demoBefore });
    if (state.keyId) await rpc(base, cookie, "accessKeys/revoke", { id: state.keyId });
  }
  await rm(STATE, { force: true });
  pass("allowlist cleanup: the list is off, the demo switch is back, the AccessKey is revoked");
  process.exit(0);
}

// a. The host's address, the lockout check, and [X].
const admin = await signIn(ADMIN);
assert.equal(admin.status, 200, `operator sign-in: ${JSON.stringify(admin.json)}`);
const demoBefore = (await rpc(base, admin.cookie, "settings/demo", {})).enabled;
const created = await rpc(base, admin.cookie, "accessKeys/create", { name: "allowlist-e2e" });
await mkdir(".e2e", { recursive: true });
await writeFile(STATE, JSON.stringify({ key: created.key, keyId: created.id, demoBefore }));
await rpc(base, admin.cookie, "settings/setDemo", { enabled: true });
const seen = await rpc(base, admin.cookie, "settings/loginAllowList", {});
const X = seen.currentIp;
assert.match(X, /^[0-9a-f.:]+$/, `the host's address: ${JSON.stringify(seen)}`);
assert.deepEqual(seen.cidrs, []);
// A gateway or VM address is private: the card says it may be a proxy's.
assert.equal(seen.proxyHint, true, `proxy hint for ${X}`);
const excluded = await rpcRaw(admin.cookie, "settings/setLoginAllowList", {
  cidrs: ["192.0.2.0/24"],
});
assert.equal(excluded.status, 400);
assert.equal(excluded.json.code, "LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP");
assert.equal(excluded.json.data.ip, X);
const own = await rpc(base, admin.cookie, "settings/setLoginAllowList", { cidrs: [X] });
const hostRange = own.cidrs[0];
assert.ok(hostRange?.startsWith(X), JSON.stringify(own));
const spare = await signIn(ADMIN);
assert.equal(spare.status, 200, "the host on the list signs in");
pass(
  `a. the console sees the host as ${X} (proxy hint); a list without it is refused; [${hostRange}] saved, the host signs in`,
);

// b. client-a saves its own address with the AccessKey.
const keyHeaders = { "content-type": "application/json", "x-api-key": created.key };
const clientView = await fromClientA("GET", "/api/v1/settings/login-allow-list", keyHeaders);
assert.equal(clientView.status, 200, JSON.stringify(clientView));
const Y = clientView.json.currentIp;
assert.notEqual(Y, X, "client-a has an address of its own");
const saved = await fromClientA("PUT", "/api/v1/settings/login-allow-list", keyHeaders, {
  cidrs: [Y],
});
assert.equal(saved.status, 200, JSON.stringify(saved));
const clientRange = saved.json.cidrs[0];
pass(`b. client-a (${Y}) saves [${clientRange}] with an AccessKey over /api/v1`);

// c. The host is outside the list now.
for (const password of [ADMIN.password, "not-the-password-at-all"]) {
  const refused = await signIn({ email: ADMIN.email, password });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "LOGIN_IP_NOT_ALLOWED");
  assert.equal(refused.cookie, "");
}
const me = await rpcRaw(admin.cookie, "account/me", {});
assert.equal(me.status, 403);
assert.equal(me.json.code, "LOGIN_IP_NOT_ALLOWED");
const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: admin.cookie } });
assert.equal(session.status, 403);
const viaKey = await v1(created.key, "GET", "/settings/login-allow-list");
assert.equal(viaKey.status, 200);
assert.deepEqual(viaKey.json.cidrs, [clientRange]);
assert.equal(viaKey.json.currentIp, X);
assert.equal((await rpcRaw("", "system/status", {})).status, 200);
const demo = await signIn(DEMO);
assert.equal(demo.status, 200, `demo sign-in: ${JSON.stringify(demo.json)}`);
assert.equal((await rpc(base, demo.cookie, "account/me", {})).demo, true);
const demoView = await rpc(base, demo.cookie, "settings/loginAllowList", {});
assert.deepEqual(demoView.cidrs, [`${Y.split(".").slice(0, 3).join(".")}.0/24`]);
// Signing out only ends the session: not limited.
const signOut = await fetch(`${base}/api/auth/sign-out`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie: spare.cookie },
  body: "{}",
});
assert.equal(signOut.status, 200);
const logs = await run([...compose, "logs", "--since", "5m", "console"]);
assert.match(
  logs,
  new RegExp(
    `request refused: address outside the login allow list.*"ip":"${X.replace(/\./g, "\\.")}"`,
  ),
);
pass(
  `c. from ${X}: sign-in 403 LOGIN_IP_NOT_ALLOWED (right and wrong password), the session cookie 403 on /rpc and get-session (sign-out answers), the AccessKey reads /api/v1, system.status answers, the demo account signs in and sees ${demoView.cidrs[0]}, the refusals are logged`,
);

// d. client-a is on the list.
const clientSignIn = await fromClientA(
  "POST",
  "/api/auth/sign-in/email",
  { "content-type": "application/json", origin: base },
  ADMIN,
);
assert.equal(clientSignIn.status, 200, JSON.stringify(clientSignIn));
pass(`d. client-a (${Y}) signs in`);

// e. Server-side recovery clears the list and signs every session out.
const out = await recover();
assert.match(out, /Login allow list cleared \(1 range\)\./);
assert.match(out, /Signed out \d+ sessions?\./);
const again = await signIn(ADMIN);
assert.equal(again.status, 200, "the host signs in again");
assert.equal(
  (await rpcRaw(admin.cookie, "account/me", {})).status,
  401,
  "the old cookie is signed out",
);
const audit = await v1(created.key, "GET", "/audit-logs?action=account.recover&limit=1");
assert.deepEqual(audit.json.items[0].metadata.loginAllowListCleared, [clientRange]);
assert.deepEqual((await v1(created.key, "GET", "/settings/login-allow-list")).json.cidrs, []);
pass(
  "e. recover.js --clear-login-allowlist: the host signs in again, the old cookie is signed out, account.recover records the cleared range",
);
