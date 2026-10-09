import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { MasterKey } from "./envelope";

/** Envelope binding of an access authentication rule's secret: the column and the rule (AAD). */
export const ACCESS_AUTH_SECRET_PURPOSE = "site_auth_rule.secret_envelope";
export const accessAuthSecretBinding = (ruleId: string) => ({
  purpose: ACCESS_AUTH_SECRET_PURPOSE,
  recordId: ruleId,
});

/**
 * The secret of a rule: Basic users with their password hashes, or the URL
 * signing keys (primary first). Nodes receive it as this JSON document.
 */
export type AuthSecret = { users: { name: string; hash: string }[] } | { keys: string[] };

export function sealAuthSecret(masterKey: MasterKey, ruleId: string, secret: AuthSecret): string {
  return JSON.stringify(masterKey.seal(JSON.stringify(secret), accessAuthSecretBinding(ruleId)));
}

/** The secret of a rule, or null when it has none or it cannot be opened. */
export function openAuthSecret(
  masterKey: MasterKey,
  ruleId: string,
  envelope: string | null,
): AuthSecret | null {
  if (!envelope) return null;
  const parsed = JSON.parse(
    masterKey.open(JSON.parse(envelope), accessAuthSecretBinding(ruleId)).toString("utf8"),
  ) as unknown;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray((parsed as { users?: unknown }).users)) return parsed as AuthSecret;
    if (Array.isArray((parsed as { keys?: unknown }).keys)) return parsed as AuthSecret;
  }
  return null;
}

const derive = promisify(pbkdf2);

/**
 * Basic password hashes (ADR-0038): PBKDF2-HMAC-SHA256 with a 16-byte salt,
 * BASIC_HASH_ITERATIONS iterations and 32 bytes of output, stored as
 * `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>`. Nodes verify the same
 * format with lua-resty-openssl.
 */
export const BASIC_HASH_ITERATIONS = 10_000;
const HASH_FORMAT = /^pbkdf2-sha256\$([0-9]{4,6})\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

export async function hashBasicPassword(
  password: string,
  iterations = BASIC_HASH_ITERATIONS,
): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  return `pbkdf2-sha256$${iterations}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Whether password matches a stored hash (constant-time comparison). */
export async function verifyBasicPassword(password: string, stored: string): Promise<boolean> {
  const m = HASH_FORMAT.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[3] as string, "hex");
  const hash = await derive(
    Buffer.from(password, "utf8"),
    Buffer.from(m[2] as string, "hex"),
    Number(m[1]),
    32,
    "sha256",
  );
  return timingSafeEqual(hash, expected);
}
