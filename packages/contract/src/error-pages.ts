import {
  canonicalCidr,
  RULES_V3_PLACEHOLDERS,
  usesRulesV3Placeholders,
} from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { expectedUpdatedAt, isoDateTime, pathPrefix, uuid } from "./schemas";

/**
 * Error pages replace the nodes' built-in pages (feature error-pages-v1):
 * a site's pages for the responses its nodes generate (403 denied, 429 rate
 * limited, 502/503/504 origin unavailable or failing), optionally also for
 * origin responses with those statuses, and the platform's pages for hosts
 * no site serves and for disabled sites.
 */
export const ERROR_PAGE_STATUSES = [400, 401, 403, 404, 405, 410, 429, 500, 502, 503, 504] as const;
/** Statuses of error-pages-v1; the others, the classes, redirects and replacement statuses need site-content-v1. */
export const ERROR_PAGES_V1_STATUSES = [403, 429, 502, 503, 504] as const;
/** Pages for every 4xx or 5xx status without a page of its own. */
export const ERROR_PAGE_CLASSES = ["4xx", "5xx"] as const;
/** Longest redirect URL of an error page. */
export const ERROR_PAGE_REDIRECT_MAX = 2048;
/** Placeholders of an error page's redirect URL, replaced with percent-encoded values. */
export const ERROR_PAGE_REDIRECT_PLACEHOLDERS = ["{{status}}", "{{request_id}}"] as const;
/** Templates are at most 64 KiB of UTF-8. */
export const ERROR_PAGE_MAX_BYTES = 65_536;
/** Placeholders nodes replace with HTML-escaped values; any other text is sent as it is. */
export const ERROR_PAGE_PLACEHOLDERS = [
  "{{status}}",
  "{{request_id}}",
  "{{client_ip}}",
  "{{host}}",
  ...RULES_V3_PLACEHOLDERS,
] as const;
export { RULES_V3_PLACEHOLDERS, usesRulesV3Placeholders };
/** Statuses of the platform pages (the ERROR_PAGE_TOO_LARGE status of each). */
export const PLATFORM_ERROR_PAGE_STATUSES = {
  unknownHost: 404,
  siteDisabled: 503,
} as const;

/** Size of a template as nodes receive it (UTF-8), which the limit applies to. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const errorPageStatus = z.union([
  z.literal(ERROR_PAGE_STATUSES),
  z.enum(ERROR_PAGE_CLASSES),
]);

/**
 * An absolute redirect URL as nodes and the console both take it: http(s),
 * "//", a host that is a dotted-quad IPv4 address, a DNS name whose last
 * label starts with a letter or a bracketed IPv6 literal (no user
 * information, no escapes), an optional port, then a path, query or
 * fragment. URL parsers repair other shapes differently (WHATWG reads
 * "https:example.com" as https://example.com/ and "1.08" as an invalid
 * IPv4 address, Go reads them as an opaque URL and a host name).
 */
