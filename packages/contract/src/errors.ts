/**
 * Stable error codes returned by the API (the oRPC error `code`, with the
 * listed HTTP status). Clients localize them by code; `params` name the fields
 * of the error's `data` that the message interpolates. Unknown codes fall back
 * to the server's English `message`.
 */
export const errorDefs = {
  UPGRADE_RELEASE_UNAVAILABLE: { status: 502, params: [] },
  RELEASE_SOURCE_REFUSED: { status: 400, params: [] },
  UPGRADE_NOT_FOUND: { status: 404, params: [] },
  UPGRADE_BUSY: { status: 409, params: [] },
  UPGRADE_NODES_UNAVAILABLE: { status: 409, params: [] },
  UPGRADE_NOT_READY: { status: 409, params: [] },

  ACCESS_KEY_NOT_FOUND: { status: 404, params: [] },
  ACCESS_KEY_READ_ONLY: { status: 403, params: [] },
  ACCESS_KEY_SESSION_REQUIRED: { status: 403, params: [] },
  SCOPE_REQUIRED: { status: 403, params: ["scope"] },
  SERVICE_ACCOUNT_FORBIDDEN: { status: 403, params: [] },
  SERVICE_ACCOUNT_NOT_FOUND: { status: 404, params: [] },
  SERVICE_ACCOUNT_KEY_NOT_FOUND: { status: 404, params: [] },
  SERVICE_ACCOUNT_NAME_TAKEN: { status: 409, params: ["name"] },
  IDEMPOTENCY_KEY_INVALID: { status: 400, params: [] },
  IDEMPOTENCY_KEY_MISMATCH: { status: 422, params: [] },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, params: [] },
  ALERT_CHANNEL_NOT_FOUND: { status: 404, params: [] },
  ALERT_CHANNEL_LIMIT: { status: 409, params: [] },
  ALERT_SEND_FAILED: { status: 502, params: [] },
  ALERT_SUBSCRIPTION_NOT_FOUND: { status: 404, params: [] },
  SMTP_PASSWORD_REQUIRED: { status: 400, params: [] },
  SMTP_CA_INVALID: { status: 400, params: [] },
  DNS_ZONE_MISMATCH: { status: 400, params: [] },
  DNS_PROVIDER_NOT_FOUND: { status: 404, params: [] },
  DNS_TEST_DISABLED: { status: 400, params: [] },
  DNS_PROVIDER_IN_USE: { status: 409, params: [] },
  DNS_POLICY_INVALID: { status: 400, params: [] },
  DNS_REVISION_NOT_FOUND: { status: 404, params: [] },
  DNS_NOT_BLOCKED: { status: 409, params: [] },
  DNS_RECORD_CONFLICT: { status: 409, params: [] },
  RULE_INVALID: { status: 400, params: [] },
  IP_LIST_NOT_FOUND: { status: 404, params: [] },
  IP_LIST_NAME_TAKEN: { status: 409, params: [] },
  IP_LIST_LIMIT: { status: 409, params: [] },
  IP_LIST_IN_USE: { status: 409, params: [] },
  BAN_INVALID_CIDR: { status: 400, params: [] },
  BAN_PREFIX_TOO_SHORT: { status: 400, params: ["min"] },
  BAN_EXPIRY_OUT_OF_RANGE: { status: 400, params: [] },
  BAN_PROTECTED_ADDRESS: { status: 400, params: ["address"] },
  BAN_PLATFORM_LIMIT: { status: 409, params: ["limit"] },
  BAN_NOT_FOUND: { status: 404, params: [] },
  PROTECTION_POW_DIFFICULTY: { status: 400, params: ["min"] },
  CERTIFICATE_NOT_FOUND: { status: 404, params: [] },
  CERTIFICATE_INVALID: { status: 400, params: [] },
  CERTIFICATE_DOMAIN_MISMATCH: { status: 400, params: [] },
  CERTIFICATE_BUSY: { status: 409, params: [] },
  CERTIFICATE_IN_USE: { status: 409, params: [] },
  DNS_CREDENTIAL_NOT_FOUND: { status: 404, params: [] },
  DNS_CREDENTIAL_INVALID: { status: 400, params: [] },

  SETUP_DONE: { status: 403, params: [] },
  SETUP_IN_PROGRESS: { status: 409, params: [] },
  SETUP_TOKEN_INVALID: { status: 403, params: [] },
  CLUSTER_NOT_FOUND: { status: 404, params: [] },
  CLUSTER_SITE_LIMIT: { status: 409, params: ["limit"] },
  NODE_CAPABILITY_REQUIRED: { status: 409, params: ["features"] },
  CLUSTER_NAME_TAKEN: { status: 409, params: ["name"] },
  CLUSTER_NOT_EMPTY: { status: 409, params: ["nodes", "sites"] },
  NO_CLUSTER: { status: 412, params: [] },
  NODE_GROUP_NOT_FOUND: { status: 404, params: [] },
  NODE_GROUP_NAME_TAKEN: { status: 409, params: ["name"] },
  NODE_GROUP_IS_DEFAULT: { status: 409, params: [] },
  NODE_GROUP_CLUSTER_MISMATCH: { status: 400, params: [] },
  REGION_NOT_FOUND: { status: 404, params: [] },
  REGION_CODE_TAKEN: { status: 409, params: ["code"] },
  NODE_NOT_FOUND: { status: 404, params: [] },
  SITE_NOT_FOUND: { status: 404, params: [] },
  SITE_DISABLED: { status: 409, params: [] },
  UPDATED_AT_MISMATCH: { status: 409, params: [] },
  DOMAIN_IN_USE: { status: 409, params: ["domains"] },
  REVISION_NOT_FOUND: { status: 404, params: [] },
  ROLLOUT_NOT_ACTIVE: { status: 409, params: [] },
  ROLLBACK_RESOURCE_UNAVAILABLE: { status: 409, params: [] },
  S3_SECRET_REQUIRED: { status: 400, params: ["accessKeyId"] },
  ORIGIN_ADDRESS_FORBIDDEN: { status: 400, params: ["address", "range"] },
  CACHE_TASK_NOT_FOUND: { status: 404, params: [] },
  USAGE_RANGE_INVALID: { status: 400, params: [] },
  USAGE_CURSOR_INVALID: { status: 400, params: [] },
  CACHE_TASK_URL_INVALID: { status: 400, params: ["urls"] },
  CACHE_TASK_HOST_UNKNOWN: { status: 400, params: ["hosts"] },
  API_KEY_RATE_LIMITED: { status: 429, params: ["retryAfterSeconds"] },
} as const satisfies Record<string, { status: number; params: readonly string[] }>;

