import { createHash, randomBytes } from "node:crypto";
import {
  ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
  DEMO_EMAIL,
  DEMO_PASSWORD,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { call } from "@orpc/server";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { router } from "../../src/server/rpc/router";
import { AccessKeyRateLimiter } from "../../src/server/services/access-keys";
import { authenticateMcpToken, pruneOAuth } from "../../src/server/services/mcp";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const CIMD_CLIENT_ID = "https://client.example.com/mcp/client.json";
const REDIRECT = "http://127.0.0.1:33418/callback";

describe("MCP over OAuth (ADR-0076)", async () => {
  const cimdFetches: string[] = [];
  // The provider's issuer is https (OAuth 2.1), so is the console here.
  const { ctx, client: db } = await createTestContext(
    { EDGEWEIR_PUBLIC_URL: "https://console.test" },
    {
      fetchClientMetadata: async (input) => {
        cimdFetches.push(String(input));
        return new Response(
          JSON.stringify({
            client_id: CIMD_CLIENT_ID,
            client_name: "Metadata Agent",
            redirect_uris: [REDIRECT],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const resource = `${origin}/mcp`;
  let clock = Date.now();
  ctx.accessKeyLimits = new AccessKeyRateLimiter(() => clock);
  let admin: ApiClient;
  let cookie = "";
  beforeAll(async () => {
    await setupPlatform(ctx);
    cookie = await signIn(app, origin, "admin@example.com");
    admin = rpcClient(app, origin, cookie);
  });
  afterAll(() => db.close());

  /** Where a redirecting better-auth answer sends the browser (Location or JSON url). */
  const target = async (res: Response): Promise<URL> => {
    const location =
      res.headers.get("location") ??
      (
        (await res
          .clone()
          .json()
          .catch(() => ({}))) as { url?: string }
      ).url;
    expect(location, `redirect (status ${res.status})`).toBeTruthy();
    return new URL(location as string, origin);
  };

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  const authorize = (params: Record<string, string>, withCookie = cookie) =>
    app.request(`${origin}/api/auth/oauth2/authorize?${new URLSearchParams(params)}`, {
      headers: withCookie ? { cookie: withCookie } : {},
    });

  const form = (path: string, body: Record<string, string>) =>
    app.request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });

  /** Runs the browser part of the flow; returns the token response. */
  async function grant(
    clientId: string,
    opts: {
      scope?: string;
      access?: "read" | "write";
      resource?: string | null;
      client?: ApiClient;
      session?: string;
    } = {},
  ) {
    const { verifier, challenge } = pkce();
    const params: Record<string, string> = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: opts.scope ?? "edgeweir:read edgeweir:write offline_access",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(opts.resource === null ? {} : { resource: opts.resource ?? resource }),
    };
    const next = await target(await authorize(params, opts.session ?? cookie));
    // An existing grant that covers the scopes skips the consent page.
    const back =
      next.pathname === "/oauth/consent"
        ? new URL(
            (
              await (opts.client ?? admin).mcp.consent({
                oauthQuery: next.search.slice(1),
                accept: true,
                access: opts.access ?? "write",
              })
            ).url,
          )
        : next;
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code");
    expect(code).toBeTruthy();
    const res = await form("/oauth2/token", {
      grant_type: "authorization_code",
      code: code as string,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      ...(opts.resource === null ? {} : { resource: opts.resource ?? resource }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      scope: string;
      expires_in: number;
    };
  }

  let rpcId = 0;
  /** One JSON-RPC request to /mcp (2025-11-25, stateless); the response and its message. */
  async function mcp(token: string | null, method: string, params: unknown = {}) {
    const res = await app.request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const body = await res.text();
    // JSON, or one SSE message event.
    const data = body.startsWith("{")
      ? body
      : body
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
    const message = data
      ? (JSON.parse(data) as {
          result?: {
            tools?: { name: string; annotations?: Record<string, unknown> }[];
            content?: { text: string }[];
            isError?: boolean;
            serverInfo?: { name: string };
          };
          error?: unknown;
        })
      : {};
    return { res, message };
  }
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const { res, message } = await mcp(token, "tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? "";
    return { res, isError: message.result?.isError === true, json: text ? JSON.parse(text) : null };
  };

  let dcrClientId = "";
  let writeToken = "";
  let readToken = "";
  let refreshToken = "";

  it("answers 404 for /mcp, the OAuth endpoints and their metadata while MCP is off", async () => {
    expect((await admin.mcp.settings()).enabled).toBe(false);
    expect((await app.request(`${origin}/mcp`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`${origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(
      404,
    );
    expect(
      (await app.request(`${origin}/.well-known/oauth-authorization-server/api/auth`)).status,
    ).toBe(404);
    expect((await form("/oauth2/register", { client_name: "x" })).status).toBe(404);
  });

  it("switches MCP on with an audit entry", async () => {
    expect(await admin.mcp.setSettings({ enabled: true })).toEqual({
      enabled: true,
      url: resource,
    });
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "mcp.settings_update"));
    expect(entry?.metadata).toMatchObject({ from: { enabled: false }, to: { enabled: true } });
  });

  it("challenges an unauthenticated request and publishes the discovery documents", async () => {
    const { res } = await mcp(null, "initialize");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="edgeweir:read edgeweir:write offline_access"');
    const bogus = await mcp("ewo_notatoken", "initialize");
    expect(bogus.res.status).toBe(401);
    expect(bogus.res.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const prm = await (
      await app.request(`${origin}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    expect(prm).toMatchObject({
      resource,
      authorization_servers: [`${origin}/api/auth`],
      scopes_supported: ["edgeweir:read", "edgeweir:write"],
    });
    for (const path of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-authorization-server",
    ]) {
      const as = (await (await app.request(`${origin}${path}`)).json()) as Record<string, unknown>;
      expect(as).toMatchObject({
        issuer: `${origin}/api/auth`,
        authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
        token_endpoint: `${origin}/api/auth/oauth2/token`,
        registration_endpoint: `${origin}/api/auth/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      });
      expect(as.scopes_supported).toEqual(["edgeweir:read", "edgeweir:write", "offline_access"]);
      expect(as).not.toHaveProperty("introspection_endpoint");
      expect(as).not.toHaveProperty("jwks_uri");
    }
    // Not the endpoints that stay server side.
    expect((await form("/oauth2/introspect", { token: "x" })).status).toBe(404);
    expect((await app.request(`${origin}/api/auth/oauth2/get-clients`)).status).toBe(404);
  });

  it("registers a client dynamically and refuses an authorization request without PKCE", async () => {
    const res = await app.request(`${origin}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect([200, 201]).toContain(res.status);
    dcrClientId = ((await res.json()) as { client_id: string }).client_id;
    expect(dcrClientId).toBeTruthy();

    const noPkce = await target(
      await authorize({
        response_type: "code",
        client_id: dcrClientId,
        redirect_uri: REDIRECT,
        scope: "edgeweir:read",
        state: "s0",
        resource,
      }),
    );
    expect(`${noPkce.origin}${noPkce.pathname}`).toBe(REDIRECT);
    expect(noPkce.searchParams.get("error")).toBe("invalid_request");
  });

  it("sends a browser without a session to /login, and one with a session to /oauth/consent", async () => {
    const { challenge } = pkce();
    const params = {
      response_type: "code",
      client_id: dcrClientId,
      redirect_uri: REDIRECT,
      scope: "edgeweir:read edgeweir:write offline_access",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    };
    const login = await target(await authorize(params, ""));
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("client_id")).toBe(dcrClientId);
    expect(login.searchParams.get("sig")).toBeTruthy();
    // The login page's sign-in carries the signed request (oauthProviderClient) and resumes it.
    const resumed = await app.request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.com",
        password: PASSWORD,
        oauth_query: login.search.slice(1),
      }),
    });
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect(await resumed.clone().json()).toMatchObject({ redirect: true });
    expect((await target(resumed)).pathname).toBe("/oauth/consent");

    const consent = await target(await authorize(params));
    expect(consent.pathname).toBe("/oauth/consent");
    const oauthQuery = consent.search.slice(1);
    expect(await admin.mcp.consentRequest({ oauthQuery })).toEqual({
      clientId: dcrClientId,
      clientName: "Claude Code",
      clientIdHost: null,
      redirectHost: "127.0.0.1:33418",
      localhost: true,
      scopes: ["edgeweir:read", "edgeweir:write", "offline_access"],
      readOnly: false,
    });
    const tampered = oauthQuery.replace("edgeweir%3Aread", "edgeweir%3Awrite");
    expect((await rpcError(admin.mcp.consentRequest({ oauthQuery: tampered }))).code).toBe(
      "OAUTH_REQUEST_INVALID",
    );
    // Consent is a session's: an AccessKey cannot grant.
    const key = await admin.accessKeys.create({ name: "k", scope: "write" });
    const viaKey = await app.request(`${origin}/api/v1/mcp/consent`, {
      method: "POST",
      headers: { "x-api-key": key.key, "content-type": "application/json" },
      body: JSON.stringify({ oauthQuery, accept: true, access: "write" }),
    });
    expect(viaKey.status).toBe(403);
    expect(await viaKey.json()).toMatchObject({ code: "OAUTH_SESSION_REQUIRED" });
  });

  it("grants read only when the operator downgrades, with an audit entry", async () => {
    const tokens = await grant(dcrClientId, { access: "read" });
    expect(tokens.access_token).toMatch(/^ewo_/);
    expect(tokens.refresh_token).toMatch(/^ewr_/);
    expect(tokens.scope.split(" ").sort()).toEqual(["edgeweir:read", "offline_access"]);
    readToken = tokens.access_token;
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "oauth.consent_grant"));
    expect(entry).toMatchObject({ targetType: "oauth_client", targetName: "Claude Code" });
    expect(entry?.metadata).toMatchObject({ scopes: ["edgeweir:read", "offline_access"] });
  });

  it("serves the tools with annotations and runs reads through the router", async () => {
    const init = await mcp(readToken, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(init.res.status).toBe(200);
    expect(init.message.result?.serverInfo?.name).toBe("edgeweir");

    const list = await mcp(readToken, "tools/list");
    const tools = new Map((list.message.result?.tools ?? []).map((t) => [t.name, t]));
    for (const name of [
      "search_operations",
      "describe_operation",
      "call_operation",
      "get_overview",
      "list_sites",
      "purge_cache",
      "query_access_logs",
      "get_site_stats",
      "list_alerts",
    ])
      expect(tools.has(name), name).toBe(true);
    expect(tools.get("list_sites")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get("purge_cache")?.annotations).toMatchObject({ readOnlyHint: false });

    const groups = await tool(readToken, "search_operations");
    const names = (groups.json.groups as { name: string }[]).map((g) => g.name);
    expect(names).toContain("sites");
    for (const forbidden of ["accessKeys", "serviceAccounts", "mcp", "extensionKeys"])
      expect(names).not.toContain(forbidden);
    const found = await tool(readToken, "search_operations", { query: "sites list" });
    expect(found.json.operations).toContainEqual({
      name: "sites.list",
      method: "GET",
      path: "/sites",
      readOnly: true,
    });
    const settings = await tool(readToken, "search_operations", { query: "login allow" });
    expect(settings.json.total).toBe(0);

    const described = await tool(readToken, "describe_operation", { name: "sites.create" });
    expect(described.json).toMatchObject({ name: "sites.create", method: "POST", readOnly: false });
    expect(described.json.input.properties).toHaveProperty("domains");

    const sites = await tool(readToken, "call_operation", { name: "sites.list", input: {} });
    expect(sites.isError).toBe(false);
    expect(sites.json).toHaveProperty("items");
    const overview = await tool(readToken, "get_overview");
    expect(overview.isError).toBe(false);

    const refused = await tool(readToken, "call_operation", { name: "accessKeys.list" });
    expect(refused.isError).toBe(true);
    expect(refused.json.error).toBe("UNKNOWN_OPERATION");
  });

  it("answers a write with a read token 403 insufficient_scope", async () => {
    for (const [name, args] of [
      ["call_operation", { name: "sites.create", input: { name: "x" } }],
      ["purge_cache", { type: "site", siteIds: [] }],
    ] as const) {
      const { res } = await mcp(readToken, "tools/call", { name, arguments: args });
      expect(res.status, name).toBe(403);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain("edgeweir:write");
      expect(challenge).toContain(`resource_metadata="${origin}/.well-known/`);
    }
  });

  it("refuses excluded procedures and writes without the scope in the guard itself", async () => {
    const principal = await authenticateMcpToken(ctx, readToken);
    expect(principal).not.toBeNull();
    const context = {
      app: ctx,
      headers: new Headers(),
      ip: "",
      userAgent: "",
      oauth: principal ?? undefined,
    };
    for (const [path, code] of [
      ["accessKeys.list", "MCP_PROCEDURE_FORBIDDEN"],
      ["settings.loginAllowList", "MCP_PROCEDURE_FORBIDDEN"],
      ["settings.setDemo", "MCP_PROCEDURE_FORBIDDEN"],
      ["mcp.apps", "MCP_PROCEDURE_FORBIDDEN"],
      ["extensionKeys.list", "MCP_PROCEDURE_FORBIDDEN"],
      ["clusters.createEnrollmentToken", "MCP_PROCEDURE_FORBIDDEN"],
      ["sites.setEnabled", "SCOPE_REQUIRED"],
    ] as const) {
      const [group, name] = path.split(".") as [string, string];
      const procedure = (router as unknown as Record<string, Record<string, unknown>>)[group]?.[
        name
      ];
      const error = await (call as (...args: unknown[]) => Promise<unknown>)(
        procedure,
        {},
        {
          context,
          path: path.split("."),
        },
      ).catch((e: { code?: string }) => e);
      expect((error as { code?: string }).code, path).toBe(code);
    }
  });

  it("writes with a write token, as an oauth_client in the audit log", async () => {
    const tokens = await grant(dcrClientId, { access: "write" });
    expect(tokens.scope.split(" ")).toContain("edgeweir:write");
    writeToken = tokens.access_token;
    refreshToken = tokens.refresh_token as string;
    const created = await tool(writeToken, "call_operation", {
      name: "sites.create",
      input: { name: "agent-site", domains: ["agent.test"], origins: [{ address: "origin.test" }] },
    });
    expect(created.isError, JSON.stringify(created.json)).toBe(false);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "site.create"))
      .orderBy(desc(schema.auditLog.id));
    expect(entry).toMatchObject({
      actorType: "oauth_client",
      actorId: dcrClientId,
      actorName: "Claude Code",
    });
    // Validation errors come back as tool errors, not transport failures.
    const invalid = await tool(writeToken, "call_operation", { name: "sites.create", input: {} });
    expect(invalid.isError).toBe(true);
    expect(invalid.json.error).toBe("BAD_REQUEST");
  });

  it("rotates refresh tokens", async () => {
    const res = await form("/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: dcrClientId,
      resource,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const next = (await res.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).toMatch(/^ewr_/);
    expect(next.refresh_token).not.toBe(refreshToken);
    expect(next.access_token).not.toBe(writeToken);
    expect((await tool(next.access_token, "get_overview")).isError).toBe(false);
    refreshToken = next.refresh_token;
    writeToken = next.access_token;
  });

  it("refuses tokens bound to another audience or to none", async () => {
    const unbound = await grant(dcrClientId, { resource: null });
    expect((await mcp(unbound.access_token, "tools/list")).res.status).toBe(401);
    const raw = randomBytes(24)
      .toString("base64url")
      .replace(/[^A-Za-z]/g, "a");
    const [ownToken] = await ctx.db
      .select()
      .from(schema.oauthAccessToken)
      .where(eq(schema.oauthAccessToken.clientId, dcrClientId))
      .limit(1);
    await ctx.db.insert(schema.oauthAccessToken).values({
      ...(ownToken as typeof schema.oauthAccessToken.$inferInsert),
      id: "other-audience",
      token: createHash("sha256").update(raw).digest("base64url"),
      resources: ["https://other.example/mcp"],
      expiresAt: new Date(Date.now() + 3600_000),
      refreshId: null,
    });
    expect((await mcp(`ewo_${raw}`, "tools/list")).res.status).toBe(401);
  });

  it("limits each grant's requests", async () => {
    const [grantRow] = await ctx.db
      .select()
      .from(schema.oauthConsent)
      .where(eq(schema.oauthConsent.clientId, dcrClientId));
    clock += 120_000;
    for (let i = 0; i < ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE; i++)
      ctx.accessKeyLimits.take(
        `oauth:${grantRow?.id}`,
        ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
        60_000,
      );
    const { res } = await mcp(writeToken, "tools/list");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    clock += 60_000;
    expect((await mcp(writeToken, "tools/list")).res.status).toBe(200);
  });

  it("lists the connected app and revokes it at once", async () => {
    const { apps } = await admin.mcp.apps();
    expect(apps).toEqual([
      expect.objectContaining({
        clientId: dcrClientId,
        name: "Claude Code",
        host: "127.0.0.1:33418",
        scopes: ["edgeweir:read", "edgeweir:write", "offline_access"],
      }),
    ]);
    expect(apps[0]?.lastUsedAt).not.toBeNull();
    await admin.mcp.revokeApp({ clientId: dcrClientId });
    expect((await mcp(writeToken, "tools/list")).res.status).toBe(401);
    const refresh = await form("/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: dcrClientId,
    });
    expect(refresh.status).toBe(400);
    expect((await admin.mcp.apps()).apps).toEqual([]);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "oauth.revoke"));
    expect(entry).toMatchObject({ targetId: dcrClientId, targetName: "Claude Code" });
    expect((await rpcError(admin.mcp.revokeApp({ clientId: dcrClientId }))).code).toBe(
      "OAUTH_APP_NOT_FOUND",
    );
  });

  it("resolves a client from its metadata document (CIMD)", async () => {
    const { challenge } = pkce();
    const consent = await target(
      await authorize({
        response_type: "code",
        client_id: CIMD_CLIENT_ID,
        redirect_uri: REDIRECT,
        scope: "edgeweir:read",
        state: "c1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
      }),
    );
    expect(cimdFetches).toContain(CIMD_CLIENT_ID);
    expect(consent.pathname).toBe("/oauth/consent");
    expect(await admin.mcp.consentRequest({ oauthQuery: consent.search.slice(1) })).toMatchObject({
      clientId: CIMD_CLIENT_ID,
      clientName: "Metadata Agent",
      clientIdHost: "client.example.com",
      scopes: ["edgeweir:read"],
    });
    const tokens = await grant(CIMD_CLIENT_ID, { scope: "edgeweir:read" });
    expect((await mcp(tokens.access_token, "tools/list")).res.status).toBe(200);
    writeToken = tokens.access_token;
  });

  it("refuses tokens while MCP is off and accepts them again when it is back on", async () => {
    await admin.mcp.setSettings({ enabled: false });
    expect((await mcp(writeToken, "tools/list")).res.status).toBe(404);
    expect((await form("/oauth2/token", { grant_type: "refresh_token" })).status).toBe(404);
    expect((await rpcError(admin.mcp.consentRequest({ oauthQuery: "a=b" }))).code).toBe(
      "MCP_DISABLED",
    );
    await admin.mcp.setSettings({ enabled: true });
    expect((await mcp(writeToken, "tools/list")).res.status).toBe(200);
  });

  it("lets the demo account grant reads only", async () => {
    await admin.settings.setDemo({ enabled: true });
    const demoCookie = await signIn(app, origin, DEMO_EMAIL, DEMO_PASSWORD);
    const demo = rpcClient(app, origin, demoCookie);
    const tokens = await grant(dcrClientId, { access: "write", client: demo, session: demoCookie });
    expect(tokens.scope.split(" ")).not.toContain("edgeweir:write");
    const { res } = await mcp(tokens.access_token, "tools/call", {
      name: "call_operation",
      arguments: { name: "sites.setEnabled", input: {} },
    });
    expect(res.status).toBe(403);
  });

  it("prunes expired tokens and clients nobody authorized", async () => {
    const stale = new Date(Date.now() - 40 * 24 * 3600_000);
    await ctx.db.insert(schema.oauthClient).values({
      id: "stale",
      clientId: "stale-client",
      redirectUris: [REDIRECT],
      createdAt: stale,
    });
    await pruneOAuth(ctx.db, new Date(Date.now() + 2 * 3600_000));
    const clients = await ctx.db
      .select({ id: schema.oauthClient.clientId })
      .from(schema.oauthClient);
    expect(clients.map((c) => c.id)).not.toContain("stale-client");
    // Clients with a grant stay; expired access tokens are gone.
    expect(clients.map((c) => c.id)).toContain(CIMD_CLIENT_ID);
    expect(
      await ctx.db
        .select()
        .from(schema.oauthAccessToken)
        .where(and(eq(schema.oauthAccessToken.clientId, CIMD_CLIENT_ID))),
    ).toEqual([]);
  });
});
