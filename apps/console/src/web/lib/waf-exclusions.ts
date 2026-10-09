import {
  crsDetectionRule,
  type SiteWaf,
  validWafExclusionPath,
  WAF_MAX_EXCLUSION_TARGETS,
  WAF_MAX_EXCLUSIONS,
  WAF_TARGET_RE,
  wafExclusion,
} from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

/** A CRS exclusion as the site's settings hold it (the API's shape, every field present). */
export type Exclusion = SiteWaf["exclusions"][number];

/** Ascending and without duplicates, as the API stores rule ids. */
const sortedIds = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

/** "942100, 920350 941100" → sorted unique ids, or null when a token is not a six-digit id. */
export function parseRuleIds(value: string): number[] | null {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (!tokens.every((token) => /^\d{6}$/.test(token))) return null;
  return sortedIds(tokens.map(Number));
}

/** "ARGS:q, REQUEST_COOKIES:session" → the targets in their order, without duplicates. */
export const parseTargets = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];

/** An entry for every path that does not narrow the rules to targets: what nodes before waf-v2 run. */
export const isSiteWide = (entry: Exclusion) => entry.path === "" && entry.targets.length === 0;

/** Whether the cluster's nodes need waf-v2 for the entry (a path or targets). */
export const needsWafV2 = (entry: Exclusion) => !isSiteWide(entry);

/** The rule ids every request skips: those of the first site-wide entry. */
export function siteWideRuleIds(list: readonly Exclusion[]): number[] {
  return list.find(isSiteWide)?.ruleIds ?? [];
}

/**
 * The list with the first site-wide entry's rule ids replaced (sorted, unique); without ids the
 * entry goes, and a list without one gets it first.
 */
export function withSiteWideRuleIds(list: readonly Exclusion[], ids: readonly number[]) {
  const ruleIds = sortedIds(ids);
  const index = list.findIndex(isSiteWide);
  if (index < 0)
    return ruleIds.length ? [{ path: "", exact: false, ruleIds, targets: [] }, ...list] : [...list];
  return ruleIds.length
    ? list.map((entry, i) => (i === index ? { ...entry, ruleIds } : entry))
    : list.filter((_, i) => i !== index);
}

/** Entries that cover the same requests and targets (a prefix and an exact path differ). */
const sameScope = (a: Exclusion, b: Exclusion) =>
  a.path === b.path &&
  (a.path === "" || a.exact === b.exact) &&
  a.targets.length === b.targets.length &&
  a.targets.every((target) => b.targets.includes(target));

/**
 * The list with `entry` added: its rule ids join an entry of the same path, match and targets,
 * else it is appended. Rule ids end up sorted and unique; a site-wide entry is never exact.
 */
export function addExclusion(list: readonly Exclusion[], entry: Exclusion): Exclusion[] {
  const added: Exclusion = {
    path: entry.path,
    exact: entry.path === "" ? false : entry.exact,
    ruleIds: sortedIds(entry.ruleIds),
    targets: [...new Set(entry.targets)],
  };
  const index = list.findIndex((existing) => sameScope(existing, added));
  if (index < 0) return [...list, added];
  return list.map((existing, i) =>
    i === index
      ? { ...existing, ruleIds: sortedIds([...existing.ruleIds, ...added.ruleIds]) }
      : existing,
  );
}

/** Rule ids that cannot be excluded (they set up or evaluate the CRS; the server refuses them). */
export const unexcludable = (ids: readonly number[]) => ids.filter((id) => !crsDetectionRule(id));

/**
 * The path of a logged request as an exclusion path: without its query and fragment, or "" when
 * what is left is not one (no leading "/", spaces or control characters).
 */
export function exclusionPath(requestPath: string): string {
  const path = requestPath.split(/[?#]/, 1)[0] ?? "";
  return path.startsWith("/") && validWafExclusionPath(path) ? path : "";
}

/** An exclusion as its form holds it: rule ids and targets as typed. */
export interface ExclusionForm {
  path: string;
  exact: boolean;
  ruleIds: string;
  targets: string;
}

export const toExclusionForm = (entry: Exclusion): ExclusionForm => ({
  path: entry.path,
  exact: entry.exact,
  ruleIds: entry.ruleIds.join(", "),
  targets: entry.targets.join(", "),
});

/** The entry a form describes, or the field that is wrong and why (in the console's language). */
export function readExclusionForm(
  form: ExclusionForm,
  { requirePath = false } = {},
):
  | { entry: Exclusion; field?: undefined; message?: undefined }
  | { field: "path" | "ruleIds" | "targets"; message: string } {
  const path = form.path.trim();
  if (requirePath && path === "")
    return { field: "path", message: m.waf_exclusion_path_required() };
  if (!validWafExclusionPath(path))
    return { field: "path", message: m.waf_exclusion_path_invalid() };
  const ruleIds = parseRuleIds(form.ruleIds);
  const idsError = {
    field: "ruleIds",
    message: m.waf_exclusions_invalid({ max: WAF_MAX_EXCLUSIONS }),
  } as const;
  if (!ruleIds?.length || ruleIds.length > WAF_MAX_EXCLUSIONS) return idsError;
  // Setup and evaluation rules would turn blocking off: the server refuses them too.
  const refused = unexcludable(ruleIds);
  if (refused.length)
    return {
      field: "ruleIds",
      message: m.error_waf_rule_not_excludable({ ids: refused.join(", ") }),
    };
  const targets = parseTargets(form.targets);
  if (targets.length > WAF_MAX_EXCLUSION_TARGETS || !targets.every((t) => WAF_TARGET_RE.test(t)))
    return {
      field: "targets",
      message: m.waf_exclusion_targets_invalid({ max: WAF_MAX_EXCLUSION_TARGETS }),
    };
  const entry = { path, exact: path === "" ? false : form.exact, ruleIds, targets };
  const parsed = wafExclusion.safeParse(entry);
  return parsed.success ? { entry: parsed.data } : idsError;
}
