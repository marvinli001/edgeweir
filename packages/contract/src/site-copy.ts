import { oc } from "@orpc/contract";
import * as z from "zod";
import { siteDomains } from "./domains";
import { revision, siteMutationResult, uuid } from "./schemas";
import { MAX_BATCH_SITES, queryList, siteTagNames } from "./site-tags";

/**
 * The parts of a site's settings one copy can take to other sites (ADR-0042),
 * in the order the console lists them:
 * - cacheRules: the cache rules;
 * - cacheKey: the cache key and slicing (Range requests);
 * - cacheTag: forwarding Cache-Tag to clients;
 * - compression: gzip, Brotli and Zstandard with their levels, sizes and types;
 * - https: the HTTPS options without the certificates (redirect, HSTS, TLS
 *   versions and ciphers, HTTP/2 and HTTP/3, OCSP stapling, client
 *   certificates); the target keeps its certificates and the domains its
 *   redirect leaves alone;
 * - rules: the site's rules (every phase);
 * - bulkRedirects: the bulk redirect table;
 * - errorPages: the error pages and whether they replace origin errors;
 * - waf: the OWASP CRS settings and exclusions;
 * - protection: Under Attack, the CC policy and the challenge settings;
 * - accessControl: site lists, hotlink, user agents, CORS, regions,
 *   WebSocket origins and security headers;
 * - authRules: the access authentication rules, their secrets sealed anew
 *   for the target;
 * - originSettings: the origin pool settings without the origins;
 * - logs: the access log sample rate and options (blocked requests, the
 *   query string, request headers, the peer address) and JA4 logging;
 * - imageConvert: the WebP / AVIF conversion settings.
 */
export const SITE_COPY_PARTS = [
  "cacheRules",
  "cacheKey",
  "cacheTag",
  "compression",
  "https",
  "rules",
  "bulkRedirects",
  "errorPages",
  "waf",
  "protection",
  "accessControl",
  "authRules",
  "originSettings",
  "logs",
  "imageConvert",
] as const;
export const siteCopyPart = z.enum(SITE_COPY_PARTS);
export type SiteCopyPart = z.infer<typeof siteCopyPart>;

/** Parts that are lists: their change is told as the number of items before and after. */
export const SITE_COPY_LIST_PARTS: readonly SiteCopyPart[] = [
  "cacheRules",
  "rules",
  "bulkRedirects",
  "errorPages",
  "authRules",
];

const parts = z
  .array(siteCopyPart)
  .min(1)
  .max(SITE_COPY_PARTS.length)
  .transform((list) => SITE_COPY_PARTS.filter((part) => list.includes(part)));

const targets = z
  .array(uuid)
  .min(1)
  .max(MAX_BATCH_SITES)
  .transform((ids) => [...new Set(ids)]);

const notSelf = <T extends { id: string; targetIds: string[] }>(input: T) =>
  !input.targetIds.includes(input.id);
const selfIssue = { message: "a site cannot copy to itself", path: ["targetIds"] };

/** Copies the parts of site `id` to every target, one transaction each. */
export const siteCopyInput = z
  .object({ id: uuid, targetIds: targets, parts })
  .refine(notSelf, selfIssue);

/** The same in a query string: `targetIds[]=…&parts[]=…`. */
export const siteCopyPreviewInput = z
  .object({
    id: uuid,
    targetIds: queryList(uuid).pipe(targets),
    parts: queryList(siteCopyPart).pipe(parts),
  })
  .refine(notSelf, selfIssue);

/** Why a target failed: an API error code with its parameters (and the English message). */
export const siteCopyError = z.object({
  code: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.number()])),
});

/** What copying a part would change on a target. */
export const siteCopyChange = z.object({
  part: siteCopyPart,
  changed: z.boolean(),
  /** List parts: the items the target has now and would have. */
  before: z.number().int().nullable(),
  after: z.number().int().nullable(),
  /** Other parts: how many of the part's settings would change. */
  fields: z.number().int().nullable(),
});

export const siteCopyPreview = z.object({
  source: z.object({ id: uuid, name: z.string() }),
  targets: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      changes: z.array(siteCopyChange),
      /** Set when the copy would fail on this target: nothing of it would change. */
      error: siteCopyError.nullable(),
    }),
  ),
});

export const siteCopyResult = z.object({
  targets: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      ok: z.boolean(),
      /** The parts whose settings changed. */
      changed: z.array(siteCopyPart),
      /** The revision of the target's cluster after the copy (null when it failed). */
      revision: revision.nullable(),
      error: siteCopyError.nullable(),
    }),
  ),
});

/** A new site with the source's settings and origins: its own name and domains. */
export const siteCloneInput = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(100).optional(),
  domains: siteDomains,
  /** Omitted: the source's tags. */
  tags: siteTagNames.optional(),
});

export const siteCopyContract = {
  /**
   * What copying the parts would change on each target, and the targets on
   * which it would fail (a dry run: nothing is saved).
   */
  copySettingsPreview: oc
    .route({ method: "GET", path: "/sites/{id}/copy-settings", tags: ["sites"] })
    .input(siteCopyPreviewInput)
    .output(siteCopyPreview),
  /**
   * Copies the parts to each target in its own transaction: a target that
   * lacks what the settings name (an origin group, a domain, a
   * certificate…) fails with the reason and keeps its settings, the others
   * are saved, published and audited (site.settings_copied).
   */
  copySettings: oc
    .route({ method: "POST", path: "/sites/{id}/copy-settings", tags: ["sites"] })
    .input(siteCopyInput)
    .output(siteCopyResult),
  /**
   * Creates a site in the source's cluster with every setting of the source,
   * its origins and its tags; certificates, which name the source's domains,
   * stay behind (with them the settings that need one).
   */
  clone: oc
    .route({ method: "POST", path: "/sites/{id}/clone", tags: ["sites"], successStatus: 201 })
    .input(siteCloneInput)
    .output(siteMutationResult),
};

export type SiteCopyInput = z.output<typeof siteCopyInput>;
export type SiteCopyPreview = z.infer<typeof siteCopyPreview>;
export type SiteCopyResult = z.infer<typeof siteCopyResult>;
export type SiteCopyChange = z.infer<typeof siteCopyChange>;
export type SiteCopyError = z.infer<typeof siteCopyError>;
export type SiteCloneInput = z.output<typeof siteCloneInput>;
