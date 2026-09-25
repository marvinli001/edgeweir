import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveDownload } from "./downloads";
import { API_KEY_HEADER, AUTH_BASE_PATH, isAllowedAuthRoute } from "./lib/auth";
import { resolveClientIp, withClientIp } from "./lib/client-ip";
import type { AppContext } from "./lib/context";
import { type RequestContext, router } from "./rpc/router";
import { getLandingPage } from "./services/landing";

const here = dirname(fileURLToPath(import.meta.url));

/** Finds a bundled asset in dev (src/server/...) and production (dist/server/...). */
export function assetPath(...segments: string[]): string {
  const candidates = [join(here, ...segments), join(here, "..", ...segments)];
  return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

/**
 * The SPA shell is `noindex`; a public landing page at `/` is meant to be
 * found, so it gets the brand as title, its description, and no robots block.
 */
export function landingShell(
  indexHtml: string,
  landing: { brandName: string; headline: string; description: string },
): string {
  const title = landing.headline ? `${landing.headline} | ${landing.brandName}` : landing.brandName;
  const head = [
    `<title>${escapeHtml(title)}</title>`,
    landing.description
      ? `<meta name="description" content="${escapeHtml(landing.description)}" />`
      : "",
  ].join("");
  return indexHtml
    .replace(/\s*<meta name="robots"[^>]*>/, "")
    .replace(/<title>[^<]*<\/title>/, () => head);
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

  const requestContext = (c: HonoContext, surface: "rpc" | "api"): RequestContext => {
    const ip = clientIp(c);
    // Server-side auth.api.* calls see the same resolved address as /api/auth.
    const headers = withClientIp(c.req.raw.headers, ip);
    if (surface === "rpc") headers.delete(API_KEY_HEADER);
    else headers.delete("cookie");
    return { app: ctx, headers, ip, userAgent: c.req.header("user-agent") ?? "" };
  };

  /**
   * better-auth reads the client IP (rate limiting, session records) from a
   * header; it gets the one resolved here instead of anything the client sent.
   * The API key header is removed: keys authenticate /api/v1 only (ADR-0005)
   * and must never become a session on better-auth's own endpoints.
   */
  const authRequest = (c: HonoContext): Request => {
    const headers = withClientIp(c.req.raw.headers, clientIp(c));
    headers.delete(API_KEY_HEADER);
    return new Request(c.req.raw, { headers });
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

  app.get("/healthz", (c) => c.json({ status: "ok", version: ctx.env.version }));

  app.on(["GET", "POST"], "/api/auth/*", async (c, next) => {
    // Exact match on the normalized path: no prefixes, encodings or trailing slashes.
    const path = new URL(c.req.url).pathname.slice(AUTH_BASE_PATH.length);
    if (!isAllowedAuthRoute(c.req.method, path)) return next(); // -> the /api/* 404
    return ctx.auth.handler(authRequest(c));
  });

  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: requestContext(c, "rpc"),
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
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
    const { matched, response } = await openapi.handle(c.req.raw, {
      prefix: "/api/v1",
      context: requestContext(c, "api"),
    });
    if (matched) return c.newResponse(response.body, response);
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

  app.on(["GET", "HEAD"], "/downloads/*", (c) =>
    serveDownload(ctx.env.EDGEWEIR_DOWNLOADS_DIR, c.req.raw),
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

  if (opts.webDist) {
    const root = resolve(opts.webDist);
    const indexHtml = readFileSync(join(root, "index.html"), "utf8");
    app.get("/", async (c) => {
      const { settings } = await getLandingPage(ctx.db).catch(() => ({ settings: null }));
      if (!settings || settings.template === "none") return c.html(indexHtml);
      return c.html(landingShell(indexHtml, settings));
    });
    app.use(
      "/assets/*",
      serveStatic({
        root,
        onFound: (_p, c) => {
          c.header("cache-control", "public, max-age=31536000, immutable");
        },
      }),
    );
    app.use("*", serveStatic({ root }));
    // Client-side routes fall back to the SPA shell.
    app.get("*", (c) => c.html(indexHtml));
  }

  return app;
}
