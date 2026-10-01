import { oc } from "@orpc/contract";
import * as z from "zod";
import { expectedUpdatedAt, isoDateTime, uuid } from "./schemas";

/**
 * Error pages replace the nodes' built-in pages (feature error-pages-v1):
 * a site's pages for the responses its nodes generate (403 denied, 429 rate
 * limited, 502/503/504 origin unavailable or failing), optionally also for
 * origin responses with those statuses, and the platform's pages for hosts
 * no site serves and for disabled or suspended sites.
 */
export const ERROR_PAGE_STATUSES = [403, 429, 502, 503, 504] as const;
/** Templates are at most 64 KiB of UTF-8. */
export const ERROR_PAGE_MAX_BYTES = 65_536;
/** Placeholders nodes replace with HTML-escaped values; any other text is sent as it is. */
export const ERROR_PAGE_PLACEHOLDERS = [
  "{{status}}",
  "{{request_id}}",
  "{{client_ip}}",
  "{{host}}",
] as const;
/** Statuses of the platform pages (the ERROR_PAGE_TOO_LARGE status of each). */
export const PLATFORM_ERROR_PAGE_STATUSES = {
  unknownHost: 404,
  siteDisabled: 503,
  siteSuspended: 503,
} as const;

/** Size of a template as nodes receive it (UTF-8), which the limit applies to. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const errorPageStatus = z.literal(ERROR_PAGE_STATUSES);

export const errorPage = z.object({ status: errorPageStatus, template: z.string() });

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
    .array(z.object({ status: errorPageStatus, template: z.string().min(1) }))
    .max(ERROR_PAGE_STATUSES.length)
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
  /** Hosts of sites the platform suspended (503). */
  siteSuspended: z.string().default(""),
});

const idParam = z.object({ id: uuid });

/** A site's error pages (members read; owners and admins change them). */
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

export type ErrorPageStatus = (typeof ERROR_PAGE_STATUSES)[number];
export type ErrorPage = z.infer<typeof errorPage>;
export type SiteErrorPages = z.infer<typeof siteErrorPages>;
export type SiteErrorPagesInput = z.infer<typeof siteErrorPagesInput>;
export type PlatformErrorPages = z.infer<typeof platformErrorPages>;
