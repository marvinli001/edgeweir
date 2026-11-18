import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { actor, pass, stack, waitFor } from "./e2e-lib.mjs";

const HOST = "api.security.e2e.test";
const STATE = ".e2e/api-security-state.json";
const { nodeIn, psql, compose, run } = stack();
const admin = await actor("admin@e2e.test", "e2e-admin-password-123", "api-security-e2e");
if (process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(STATE, "utf8"));
  await admin.ok("DELETE", `/sites/${state.siteId}`);
  pass("API security test site removed");
  process.exit(0);
}
const clusterId = (await admin.ok("GET", "/clusters"))[0].id;
const nodes = await admin.ok("GET", `/nodes?clusterId=${clusterId}`);
assert.ok(
  nodes.length && nodes.every((node) => node.supportedFeatures.includes("api-security-v1")),
);
const synced = async () => {
  const latest = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
  await waitFor(`API policy applied #${latest}`, async () => {
    const current = await Promise.all(nodes.map((node) => admin.ok("GET", `/nodes/${node.id}`)));
    return current.every(
      (node) =>
        node.online &&
        node.dataPlaneHealthy &&
        node.applyState === "applied" &&
        node.appliedRevision >= latest,
    );
  });
  return latest;
};
const created = await admin.ok("POST", "/sites", {
  name: "api-security",
  clusterId,
  domains: [HOST],
  origins: [{ address: "api-origin", port: 8080, scheme: "http" }],
  cacheRules: [
    {
      pathPrefixes: ["/"],
      edgeTtlSeconds: 3600,
      originCacheControl: "override",
      cacheAuthorized: true,
    },
  ],
});
const siteId = created.site.id;
await writeFile(STATE, JSON.stringify({ siteId, host: HOST }));
await admin.ok("PUT", `/sites/${siteId}/logs/settings`, {
  sampleRate: 10000,
  logBlocked: true,
  logQuery: true,
  logHeaders: ["x-secret"],
});
await synced();
const policyUrl = `/sites/${siteId}/api-security`;
const save = async (change) => {
  const current = await admin.ok("GET", policyUrl);
  change(current.settings);
  const result = await admin.ok("PUT", policyUrl, {
    settings: current.settings,
    expectedUpdatedAt: current.updatedAt,
  });
  await synced();
  return result;
};
function request(path, { method = "GET", body, headers = {}, probe = randomUUID() } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(process.env.E2E_NODE_PORT ?? 18080),
        path,
        method,
        headers: { host: HOST, "x-api-probe": probe, "accept-encoding": "identity", ...headers },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            probe,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("edge timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
const seen = async (probe) =>
  JSON.parse(
    await nodeIn(
      "client-a",
      `fetch('http://api-origin:8080/_seen?probe=${probe}').then(r=>r.text()).then(t=>process.stdout.write(t))`,
    ),
  ).count;
async function reaches(path, options) {
  const result = await request(path, options);
  assert.equal(
    result.status,
    200,
    `${path}: ${result.status} ${result.headers["x-edgeweir-error"]} ${result.body.slice(0, 120)}`,
  );
  assert.equal(await seen(result.probe), 1, "origin must receive the valid/observed request");
  return result;
}
async function blocked(path, options) {
  const result = await request(path, options);
  assert.ok(result.status >= 400 && result.status < 600, `${path}: unexpected ${result.status}`);
  assert.ok(result.headers["x-request-id"], "denial must have a request id");
  assert.equal(await seen(result.probe), 0, "blocked request must never reach the origin");
  return result;
}
const json = (body, extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-client": "web", ...extra },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const doc = {
  openapi: "3.1.0",
  info: { title: "API test", version: "1" },
  paths: {
    "/api/items/{id}": {
      post: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          {
            name: "count",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 10 },
          },
          {
            name: "x-client",
            in: "header",
            required: true,
            schema: { type: "string", enum: ["web", "mobile"] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string", minLength: 1, maxLength: 20 } },
                required: ["name"],
                additionalProperties: false,
              },
            },
          },
        },
        responses: { 200: { description: "OK" } },
      },
    },
  },
};
doc.paths["/api/other/{id}"] = structuredClone(doc.paths["/api/items/{id}"]);
doc.paths["/api/items/{id}"].get = {
  parameters: structuredClone(doc.paths["/api/items/{id}"].post.parameters),
  responses: { 200: { description: "OK" } },
};
const imported = await admin.ok("POST", `${policyUrl}/import`, { document: JSON.stringify(doc) });
assert.deepEqual(imported.issues, [], "supported OpenAPI import must be complete");
const unsupported = structuredClone(doc);
unsupported.paths["/api/items/{id}"].post.parameters[0].schema.pattern = ".*";
const incomplete = await admin.ok("POST", `${policyUrl}/import`, {
  document: JSON.stringify(unsupported),
});
assert.ok(
  incomplete.issues.length && incomplete.issues[0].location,
  "unsupported constraint needs a location",
);
await save((settings) => {
  settings.discovery = { enabled: true, sampleRate: 10000 };
  settings.schema = {
    mode: "observe",
    unknownEndpoints: "allow",
    endpoints: imported.endpoints,
    issues: [],
  };
});
await reaches("/api/items/1?count=1", json({ name: "valid" }));
await reaches("/api/users/discovery-private-value?token=discovery-private-value", {
  headers: { cookie: "session=discovery-private-value", "x-secret": "discovery-private-value" },
});
const observed = await reaches("/api/items/1?count=99", json({ name: "observed" }));
await waitFor("observation reaches existing log pipeline", async () => {
  const result = await admin.ok("GET", `${policyUrl}/results`);
  return result.events.find(
    (event) =>
      event.requestId === observed.headers["x-request-id"] &&
      event.detail.issues.some((issue) => issue.check === "schema" && issue.mode === "observe"),
  );
});
const beforeEnforce = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
await save((settings) => {
  settings.schema.mode = "enforce";
});
const invalid = [
  ["/api/items/1?count=99", json({ name: "bad query" })],
  ["/api/items/no-number?count=1", json({ name: "bad path" })],
  ["/api/items/1?count=1&count=2", json({ name: "duplicate" })],
  ["/api/items/1?count=1&%63ount=2", json({ name: "encoded duplicate" })],
  ["/api/items/1?count=1", json({ name: "duplicate header" }, { "x-client": ["web", "mobile"] })],
  ["/api/items/1?count=1", json('{"name":"first","name":"second"}')],
  ["/api/items/1?count=1", json('{"name":"\\ud800"}')],
  ["/api/items/1?count=1&other=%FF", json({ name: "invalid query" })],
  ["/api/items/1?count=1", json({ name: "wrong type" }, { "content-type": "text/plain" })],
  ["/api/items/1?count=1", json("{".repeat(1000))],
  ["/api/items/1?count=1", json({ name: "x".repeat(140000) })],
  ["/api%2fitems/1?count=1", json({ name: "encoded" })],
];
for (const [path, options] of invalid) await blocked(path, options);
await reaches("/api/items/1?count=1", json({ name: "still valid" }));
pass(
  "schema: valid and observed requests reach origin; enforced violations, duplicates, parse/size/path failures do not",
);