const ABSOLUTE_REDIRECT =
  /^https?:\/\/(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(?:[A-Za-z0-9-]+\.)*[A-Za-z][A-Za-z0-9-]*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:[/?#][\x21-\x7e]*)?$/;

/**
 * Whether a redirect URL is valid: an absolute http(s) URL without user
 * information, or a path starting with a single "/", 1-2048 printable ASCII
 * characters without spaces, whose only placeholders are {{status}} and
 * {{request_id}}, and whose "%" each start an escape of two hex digits.
 * edgeweir-node (internal/configir validErrorRedirect) applies the same
 * rule; shared vectors: packages/contract/test/fixtures/error_redirect_vectors.json.
 */
export function validErrorRedirect(url: string): boolean {
  if (url.length > ERROR_PAGE_REDIRECT_MAX || !/^[\x21-\x7e]+$/.test(url)) return false;
  const bare = url.replaceAll("{{status}}", "0").replaceAll("{{request_id}}", "0");
  if (bare.includes("{{") || bare.includes("}}") || bare.includes("\\")) return false;
  if (/%(?![0-9A-Fa-f]{2})/.test(bare)) return false;
  if (bare.startsWith("/")) return !bare.startsWith("//");
  if (!ABSOLUTE_REDIRECT.test(bare)) return false;
  try {
    const parsed = new URL(bare);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export const errorPage = z.object({
  status: errorPageStatus,
  /** HTML template; empty for a redirect page. */
  template: z.string(),
  /** Redirect with 302 to this URL instead of a template; "" for a template page. */
  redirectUrl: z.string(),
  /** Status a template page is sent with; 0 keeps the response's. */
  responseStatus: z.number().int(),
});

export const siteErrorPages = z.object({
  siteId: uuid,
  /** At most one page per status, sorted by status. */
  pages: z.array(errorPage),
  /** Also replace origin responses whose status has a page. */
  interceptOriginErrors: z.boolean(),
  /** Null until the pages were first saved. */
  updatedAt: isoDateTime.nullable(),
});

/** Replaces every page; a status without a page uses the built-in page. */
export const siteErrorPagesInput = z.object({
  id: uuid,
  /** Templates of 1 to 65536 bytes (UTF-8); larger ones fail with ERROR_PAGE_TOO_LARGE. */
  pages: z
    .array(
      z
        .object({
          status: errorPageStatus,
          template: z.string().default(""),
          redirectUrl: z.string().trim().default(""),
          responseStatus: z
            .number()
            .int()
            .refine((n) => n === 0 || (n >= 200 && n <= 599), "200-599, or 0 to keep the status")
            .default(0),
        })
        .superRefine((page, ctx) => {
          if (page.redirectUrl) {
            if (!validErrorRedirect(page.redirectUrl))
              ctx.addIssue({
                code: "custom",
                message: "invalid redirect URL",
                path: ["redirectUrl"],
              });
            if (page.template)
              ctx.addIssue({
                code: "custom",
                message: "a template or a redirect URL, not both",
                path: ["template"],
              });
            if (page.responseStatus)
              ctx.addIssue({
                code: "custom",
                message: "redirect pages are sent with 302",
                path: ["responseStatus"],
              });
          } else if (!page.template) {
            ctx.addIssue({
              code: "custom",
              message: "a template or a redirect URL",
              path: ["template"],
            });
          }
        }),
    )
    .max(ERROR_PAGE_STATUSES.length + ERROR_PAGE_CLASSES.length)
    .refine((pages) => new Set(pages.map((page) => page.status)).size === pages.length, {
      message: "one page per status",
    }),
  interceptOriginErrors: z.boolean().default(false),
  expectedUpdatedAt,
});

/**
 * The platform's pages (system setting `error_pages`); an empty template
 * uses the nodes' built-in page. Same size limit as site pages.
 */
export const platformErrorPages = z.object({
  /** Hosts no site serves (404). */
  unknownHost: z.string().default(""),
  /** Hosts of disabled sites (503). */
  siteDisabled: z.string().default(""),
});

const idParam = z.object({ id: uuid });

/**
 * A site's maintenance mode (site-content-v1): 503 with the page (empty: the
 * nodes' built-in maintenance page) and Retry-After when set, except for
 * requests from allowedCidrs or to paths under allowedPathPrefixes and
 * HTTP-01 requests for the origin; nothing is served from the cache. The
 * settings are kept while off.
 */
export const siteMaintenance = z.object({
  siteId: uuid,
  enabled: z.boolean(),
  template: z.string(),
  retryAfterSeconds: z.number().int(),
  allowedCidrs: z.array(z.string()),
  allowedPathPrefixes: z.array(z.string()),
  /** Null until the settings were first saved. */
  updatedAt: isoDateTime.nullable(),
});

export const MAINTENANCE_MAX_CIDRS = 64;
export const MAINTENANCE_MAX_PREFIXES = 32;

export const siteMaintenanceInput = z.object({
  id: uuid,
  enabled: z.boolean(),
  /** 0-65536 bytes (UTF-8), with the error page placeholders; larger fails with ERROR_PAGE_TOO_LARGE. */
  template: z.string().default(""),
  retryAfterSeconds: z.number().int().min(0).max(86_400).default(0),
  /**
   * Addresses or CIDRs, normalized as IP list entries are: an IPv4-mapped
   * IPv6 prefix becomes IPv4 (nodes look IPv4 clients up as IPv4), and one
   * shorter than /96 is refused as ambiguous.
   */
  allowedCidrs: z
    .array(
      z
        .string()
        .trim()
        .max(64)
        .transform((value, ctx) => {
          try {
            return canonicalCidr(value);
          } catch {
            ctx.addIssue({ code: "custom", message: "invalid CIDR", input: value });
            return z.NEVER;
          }
        }),
    )
    .max(MAINTENANCE_MAX_CIDRS)
    .default([]),
  allowedPathPrefixes: z
    .array(
      pathPrefix
        .refine(
          (value) => !/[?#]/.test(value) && [...value].every((c) => c >= " " && c !== "\x7f"),
          "no query, fragment or control characters",
        )
        // Nodes count bytes of UTF-8, not characters.
        .refine((value) => utf8Bytes(value) <= 1024, "at most 1024 bytes"),
    )
    .max(MAINTENANCE_MAX_PREFIXES)
    .default([]),
  expectedUpdatedAt,
});

/** A site's maintenance mode. */
export const maintenanceContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/maintenance", tags: ["sites"] })
    .input(idParam)
    .output(siteMaintenance),
  /** Publishes the site's cluster (hot update). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/maintenance", tags: ["sites"] })
    .input(siteMaintenanceInput)
    .output(siteMaintenance),
};

/** A site's error pages. */
export const errorPagesContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/error-pages", tags: ["sites"] })
    .input(idParam)
    .output(siteErrorPages),
  /** Publishes the site's cluster. */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/error-pages", tags: ["sites"] })
    .input(siteErrorPagesInput)
    .output(siteErrorPages),
};

export type ErrorPageStatus = z.infer<typeof errorPageStatus>;
export type SiteMaintenance = z.infer<typeof siteMaintenance>;
export type SiteMaintenanceInput = z.infer<typeof siteMaintenanceInput>;
export type ErrorPage = z.infer<typeof errorPage>;
export type SiteErrorPages = z.infer<typeof siteErrorPages>;
export type SiteErrorPagesInput = z.infer<typeof siteErrorPagesInput>;
export type PlatformErrorPages = z.infer<typeof platformErrorPages>;
