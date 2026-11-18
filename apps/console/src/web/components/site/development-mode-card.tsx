import type { Site } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Switch } from "@/components/arc/switch/switch";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { QueryView } from "@/components/states";
import { formatClockTime, formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const VIEWS = [orpc.developmentMode.key(), orpc.sites.key()];
const MINUTE = 60_000;

/** "2 h 58 min left", "12 min left", or "less than a minute left". */
function remainingLabel(until: string, now: number): string {
  const minutes = Math.floor((Date.parse(until) - now) / MINUTE);
  if (minutes < 1) return m.site_dev_mode_left_soon();
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? m.site_dev_mode_left_hours({
        hours: formatNumber(hours),
        minutes: formatNumber(minutes % 60),
      })
    : m.site_dev_mode_left_minutes({ minutes: formatNumber(minutes) });
}

/** The current time, every 30 seconds while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Development mode (developmentMode.get/set): a switch that bypasses the edge cache for three
 * hours, the time left while on, and a refresh when it ends.
 */
export function DevelopmentModeCard({ site }: { site: Site }) {
  return (
    <Panel className="animate-enter" style={{ animationDelay: "40ms" }} data-testid="dev-mode-card">
      <PanelHeader>
        <PanelTitle>{m.site_dev_mode_title()}</PanelTitle>
      </PanelHeader>
      <PanelContent>
        <DevelopmentModeControl siteId={site.id} />
      </PanelContent>
    </Panel>
  );
}

export function DevelopmentModeControl({
  siteId,
  quick = false,
}: {
  siteId: string;
  quick?: boolean;
}) {
  const query = useQuery(orpc.developmentMode.get.queryOptions({ input: { id: siteId } }));
  return (
    <QueryView query={query}>
      {(mode) => <DevelopmentModeBody siteId={siteId} mode={mode} quick={quick} />}
    </QueryView>
  );
}

function DevelopmentModeBody({
  siteId,
  mode,
  quick,
}: {
  siteId: string;
  mode: { until: string | null; unsupportedNodes: number };
  quick: boolean;
}) {
  const queryClient = useQueryClient();
  const set = useMutation({
    ...orpc.developmentMode.set.mutationOptions(),
    meta: { invalidates: VIEWS, toastError: true },
  });
  const until = mode.until;
  const now = useNow(until !== null);
  // Nodes stop at the deadline on their own; the card and the site's badge follow it.
  React.useEffect(() => {
    if (!until) return;
    const refresh = () =>
      VIEWS.forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));
    const timer = setTimeout(refresh, Math.max(0, Date.parse(until) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [until, queryClient]);
  const on = until !== null && Date.parse(until) > now;
  const blocked = !on && mode.unsupportedNodes > 0;
  const setEnabled = (enabled: boolean) => set.mutate({ id: siteId, enabled });
  if (quick)
    return (
      <>
        <div className="flex min-h-9 items-center justify-between gap-3 text-[13px] pointer-coarse:min-h-11">
          <span>{m.site_dev_mode_title()}</span>
          <Switch
            checked={on}
            disabled={blocked || set.isPending}
            onCheckedChange={setEnabled}
            aria-label={m.site_dev_mode_title()}
            data-testid="site-quick-dev-mode"
          />
        </div>
        {blocked ? <SafetyNote>{m.feature_unavailable_nodes()}</SafetyNote> : null}
      </>
    );
  return (
    <div className="flex flex-col gap-3">
      {blocked ? (
        <SafetyNote data-testid="dev-mode-unavailable">{m.feature_unavailable_nodes()}</SafetyNote>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SwitchField
          id="dev-mode-switch"
          label={m.site_dev_mode_switch()}
          checked={on}
          disabled={blocked || set.isPending}
          onCheckedChange={setEnabled}
          className="self-start"
          testId="dev-mode-switch"
        />
        {on && until ? (
          <span
            className="text-sm tabular-nums text-muted-foreground"
            title={formatClockTime(until)}
            data-testid="dev-mode-left"
          >
            {remainingLabel(until, now)}
          </span>
        ) : null}
      </div>
      {on ? <SafetyNote data-testid="dev-mode-note">{m.site_dev_mode_note()}</SafetyNote> : null}
    </div>
  );
}