await admin.ok("POST", `/clusters/${clusterId}/rollback`, { revision: beforeEnforce });
await synced();
await reaches("/api/items/1?count=99", json({ name: "rolled back" }));
await save((settings) => {
  settings.schema.mode = "enforce";
});
const exceptionId = randomUUID();
await save((settings) => {
  settings.exceptions = [
    {
      id: exceptionId,
      enabled: true,
      method: "POST",
      path: "/api/items/{id}",
      check: "schema",
      reason: "test compatibility exception",
    },
  ];
});
await reaches("/api/items/1?count=99", json({ name: "excepted" }));
await blocked("/api/items/1?count=99", { headers: { "x-client": "web" } });
await blocked("/api/other/1?count=99", json({ name: "other endpoint" }));
await save((settings) => {
  settings.graphql.mode = "enforce";
  settings.graphql.pathPrefixes = ["/api/items/"];
});
await blocked("/api/items/1?count=99", json({ name: "GraphQL still applies" }));
await save((settings) => {
  settings.graphql.mode = "off";
  settings.graphql.pathPrefixes = ["/graphql"];
});
await admin.ok("PUT", `/sites/${siteId}/auth-rules`, {
  rules: [
    {
      kind: "basic",
      enabled: true,
      scope: { pathPrefixes: ["/api/"] },
      basic: {
        realm: "API test",
        users: [{ name: "tester", password: "e2e-api-security-password" }],
      },
    },
  ],
});
await synced();
await blocked("/api/items/1?count=99", json({ name: "basic still applies" }));
await admin.ok("PUT", `/sites/${siteId}/auth-rules`, { rules: [] });
await synced();
await save((settings) => {
  settings.exceptions[0].enabled = false;
});
await blocked("/api/items/1?count=99", json({ name: "disabled exception" }));
await save((settings) => {
  settings.exceptions = [];
});
pass(
  "policy rollback and exception enable/disable/delete preserve independent access authentication",
);

