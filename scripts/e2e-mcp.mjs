// MCP over OAuth (ADR-0076) against the stack's console image, as a client
// such as Claude Code drives it over HTTP:
//   a. MCP is off: /mcp and the discovery documents answer 404; the operator
//      switches it on (mcp.settings_update)
//   b. /mcp without a token: 401 with resource_metadata; the protected
//      resource and authorization server metadata name each other
//   c. dynamic client registration; authorize without a session goes to
//      /login with a signed request, the sign-in resumes it to
//      /oauth/consent (the SPA serves it), the operator grants read and write
//   d. code + PKCE for tokens (opaque ewo_ / ewr_), initialize, tools/list,
//      get_overview, a purge through purge_cache recorded as the MCP client,
//      a forbidden procedure refused, refresh rotation
//   e. a read-only grant gets 403 insufficient_scope for a write; revoking the
//      app makes its tokens 401 at once
// `node scripts/e2e-mcp.mjs --cleanup` revokes what is left and switches MCP off.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rpc, signInResponse } from "./e2e-auth.mjs";
import { base, pass } from "./e2e-lib.mjs";

const ADMIN = { email: "admin@e2e.test", password: "e2e-admin-password-123" };
const REDIRECT = "http://127.0.0.1:47123/callback";
const resource = `${base}/mcp`;

