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
import { API_KEY_HEADER } from "./lib/auth";
import type { AppContext } from "./lib/context";
import { type RequestContext, router } from "./rpc/router";

const here = dirname(fileURLToPath(import.meta.url));

/** Finds a bundled asset in dev (src/server/...) and production (dist/server/...). */
export function assetPath(...segments: string[]): string {
  const candidates = [join(here, ...segments), join(here, "..", ...segments)];
  return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
}

function clientIp(c: Parameters<typeof getConnInfo>[0]): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
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
  const requestContext = (
    c: Parameters<typeof getConnInfo>[0],
    surface: "rpc" | "api",
  ): RequestContext => {
    const headers = new Headers(c.req.raw.headers);
    if (surface === "rpc") headers.delete(API_KEY_HEADER);
    else headers.delete("cookie");
    return { app: ctx, headers, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? "" };
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

  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth.handler(c.req.raw));

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

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (opts.webDist) {
    const root = resolve(opts.webDist);
    const indexHtml = readFileSync(join(root, "index.html"), "utf8");
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
