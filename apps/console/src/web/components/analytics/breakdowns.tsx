import type { TrafficTopItem, TrafficTotals } from "@edgeweir/contract";
import type * as React from "react";
import { OpenCardButton, OpenCardHint, Panel, PanelHeader } from "@/components/analytics/panel";
import { STATUS_CLASSES } from "@/lib/analytics";
import { formatCompact, formatPercent, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A panel with nothing to show: one quiet line (no empty-state box inside the card). */
export function NoTraffic() {
  return (
    <p className="flex flex-1 items-center justify-center px-4 py-8 text-sm text-muted-foreground">
      {m.analytics_no_traffic()}
    </p>
  );
}

/**
 * Responses by status class: one segmented bar plus the counts, so no value hides in color.
 * `wide` lays the classes out side by side when the card spans the whole row.
 */
export function StatusCodesCard({
  totals,
  wide,
  onOpen,
}: {
  totals: TrafficTotals;
  wide?: boolean;
  /** Opens the per-code breakdown. */
  onOpen?: () => void;
}) {
  const total = STATUS_CLASSES.reduce((sum, c) => sum + totals[c.key], 0);
  return (
    <Panel
      data-testid="status-codes"
      className={cn(
        "h-full",
        onOpen &&
          "group/panel transition-shadow duration-200 ease-lit hover:shadow-elev-2 motion-reduce:transition-none",
      )}
    >
      {onOpen ? (
        <OpenCardButton
          label={m.analytics_details({ metric: m.analytics_status_codes() })}
          onOpen={onOpen}
        />
      ) : null}
      <PanelHeader
        title={m.analytics_status_codes()}
        aside={onOpen ? <OpenCardHint /> : undefined}
      />
      {total === 0 ? (
        <NoTraffic />
      ) : (
        <div className="flex flex-1 flex-col gap-4 px-4 pt-4 pb-4">
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[4px]" aria-hidden>
            {STATUS_CLASSES.filter((c) => totals[c.key] > 0).map((c) => (
              <span
                key={c.key}
                className="h-full min-w-0.5 transition-[flex-grow] duration-500 motion-reduce:transition-none"
                style={{ flexGrow: totals[c.key], backgroundColor: c.color }}
                title={`${c.label} · ${formatPercent((totals[c.key] / total) * 100)}`}
              />
            ))}
          </div>
          <table className={cn("w-full text-sm", wide && "@3xl/main:hidden")}>
            <tbody>
              {STATUS_CLASSES.map((c) => (
                <tr key={c.key} className="border-b last:border-0">
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="font-mono text-xs">{c.label}</span>
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums" data-testid={`status-${c.label}`}>
                    {formatCompact(totals[c.key])}
                  </td>
                  <td className="w-16 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {formatPercent((totals[c.key] / total) * 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {wide ? (
            <dl className="hidden grid-cols-4 divide-x @3xl/main:grid">
              {STATUS_CLASSES.map((c) => (
                <div key={c.key} className="flex flex-col gap-1 px-4 first:pl-0">
                  <dt className="flex items-center gap-2 text-xs">
                    <span
                      className="size-2.5 shrink-0 rounded-[3px]"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="font-mono">{c.label}</span>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {formatPercent((totals[c.key] / total) * 100)}
                    </span>
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {formatCompact(totals[c.key])}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** A ranked list with a share bar under each row, scaled to the leader. */
export function TopListCard({
  title,
  items,
  renderLink,
  showParent = true,
  testId,
}: {
  title: string;
  items: TrafficTopItem[];
  /** Show each item's cluster. */
  showParent?: boolean;
  /** Wraps a row in a link to the item. */
  renderLink: (
    item: TrafficTopItem,
    props: { className: string; children: React.ReactNode },
  ) => React.ReactNode;
  testId?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.requests));
  return (
    <Panel data-testid={testId} className="h-full">
      <PanelHeader title={title} />
      {items.length === 0 ? (
        <NoTraffic />
      ) : (
        <ol className="flex flex-col px-2 pt-2 pb-2">
          {items.map((item) => (
            <li key={item.id}>
              {renderLink(item, {
                className:
                  "flex flex-col gap-1.5 rounded-xl px-2 py-2 outline-none transition-colors focus-lit hover:bg-wash focus-visible:bg-wash",
                children: (
                  <>
                    <span className="flex items-baseline gap-2 text-sm">
                      <span className="truncate font-medium" data-testid="top-item-name">
                        {item.name}
                      </span>
                      {showParent ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.parentName}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 tabular-nums">
                        {formatCompact(item.requests)}
                      </span>
                    </span>
                    <span className="h-1 overflow-hidden rounded-full bg-wash">
                      <span
                        data-slot="bar-fill"
                        className="block h-full rounded-full bg-metric transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${(item.requests / max) * 100}%` }}
                      />
                    </span>
                  </>
                ),
              })}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
