import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { type Database, schema } from "@edgeweir/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { CLIENT_IP_HEADER } from "./client-ip";

// Edgeweir never phones home. better-auth's own telemetry is opt-in via this
// variable; strip it so no third-party telemetry can be switched on implicitly.
delete process.env.BETTER_AUTH_TELEMETRY;

export const API_KEY_HEADER = "x-api-key";
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The better-auth HTTP endpoints the web console calls (apps/console/src/web,
 * `authClient`), by path under /api/auth and method. Everything else answers
 * 404: the organization and admin plugins are used server side only
 * (`auth.api.*`), and their HTTP endpoints would bypass Edgeweir's own
 * checks, audit log and revisions.
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
  "/api-key/create": ["POST"],
  "/api-key/list": ["GET"],
  "/api-key/delete": ["POST"],
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
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
        apikey: schema.apikey,
        rateLimit: schema.rateLimit,
      },
    }),
    // Counters live in PostgreSQL so every instance shares them and a restart
    // does not reset them.
    rateLimit: { enabled: opts.rateLimit, storage: "database", modelName: "rateLimit" },
    emailAndPassword: {
      enabled: true,
      // Accounts are created by the setup wizard and by administrators only.
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
      organization({ allowUserToCreateOrganization: false }),
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      twoFactor({ issuer: "Edgeweir" }),
      passkey({ rpID: url.hostname, rpName: "Edgeweir", origin: url.origin }),
      apiKey({
        apiKeyHeaders: [API_KEY_HEADER],
        defaultPrefix: "ewk_",
        // API keys act as their owner so the same RBAC applies to /api/v1.
        enableSessionForAPIKeys: true,
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
