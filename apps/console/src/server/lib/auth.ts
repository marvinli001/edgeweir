import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { type Database, schema } from "@edgeweir/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, twoFactor } from "better-auth/plugins";

// Edgeweir never phones home. better-auth's own telemetry is opt-in via this
// variable; strip it so no third-party telemetry can be switched on implicitly.
delete process.env.BETTER_AUTH_TELEMETRY;

export const API_KEY_HEADER = "x-api-key";

export function createAuth(opts: { db: Database; secret: string; publicUrl: string }) {
  const url = new URL(opts.publicUrl);
  return betterAuth({
    appName: "Edgeweir",
    baseURL: opts.publicUrl,
    basePath: "/api/auth",
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
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Accounts are created by the setup wizard and by administrators only.
      disableSignUp: true,
      minPasswordLength: 12,
    },
    advanced: {
      useSecureCookies: url.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
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