export type ErrorCode = keyof typeof errorDefs;

export const errorCodes = Object.keys(errorDefs) as ErrorCode[];

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(errorDefs, code);
}

/**
 * Why a config revision was published. Stored as `reason_code` + params; the
 * UI renders it per locale, `reasonText` gives the English form for the API.
 */
export const revisionReasonDefs = {
  rules_updated: { params: [], en: "rules and IP lists updated" },
  certificate_updated: { params: ["site"], en: "certificate policy for {site} updated" },
  acme_challenge_updated: { params: [], en: "ACME challenge updated" },
  cluster_created: { params: ["cluster"], en: "cluster {cluster} created" },
  site_created: { params: ["site"], en: "site {site} created" },
  site_updated: { params: ["site"], en: "site {site} updated" },
  site_deleted: { params: ["site"], en: "site {site} deleted" },
  site_purged: { params: ["site"], en: "site {site} purged" },
  site_enabled: { params: ["site"], en: "site {site} enabled" },
  site_disabled: { params: ["site"], en: "site {site} disabled" },
  rollback: { params: ["revision"], en: "rollback to revision {revision}" },
  rollout_rollback: {
    params: ["revision"],
    en: "canary of revision {revision} rolled back",
  },
  origin_allow_list_updated: { params: [], en: "origin allow list updated" },
  site_protection_updated: { params: ["site"], en: "protection of {site} updated" },
  platform_protection_updated: { params: [], en: "global Under Attack updated" },
  cc_template_updated: { params: [], en: "CC template updated" },
  challenge_keys_rotated: { params: [], en: "challenge keys rotated" },
  site_waf_updated: { params: ["site"], en: "OWASP CRS of {site} updated" },
  recompiled: { params: [], en: "configuration recompiled after an upgrade" },
} as const satisfies Record<string, { params: readonly string[]; en: string }>;

export type RevisionReasonCode = keyof typeof revisionReasonDefs;

export const revisionReasonCodes = Object.keys(revisionReasonDefs) as RevisionReasonCode[];

export type ReasonParams = Record<string, string | number>;

export function reasonText(code: RevisionReasonCode, params: ReasonParams): string {
  return revisionReasonDefs[code].en.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(params[key] ?? ""),
  );
}
