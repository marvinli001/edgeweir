import type { Site } from "@edgeweir/contract";
import { StatusDot } from "@/components/status-dot";
import { m } from "@/lib/i18n";

/** Running or disabled. */
export function SiteStatus({ site }: { site: Pick<Site, "enabled"> }) {
  if (!site.enabled)
    return (
      <StatusDot tone="idle" data-testid="site-status" data-state="disabled">
        {m.site_state_disabled()}
      </StatusDot>
    );
  return (
    <StatusDot tone="good" data-testid="site-status" data-state="active">
      {m.site_state_active()}
    </StatusDot>
  );
}
