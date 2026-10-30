/**
 * Markdown for Agents (feature markdown-v1): for GET and HEAD requests whose
 * Accept names text/markdown, nodes convert a site's HTML responses to
 * Markdown (YAML frontmatter from the meta tags, the main content, JSON-LD
 * at the end) with Content-Type text/markdown, X-Markdown-Tokens and
 * Vary: Accept. HTML over 6 MiB, other types and failed conversions pass
 * unchanged. The Markdown is cached apart from the HTML and purged with it.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { analyticsRange, uuid } from "./schemas";

/** Prefix lists hold at most this many entries. */
const MAX_MARKDOWN_PREFIXES = 32;
/** A prefix is at most this many bytes. */
const MAX_MARKDOWN_PREFIX_LENGTH = 256;

/** What a site starts with (off, every path). */
export const MARKDOWN_DEFAULTS = {
  enabled: false,
  includePrefixes: [] as string[],
  excludePrefixes: [] as string[],
};

/** "/" and printable ASCII without spaces (the node's check). */
const prefix = z
  .string()
  .max(MAX_MARKDOWN_PREFIX_LENGTH)
  .regex(/^\/[\x21-\x7e]*$/, "a path prefix starting with /");

/** Stored sorted and unique. */
const prefixes = z.array(prefix).max(MAX_MARKDOWN_PREFIXES);

export const markdownSettings = z.object({
  enabled: z.boolean(),
  /** Paths converted; empty means every path. */
  includePrefixes: prefixes,
  /** Paths never converted, checked after includePrefixes. */
  excludePrefixes: prefixes,
});
const markdownInput = markdownSettings.extend({ id: uuid });

/** Markdown responses over a range. */
const markdownStatsInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
});
const markdownStats = z.object({
  /** Complete 200 responses to GETs served as Markdown converted from HTML (cache hits included). */
  responses: z.number(),
  /** Active nodes of the site's cluster that do not convert (no markdown-v1). */
  unsupportedNodes: z.number().int(),
});

const idParam = z.object({ id: uuid });

/** A site's Markdown for Agents. */
export const markdownContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/markdown", tags: ["sites"] })
    .input(idParam)
    .output(markdownSettings),
  /** Replaces the settings; publishes the site's cluster when nodes see a change (hot update). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/markdown", tags: ["sites"] })
    .input(markdownInput)
    .output(markdownSettings),
  stats: oc
    .route({ method: "GET", path: "/sites/{id}/markdown/stats", tags: ["sites"] })
    .input(markdownStatsInput)
    .output(markdownStats),
};

export type MarkdownSettings = z.infer<typeof markdownSettings>;
export type MarkdownStats = z.infer<typeof markdownStats>;
