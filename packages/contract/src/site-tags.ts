import { oc } from "@orpc/contract";
import * as z from "zod";

// Not from ./schemas: the site schema there imports this module.
const uuid = z.uuid();

/** Tags a site carries at most. */
export const MAX_SITE_TAGS = 10;
/** Characters (code points) of a tag name at most. */
export const TAG_NAME_MAX = 32;
/** Sites one batch operation changes at most (also a whole-site purge task's). */
export const MAX_BATCH_SITES = 100;

/** A tag name as stored: NFC-normalized, without leading and trailing white space. */
export const normalizeTagName = (raw: string) => raw.normalize("NFC").trim();
/** What makes two tag names the same tag: the normalized name in lower case. */
export const tagKey = (raw: string) => normalizeTagName(raw).toLowerCase();

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A tag name: 1-32 characters after trimming, no control characters. */
export const tagName = z
  .string()
  .max(256)
  .transform(normalizeTagName)
  .refine((name) => name.length > 0, "empty tag")
  .refine((name) => [...name].length <= TAG_NAME_MAX, `at most ${TAG_NAME_MAX} characters`)
  .refine((name) => !CONTROL_RE.test(name), "control characters are not allowed");

/** Tag names without the ones that repeat an earlier one regardless of case. */
export function uniqueTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = tagKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A site's tags as written: at most 10, repeats (any case) dropped. */
export const siteTagNames = z.array(tagName).max(MAX_SITE_TAGS).transform(uniqueTagNames);

/** A tag on a site. */
export const siteTagRef = z.object({ id: uuid, name: z.string() });

/** A tag with the number of sites that carry it. */
export const siteTag = siteTagRef.extend({ sites: z.number().int() });

/**
 * A list in a query string: `name[]=a&name[]=b` (bracket notation), or one
 * value as `name=a`.
 */
export const queryList = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item)])
    .transform((value) => (Array.isArray(value) ? value : [value]) as z.output<T>[]);

/** Sites of a batch operation: 1-100, repeats dropped. */
export const batchSiteIds = z
  .array(uuid)
  .min(1)
  .max(MAX_BATCH_SITES)
  .transform((ids) => [...new Set(ids)]);

export const siteTagsInput = z.object({ id: uuid, tags: siteTagNames });

export const batchSetEnabledInput = z.object({ ids: batchSiteIds, enabled: z.boolean() });

/** Adds and removes tags (names, any case) on every site; a site keeps at most 10 (SITE_TAG_LIMIT). */
export const batchTagsInput = z
  .object({
    ids: batchSiteIds,
    add: z.array(tagName).max(MAX_SITE_TAGS).default([]).transform(uniqueTagNames),
    remove: z.array(tagName).max(MAX_SITE_TAGS).default([]).transform(uniqueTagNames),
  })
  .refine((input) => input.add.length + input.remove.length > 0, {
    message: "nothing to change",
    path: ["add"],
  })
  .refine(
    (input) =>
      !input.add.some((name) => input.remove.some((other) => tagKey(other) === tagKey(name))),
    { message: "a tag cannot be added and removed at once", path: ["remove"] },
  );

/** What a batch operation changed: the sites, and each cluster's revision once. */
export const batchResult = z.object({
  /** The sites it changed (others were already as asked). */
  changed: z.array(z.object({ id: uuid, name: z.string() })),
  /** The revision of each cluster it published, one per cluster. */
  revisions: z.array(
    z.object({ clusterId: uuid, revision: z.number().int(), created: z.boolean() }),
  ),
});

export const siteTagsContract = {
  /** Every tag with the number of its sites, by name. */
  list: oc.route({ method: "GET", path: "/site-tags", tags: ["sites"] }).output(z.array(siteTag)),
  /**
   * Renames a tag on every site. A name another tag has (any case) merges
   * the two: its sites get that tag and this one is deleted.
   */
  rename: oc
    .route({ method: "PATCH", path: "/site-tags/{id}", tags: ["sites"] })
    .input(z.object({ id: uuid, name: tagName }))
    .output(siteTag),
  /** Deletes a tag and takes it off every site. */
  delete: oc
    .route({ method: "DELETE", path: "/site-tags/{id}", tags: ["sites"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
};

export type SiteTag = z.infer<typeof siteTag>;
export type SiteTagRef = z.infer<typeof siteTagRef>;
export type BatchResult = z.infer<typeof batchResult>;
export type BatchTagsInput = z.output<typeof batchTagsInput>;
