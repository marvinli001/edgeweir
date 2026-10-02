import { errorDefs, isErrorCode } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

type MessageFn = (params?: Record<string, string | number>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

/** Generic oRPC codes (validation, auth, rate limits) that are not in the contract table. */
const genericCodes: Record<string, MessageFn> = {
  UNAUTHORIZED: () => m.error_unauthorized(),
  FORBIDDEN: () => m.error_forbidden(),
  BAD_REQUEST: () => m.error_bad_request(),
  NOT_FOUND: () => m.error_not_found(),
  TOO_MANY_REQUESTS: () => m.error_too_many_requests(),
  INTERNAL_SERVER_ERROR: () => m.error_internal(),
};

/**
 * better-auth error codes the UI can meet (sign-in, password, 2FA, passkeys), with the WebAuthn
 * codes (`ERROR_*`, @simplewebauthn/browser) its passkey client passes through.
 */
const authCodes: Record<string, MessageFn> = {
  INVALID_EMAIL_OR_PASSWORD: () => m.login_failed(),
  INVALID_PASSWORD: () => m.error_invalid_password(),
  PASSWORD_TOO_SHORT: () => m.error_password_too_short(),
  PASSWORD_TOO_LONG: () => m.error_password_too_long(),
  SESSION_EXPIRED: () => m.error_session_expired(),
  SESSION_NOT_FRESH: () => m.error_session_not_fresh(),
  INVALID_CODE: () => m.error_invalid_code(),
  INVALID_BACKUP_CODE: () => m.error_invalid_code(),
  INVALID_TWO_FACTOR_COOKIE: () => m.error_two_factor_expired(),
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: () => m.error_too_many_requests(),
  ACCOUNT_TEMPORARILY_LOCKED: () => m.error_too_many_requests(),
  AUTH_CANCELLED: () => m.error_passkey_cancelled(),
  REGISTRATION_CANCELLED: () => m.error_passkey_cancelled(),
  ERROR_CEREMONY_ABORTED: () => m.error_passkey_cancelled(),
  PREVIOUSLY_REGISTERED: () => m.error_passkey_registered(),
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: () => m.error_passkey_registered(),
  ERROR_INVALID_DOMAIN: () => m.error_passkey_domain(),
  ERROR_INVALID_RP_ID: () => m.error_passkey_domain(),
  ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT: () => m.error_passkey_unsupported(),
  ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT: () => m.error_passkey_unsupported(),
  ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG: () => m.error_passkey_unsupported(),
  AUTHENTICATION_FAILED: () => m.error_passkey_failed(),
  PASSKEY_NOT_FOUND: () => m.error_passkey_failed(),
  CHALLENGE_NOT_FOUND: () => m.error_passkey_failed(),
  FAILED_TO_VERIFY_REGISTRATION: () => m.error_passkey_failed(),
};

function errorFields(error: unknown): {
  code?: string;
  status?: number;
  message?: string;
  data?: unknown;
} {
  if (!error || typeof error !== "object") return {};
  const e = error as { code?: unknown; status?: unknown; message?: unknown; data?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
    data: e.data,
  };
}

/**
 * Localizes an API error by its stable code; unknown codes fall back to the
 * server's message, then to `fallback`.
 */
export function localizeError(error: unknown, fallback: string = m.common_unknown_error()): string {
  const { code, status, message, data } = errorFields(error);
  if (code && isErrorCode(code)) {
    const params: Record<string, string | number> = {};
    const values = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    for (const name of errorDefs[code].params) {
      const value = values[name];
      params[name] = typeof value === "number" ? value : String(value ?? "");
    }
    const fn = messages[`error_${code.toLowerCase()}`];
    if (fn) return fn(params);
  }
  if (code && genericCodes[code]) return (genericCodes[code] as MessageFn)();
  if (code && authCodes[code]) return (authCodes[code] as MessageFn)();
  // Other WebAuthn failures carry the browser's English message.
  if (code?.startsWith("ERROR_")) return m.error_passkey_failed();
  // better-auth's rate limiter answers 429 without a code.
  if (status === 429) return m.error_too_many_requests();
  // A schema parsed in the browser: its message is the issues as JSON.
  if (Array.isArray((error as { issues?: unknown } | null)?.issues)) return m.error_bad_request();
  return message || fallback;
}
