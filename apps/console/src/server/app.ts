import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
  DEMO_EMAIL,
  DEMO_USER_ID,
  MCP_PATH,
  MCP_SCOPE_OFFLINE,
  mcpScopes,
  NODE_CHANNEL_WEBSOCKET_PATH,
} from "@edgeweir/contract";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serveDownload } from "./downloads";
import {
  ACCOUNT_CHANGE_ROUTES,
  API_KEY_HEADER,
  AUTH_BASE_PATH,
  isAllowedAuthRoute,
  LOGIN_ALLOW_LIST_EXEMPT_ROUTES,
  mcpIssuer,
  mcpResourceUrl,
  OAUTH_ROUTES,
} from "./lib/auth";
import { normalizeIp, resolveClientIp, withClientIp } from "./lib/client-ip";
import type { AppContext } from "./lib/context";
import { withIdempotency } from "./lib/idempotency";
import { createMcpServerHandler, toolCallScope } from "./rpc/mcp";
import { type RequestContext, router } from "./rpc/router";
import { findAccessKey } from "./services/access-keys";
import { isDemoEnabled } from "./services/demo";
import { PROBE_SOURCE_WEBHOOK_PATH } from "./services/external-probes";
import { loginAllowed, logLoginRefusal } from "./services/login-allow-list";
import { authenticateMcpToken, mcpEnabled } from "./services/mcp";
import { nodeChannelWebSocketOpen } from "./services/node-channel-url";
import {
  PROBE_SOURCE_WEBHOOK_MAX_BYTES,
  ProbeSourceWebhooks,
} from "./services/probe-source-webhook";
import { evaluateAfterProbeReport } from "./services/scheduling";
import { authenticateServiceAccountKey, isServiceAccountKey } from "./services/service-accounts";

/**
 * Request bodies of /rpc and /api/v1: anyone may send MAX_BODY_BYTES; larger
 * ones, up to MAX_AUTHENTICATED_BODY_BYTES (a full bulk redirect table is
 * about 8 MiB), only callers whose credentials check out. better-auth's
 * endpoints take MAX_AUTH_BODY_BYTES.
 */
export const MAX_BODY_BYTES = 1 << 20;
export const MAX_AUTHENTICATED_BODY_BYTES = 16 << 20;
export const MAX_AUTH_BODY_BYTES = 64 << 10;
/** Extension packages with a sidecar (64 MiB, base64 in JSON): verify and install. */
const MAX_EXTENSION_PACKAGE_BODY_BYTES = 96 << 20;
/** Extension site data items (24 MiB, base64 in JSON). */
const MAX_EXTENSION_DATA_BODY_BYTES = 34 << 20;

