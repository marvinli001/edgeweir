import type { Site, SiteSuspendReason } from "@edgeweir/contract";
import { StatusDot } from "@/components/status-dot";
import { m } from "@/lib/i18n";

const REASONS: Record<SiteSuspendReason, () => string> = {
  billing: () => m.site_suspend_reason_billing(),
  abuse: () => m.site_suspend_reason_abuse(),
  security: () => m.site_suspend_reason_security(),
  other: () => m.site_suspend_reason_other(),
};

export const SUSPEND_REASONS = Object.keys(REASONS) as SiteSuspendReason[];

export function suspendReasonLabel(reason: SiteSuspendReason | null): string {
  return REASONS[reason ?? "other"]();
}

/** Running, disabled (by the organization) or suspended (by the platform). */
export function SiteStatus({ site }: { site: Pick<Site, "enabled" | "suspended"> }) {
  if (site.suspended)
    return (
      <StatusDot tone="bad" data-testid="site-status" data-state="suspended">
        {m.site_state_suspended()}
      </StatusDot>
    );
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
