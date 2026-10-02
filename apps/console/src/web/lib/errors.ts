import { errorDefs, expressionIssue, isErrorCode } from "@edgeweir/contract";
import type * as z from "zod";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { expressionErrorText, expressionReason } from "./expressions";

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

/**
 * Labels of the input fields a validation issue can point at, by the field's name in the
 * contract. The deepest named segment of the issue's path that has a label wins.
 */
const fieldLabels: Record<string, () => string> = {
  name: () => m.site_form_name(),
  domains: () => m.site_form_domains(),
  domain: () => m.site_form_domains(),
  address: () => m.site_form_origin(),
  port: () => m.site_form_port(),
  hostHeader: () => m.site_form_host_header(),
  sni: () => m.site_origin_sni(),
  pathPrefixes: () => m.site_form_cache_prefix(),
  paths: () => m.site_rule_paths(),
  edgeTtlSeconds: () => m.site_form_cache_ttl(),
  headers: () => m.site_cache_key_headers(),
  queryParams: () => m.site_cache_key_query(),
  cookies: () => m.site_cache_key_cookies(),
  statusCodes: () => m.site_rule_status_codes(),
  names: () => m.cert_domains(),
  challenge: () => m.cert_challenge(),
  email: () => m.cert_email(),
  chainPem: () => m.cert_chain(),
  hstsMaxAge: () => m.cert_hsts_age(),
  version: () => m.upgrade_version(),
  urls: () => m.purge_urls(),
  hosts: () => m.purge_hosts(),
  tags: () => m.purge_tags(),
  sitemapUrl: () => m.purge_sitemap_url(),
  siteIds: () => m.purge_sites(),
  expression: () => m.rules_expression(),
  entries: () => m.ip_lists_entries(),
  cidr: () => m.bans_address(),
  ttl: () => m.dns_ttl(),
};

/** A node capability id ("tls-v1") by its label, or the id itself when it has none. */
export function nodeFeatureLabel(feature: string): string {
  const fn = messages[`node_feature_${feature.replaceAll("-", "_")}`];
  return fn ? fn() : feature;
}

/** "tls-v1, purge-tag-v1" → "HTTPS、Host 与标签刷新" (", " in English). */
function featureList(features: string): string {
  const labels = features
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean)
    .map(nodeFeatureLabel);
  return [...new Set(labels)].join(getLocale() === "zh-CN" ? "、" : ", ");
}

type Issue = { path?: readonly PropertyKey[]; code?: string; params?: unknown };

/** The first validation issue of a server (oRPC `data.issues`) or browser (zod) error. */
function firstIssue(error: unknown, data: unknown): Issue | undefined {
  const fromData = (data as { issues?: unknown } | null | undefined)?.issues;
  const issues = Array.isArray(fromData)
    ? fromData
    : (error as { issues?: unknown } | null | undefined)?.issues;
  return Array.isArray(issues) ? (issues[0] as Issue | undefined) : undefined;
}

/**
 * "Check “Domains” (item 3)" for the deepest labelled field of the issue's path; an expression the
 * parser refused adds where and why (`params.expressionError`, as the editor shows it).
 */
function issueMessage(issue: Issue | undefined): string {
  const path = issue?.path ?? [];
  const failure = issue ? expressionIssue(issue as z.core.$ZodIssue) : null;
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];
    const label = typeof segment === "string" ? fieldLabels[segment] : undefined;
    if (!label) continue;
    const index = path[i + 1];
    if (failure) {
      const where = { field: label(), position: failure.position + 1 };
      const reason = expressionReason(failure);
      return typeof index === "number"
        ? m.common_check_field_item_expression({ ...where, item: index + 1, reason })
        : m.common_check_field_expression({ ...where, reason });
    }
    return typeof index === "number"
      ? m.common_check_field_item({ field: label(), item: index + 1 })
      : m.common_check_field({ field: label() });
  }
  return failure ? expressionErrorText(failure) : m.error_bad_request();
}

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
    if (code === "NODE_CAPABILITY_REQUIRED") params.features = featureList(String(params.features));
    const fn = messages[`error_${code.toLowerCase()}`];
    if (fn) return fn(params);
  }
  // oRPC's input validation: name the field the first issue points at.
  if (code === "BAD_REQUEST" && firstIssue(error, data)) {
    return issueMessage(firstIssue(error, data));
  }
  if (code && genericCodes[code]) return (genericCodes[code] as MessageFn)();
  if (code && authCodes[code]) return (authCodes[code] as MessageFn)();
  // Other WebAuthn failures carry the browser's English message.
  if (code?.startsWith("ERROR_")) return m.error_passkey_failed();
  // better-auth's rate limiter answers 429 without a code.
  if (status === 429) return m.error_too_many_requests();
  // A schema parsed in the browser: its message is the issues as JSON.
  if (Array.isArray((error as { issues?: unknown } | null)?.issues)) {
    return issueMessage(firstIssue(error, undefined));
  }
  return message || fallback;
}
