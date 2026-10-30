import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeMasterKey } from "../lib/envelope";

/**
 * The header the console's own check of the WebSocket entry carries
 * (services/node-channel-check.ts): with a valid token the entry bridges that
 * one WebSocket to the node channel even while it is closed, so the console
 * can tell whether the entry works through whatever is in front of its web
 * port before anyone opens it.
 */
export const CHECK_HEADER = "x-edgeweir-channel-check";

/** How long a token is taken: one check, a few seconds through a CDN. */
export const CHECK_TOKEN_TTL_MS = 30_000;

/**
 * HKDF-SHA256 labels of the key that signs the tokens, derived from
 * EDGEWEIR_MASTER_KEY so every console instance (one behind the CDN may get
 * another instance's check) verifies them; separate from the envelope KEK and
 * the auth secret.
 */
const HKDF = { salt: "edgeweir/node-channel-check/v1", info: "websocket-entry-check", length: 32 };

const keys = new Map<string, Buffer>();
function keyOf(masterKey: string): Buffer {
  let key = keys.get(masterKey);
  if (!key) {
    key = Buffer.from(
      hkdfSync("sha256", decodeMasterKey(masterKey), HKDF.salt, HKDF.info, HKDF.length),
    );
    keys.set(masterKey, key);
  }
  return key;
}

const mac = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest("base64url");

/** Tokens this process accepted, by nonce, until they expire: each is taken once. */
const used = new Map<string, number>();

/** `<expires ms>.<nonce>.<HMAC>`, valid for CHECK_TOKEN_TTL_MS. */
export function issueCheckToken(masterKey: string, now = Date.now()): string {
  const payload = `${now + CHECK_TOKEN_TTL_MS}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${mac(keyOf(masterKey), payload)}`;
}

/**
 * Whether `value` is a token this console issued, not expired, not dated
 * further ahead than a token can be, and not taken before by this process.
 * Takes it.
 */
export function acceptCheckToken(
  masterKey: string,
  value: string | string[] | undefined,
  now = Date.now(),
): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [expiresText, nonce, signature] = parts as [string, string, string];
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + CHECK_TOKEN_TTL_MS)
    return false;
  const expected = Buffer.from(mac(keyOf(masterKey), `${expiresText}.${nonce}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  for (const [seen, until] of used) if (until <= now) used.delete(seen);
  if (used.has(nonce)) return false;
  used.set(nonce, expires);
  return true;
}
