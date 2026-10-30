import type { Site, SiteDelivery } from "@edgeweir/contract";
import { Badge } from "@/components/arc/badge/badge";
import { StatusDot } from "@/components/status-dot";
import { formatClockTime, m } from "@/lib/i18n";

/** "Canary 1/3, all nodes at 14:05" (or awaiting promotion), or null outside a canary. */
export function canaryLabel(delivery: SiteDelivery): string | null {
  const { canary, currentNodes: current, totalNodes: total } = delivery;
  if (!canary || delivery.state === "live") return null;
  return canary.autoPromote
    ? m.site_state_canary({ current, total, time: formatClockTime(canary.endsAt) })
    : m.site_state_canary_waiting({ current, total });
}

/**
 * Whether the site runs on its cluster's online nodes: disabled, pending, rolling out or live;
 * and badges while its usage protection holds maintenance mode or the site disabled, and while
 * its development mode bypasses the cache.
 */
export function SiteStatus({
  site,
}: {
  site: Pick<Site, "enabled" | "delivery"> &
    Partial<Pick<Site, "usageGuardHeld" | "developmentModeUntil">>;
}) {
  const dot = <SiteStatusDot site={site} />;
  if (!site.usageGuardHeld && !site.developmentModeUntil) return dot;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {dot}
      {site.usageGuardHeld ? (
        <Badge size="sm" tone="neutral" data-testid="site-usage-guard">
          {m.usage_guard_badge()}
        </Badge>
      ) : null}
      {site.developmentModeUntil ? (
        <DevelopmentModeBadge until={site.developmentModeUntil} testId="site-dev-mode" />
      ) : null}
    </span>
  );
}

/** "Development mode", with the time it ends as its tooltip. */
export function DevelopmentModeBadge({ until, testId }: { until: string; testId: string }) {
  return (
    <Badge size="sm" tone="warning" title={formatClockTime(until)} data-testid={testId}>
      {m.site_dev_mode_badge()}
    </Badge>
  );
}

function SiteStatusDot({ site }: { site: Pick<Site, "enabled" | "delivery"> }) {
  const { state, currentNodes, totalNodes } = site.delivery;
  if (!site.enabled || state === "disabled")
    return (
      <StatusDot tone="idle" data-testid="site-status" data-state="disabled">
        {m.site_state_disabled()}
      </StatusDot>
    );
  if (state === "pending")
    return (
      <StatusDot tone="warn" data-testid="site-status" data-state="pending">
        {m.site_state_pending()}
      </StatusDot>
    );
  if (state === "partial")
    return (
      <StatusDot tone="warn" pulse data-testid="site-status" data-state="partial">
        {canaryLabel(site.delivery) ??
          m.site_state_partial({ current: currentNodes, total: totalNodes })}
      </StatusDot>
    );
  return (
    <StatusDot tone="good" data-testid="site-status" data-state="active">
      {m.site_state_active()}
    </StatusDot>
  );
}

/** Polls a site until every online node runs it (`refetchInterval` of site queries). */
export const untilLive = (sites: Pick<Site, "delivery">[] | undefined) =>
  sites?.some((s) => s.delivery.state === "pending" || s.delivery.state === "partial")
    ? 5000
    : false;
