import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { type ClientMetadataResourceFetch, oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE, MCP_PATH, mcpScopes } from "@edgeweir/contract";
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

/** The MCP resource (RFC 8707 / RFC 9728): the audience every OAuth access token is bound to. */
export function mcpResourceUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}${MCP_PATH}`;
}

/** The OAuth authorization server's issuer: better-auth's base URL. */
export function mcpIssuer(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}${AUTH_BASE_PATH}`;
}

/** Opaque OAuth tokens carry a prefix, so secret scanners and logs can tell them apart. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "ewo_";
const OAUTH_REFRESH_TOKEN_PREFIX = "ewr_";

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
  // OAuth for MCP clients (ADR-0076), only while MCP is on (app.ts): the browser's authorization
  // request, and the client's registration, token and revocation calls. Consent goes through
  // the mcp.consent procedure; introspection, userinfo, client and consent management stay
  // server side.
  "/oauth2/authorize": ["GET"],
  "/oauth2/register": ["POST"],
  "/oauth2/token": ["POST"],
  "/oauth2/revoke": ["POST"],
};

/** The OAuth endpoints of AUTH_HTTP_ROUTES: 404 while MCP is off. */
export const OAUTH_ROUTES: ReadonlySet<string> = new Set(
  Object.keys(AUTH_HTTP_ROUTES).filter((path) => path.startsWith("/oauth2/")),
);

/**
 * Allowed endpoints that change the signed-in account (its password, second
 * factor or passkeys): the demo account may not call them.
 */
export const ACCOUNT_CHANGE_ROUTES: ReadonlySet<string> = new Set([
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
]);

/**
 * Allowed endpoints the login allow list does not limit (ADR-0047): signing out only ends the
 * session the request carries.
 */
export const LOGIN_ALLOW_LIST_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  "/sign-out",
  // MCP clients call these from wherever they run (often a cloud egress), like AccessKeys; the
  // browser's authorization request is not exempt: granting takes an allowed session.
  "/oauth2/register",
  "/oauth2/token",
  "/oauth2/revoke",
]);

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
  /**
   * Fetches Client ID Metadata Documents (CIMD): resolve once, refuse special-purpose
   * addresses, pin the address, no redirects (lib/outbound.ts). Unset: refused.
   */
  fetchClientMetadata?: ClientMetadataResourceFetch;
}) {
  const fetchClientMetadata: ClientMetadataResourceFetch =
    opts.fetchClientMetadata ??
    (() => Promise.reject(new Error("client metadata documents are not fetched here")));
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
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    // The /api/auth endpoints' limits (sign-in, second factor): counters live in
    // PostgreSQL so every instance shares them and a restart does not reset
    // them. AccessKey request limits are not these: the console counts them in
    // its own process (AccessKeyRateLimiter, services/access-keys.ts).
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
      // Creates AccessKeys only (`auth.api.createApiKey`). The console verifies them itself,
      // with one lookup and an in-process request limit (authenticateAccessKey,
      // services/access-keys.ts): the plugin wrote the key's row twice per request, so
      // requests with one key waited for each other's commits. Its sessions for API keys stay
      // off, and so does its verification.
      apiKey({
        defaultPrefix: "ewk_",
        maximumNameLength: 64,
        permissions: { defaultPermissions: { edgeweir: ["read", "write"] } },
        // Defaults for a new key's columns; each key keeps its own limit (services/access-keys.ts).
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
        },
      }),
      // The authorization server for MCP clients (ADR-0076). Access tokens are opaque and stored
      // as SHA-256 (no JWT signing keys): /mcp looks each one up, so a revoked grant stops at
      // once. One resource, /mcp, which every token is bound to.
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: [...mcpScopes],
        grantTypes: ["authorization_code", "refresh_token"],
        disableJwtPlugin: true,
        resources: [{ identifier: mcpResourceUrl(opts.publicUrl), name: "Edgeweir MCP" }],
        // Every client may ask for the one resource; there is nothing to separate.
        enforcePerClientResources: false,
        // Open dynamic registration (RFC 7591) for clients without a metadata document; its
        // endpoint has a request limit (rateLimit below), unused clients are pruned
        // (services/mcp.ts).
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Native clients (Claude Code, Cursor) register loopback callbacks without
        // application_type.
        clientRegistrationDefaultApplicationType: "infer",
        // A registered client may ask for every scope; the operator decides on /oauth/consent.
        clientRegistrationDefaultScopes: [...mcpScopes],
        prefix: {
          opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
          refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
        },
        // A retried refresh gets the response of the first one (as @better-auth/mcp sets it).
        refreshTokenReuseInterval: 30,
        advertisedMetadata: { scopes_supported: [...mcpScopes] },
        rateLimit: { register: { window: 60, max: 10 } },
      }),
      // Clients identified by an https URL (Client ID Metadata Document, as MCP prefers).
      cimd({
        fetchClientMetadataResource: fetchClientMetadata,
        metadataFetchPolicy: { maximumFetchesPerMinute: 60, maximumFetchesPerOriginPerMinute: 10 },
      }),
      // Last, so its hooks see the other plugins' final responses: audit entries
      // for sign-in, password, passkey and API key changes.
      authAuditPlugin(opts.db),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
