import { errorDefs, isErrorCode } from "@edgeweir/contract";
import { orgLimitLabel } from "@/lib/org-limits";
import { m } from "@/paraglide/messages.js";

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

/** better-auth error codes the UI can meet (sign-in, password, 2FA, passkeys). */
const authCodes: Record<string, MessageFn> = {
  INVALID_EMAIL_OR_PASSWORD: () => m.login_failed(),
  INVALID_PASSWORD: () => m.error_invalid_password(),
  PASSWORD_TOO_SHORT: () => m.error_password_too_short(),
  INVALID_CODE: () => m.error_invalid_code(),
  INVALID_TWO_FACTOR_COOKIE: () => m.error_two_factor_expired(),
  BANNED_USER: () => m.error_user_disabled(),
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
    if (code === "ORG_LIMIT_EXCEEDED") params.resource = orgLimitLabel(String(params.resource));
    const fn = messages[`error_${code.toLowerCase()}`];
    if (fn) return fn(params);
  }
  if (code && genericCodes[code]) return (genericCodes[code] as MessageFn)();
  if (code && authCodes[code]) return (authCodes[code] as MessageFn)();
  // better-auth's rate limiter answers 429 without a code.
  if (status === 429) return m.error_too_many_requests();
  return message || fallback;
}
