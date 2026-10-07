import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { type Database, schema } from "@edgeweir/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor } from "better-auth/plugins";
import { authAuditDatabaseHooks, authAuditPlugin } from "./auth-audit";
import { CLIENT_IP_HEADER } from "./client-ip";

// Edgeweir never phones home. better-auth's own telemetry is opt-in via this
// variable; strip it so no third-party telemetry can be switched on implicitly.
delete process.env.BETTER_AUTH_TELEMETRY;

export const API_KEY_HEADER = "x-api-key";
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The better-auth HTTP endpoints the web console calls (apps/console/src/web,
 * `authClient`), by path under /api/auth and method. Everything else answers
 * 404: the admin and API key plugins are used server side only (`auth.api.*`:
 * the account at setup, AccessKeys through the accessKeys procedures), and
 * their HTTP endpoints would bypass Edgeweir's own checks and audit log.
 */
export const AUTH_HTTP_ROUTES: Readonly<Record<string, readonly ("GET" | "POST")[]>> = {
  "/get-session": ["GET"],
  "/sign-in/email": ["POST"],
  "/sign-out": ["POST"],
  "/change-password": ["POST"],
  "/two-factor/enable": ["POST"],
  "/two-factor/disable": ["POST"],
  "/two-factor/verify-totp": ["POST"],
  "/two-factor/verify-backup-code": ["POST"],
  "/passkey/generate-register-options": ["GET"],
  "/passkey/verify-registration": ["POST"],
  "/passkey/generate-authenticate-options": ["GET"],
  "/passkey/verify-authentication": ["POST"],
  "/passkey/list-user-passkeys": ["GET"],
  "/passkey/delete-passkey": ["POST"],
};

/** Whether an /api/auth request (path below the base path) is on the allow list. */
export function isAllowedAuthRoute(method: string, path: string): boolean {
  const methods = Object.hasOwn(AUTH_HTTP_ROUTES, path) ? AUTH_HTTP_ROUTES[path] : undefined;
  return methods?.includes(method as "GET" | "POST") ?? false;
}

export function createAuth(opts: {
  db: Database;
  secret: string;
  publicUrl: string;
  /** better-auth rate limiting; unset keeps its default (on in production only). */
  rateLimit?: boolean;
}) {
  const url = new URL(opts.publicUrl);
  return betterAuth({
    appName: "Edgeweir",
    baseURL: opts.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: opts.secret,
    telemetry: { enabled: false },
    trustedOrigins: [url.origin],
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
        apikey: schema.apikey,
        rateLimit: schema.rateLimit,
      },
    }),
    // Counters live in PostgreSQL so every instance shares them and a restart
    // does not reset them.
    rateLimit: { enabled: opts.rateLimit, storage: "database", modelName: "rateLimit" },
    // Audit entries for two-factor changes; the rest comes from authAuditPlugin.
    databaseHooks: authAuditDatabaseHooks(opts.db),
    emailAndPassword: {
      enabled: true,
      // The only account is created by the setup wizard.
      disableSignUp: true,
      minPasswordLength: 12,
    },
    advanced: {
      useSecureCookies: url.protocol === "https:",
      // Only the address the console resolved itself (socket, or a trusted
      // proxy's X-Forwarded-For); client-supplied forwarding headers are
      // stripped before a request reaches better-auth.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [
      // Server side only: creates the account at setup (`auth.api.createUser`).
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      twoFactor({ issuer: "Edgeweir" }),
      passkey({ rpID: url.hostname, rpName: "Edgeweir", origin: url.origin }),
      apiKey({
        apiKeyHeaders: [API_KEY_HEADER],
        defaultPrefix: "ewk_",
        maximumNameLength: 64,
        permissions: { defaultPermissions: { edgeweir: ["read", "write"] } },
        // API keys act as the account they belong to, so /api/v1 passes the same checks as /rpc.
        enableSessionForAPIKeys: true,
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
      // Last, so its hooks see the other plugins' final responses: audit entries
      // for sign-in, password, passkey and API key changes.
      authAuditPlugin(opts.db),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