/** The larger bound of an authenticated request: the extension uploads take more. */
export function authenticatedBodyLimit(method: string, path: string): number {
  if (
    method === "POST" &&
    /^\/(?:api\/v1\/extensions(?:\/verify)?|rpc\/extensions\/(?:install|verify))$/.test(path)
  )
    return MAX_EXTENSION_PACKAGE_BODY_BYTES;
  if (
    (method === "PUT" && /^\/api\/v1\/sites\/[^/]+\/extensions\/[^/]+\/data\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/rpc/extensions/putSiteData")
  )
    return MAX_EXTENSION_DATA_BODY_BYTES;
  return MAX_AUTHENTICATED_BODY_BYTES;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Finds a bundled asset in dev (src/server/...) and production (dist/server/...). */
export function assetPath(...segments: string[]): string {
  const candidates = [join(here, ...segments), join(here, "..", ...segments)];
  return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
}

type HonoContext = Parameters<typeof getConnInfo>[0];

/** The TCP peer ("" when there is no socket, e.g. in-process test requests). */
function peerAddress(c: HonoContext): string {
  try {
    return getConnInfo(c).remote.address ?? "";
  } catch {
    return "";
  }
}

export function createApp(ctx: AppContext, opts: { webDist?: string } = {}) {
  const app = new Hono();
  const log = ctx.log.child({ component: "http" });
  const logServerError = (error: unknown) => {
    const status = (error as { status?: number }).status ?? 500;
    if (status >= 500) log.error("rpc error", { error });
  };
  const rpc = new RPCHandler(router, {
    interceptors: [onError(logServerError)],
    plugins: [new SimpleCsrfProtectionHandlerPlugin()],
  });
  const openapi = new OpenAPIHandler(router, { interceptors: [onError(logServerError)] });
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
  let spec: unknown;

  /**
   * The UI surface (/rpc) authenticates with the session cookie only; the
   * public API (/api/v1) with the x-api-key header only (ADR-0005). The other
   * credential is stripped so it can never be used on the wrong surface.
   */
  const clientIp = (c: HonoContext) =>
    resolveClientIp(peerAddress(c), c.req.raw.headers, ctx.env.trustedProxies);

  /** Forwarding headers came from a peer outside EDGEWEIR_TRUSTED_PROXIES, so they were ignored. */
  const untrustedForwarding = (c: HonoContext) =>
    (c.req.raw.headers.has("x-forwarded-for") || c.req.raw.headers.has("x-real-ip")) &&
    !ctx.env.trustedProxies.has(normalizeIp(peerAddress(c)));

  const requestContext = (c: HonoContext, surface: "rpc" | "api"): RequestContext => {
    const ip = clientIp(c);
    // Server-side auth.api.* calls see the same resolved address as /api/auth.
    const headers = withClientIp(c.req.raw.headers, ip);
    if (surface === "rpc") headers.delete(API_KEY_HEADER);
    else headers.delete("cookie");
    return {
      app: ctx,
      headers,
      ip,
      userAgent: c.req.header("user-agent") ?? "",
      untrustedForwarding: untrustedForwarding(c),
    };
  };

  /**
   * better-auth reads the client IP (rate limiting, session records) from a
   * header; it gets the one resolved here instead of anything the client sent.
   * The API key header is removed: keys authenticate /api/v1 only (ADR-0005)
   * and must never become a session on better-auth's own endpoints.
   */
  const authRequest = (c: HonoContext, ip: string, withoutCookie = false): Request => {
    const headers = withClientIp(c.req.raw.headers, ip);
    headers.delete(API_KEY_HEADER);
    if (withoutCookie) headers.delete("cookie");
    return new Request(c.req.raw, { headers });
  };

  /**
   * Whether an /api/auth request outside the login allow list is the demo account's, which the
   * list does not limit (ADR-0047): a JSON sign-in with its e-mail (better-auth looks the
   * address up lowercased, as here) while it exists, or a call with its session.
   */
  const demoAuthRequest = async (path: string, request: Request): Promise<boolean> => {
    if (path === "/sign-in/email") {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return false;
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => null);
      const email = (body as { email?: unknown } | null)?.email;
      return (
        typeof email === "string" &&
        email.toLowerCase() === DEMO_EMAIL &&
        (await isDemoEnabled(ctx.db))
      );
    }
    const session = await ctx.auth.api.getSession({ headers: request.headers }).catch(() => null);
    return session?.user.id === DEMO_USER_ID;
  };

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  /**
   * A response without Cache-Control may be stored by a CDN in front of the
   * console (bunny.net keeps one for a month) and served to the next caller of
   * the same URL: the session, an /api/v1 answer for another API key, the SPA
   * shell of an old release. Routes that may be cached set the header
   * themselves (hashed /assets/*, /downloads/*).
   */
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });

  app.get("/healthz", (c) => c.json({ status: "ok", version: ctx.env.version }));

  /** Whether the request's credential for its surface is valid (base.ts decides what it may do). */
  const credentialValid = async (c: HonoContext, surface: "rpc" | "api") => {
    const { headers, ip } = requestContext(c, surface);
    const key = headers.get(API_KEY_HEADER);
    try {
      if (key && isServiceAccountKey(key))
        return (await authenticateServiceAccountKey(ctx.db, key)) !== null;
      // Not counted against the key's limit: `os` counts the request.
      if (key) return (await findAccessKey(ctx.db, key, new Date())) !== null;
      const session = await ctx.auth.api.getSession({ headers });
      if (!session) return false;
      // A session outside the login allow list gets no further than `authed`.
      return (
        surface === "api" || session.user.id === DEMO_USER_ID || (await loginAllowed(ctx.db, ip))
      );
    } catch {
      return false;
    }
  };

  /**
   * The handlers read the whole body before they check credentials (oRPC
   * decodes the input first, withIdempotency hashes it), so the body is
   * bounded before it reaches them; only a valid credential unlocks the
   * larger bound, checked only for a body over the smaller one.
   */
  const limitBody = (surface: "rpc" | "api") => {
    const tooLarge = (c: HonoContext) => {
      const error = new ORPCError("PAYLOAD_TOO_LARGE", { message: "request body too large" });
      return c.json(surface === "rpc" ? { json: error.toJSON() } : error.toJSON(), 413);
    };
    return async (c: HonoContext, next: () => Promise<void>) => {
      const body = c.req.raw.body;
      if (!body) return next();
      const authenticatedLimit = authenticatedBodyLimit(c.req.method, c.req.path);
      const length = Number(c.req.header("content-length") ?? Number.NaN);
      if (c.req.header("transfer-encoding") === undefined && Number.isFinite(length)) {
        // Node's parser holds the body to its declared length.
        if (length <= MAX_BODY_BYTES) return next();
        return length <= authenticatedLimit && (await credentialValid(c, surface))
          ? next()
          : tooLarge(c);
      }
      // A body without a length is counted as it arrives.
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let limit = MAX_BODY_BYTES;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          if (limit === authenticatedLimit || !(await credentialValid(c, surface))) {
            await reader.cancel();
            return tooLarge(c);
          }
          limit = authenticatedLimit;
          if (size > limit) {
            await reader.cancel();
            return tooLarge(c);
          }
        }
        chunks.push(value);
      }
      c.req.raw = new Request(c.req.raw, { body: new Blob(chunks) });
      return next();
    };
  };
  app.use("/rpc/*", limitBody("rpc"));
  app.use("/api/v1/*", limitBody("api"));
  app.use(
    "/api/auth/*",
    bodyLimit({
      maxSize: MAX_AUTH_BODY_BYTES,
      onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "request body too large" }, 413),
    }),
  );

  // MCP's OAuth discovery (ADR-0076): RFC 8414 metadata of the authorization server (issuer
  // <public URL>/api/auth) at its path-inserted and root locations, RFC 9728 metadata of the /mcp
  // resource. 404 while MCP is off.
  const publicUrl = ctx.env.EDGEWEIR_PUBLIC_URL.replace(/\/$/, "");
  const mcpResource = mcpResourceUrl(ctx.env.EDGEWEIR_PUBLIC_URL);
  const resourceMetadataUrl = `${new URL(publicUrl).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
  const authorizationServerMetadata = async (c: HonoContext) => {
    if (!(await mcpEnabled(ctx.db))) return notFound(c);
    const metadata: Record<string, unknown> = { ...(await ctx.auth.api.getOAuthServerConfig()) };
    // Introspection stays server side (not on the /api/auth allow list).
    for (const key of Object.keys(metadata))
      if (key.startsWith("introspection_")) delete metadata[key];
    return c.json(metadata);
  };
  for (const path of [
    `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
    "/.well-known/oauth-authorization-server",
    `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server`,
  ])
    app.get(path, authorizationServerMetadata);
  const protectedResourceMetadata = async (c: HonoContext) => {
    if (!(await mcpEnabled(ctx.db))) return notFound(c);
    return c.json({
      resource: mcpResource,
      authorization_servers: [mcpIssuer(publicUrl)],
      bearer_methods_supported: ["header"],
      scopes_supported: mcpScopes.filter((scope) => scope !== MCP_SCOPE_OFFLINE),
      resource_name: "Edgeweir",
    });
  };
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

  app.on(["GET", "POST"], "/api/auth/*", async (c, next) => {
    // Exact match on the normalized path: no prefixes, encodings or trailing slashes.
    const path = new URL(c.req.url).pathname.slice(AUTH_BASE_PATH.length);
    if (!isAllowedAuthRoute(c.req.method, path)) return next(); // -> the /api/* 404
    if (OAUTH_ROUTES.has(path) && !(await mcpEnabled(ctx.db))) return next();
    const ip = clientIp(c);
    // Registration, token and revocation calls come from MCP clients, never with a session.
    const request = authRequest(
      c,
      ip,
      OAUTH_ROUTES.has(path) && LOGIN_ALLOW_LIST_EXEMPT_ROUTES.has(path),
    );
    // Checked before better-auth sees the request: no password check, no sign-in limiter, the
    // same answer for right and wrong passwords.
    if (
      !LOGIN_ALLOW_LIST_EXEMPT_ROUTES.has(path) &&
      !(await loginAllowed(ctx.db, ip)) &&
      !(await demoAuthRequest(path, request))
    ) {
      logLoginRefusal(log, ip, c.req.path);
      return c.json(
        { code: "LOGIN_IP_NOT_ALLOWED", message: "this address may not sign in to the console" },
        403,
      );
    }
    if (ACCOUNT_CHANGE_ROUTES.has(path)) {
      const session = await ctx.auth.api.getSession({ headers: request.headers }).catch(() => null);
      if (session?.user.id === DEMO_USER_ID)
        return c.json({ code: "DEMO_READ_ONLY", message: "the demo account can only read" }, 403);
    }
    return ctx.auth.handler(request);
  });

  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: requestContext(c, "rpc"),
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  /**
   * /mcp (ADR-0076): only OAuth access tokens bound to this resource, never the session cookie or
   * an AccessKey (both stripped). Unauthenticated: 401 with the RFC 9728 challenge; a tool call
   * that needs edgeweir:write with a read token: 403 insufficient_scope; each grant has the
   * AccessKey request limit.
   */
  const mcp = createMcpServerHandler({
    version: ctx.env.version,
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => log.warn("mcp request failed", { error }),
  });
  const bearerChallenge = (c: HonoContext, status: 401 | 403, fields: Record<string, string>) => {
    const params = { ...fields, resource_metadata: resourceMetadataUrl };
    c.header(
      "www-authenticate",
      `Bearer ${Object.entries(params)
        .map(([key, value]) => `${key}="${value}"`)
        .join(", ")}`,
    );
    const message = status === 401 ? "authentication required" : "insufficient scope";
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, status);
  };
  app.use(
    MCP_PATH,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { jsonrpc: "2.0", error: { code: -32600, message: "request body too large" }, id: null },
          413,
        ),
    }),
  );
  app.all(MCP_PATH, async (c) => {
    if (!(await mcpEnabled(ctx.db))) return notFound(c);
    const token = /^Bearer +(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const principal = token ? await authenticateMcpToken(ctx, token) : null;
    if (!principal)
      return bearerChallenge(c, 401, {
        ...(token ? { error: "invalid_token" } : {}),
        scope: mcpScopes.join(" "),
      });
    const wait = ctx.accessKeyLimits.take(
      `oauth:${principal.grantId}`,
      ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
      60_000,
    );
    if (wait !== null) {
      c.header("retry-after", String(Math.max(1, Math.ceil(wait / 1000))));
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "too many requests" }, id: null },
        429,
      );
    }
    const body = c.req.method === "POST" ? await c.req.text() : undefined;
    if (body !== undefined) {
      let message: { method?: unknown; params?: { name?: unknown; arguments?: unknown } } = {};
      try {
        message = JSON.parse(body) ?? {};
      } catch {}
      const needed =
        message.method === "tools/call" && typeof message.params?.name === "string"
          ? toolCallScope(message.params.name, message.params.arguments)
          : null;
      if (needed && !principal.scopes.includes(needed))
        return bearerChallenge(c, 403, {
          error: "insufficient_scope",
          scope: [...new Set([...principal.scopes, needed])].join(" "),
          error_description: `this call needs the ${needed} scope`,
        });
    }
    const ip = clientIp(c);
    // Procedures see the request without any credential: the grant is the caller.
    const headers = withClientIp(c.req.raw.headers, ip);
    for (const name of ["cookie", API_KEY_HEADER, "authorization"]) headers.delete(name);
    const context: RequestContext = {
      app: ctx,
      headers,
      ip,
      userAgent: c.req.header("user-agent") ?? "",
      untrustedForwarding: untrustedForwarding(c),
    };
    return mcp.fetch(new Request(c.req.raw.url, { method: c.req.method, headers, body }), {
      authInfo: {
        token: "",
        clientId: principal.clientId,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
        resource: new URL(mcpResource),
        resourceMetadataUrl,
        extra: { caller: { principal, context } },
      },
    });
  });

  app.get("/api/v1/openapi.json", async (c) => {
    spec ??= await generator.generate(router, {
      info: {
        title: "Edgeweir API",
        version: ctx.env.version,
        description: "Public API of the Edgeweir console. Authenticate with the x-api-key header.",
        license: { name: "AGPL-3.0-only" },
      },
      servers: [{ url: `${ctx.env.EDGEWEIR_PUBLIC_URL.replace(/\/$/, "")}/api/v1` }],
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } },
      },
      security: [{ apiKey: [] }],
    });
    return c.json(spec);
  });

  app.use("/api/v1/*", async (c, next) => {
    const context = requestContext(c, "api");
    const response = await withIdempotency(
      ctx.db,
      c.req.raw,
      c.req.header(API_KEY_HEADER) ?? null,
      async (request) => {
        const result = await openapi.handle(request, { prefix: "/api/v1", context });
        return result.matched ? result.response : null;
      },
    );
    if (response) return c.newResponse(response.body, response);
    await next();
  });

  const installScript = readFileSync(assetPath("install", "install.sh"), "utf8");
  app.get("/install.sh", (c) => {
    c.header("content-type", "text/x-shellscript; charset=utf-8");
    c.header("cache-control", "no-store");
    return c.body(
      installScript.replaceAll("__EDGEWEIR_CONSOLE_URL__", ctx.env.EDGEWEIR_PUBLIC_URL),
    );
  });

  // The node channel's WebSocket entry upgrades before Hono sees the request
  // (node-channel/websocket.ts); a plain request learns whether it is open.
  app.get(NODE_CHANNEL_WEBSOCKET_PATH, async (c) => {
    if (!(await nodeChannelWebSocketOpen(ctx))) return c.json({ error: "not found" }, 404);
    c.header("upgrade", "websocket");
    return c.json({ error: "upgrade required" }, 426);
  });

  // External probe source deliveries (ADR-0069): no session or API key; the
  // source's webhook secret authenticates each one (adapter verification).
  const probeSourceWebhooks = new ProbeSourceWebhooks();
  app.post(
    `${PROBE_SOURCE_WEBHOOK_PATH}/:id`,
    bodyLimit({
      maxSize: PROBE_SOURCE_WEBHOOK_MAX_BYTES,
      onError: (c) => c.json({ code: "payload_too_large" }, 413),
    }),
    async (c) => {
      const outcome = await probeSourceWebhooks.handle(ctx, c.req.param("id"), {
        headers: c.req.raw.headers,
        body: Buffer.from(await c.req.arrayBuffer()),
        ip: clientIp(c),
      });
      if (outcome.retryAfterSeconds) c.header("retry-after", String(outcome.retryAfterSeconds));
      if (outcome.clusterIds?.length) void evaluateAfterProbeReport(ctx, outcome.clusterIds);
      return c.json(
        outcome.status === 202
          ? { code: outcome.code, accepted: outcome.accepted ?? 0 }
          : { code: outcome.code },
        outcome.status,
      );
    },
  );

  app.on(["GET", "HEAD"], "/downloads/*", (c) =>
    serveDownload(ctx.env.EDGEWEIR_DOWNLOADS_DIR, c.req.raw, ctx.log),
  );

  // Server paths never fall through to the SPA shell: an unknown API route or
  // a file missing from the mirror must be a 404, not a 200 index.html
  // (install.sh would otherwise "download" HTML).
  const notFound = (c: HonoContext) => c.json({ error: "not found" }, 404);
  for (const prefix of ["/api", "/rpc", "/downloads"]) {
    app.all(prefix, notFound);
    app.all(`${prefix}/*`, notFound);
  }
  app.all("/install.sh", notFound);
  app.all("/healthz", notFound);
  app.all("/.well-known/*", notFound);
  app.all(NODE_CHANNEL_WEBSOCKET_PATH, notFound);

  if (opts.webDist) {
    const root = resolve(opts.webDist);
    const indexHtml = readFileSync(join(root, "index.html"), "utf8");
    // Build output with content-hashed names. The header is set on the
    // response: serveStatic's onFound runs after the response is built. A
    // missing asset is a 404, never the SPA shell under an asset URL.
    app.use(
      "/assets/*",
      async (c, next) => {
        await next();
        if (c.res.ok) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
      },
      serveStatic({ root }),
    );
    app.all("/assets/*", notFound);
    app.use("*", serveStatic({ root }));
    // Client-side routes fall back to the SPA shell.
    app.get("*", (c) => c.html(indexHtml));
  }

  return app;
}
