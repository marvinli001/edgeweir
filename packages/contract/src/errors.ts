/**
 * Stable error codes returned by the API (the oRPC error `code`, with the
 * listed HTTP status). Clients localize them by code; `params` name the fields
 * of the error's `data` that the message interpolates. Unknown codes fall back
 * to the server's English `message`.
 */
export const errorDefs = {
  SETUP_DONE: { status: 403, params: [] },
  SETUP_TOKEN_INVALID: { status: 403, params: [] },
  NOT_A_MEMBER: { status: 403, params: [] },
  ORG_ADMIN_REQUIRED: { status: 403, params: [] },
  OWNER_REQUIRED: { status: 403, params: [] },
  TWO_FACTOR_REQUIRED: { status: 403, params: [] },
  USER_DISABLED: { status: 403, params: [] },
  CLUSTER_SELECTION_FORBIDDEN: { status: 403, params: [] },
  CLUSTER_NOT_FOUND: { status: 404, params: [] },
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
  DOMAIN_IN_USE: { status: 409, params: ["domains"] },
  REVISION_NOT_FOUND: { status: 404, params: [] },
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
  cluster_created: { params: ["cluster"], en: "cluster {cluster} created" },
  site_created: { params: ["site"], en: "site {site} created" },
  site_updated: { params: ["site"], en: "site {site} updated" },
  site_deleted: { params: ["site"], en: "site {site} deleted" },
  site_purged: { params: ["site"], en: "site {site} purged" },
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
