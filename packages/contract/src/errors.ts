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
  IDEMPOTENCY_KEY_UNSUPPORTED: { status: 400, params: [] },
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
  DNS_BINDING_CONFLICT: { status: 409, params: [] },
  DNS_BINDING_IN_USE: { status: 409, params: [] },
  DNS_PROVIDER_AUTH_FAILED: { status: 400, params: [] },
  DNS_PROVIDER_ZONE_NOT_FOUND: { status: 400, params: [] },
  DNS_PROVIDER_UNREACHABLE: { status: 502, params: [] },
  DNS_PROVIDER_RATE_LIMITED: { status: 429, params: [] },
  DNS_PROVIDER_FAILED: { status: 502, params: [] },
  DNS_ADDRESS_REFUSED: { status: 400, params: [] },
  DNS_ZONES_UNSUPPORTED: { status: 400, params: [] },
  /** A binding line's resolution line that the binding's provider does not implement. */
  DNS_LINE_UNSUPPORTED: { status: 400, params: ["line"] },
  RULE_INVALID: { status: 400, params: [] },
  /** A "host/path" bulk redirect source whose host is none of the site's domains. */
  BULK_REDIRECT_HOST_UNKNOWN: { status: 400, params: ["hosts"] },
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
  /** A stored certificate that cannot be read. */
  CERTIFICATE_INVALID: { status: 400, params: [] },
  CERTIFICATE_CHAIN_FOREIGN_BLOCK: { status: 400, params: [] },
  /** No PEM certificate, more than 10, or one that cannot be parsed. */
  CERTIFICATE_CHAIN_UNREADABLE: { status: 400, params: [] },
  /** A private key that cannot be read, such as an encrypted one. */
  CERTIFICATE_KEY_UNREADABLE: { status: 400, params: [] },
  CERTIFICATE_KEY_MISMATCH: { status: 400, params: [] },
  /** The first certificate is a CA, or one is not issued by the next. */
  CERTIFICATE_CHAIN_ORDER: { status: 400, params: [] },
  /** Not yet valid or expired; the validity in UTC ("2026-10-02 12:00 UTC"). */
  CERTIFICATE_NOT_CURRENTLY_VALID: { status: 400, params: ["notBefore", "notAfter"] },
  CERTIFICATE_NO_DNS_NAMES: { status: 400, params: [] },
  /** A certificate chosen for a site that is not issued yet or has expired. */
  CERTIFICATE_UNAVAILABLE: { status: 409, params: [] },
  /** Names a certificate or DNS zone does not cover, or HTTP-01 names no site has (first 5). */
  CERTIFICATE_DOMAIN_MISMATCH: { status: 400, params: ["domains"] },
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
  /** Probes are bound to the region; delete or move them first. */
  REGION_IN_USE: { status: 409, params: ["probes"] },
  PROBE_NOT_FOUND: { status: 404, params: [] },
  /** A node probes from its node group's region; the group has none. */
  NODE_REGION_REQUIRED: { status: 409, params: [] },
  /** A scheduling address that is not a single unicast IP literal. */
  NODE_ADDRESS_INVALID: { status: 400, params: ["address"] },
  SCHEDULING_RULE_NOT_FOUND: { status: 404, params: [] },
  /** A rule the cluster cannot evaluate (e.g. backup_group without a line, an unknown line). */
  SCHEDULING_RULE_INVALID: { status: 400, params: [] },
  NODE_NOT_FOUND: { status: 404, params: [] },
  SITE_NOT_FOUND: { status: 404, params: [] },
  CACHE_RULE_PRIORITY_DUPLICATE: { status: 400, params: ["priority"] },
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
  CACHE_TASK_HOST_INVALID: { status: 400, params: ["hosts"] },
  CACHE_TASK_TAG_INVALID: { status: 400, params: ["tags"] },
  /** An error page template over the byte limit; status names the page (404/503 for platform pages). */
  ERROR_PAGE_TOO_LARGE: { status: 400, params: ["status", "limit"] },
  API_KEY_RATE_LIMITED: { status: 429, params: ["retryAfterSeconds"] },
  L4_APP_NOT_FOUND: { status: 404, params: [] },
  /** A cluster has at most MAX_L4_APPS_PER_CLUSTER applications. */
  L4_APP_LIMIT: { status: 409, params: ["limit"] },
  /** An application port outside every port pool of its cluster for its protocol. */
  L4_PORT_OUTSIDE_POOL: { status: 400, params: ["port"] },
  /**
   * Ports other applications of the cluster use: the protocol and port of a
   * new or changed application, or ports a pool change would leave outside
   * the pools. `apps` lists them as "name (port/protocol)".
   */
  L4_PORT_IN_USE: { status: 409, params: ["apps"] },
  /** A port of the cluster's HTTP(S) listeners in a pool or an application. */
  L4_PORT_RESERVED: { status: 400, params: ["port"] },
  /** Port pools of a cluster sharing ports of a protocol ("from-to/protocol"). */
  L4_PORT_POOL_OVERLAP: { status: 400, params: ["pools"] },
  /** PROXY protocol (accepted or sent) on a UDP application. */
  L4_PROXY_PROTOCOL_UNSUPPORTED: { status: 400, params: [] },
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
  site_error_pages_updated: { params: ["site"], en: "error pages of {site} updated" },
  error_pages_updated: { params: [], en: "platform error pages updated" },
  recompiled: { params: [], en: "configuration recompiled after an upgrade" },
  l4_app_created: { params: ["app"], en: "L4 application {app} created" },
  l4_app_updated: { params: ["app"], en: "L4 application {app} updated" },
  l4_app_deleted: { params: ["app"], en: "L4 application {app} deleted" },
} as const satisfies Record<string, { params: readonly string[]; en: string }>;

export type RevisionReasonCode = keyof typeof revisionReasonDefs;

export const revisionReasonCodes = Object.keys(revisionReasonDefs) as RevisionReasonCode[];

export type ReasonParams = Record<string, string | number>;

export function reasonText(code: RevisionReasonCode, params: ReasonParams): string {
  return revisionReasonDefs[code].en.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(params[key] ?? ""),
  );
}
