import { createHmac, hkdfSync } from "node:crypto";
import { type Database, schema } from "@edgeweir/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { Env } from "./env";
import { decodeMasterKey, type Envelope, type MasterKey } from "./envelope";
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
  /**
   * "environment": BETTER_AUTH_SECRET; "master_key": derived from
   * EDGEWEIR_MASTER_KEY; "stored": derived from an earlier master key and
   * kept in system_setting, sealed with the current one (loadAuthSecret).
   */
  source: "environment" | "master_key" | "stored";
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
/** Setting that holds the derived secret once the master key it came from is rotated. */
export const AUTH_SECRET_KEY = "auth_secret";
/** Envelope binding of the stored session secret: the setting and its key (AAD). */
export const AUTH_SECRET_BINDING = {
  purpose: "system_setting.auth_secret",
  recordId: AUTH_SECRET_KEY,
} as const;

/**
 * The session secret of this database. An explicit BETTER_AUTH_SECRET wins;
 * otherwise it is derived from the master key, and it has to outlive a
 * rotation of that key, or everyone is signed out and enrolled two-factor
 * secrets become unreadable. So when the secret this database ran with is
 * the one EDGEWEIR_MASTER_KEY_PREVIOUS derives, it is sealed with the current
 * key into system_setting and read from there from then on, also once
 * EDGEWEIR_MASTER_KEY_PREVIOUS is removed.
 */
export async function loadAuthSecret(
  db: Database,
  env: Pick<Env, "BETTER_AUTH_SECRET" | "EDGEWEIR_MASTER_KEY" | "EDGEWEIR_MASTER_KEY_PREVIOUS">,
  masterKey: MasterKey,
): Promise<AuthSecret> {
  const resolved = resolveAuthSecret(env);
  if (resolved.source === "environment") return resolved;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.auth-secret'))`);
    const rows = await tx
      .select()
      .from(schema.systemSetting)
      .where(inArray(schema.systemSetting.key, [AUTH_SECRET_KEY, AUTH_SECRET_CHECK_KEY]));
    const setting = (key: string) => rows.find((row) => row.key === key)?.value;
    const sealed = setting(AUTH_SECRET_KEY)?.envelope as Envelope | undefined;
    if (sealed) {
      try {
        const value = masterKey.open(sealed, AUTH_SECRET_BINDING).toString("utf8");
        return { value, source: "stored" };
      } catch (error) {
        throw new Error(
          `the stored session secret cannot be opened with the configured master key: ${(error as Error).message}`,
        );
      }
    }
    const check = setting(AUTH_SECRET_CHECK_KEY)?.check;
    const previous = env.EDGEWEIR_MASTER_KEY_PREVIOUS;
    if (previous && typeof check === "string" && check !== authSecretCheck(resolved.value)) {
      const value = deriveAuthSecret(previous);
      if (authSecretCheck(value) === check) {
        await tx.insert(schema.systemSetting).values({
          key: AUTH_SECRET_KEY,
          value: { envelope: masterKey.seal(value, AUTH_SECRET_BINDING) },
        });
        return { value, source: "stored" };
      }
    }
    return resolved;
  });
}

/** Stored instead of the secret: HMAC-SHA256 keyed with it over a fixed label. */
export function authSecretCheck(secret: string): string {
  return createHmac("sha256", secret).update("edgeweir/auth-secret-check/v1").digest("base64url");
}

export const AUTH_SECRET_CHANGED =
  "BETTER_AUTH_SECRET is not set, but this database was used with another secret: set BETTER_AUTH_SECRET to its previous value (a new secret signs everyone out and makes enrolled two-factor secrets unreadable)";

/**
 * better-auth signs session cookies and encrypts TOTP secrets and backup codes
 * with its secret, so it must never change by accident. Refuses to start when
 * the derived (or stored) secret differs from the one this database last ran
 * with: the usual cause is BETTER_AUTH_SECRET removed from an existing
 * deployment.
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
    if (secret.source !== "environment") {
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