const key = generateKeyPairSync("ed25519");
const nextKey = generateKeyPairSync("ed25519");
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "first", alg: "EdDSA" };
const nextJwk = { ...nextKey.publicKey.export({ format: "jwk" }), kid: "next", alg: "EdDSA" };
const jwt = (privateKey = key.privateKey, kid = "first", claims = {}, header = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    Buffer.from(JSON.stringify({ alg: "EdDSA", kid, typ: "JWT", ...header })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: "https://issuer.api.test",
        aud: "api-test",
        exp: now + 3600,
        iat: now,
        sub: "alice",
        ...claims,
      }),
    ).toString("base64url"),
  ];
  return `${parts.join(".")}.${sign(null, Buffer.from(parts.join(".")), privateKey).toString("base64url")}`;
};
const protectedPath = "/private/response";
await reaches(protectedPath);
assert.equal(
  (await request(protectedPath)).headers["x-cache"],
  "HIT",
  "prime an existing cached response before enabling JWT",
);
await save((settings) => {
  settings.jwt = {
    ...settings.jwt,
    mode: "enforce",
    scope: { domains: [], pathPrefixes: ["/private/"], extensions: [], excludePathPrefixes: [] },
    issuer: "https://issuer.api.test",
    audiences: ["api-test"],
    algorithms: ["EdDSA"],
    keys: [jwk],
    clockToleranceSeconds: 0,
  };
});
await blocked(protectedPath);
const firstToken = jwt();
const first = await reaches(protectedPath, { headers: { authorization: `Bearer ${firstToken}` } });
const secondToken = jwt(key.privateKey, "first", { sub: "bob" });
const second = await reaches(protectedPath, {
  headers: { authorization: `Bearer ${secondToken}` },
});
assert.equal(first.headers["x-cache"], "BYPASS");
assert.equal(second.headers["x-cache"], "BYPASS");
assert.notEqual(
  JSON.parse(first.body).credentialDigest,
  JSON.parse(second.body).credentialDigest,
  "credentials must not share cached sensitive responses",
);
for (const token of [
  jwt(nextKey.privateKey),
  jwt(key.privateKey, "unknown"),
  jwt(key.privateKey, "first", { exp: 1 }),
  jwt(key.privateKey, "first", { nbf: Math.floor(Date.now() / 1000) + 3600 }),
  jwt(key.privateKey, "first", { iss: "wrong" }),
  jwt(key.privateKey, "first", { aud: "wrong" }),
  jwt(key.privateKey, "first", {}, { jku: "http://127.0.0.1/keys" }),
  `${Buffer.from('{"alg":"none","kid":"first"}').toString("base64url")}.${firstToken.split(".")[1]}.`,
])
  await blocked(protectedPath, { headers: { authorization: `Bearer ${token}` } });
const mixed = [
  Buffer.from('{"alg":"HS256","kid":"first"}').toString("base64url"),
  firstToken.split(".")[1],
].join(".");
await blocked(protectedPath, {
  headers: {
    authorization: `Bearer ${mixed}.${createHmac("sha256", JSON.stringify(jwk)).update(mixed).digest("base64url")}`,
  },
});
await save((settings) => {
  settings.jwt.keys.push(nextJwk);
});
await reaches(protectedPath, {
  headers: { authorization: `Bearer ${jwt(nextKey.privateKey, "next")}` },
});
await save((settings) => {
  settings.jwt.keys = [nextJwk];
});
await blocked(protectedPath, { headers: { authorization: `Bearer ${firstToken}` } });
pass(
  "JWT: cached responses still authenticate, credentials bypass cache, bad algorithms/keys/claims fail, key rotation takes effect",
);

