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
  /** Nodes (first 10, then "+N") that already take part in an unfinished upgrade. */
  UPGRADE_BUSY: { status: 409, params: ["nodes"] },
  /** The upgrade being cancelled has already ended. */
  UPGRADE_FINISHED: { status: 409, params: [] },
  /** Active nodes (first 10, then "+N") that are offline, out of sync or cannot self-upgrade. */
  UPGRADE_NODES_UNAVAILABLE: { status: 409, params: ["nodes"] },
  /** The node group chosen to go first has no active nodes. */
  UPGRADE_CANARY_EMPTY: { status: 409, params: [] },
  UPGRADE_TOO_MANY_NODES: { status: 409, params: ["limit"] },
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
  ALERT_SMTP_NOT_CONFIGURED: { status: 412, params: [] },
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
  DNS_RECORD_CONFLICT: { status: 409, params: ["name"] },
  DNS_BINDING_CONFLICT: { status: 409, params: ["name"] },
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
  /** A requested reconciliation of a cluster's DNS waited in vain for the one in progress. */
  DNS_RECONCILE_BUSY: { status: 409, params: [] },
  RULE_INVALID: { status: 400, params: [] },
  /** CRS rules (first 5) that set up or evaluate the others (CRS_EVALUATION_FILES). */
  WAF_RULE_NOT_EXCLUDABLE: { status: 400, params: ["ids"] },
  /** A "host/path" bulk redirect source whose host is none of the site's domains. */
  BULK_REDIRECT_HOST_UNKNOWN: { status: 400, params: ["hosts"] },
  IP_LIST_NOT_FOUND: { status: 404, params: [] },
  /** A rule or cache rule condition references IP lists (`$name`) that do not exist. */
  IP_LIST_REFERENCE_UNKNOWN: { status: 404, params: ["lists"] },
  IP_LIST_NAME_TAKEN: { status: 409, params: [] },
  IP_LIST_LIMIT: { status: 409, params: [] },
  /**
   * Rules ("name (site)" for site rules), sites whose cache rules, and L4
   * applications that still use the list; the first five.
   */
  IP_LIST_IN_USE: { status: 409, params: ["users"] },
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
  /** An EC private key with explicit curve parameters instead of the curve's OID. */
  CERTIFICATE_KEY_EXPLICIT_CURVE: { status: 400, params: [] },
  /** A chain certificate whose EC key has explicit curve parameters instead of the curve's OID. */
  CERTIFICATE_CHAIN_EXPLICIT_CURVE: { status: 400, params: [] },
  /** The first certificate is a CA, or one is not issued by the next. */
  CERTIFICATE_CHAIN_ORDER: { status: 400, params: [] },
  /** Not yet valid or expired; the validity in UTC ("2026-10-02 12:00 UTC"). */
  CERTIFICATE_NOT_CURRENTLY_VALID: { status: 400, params: ["notBefore", "notAfter"] },
  CERTIFICATE_NO_DNS_NAMES: { status: 400, params: [] },
  /** A leaf key other than RSA (2048 bits or more) or ECDSA P-256, P-384 or P-521. */
  CERTIFICATE_KEY_TYPE_UNSUPPORTED: { status: 400, params: [] },
  /** A certificate chosen for a site that is not issued yet or has expired. */
  CERTIFICATE_UNAVAILABLE: { status: 409, params: [] },
  /** Names a certificate or DNS zone does not cover, or HTTP-01 names no site has (first 5). */
  CERTIFICATE_DOMAIN_MISMATCH: { status: 400, params: ["domains"] },
  CERTIFICATE_BUSY: { status: 409, params: [] },
  /** Sites use the certificate (the first 5 names). */
  CERTIFICATE_IN_USE: { status: 409, params: ["sites"] },
  /** Layer-4 applications that terminate TLS with the certificate (first 5 names). */
  CERTIFICATE_IN_USE_BY_L4: { status: 409, params: ["apps"] },
  DNS_CREDENTIAL_NOT_FOUND: { status: 404, params: [] },
  DNS_CREDENTIAL_INVALID: { status: 400, params: [] },
  /** Certificates use the DNS credential (the first 5 names). */
  DNS_CREDENTIAL_IN_USE: { status: 409, params: ["certificates"] },
  /** HTTP-01 names that resolve to no node, or to other addresses too (first 5). */
  CERTIFICATE_DNS_NOT_POINTING: { status: 409, params: ["names"] },
  /** Clusters serving HTTP-01 names without an online node (first 5). */
  CERTIFICATE_NODES_OFFLINE: { status: 409, params: ["clusters"] },
  /** A site's client CA bundle is not 1-10 current CA certificates in PEM. */
  CLIENT_CA_INVALID: { status: 400, params: [] },
  /** Client certificates and HTTP/3 cannot be on together. */
  CLIENT_CERTIFICATE_HTTP3: { status: 400, params: [] },
  /** A custom ACME directory that could not be read or is not an ACME directory. */
  ACME_DIRECTORY_INVALID: { status: 400, params: [] },
  /** The custom ACME directory's CA certificates are not 1-10 PEM certificates. */
  ACME_DIRECTORY_CA_INVALID: { status: 400, params: [] },
  /** An EAB key id without an HMAC key (none saved for it). */
  ACME_DIRECTORY_EAB_INCOMPLETE: { status: 400, params: [] },
  /** A request for the custom CA while no custom ACME directory is configured. */
  ACME_DIRECTORY_NOT_CONFIGURED: { status: 409, params: [] },
  ACME_ACCOUNT_NOT_FOUND: { status: 404, params: [] },
  /** Certificates use the ACME account (the first 5 names). */
  ACME_ACCOUNT_IN_USE: { status: 409, params: ["certificates"] },

  SETUP_DONE: { status: 403, params: [] },
  SETUP_IN_PROGRESS: { status: 409, params: [] },
  SETUP_TOKEN_INVALID: { status: 403, params: [] },
  CLUSTER_NOT_FOUND: { status: 404, params: [] },
  CLUSTER_SITE_LIMIT: { status: 409, params: ["limit"] },
  /** `nodes`: active nodes lacking the features (first 5). */
  NODE_CAPABILITY_REQUIRED: { status: 409, params: ["features", "nodes"] },
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
  ENROLLMENT_TOKEN_NOT_FOUND: { status: 404, params: [] },
  SITE_NOT_FOUND: { status: 404, params: [] },
  CACHE_RULE_PRIORITY_DUPLICATE: { status: 400, params: ["priority"] },
  SITE_DISABLED: { status: 409, params: [] },
  UPDATED_AT_MISMATCH: { status: 409, params: [] },
  DOMAIN_IN_USE: { status: 409, params: ["domains"] },
  /** A Unicode (or xn--) host name that UTS #46 or the LDH rules refuse. */
  DOMAIN_INVALID: { status: 400, params: ["domain"] },
  /** The CNAME prefix is taken, still resolving for another site or application, or a DNS record name. */
  CNAME_PREFIX_CONFLICT: { status: 409, params: ["prefix"] },
  CNAME_PREFIX_INVALID: { status: 400, params: ["prefix"] },
  /** The default site for unknown hosts is not an enabled site of the cluster. */
  DEFAULT_SITE_INVALID: { status: 400, params: [] },
  /** Unknown SNI can only get the default site's certificate when it has one. */
  DEFAULT_SITE_CERTIFICATE_REQUIRED: { status: 409, params: [] },
  REVISION_NOT_FOUND: { status: 404, params: [] },
  ROLLOUT_NOT_ACTIVE: { status: 409, params: [] },
  ROLLBACK_RESOURCE_UNAVAILABLE: { status: 409, params: [] },
  S3_SECRET_REQUIRED: { status: 400, params: ["accessKeyId"] },
  ORIGIN_ADDRESS_FORBIDDEN: { status: 400, params: ["address", "range"] },
  /** originSettings.grpc on a pool whose protocol towards the origins is not http2. */
  ORIGIN_GRPC_REQUIRES_HTTP2: { status: 400, params: [] },
  /**
   * The Host header of an origin or origin rule is not a host name or IP literal with an optional
   * port as nodes accept it (validHostHeader of @edgeweir/rule-engine).
   */
  ORIGIN_HOST_HEADER_INVALID: { status: 400, params: ["hostHeader"] },
  CACHE_TASK_NOT_FOUND: { status: 404, params: [] },
  USAGE_RANGE_INVALID: { status: 400, params: [] },
  USAGE_CURSOR_INVALID: { status: 400, params: [] },
  CACHE_TASK_URL_INVALID: { status: 400, params: ["urls"] },
  CACHE_TASK_HOST_UNKNOWN: { status: 400, params: ["hosts"] },
  CACHE_TASK_HOST_INVALID: { status: 400, params: ["hosts"] },
  CACHE_TASK_TAG_INVALID: { status: 400, params: ["tags"] },
  /** An error page template over the byte limit; status names the page (404/503 for platform pages). */
  ERROR_PAGE_TOO_LARGE: { status: 400, params: ["status", "limit"] },
  /** Turning the PURGE method on needs a key (cacheSettings.purgeMethod.key). */
  PURGE_KEY_REQUIRED: { status: 400, params: [] },
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
  /** The ports of a cluster's layer-4 applications (ranges counted in full) exceed `limit`. */
  L4_PORT_LIMIT: { status: 409, params: ["limit"] },
  /** A port range whose last port is not above the first or that holds more than `max` ports. */
  L4_PORT_RANGE_INVALID: { status: 400, params: ["max"] },
  /** An origin without a port while the application's originPortMode is fixed. */
  L4_ORIGIN_PORT_REQUIRED: { status: 400, params: [] },
  /** TLS termination on a UDP application. */
  L4_TLS_UNSUPPORTED: { status: 400, params: [] },
  /** The chosen certificate is not issued yet or has expired. */
  L4_CERTIFICATE_UNAVAILABLE: { status: 400, params: [] },
  /** A port in both the extra HTTP and the extra HTTPS ports of a cluster. */
  LISTEN_PORT_CONFLICT: { status: 400, params: ["port"] },
  /** An extra listener port inside a port pool of the cluster ("from-to/protocol"). */
  LISTEN_PORT_IN_POOL: { status: 400, params: ["port", "pools"] },
  /** A listener port that sites of the cluster still use (first 5 names). */
  LISTEN_PORT_IN_USE: { status: 409, params: ["port", "sites"] },
  /** A site port that is not an HTTP (or HTTPS) listener port of its cluster. */
  SITE_PORT_UNAVAILABLE: { status: 400, params: ["port"] },
  /** A site that would be served on no port. */
  SITE_PORTS_EMPTY: { status: 400, params: [] },
  /** An HTTPS port other than 443 for a site without a certificate. */
  SITE_HTTPS_PORT_NEEDS_CERTIFICATE: { status: 400, params: ["port"] },
  /** The HTTPS redirect's port is neither 443 nor an HTTPS port of the site. */
  HTTPS_REDIRECT_PORT_INVALID: { status: 400, params: ["port"] },
  /** Domains excluded from the HTTPS redirect that the site does not have. */
  HTTPS_REDIRECT_DOMAIN_INVALID: { status: 400, params: ["domains"] },
  /** An access authentication rule's scope names a domain the site does not have. */
  AUTH_DOMAIN_UNKNOWN: { status: 400, params: ["domain"] },
  /** A new Basic user (or one of a rule that had no users stored) without a password. */
  AUTH_PASSWORD_REQUIRED: { status: 400, params: ["user"] },
  /** A URL authentication rule without a stored primary key needs one. */
  AUTH_KEY_REQUIRED: { status: 400, params: [] },
  AUTH_RULE_NOT_FOUND: { status: 404, params: [] },
  /** Only URL authentication rules (kinds A-D) sign URLs. */
  AUTH_RULE_NOT_URL: { status: 400, params: [] },
  /** A URL to sign that is not a path or an http(s) URL of one of the site's domains. */
  AUTH_SIGN_URL_INVALID: { status: 400, params: [] },
  /** A signed URL can be valid for at most the rule's validity (seconds). */
  AUTH_SIGN_VALIDITY: { status: 400, params: ["max"] },
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
  session_ticket_keys_rotated: { params: [], en: "TLS session ticket keys rotated" },
  site_waf_updated: { params: ["site"], en: "OWASP CRS of {site} updated" },
  site_error_pages_updated: { params: ["site"], en: "error pages of {site} updated" },
  site_maintenance_updated: { params: ["site"], en: "maintenance of {site} updated" },
  site_auth_updated: { params: ["site"], en: "access authentication of {site} updated" },
  cluster_cache_updated: { params: [], en: "cache zone updated" },
  node_cache_updated: { params: ["node"], en: "cache size of node {node} updated" },
  error_pages_updated: { params: [], en: "platform error pages updated" },
  recompiled: { params: [], en: "configuration recompiled after an upgrade" },
  l4_app_created: { params: ["app"], en: "L4 application {app} created" },
  l4_app_updated: { params: ["app"], en: "L4 application {app} updated" },
  l4_app_deleted: { params: ["app"], en: "L4 application {app} deleted" },
  listen_ports_updated: { params: [], en: "listener ports updated" },
  client_ip_updated: { params: [], en: "client address setting updated" },
  unknown_hosts_updated: { params: [], en: "unknown host settings updated" },
} as const satisfies Record<string, { params: readonly string[]; en: string }>;

export type RevisionReasonCode = keyof typeof revisionReasonDefs;

export const revisionReasonCodes = Object.keys(revisionReasonDefs) as RevisionReasonCode[];

export type ReasonParams = Record<string, string | number>;

export function reasonText(code: RevisionReasonCode, params: ReasonParams): string {
  return revisionReasonDefs[code].en.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(params[key] ?? ""),
  );
}
