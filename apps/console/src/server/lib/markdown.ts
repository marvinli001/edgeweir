import type { MarkdownModel } from "@edgeweir/config-compiler";
import { MARKDOWN_DEFAULTS, type MarkdownSettings, markdownSettings } from "@edgeweir/contract";

/** Prefixes sorted and unique, as nodes expect them. */
function normalize(list: string[]): string[] {
  return [...new Set(list)].sort();
}

/**
 * A site's stored Markdown for Agents settings (site.markdown) with the
 * defaults filled in; `{}` (never saved) is the defaults, off.
 */
export function readMarkdown(value: unknown): MarkdownSettings {
  const stored = value && typeof value === "object" ? value : {};
  const parsed = markdownSettings.safeParse({ ...MARKDOWN_DEFAULTS, ...stored });
  if (!parsed.success) return { ...MARKDOWN_DEFAULTS, includePrefixes: [], excludePrefixes: [] };
  return {
    enabled: parsed.data.enabled,
    includePrefixes: normalize(parsed.data.includePrefixes),
    excludePrefixes: normalize(parsed.data.excludePrefixes),
  };
}

/** What nodes get (config.proto Markdown): nothing while conversion is off. */
export function markdownModel(value: unknown): MarkdownModel | undefined {
  const { enabled, includePrefixes, excludePrefixes } = readMarkdown(value);
  return enabled ? { includePrefixes, excludePrefixes } : undefined;
}