const cookieOf = (response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");

async function operator() {
  const response = await signInResponse(base, ADMIN.email, ADMIN.password);
  assert.equal(response.status, 200, `sign-in: ${await response.clone().text()}`);
  return cookieOf(response);
}

async function cleanup() {
  const cookie = await operator();
  const { apps } = await rpc(base, cookie, "mcp/apps", {});
  for (const app of apps) await rpc(base, cookie, "mcp/revokeApp", { clientId: app.clientId });
  await rpc(base, cookie, "mcp/setSettings", { enabled: false });
  pass(`MCP cleanup: ${apps.length} app(s) revoked, MCP off`);
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

let rpcId = 0;
/** One MCP JSON-RPC request (2025-11-25, stateless): the response and its message. */
async function mcp(token, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await response.text();
  const data = body.startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  return { response, message: data ? JSON.parse(data) : {} };
}

async function tool(token, name, args = {}) {
  const { response, message } = await mcp(token, "tools/call", { name, arguments: args });
  const text = message.result?.content?.[0]?.text ?? "";
  return {
    status: response.status,
    response,
    isError: message.result?.isError === true,
    json: text ? JSON.parse(text) : null,
  };
}

const form = (path, body) =>
  fetch(`${base}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

/** Where a redirecting better-auth answer sends the browser: Location, or the JSON url. */
async function target(response) {
  const text = await response.text();
  const location =
    response.headers.get("location") ?? (text.startsWith("{") ? JSON.parse(text).url : undefined);
  assert.ok(location, `no redirect (HTTP ${response.status}): ${text.slice(0, 300)}`);
  return new URL(location, base);
}

/** Authorize → (sign-in) → consent → token, as the browser and the client do it. */
async function grant(clientId, access, session) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "edgeweir:read edgeweir:write offline_access",
    state: `e2e-${access}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  });
  const authorize = await fetch(`${base}/api/auth/oauth2/authorize?${params}`, {
    redirect: "manual",
    headers: session ? { cookie: session } : {},
  });
  let next = await target(authorize);
  let cookie = session;
  if (next.pathname === "/login") {
    assert.ok(next.searchParams.get("sig"), "the /login redirect carries a signed request");
    // The login page's sign-in carries the request (oauthProviderClient) and resumes it.
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ ...ADMIN, oauth_query: next.search.slice(1) }),
    });
    assert.equal(signIn.status, 200, await signIn.clone().text());
    const body = await signIn.json();
    assert.equal(body.redirect, true, JSON.stringify(body));
    cookie = cookieOf(signIn);
    next = new URL(body.url, base);
  }
  assert.equal(next.pathname, "/oauth/consent", `authorize went to ${next}`);
  const page = await fetch(next, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/, "the SPA serves /oauth/consent");
  const oauthQuery = next.search.slice(1);
  const request = await rpc(base, cookie, "mcp/consentRequest", { oauthQuery });
  assert.deepEqual(
    { name: request.clientName, redirect: request.redirectHost, localhost: request.localhost },
    { name: "E2E Agent", redirect: "127.0.0.1:47123", localhost: true },
  );
  const { url } = await rpc(base, cookie, "mcp/consent", { oauthQuery, accept: true, access });
  const back = new URL(url);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), `e2e-${access}`);
  const token = await form("/oauth2/token", {
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  assert.equal(token.status, 200, await token.clone().text());
  return { tokens: await token.json(), cookie };
}

async function register(name) {
  const response = await fetch(`${base}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.ok([200, 201].includes(response.status), await response.clone().text());
  return (await response.json()).client_id;
}

async function main() {
  let cookie = await operator();

  // a. Off by default.
  await rpc(base, cookie, "mcp/setSettings", { enabled: false });
  assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 404);
  const settings = await rpc(base, cookie, "mcp/setSettings", { enabled: true });
  assert.deepEqual(settings, { enabled: true, url: resource });
  const audit = await rpc(base, cookie, "auditLogs/list", { action: "mcp.settings_update" });
  assert.ok(audit.items.length >= 2, "mcp.settings_update recorded");
  pass(`MCP switched on at ${settings.url} (mcp.settings_update)`);

  // b. Discovery.
  const challenge = await mcp(null, "initialize");
  assert.equal(challenge.response.status, 401);
  const header = challenge.response.headers.get("www-authenticate") ?? "";
  assert.ok(
    header.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`),
    header,
  );
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, resource);
  assert.deepEqual(prm.authorization_servers, [`${base}/api/auth`]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)).json();
  assert.equal(as.issuer, `${base}/api/auth`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.registration_endpoint, "registration endpoint advertised");
  pass(`401 challenge → ${prm.authorization_servers[0]} (PKCE S256, registration open)`);

  // c. Registration, sign-in resume, consent.
  const clientId = await register("E2E Agent");
  const write = await grant(clientId, "write", "");
  cookie = write.cookie;
  assert.match(write.tokens.access_token, /^ewo_/);
  assert.match(write.tokens.refresh_token, /^ewr_/);
  assert.deepEqual(write.tokens.scope.split(" ").sort(), [
    "edgeweir:read",
    "edgeweir:write",
    "offline_access",
  ]);
  pass(
    `client ${clientId.slice(0, 8)}… registered, sign-in resumed to consent, read+write granted`,
  );

  // d. Tools.
  const token = write.tokens.access_token;
  const init = await mcp(token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  assert.equal(init.message.result?.serverInfo?.name, "edgeweir", JSON.stringify(init.message));
  const list = await mcp(token, "tools/list");
  const names = (list.message.result?.tools ?? []).map((t) => t.name);
  for (const name of ["search_operations", "call_operation", "get_overview", "purge_cache"])
    assert.ok(names.includes(name), `tool ${name} in ${names}`);
  const overview = await tool(token, "get_overview");
  assert.equal(overview.isError, false, JSON.stringify(overview.json));
  const purge = await tool(token, "purge_cache", {
    type: "url",
    urls: ["http://demo.test/mcp-e2e"],
  });
  assert.equal(purge.isError, false, JSON.stringify(purge.json));
  const task = purge.json;
  const purged = await rpc(base, cookie, "auditLogs/list", { action: "cache.purge" });
  const entry = purged.items.find((item) => item.targetId === task.id);
  assert.equal(entry?.actorType, "oauth_client", JSON.stringify(entry));
  assert.equal(entry?.actorName, "E2E Agent");
  const forbidden = await tool(token, "call_operation", {
    name: "accessKeys.create",
    input: { name: "x" },
  });
  assert.equal(forbidden.json?.error ?? null, "UNKNOWN_OPERATION");
  const refreshed = await form("/oauth2/token", {
    grant_type: "refresh_token",
    refresh_token: write.tokens.refresh_token,
    client_id: clientId,
    resource,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const rotated = await refreshed.json();
  assert.notEqual(rotated.refresh_token, write.tokens.refresh_token);
  assert.equal((await mcp(rotated.access_token, "tools/list")).response.status, 200);
  pass(
    `tools: ${names.length} listed, overview read, purge ${task.id.slice(0, 8)}… audited as the MCP client, accessKeys hidden, refresh rotated`,
  );

  // e. Read-only grant, then revoke.
  const readClient = await register("E2E Agent");
  const read = await grant(readClient, "read", cookie);
  assert.ok(!read.tokens.scope.split(" ").includes("edgeweir:write"), read.tokens.scope);
  const denied = await tool(read.tokens.access_token, "purge_cache", {
    type: "url",
    urls: ["http://demo.test/mcp-e2e"],
  });
  assert.equal(denied.status, 403);
  assert.match(denied.response.headers.get("www-authenticate") ?? "", /insufficient_scope/);
  const { apps } = await rpc(base, cookie, "mcp/apps", {});
  assert.ok(
    apps.some((app) => app.clientId === clientId && app.lastUsedAt),
    "write app listed",
  );
  await rpc(base, cookie, "mcp/revokeApp", { clientId });
  assert.equal((await mcp(rotated.access_token, "tools/list")).response.status, 401);
  pass("read grant refused a purge with 403 insufficient_scope; revoke made the token 401 at once");
}

if (process.argv.includes("--cleanup")) await cleanup();
else await main();
