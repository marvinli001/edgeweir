import type { AnalyticsRange } from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Panel, PanelHeader } from "@/components/analytics/panel";
import { RowMenu, type RowMenuItem } from "@/components/quick-actions";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { formatCompact, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export function TopRequestsCard({
  range,
  siteId,
  by,
}: {
  range: AnalyticsRange;
  siteId?: string;
  by: "url" | "ip";
}) {
  const query = useQuery({
    ...orpc.analytics.topRequests.queryOptions({ input: { range, siteId, by } }),
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
    meta: { background: true },
  });
  const items = query.data?.items ?? [],
    maximum = Math.max(1, ...items.map((item) => item.requests));
  // Addresses can be banned on the site (or on every site); paths purged where a site has them.
  const actions = (value: string): RowMenuItem[] =>
    by === "ip"
      ? [
          {
            label: m.quick_ban_ip(),
            action: siteId
              ? { kind: "ban", address: value, siteId }
              : { kind: "ban", address: value, scope: "platform" },
            testId: "top-ban",
          },
        ]
      : siteId
        ? [
            {
              label: m.quick_purge_url(),
              action: { kind: "purge", targets: [value], siteId },
              testId: "top-purge",
            },
          ]
        : [];
  return (
    <Panel data-testid={`top-${by}`} className="animate-enter">
      <PanelHeader title={by === "url" ? m.analytics_top_urls() : m.analytics_top_ips()} />
      {query.isPending ? (
        <LoadingState />
      ) : query.isLoadingError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={m.analytics_no_traffic()} />
      ) : (
        <ol className="flex flex-col gap-3 px-4 py-4">
          {items.map((item) => (
            <li key={item.value} className="flex flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono" title={item.value}>
                  {item.value}
                </span>
                <span className="shrink-0 tabular-nums">{formatCompact(item.requests)}</span>
                <RowMenu items={actions(item.value)} />
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-metric transition-[width] duration-500 motion-reduce:transition-none"
                  style={{ width: `${(item.requests / maximum) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
