import { ruleHeaderName } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { Executor } from "./revisions";

/**
 * Identity headers of a site's former access authentication rules kept at
 * most (site.auth_identity_headers); the oldest go first. Those of the
 * current rules are kept besides, so a configuration names at most
 * 16 × 8 + 1 + 64 of them (the node takes 256).
 */
export const FORMER_IDENTITY_HEADERS_MAX = 64;

/** A stored rule's kind and settings (select or insert row). */
type RuleLike = { kind: string; settings?: unknown };

/**
 * The request headers a rule sets for the origin, lowercase: x-auth-user for
 * Basic with userHeader, the response headers a forward rule copies.
 */
export function identityHeadersOf(rule: RuleLike): string[] {
  const s = (rule.settings ?? {}) as Record<string, unknown>;
  if (rule.kind === "basic") return s.userHeader === true ? ["x-auth-user"] : [];
  if (rule.kind === "forward" && Array.isArray(s.responseHeaders))
    return s.responseHeaders.filter((h) => typeof h === "string").map((h) => h.toLowerCase());
  return [];
}

/**
 * A site's identity header history after its rules change from `before` to
 * `after`: the names of both appended (unique, in order). Past
 * FORMER_IDENTITY_HEADERS_MAX names no rule of `after` sets, the oldest of
 * those go.
 */
export function nextIdentityHistory(
  history: readonly string[],
  before: readonly RuleLike[],
  after: readonly RuleLike[],
): string[] {
  const out = [...new Set([...history, ...[...before, ...after].flatMap(identityHeadersOf)])];
  const current = new Set(after.flatMap(identityHeadersOf));
  let former = out.filter((name) => !current.has(name)).length;
  return out.filter((name) => {
    if (current.has(name) || former <= FORMER_IDENTITY_HEADERS_MAX) return true;
    former--;
    return false;
  });
}

/** Names nodes take in Site.auth_identity_headers. */
export const MAX_SITE_IDENTITY_HEADERS = 256;

/**
 * The identity headers nodes remove from every request of a site
 * (Site.auth_identity_headers): those of all its rules, disabled ones
 * included, then its history; only names a rule may set (a stored value
 * that is no longer one never reaches nodes, which refuse the whole
 * configuration for it), at most MAX_SITE_IDENTITY_HEADERS.
 */
export function siteIdentityHeaders(history: readonly string[], rules: readonly RuleLike[]) {
  return [...new Set([...rules.flatMap(identityHeadersOf), ...history])]
    .filter((name) => ruleHeaderName.safeParse(name).data === name)
    .slice(0, MAX_SITE_IDENTITY_HEADERS);
}

/** The names of a site's history no rule of `rules` sets (former identity headers), in order. */
export function formerIdentityHeaders(history: readonly string[], rules: readonly RuleLike[]) {
  const current = new Set(rules.flatMap(identityHeadersOf));
  return history.filter((name) => !current.has(name));
}

/**
 * Stores a site's identity header history for a change of its rules (in the
 * change's transaction) and returns it.
 */
export async function retainIdentityHeaders(
  tx: Executor,
  site: { id: string; authIdentityHeaders: string[] },
  before: readonly RuleLike[],
  after: readonly RuleLike[],
): Promise<string[]> {
  const next = nextIdentityHistory(site.authIdentityHeaders, before, after);
  if (next.join("\n") === site.authIdentityHeaders.join("\n")) return next;
  await tx
    .update(schema.site)
    .set({ authIdentityHeaders: next })
    .where(eq(schema.site.id, site.id));
  return next;
}
