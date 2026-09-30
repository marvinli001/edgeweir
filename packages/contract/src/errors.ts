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
  DNS_RECORD_CONFLICT: { status: 409, params: [] },
  DNS_RESOLVER_REFUSED: { status: 400, params: [] },
  DOMAIN_VERIFY_REQUIRED: { status: 403, params: [] },
  DOMAIN_ROOT_INVALID: { status: 400, params: [] },
  DOMAIN_VERIFY_FAILED: { status: 400, params: [] },
  DOMAIN_VERIFY_BUSY: { status: 429, params: [] },
  DOMAIN_PROOF_NOT_FOUND: { status: 404, params: [] },
  RULE_INVALID: { status: 400, params: [] },
  IP_LIST_NOT_FOUND: { status: 404, params: [] },
  IP_LIST_NAME_TAKEN: { status: 409, params: [] },
  IP_LIST_LIMIT: { status: 409, params: [] },
  IP_LIST_IN_USE: { status: 409, params: [] },
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
  NOT_A_MEMBER: { status: 403, params: [] },
  ORG_ADMIN_REQUIRED: { status: 403, params: [] },
  OWNER_REQUIRED: { status: 403, params: [] },
  TWO_FACTOR_REQUIRED: { status: 403, params: [] },
  USER_DISABLED: { status: 403, params: [] },
  CLUSTER_SELECTION_FORBIDDEN: { status: 403, params: [] },
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
  SITE_SUSPENDED: { status: 409, params: [] },
  UPDATED_AT_MISMATCH: { status: 409, params: [] },
  DOMAIN_IN_USE: { status: 409, params: ["domains"] },
  REVISION_NOT_FOUND: { status: 404, params: [] },
  ROLLBACK_RESOURCE_UNAVAILABLE: { status: 409, params: [] },
  ORGANIZATION_NOT_FOUND: { status: 404, params: [] },
  ORGANIZATION_SLUG_TAKEN: { status: 409, params: ["slug"] },
  USER_NOT_FOUND: { status: 404, params: [] },
  EMAIL_TAKEN: { status: 409, params: ["email"] },
  CANNOT_MODIFY_SELF: { status: 409, params: [] },
  MEMBER_NOT_FOUND: { status: 404, params: [] },
  ALREADY_MEMBER: { status: 409, params: ["email"] },
  LAST_OWNER: { status: 409, params: [] },
  INVITATION_NOT_FOUND: { status: 404, params: [] },
  INVITATION_EMAIL_MISMATCH: { status: 403, params: ["email"] },
  INVITATION_ACCOUNT_REQUIRED: { status: 400, params: [] },
  S3_SECRET_REQUIRED: { status: 400, params: ["accessKeyId"] },
  ORIGIN_ADDRESS_FORBIDDEN: { status: 400, params: ["address", "range"] },
  CACHE_TASK_NOT_FOUND: { status: 404, params: [] },
  CACHE_TASK_URL_INVALID: { status: 400, params: ["urls"] },
  CACHE_TASK_HOST_UNKNOWN: { status: 400, params: ["hosts"] },
  CACHE_TASK_RATE_LIMITED: {
    status: 429,
    params: ["tasksPerMinute", "urlsPerHour", "retryAfterSeconds"],
  },
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
  domain_verified: { params: [], en: "domain ownership verified" },
  domain_revoked: { params: [], en: "domain ownership revoked" },
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
  site_suspended: { params: ["site"], en: "site {site} suspended" },
  site_resumed: { params: ["site"], en: "site {site} resumed" },
  rollback: { params: ["revision"], en: "rollback to revision {revision}" },
  origin_allow_list_updated: { params: [], en: "origin allow list updated" },
} as const satisfies Record<string, { params: readonly string[]; en: string }>;

export type RevisionReasonCode = keyof typeof revisionReasonDefs;

export const revisionReasonCodes = Object.keys(revisionReasonDefs) as RevisionReasonCode[];

export type ReasonParams = Record<string, string | number>;

export function reasonText(code: RevisionReasonCode, params: ReasonParams): string {
  return revisionReasonDefs[code].en.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(params[key] ?? ""),
  );
}