await save((settings) => {
  settings.graphql = {
    ...settings.graphql,
    mode: "enforce",
    maxDepth: 3,
    maxFields: 8,
    maxAliases: 2,
    maxBatch: 2,
    maxDocumentBytes: 1024,
  };
});
await reaches(
  "/graphql",
  json({
    query: "query Pick($id: ID!) { user(id: $id) { ...User } } fragment User on User { id name }",
    variables: { id: "1" },
    operationName: "Pick",
  }),
);
await reaches(
  `/graphql?${new URLSearchParams({ query: "query A { ok } query B { selected }", operationName: "B", variables: "{}" })}`,
);
await reaches("/graphql", json({ query: "{ ok }", variables: null, operationName: null }));
await reaches(
  `/graphql?${new URLSearchParams({ query: "{ ok }", variables: "", operationName: "" })}`,
);
for (const body of [
  { query: "{ a { b { c { d } } } }" },
  { query: "{ a:one b:one c:one }" },
  { query: "{ ...A } fragment A on Query { ...B } fragment B on Query { ...A }" },
  { query: "{ alias:__schema { types { name } } }" },
  { query: "query A { ok } query B { bad }" },
  { query: "query A { ok }", operationName: "missing" },
  { query: "{ ...Unknown }" },
  { extensions: { persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } } },
  { query: "{ ok }", variables: [] },
  [{ query: "{ a }" }, { query: "{ b }" }, { query: "{ c }" }],
  { query: `{ ${"same ".repeat(300)}}` },
])
  await blocked("/graphql", json(body));
await blocked(`/graphql?${new URLSearchParams({ query: "mutation { change }" })}`);
await save((settings) => {
  settings.graphql.mode = "observe";
});
await reaches("/graphql", json({ query: "{ a:one b:one c:one }" }));
pass(
  "GraphQL: AST fragments, operationName, variables, alias/depth/batch/bytes/introspection/APQ and GET semantics",
);

const results = await waitFor("passive endpoints available", async () => {
  const data = await admin.ok("GET", `${policyUrl}/results`);
  return data.endpoints.length && data.events.length ? data : null;
});
assert.ok(results.endpoints.length <= 500 && results.retentionDays === 7);
const candidate = results.endpoints.find((endpoint) => !endpoint.confirmed) ?? results.endpoints[0];
const confirmed = await admin.ok("PUT", `${policyUrl}/endpoints/${candidate.id}`, {
  path: "/manual/{id}",
});
assert.equal(confirmed.confirmed, true);
assert.equal(confirmed.path, "/manual/{id}");
assert.ok(
  !(await admin.ok("GET", policyUrl)).settings.schema.endpoints.some(
    (endpoint) => endpoint.path === "/manual/{id}",
  ),
);
const logText = JSON.stringify(await admin.ok("GET", `${policyUrl}/results`));
assert.ok(!logText.includes(firstToken), "results must never contain the token");
assert.equal(
  await psql(
    `SELECT count(*) FROM access_log WHERE site_id = '${siteId}' AND (path LIKE '%discovery-private-value%' OR query LIKE '%discovery-private-value%' OR headers::text LIKE '%discovery-private-value%')`,
  ),
  "0",
  "discovery must not create raw token-bearing access logs",
);
const current = await admin.ok("GET", policyUrl);
current.settings.schema = {
  ...current.settings.schema,
  mode: "enforce",
  issues: incomplete.issues,
};
assert.ok(
  (
    await admin.raw("PUT", policyUrl, {
      settings: current.settings,
      expectedUpdatedAt: current.updatedAt,
    })
  ).status >= 400,
);
pass(
  "discovery is sampled, bounded and separate from policies; incomplete imports cannot enter enforcement",
);

// Freeze the node's reported capabilities to model a pre-feature node without a heartbeat race.
await run([...compose, "stop", "node"]);
try {
  await psql(
    `UPDATE node SET supported_features = array_remove(supported_features, 'api-security-v1') WHERE id = '${nodes[0].id}'`,
  );
  const state = await admin.ok("GET", policyUrl);
  assert.ok(state.unsupportedNodes >= 1);
  const result = await admin.raw("PUT", policyUrl, {
    settings: state.settings,
    expectedUpdatedAt: state.updatedAt,
  });
  assert.ok(result.status >= 400, "a reported old node must prevent enabling API protection");
} finally {
  await psql(
    `UPDATE node SET supported_features = array_append(supported_features, 'api-security-v1') WHERE id = '${nodes[0].id}'`,
  );
  await run([...compose, "start", "node"]);
}
await synced();
const audit = await admin.ok("GET", "/audit-logs?pageSize=100");
assert.ok(JSON.stringify(audit).includes("site.api_security_update"));
pass(
  "reported old-node capability blocks configuration; audit and request-id results remain available",
);
