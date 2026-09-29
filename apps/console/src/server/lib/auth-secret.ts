import { createHmac, hkdfSync } from "node:crypto";
import { type Database, schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import type { Env } from "./env";
import { decodeMasterKey } from "./envelope";
import type { Logger } from "./logger";

/**
 * HKDF-SHA256 parameters of the better-auth secret derived from
 * EDGEWEIR_MASTER_KEY when BETTER_AUTH_SECRET is unset (SECURITY.md). The
 * envelope KEK uses salt "edgeweir/kek/v1" and info "envelope"; separate
 * labels keep the two keys independent.
 */
export const AUTH_SECRET_HKDF = {
  salt: "edgeweir/auth-secret/v1",
  info: "better-auth.secret",
  length: 32,
} as const;

/** The secret better-auth signs sessions and encrypts two-factor secrets with. */
export interface AuthSecret {
  value: string;
  /** "environment": BETTER_AUTH_SECRET; "master_key": derived. */
  source: "environment" | "master_key";
}

/** 32 bytes from HKDF-SHA256 over the master key, base64url (43 characters). */
export function deriveAuthSecret(masterKey: string): string {
  const { salt, info, length } = AUTH_SECRET_HKDF;
  return Buffer.from(hkdfSync("sha256", decodeMasterKey(masterKey), salt, info, length)).toString(
    "base64url",
  );
}

/** An explicit BETTER_AUTH_SECRET wins, so existing deployments keep their sessions. */
export function resolveAuthSecret(
  env: Pick<Env, "BETTER_AUTH_SECRET" | "EDGEWEIR_MASTER_KEY">,
): AuthSecret {
  return env.BETTER_AUTH_SECRET
    ? { value: env.BETTER_AUTH_SECRET, source: "environment" }
    : { value: deriveAuthSecret(env.EDGEWEIR_MASTER_KEY), source: "master_key" };
}

export const AUTH_SECRET_CHECK_KEY = "auth_secret_check";

/** Stored instead of the secret: HMAC-SHA256 keyed with it over a fixed label. */
export function authSecretCheck(secret: string): string {
  return createHmac("sha256", secret).update("edgeweir/auth-secret-check/v1").digest("base64url");
}

export const AUTH_SECRET_CHANGED =
  "BETTER_AUTH_SECRET is not set, but this database was used with another secret: set BETTER_AUTH_SECRET to its previous value (a new secret signs everyone out and makes enrolled two-factor secrets unreadable)";

/**
 * better-auth signs session cookies and encrypts TOTP secrets and backup codes
 * with its secret, so it must never change by accident. Refuses to start when
 * the derived secret differs from the one this database last ran with: the
 * usual cause is BETTER_AUTH_SECRET removed from an existing deployment.
 * Databases without a check value predate the derived default and always had
 * an explicit secret once they have users. A new explicit value is the
 * operator's choice and is accepted with a warning.
 */
export async function assertAuthSecret(
  db: Database,
  secret: AuthSecret,
  log: Pick<Logger, "warn">,
): Promise<void> {
  const check = authSecretCheck(secret.value);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.auth-secret'))`);
    const [row] = await tx
      .select({ value: schema.systemSetting.value })
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, AUTH_SECRET_CHECK_KEY));
    const stored = typeof row?.value.check === "string" ? row.value.check : null;
    if (stored === check) return;
    if (secret.source === "master_key") {
      const used =
        stored !== null ||
        (await tx.select({ id: schema.user.id }).from(schema.user).limit(1)).length > 0;
      if (used) throw new Error(AUTH_SECRET_CHANGED);
    } else if (stored !== null) {
      log.warn(
        "BETTER_AUTH_SECRET changed: existing sessions end and enrolled two-factor secrets can no longer be read",
      );
    }
    const value = { check };
    await tx
      .insert(schema.systemSetting)
      .values({ key: AUTH_SECRET_CHECK_KEY, value })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
  });
}
