import { siteBytes } from "@edgeweir/config-compiler";
import type { Revision, SiteChanges } from "@edgeweir/contract";
import type { NodeConfig } from "@edgeweir/proto";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const ref = (site: { id: string; name: string }) => ({ id: site.id, name: site.name });

/** The sites `target` adds, changes and removes against `base` (none: every site is added). */
export function siteChanges(base: NodeConfig | undefined, target: NodeConfig): SiteChanges {
  const before = new Map((base?.sites ?? []).map((site) => [site.id, siteBytes(site)]));
  const after = new Set(target.sites.map((site) => site.id));
  return {
    added: target.sites
      .filter((site) => !before.has(site.id))
      .map(ref)
      .sort(byName),
    changed: target.sites
      .filter((site) => before.has(site.id) && before.get(site.id) !== siteBytes(site))
      .map(ref)
      .sort(byName),
    removed: (base?.sites ?? [])
      .filter((site) => !after.has(site.id))
      .map(ref)
      .sort(byName),
  };
}

/**
 * Revisions without repeated reasons (a candidate rebuilt over a new stable
 * revision repeats the reason of the change), the latest of each kept, in
 * publication order.
 */
export function distinctReasons(revisions: Revision[]): Revision[] {
  const key = (r: Revision) =>
    r.reasonCode ? `${r.reasonCode}\u0000${JSON.stringify(r.reasonParams)}` : `\u0000${r.reason}`;
  const latest = new Map<string, Revision>();
  for (const revision of [...revisions].sort((a, b) => a.revision - b.revision))
    latest.set(key(revision), revision);
  return [...latest.values()].sort((a, b) => a.revision - b.revision);
}
