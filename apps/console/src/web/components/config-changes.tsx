import type { SiteChanges } from "@edgeweir/contract";
import { m } from "@/lib/i18n";

/** Names shown per line; the rest is a count. */
const SHOWN = 6;

/**
 * The sites a configuration adds, changes and removes, one line each:
 * "Changed shop, blog +3". `unchanged`: the content equals the current one.
 */
export function SiteChangeList({
  changes,
  unchanged = false,
  testId,
}: {
  changes: SiteChanges;
  unchanged?: boolean;
  testId?: string;
}) {
  const lines = (
    [
      ["added", m.changes_added(), changes.added],
      ["changed", m.changes_changed(), changes.changed],
      ["removed", m.changes_removed(), changes.removed],
    ] as const
  ).filter(([, , sites]) => sites.length > 0);
  if (lines.length === 0)
    return (
      <span className="text-sm text-muted-foreground" data-testid={testId} data-empty="">
        {unchanged ? m.changes_unchanged() : m.changes_none()}
      </span>
    );
  return (
    <ul className="flex min-w-0 flex-col gap-1 text-sm" data-testid={testId}>
      {lines.map(([kind, label, sites]) => (
        <li key={kind} className="flex min-w-0 gap-2" data-kind={kind}>
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 break-words">
            {sites
              .slice(0, SHOWN)
              .map((site) => site.name)
              .join(", ")}
            {sites.length > SHOWN ? (
              <span className="text-muted-foreground"> +{sites.length - SHOWN}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
