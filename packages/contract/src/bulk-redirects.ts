import { oc } from "@orpc/contract";
import * as z from "zod";
import { redirectStatusCode, staticRedirectTarget } from "./rules";
import { uuid } from "./schemas";

/** Entries of a site's bulk redirect table at most. */
export const BULK_REDIRECT_LIMIT = 5000;
/** Longest source and target (UTF-8 bytes). */
export const BULK_REDIRECT_SOURCE_MAX_BYTES = 512;
export const BULK_REDIRECT_TARGET_MAX_BYTES = 1024;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LOWERCASE_HOST_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)*${LABEL}$`);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Splits a bulk redirect source into its host ("" for every domain of the
 * site) and path, or returns null when it is neither "/path" nor
 * "host/path" with a lowercase host name.
 */
export function bulkRedirectSourceParts(source: string): { host: string; path: string } | null {
  if (
    utf8Bytes(source) < 2 ||
    utf8Bytes(source) > BULK_REDIRECT_SOURCE_MAX_BYTES ||
    /[\s?]/.test(source) ||
    [...source].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return null;
  const slash = source.indexOf("/");
  if (slash < 0) return null;
  const host = source.slice(0, slash);
  if (host !== "" && !LOWERCASE_HOST_RE.test(host)) return null;
  return { host, path: source.slice(slash) };
}

/**
 * One exact-match redirect. The source is "/path" (every domain of the
 * site) or "host/path" (that domain only), 2 to 512 bytes without control
 * characters, whitespace or "?"; nodes match it against the request's Host
 * and normalized path, "host/path" first. The target is a static redirect
 * target of at most 1024 bytes.
 */
export const bulkRedirect = z.object({
  source: z
    .string()
    .refine((source) => bulkRedirectSourceParts(source) !== null, "invalid redirect source"),
  target: z
    .string()
    .refine(
      (target) =>
        utf8Bytes(target) <= BULK_REDIRECT_TARGET_MAX_BYTES && staticRedirectTarget(target),
      "invalid redirect target",
    ),
  statusCode: redirectStatusCode,
  /** Append the request's query string to the target. */
  preserveQuery: z.boolean().default(false),
});

export const bulkRedirectDto = z.object({
  source: z.string(),
  target: z.string(),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]),
  preserveQuery: z.boolean(),
});

/** Replaces the table; sources are unique, the hosts of "host/path" sources the site's domains. */
export const bulkRedirectsInput = z.object({
  id: uuid,
  redirects: z
    .array(bulkRedirect)
    .max(BULK_REDIRECT_LIMIT)
    .refine(
      (redirects) =>
        new Set(redirects.map((redirect) => redirect.source)).size === redirects.length,
      "sources must be unique",
    ),
});

/** A site's bulk redirects (members read; owners and admins replace them). */
export const bulkRedirectsContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/bulk-redirects", tags: ["rules"] })
    .input(z.object({ id: uuid }))
    .output(z.array(bulkRedirectDto)),
  /** Replaces every entry and publishes the site's cluster (feature rules-v2). */
  save: oc
    .route({ method: "PUT", path: "/sites/{id}/bulk-redirects", tags: ["rules"] })
    .input(bulkRedirectsInput)
    .output(z.array(bulkRedirectDto)),
};

export type BulkRedirect = z.infer<typeof bulkRedirectDto>;
export type BulkRedirectInput = z.input<typeof bulkRedirect>;
export type BulkRedirectsInput = z.infer<typeof bulkRedirectsInput>;
