import {
  type AnalyticsRange,
  MAX_CUSTOM_TIERS,
  type Site,
  type SiteTieredCacheSettings,
  TIER_TOPOLOGIES,
  type TierIdleReason,
  type TierReason,
  type TierSelection,
  type TierTopology,
} from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/arc/badge/badge";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { formatDateTime, formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const TOPOLOGY_LABEL: Record<TierTopology, () => string> = {
  off: m.tiered_cache_topology_off,
  smart: m.tiered_cache_topology_smart,
  generic: m.tiered_cache_topology_generic,
  regional: m.tiered_cache_topology_regional,
  custom: m.tiered_cache_topology_custom,
};

const REASON_LABEL: Record<TierReason, () => string> = {
  lowest_latency: m.tiered_cache_reason_lowest_latency,
  fallback_region: m.tiered_cache_reason_fallback_region,
  region_upper: m.tiered_cache_reason_region_upper,
  regional_tier: m.tiered_cache_reason_regional_tier,
  global_upper: m.tiered_cache_reason_global_upper,
  custom: m.tiered_cache_reason_custom,
};

const IDLE_LABEL: Record<TierIdleReason, () => string> = {
  no_latency: m.tiered_cache_idle_no_latency,
  no_upper: m.tiered_cache_idle_no_upper,
  single_node: m.tiered_cache_idle_single_node,
  no_custom: m.tiered_cache_idle_no_custom,
};

const topologyLabel = (topology: TierTopology) => TOPOLOGY_LABEL[topology]();

export const topologyOptions = () =>
  TIER_TOPOLOGIES.map((value) => ({ value, label: topologyLabel(value) }));

/** The upper tiers a custom topology names: node and node group checkboxes. */
export function TierUpperPicker({
  idPrefix,
  clusterId,
  nodeIds,
  groupIds,
  onChange,
}: {
  idPrefix: string;
  /** Only this cluster's nodes and groups; every cluster's without. */
  clusterId?: string;
  nodeIds: readonly string[];
  groupIds: readonly string[];
  onChange: (change: { upperNodeIds?: string[]; upperNodeGroupIds?: string[] }) => void;
}) {
  const nodes = useQuery(orpc.nodes.list.queryOptions({ input: { clusterId } }));
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId } }));
  const toggle = (list: readonly string[], id: string, on: boolean) =>
    on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id);
  const box = (
    key: string,
    label: string,
    hint: string | null,
    checked: boolean,
    onChecked: (on: boolean) => void,
  ) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
    <label
      key={key}
      className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-wash has-data-checked:bg-tint-primary"
      data-testid={`${idPrefix}-option`}
    >
      <Checkbox
        checked={checked}
        disabled={!checked && nodeIds.length + groupIds.length >= MAX_CUSTOM_TIERS}
        onCheckedChange={onChecked}
      />
      <span className="text-sm">{label}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
  return (
    <QueryView query={combineQueries(nodes, groups)}>
      {([nodeList, groupList]) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel id={`${idPrefix}-groups`}>{m.tiered_cache_upper_groups()}</FieldLabel>
            <fieldset
              aria-labelledby={`${idPrefix}-groups`}
              className="max-h-56 min-w-0 divide-y divide-border/70 overflow-y-auto rounded-lg faint-well"
            >
              {groupList.map((g) =>
                box(g.id, g.name, g.regionName, groupIds.includes(g.id), (on) =>
                  onChange({ upperNodeGroupIds: toggle(groupIds, g.id, on) }),
                ),
              )}
            </fieldset>
          </Field>
          <Field>
            <FieldLabel id={`${idPrefix}-nodes`}>{m.tiered_cache_upper_nodes()}</FieldLabel>
            <fieldset
              aria-labelledby={`${idPrefix}-nodes`}
              className="max-h-56 min-w-0 divide-y divide-border/70 overflow-y-auto rounded-lg faint-well"
            >
              {nodeList.map((n) =>
                box(n.id, n.name, n.regionName, nodeIds.includes(n.id), (on) =>
                  onChange({ upperNodeIds: toggle(nodeIds, n.id, on) }),
                ),
              )}
            </fieldset>
          </Field>
        </div>
      )}
    </QueryView>
  );
}

/** A site's topology: the console-wide one, or its own. */
export function TieredCacheCard({ site }: { site: Site }) {
  const settings = useQuery(orpc.tieredCache.site.get.queryOptions({ input: { id: site.id } }));
  const global = useQuery(orpc.tieredCache.get.queryOptions());
  return (
    <QueryView query={combineQueries(settings, global)}>
      {([saved, globalSettings]) => (
        <TieredCacheEditor site={site} server={saved} globalTopology={globalSettings.topology} />
      )}
    </QueryView>
  );
}

function TieredCacheEditor({
  site,
  server,
  globalTopology,
}: {
  site: Site;
  server: SiteTieredCacheSettings;
  globalTopology: TierTopology;
}) {
  const { draft, set, dirty, error, pending, submit } = useSettingsForm({
    value: server,
    toDraft: (value) => value,
    toInput: (value) => ({ id: site.id, ...value }),
    check: (value) =>
      value.topology === "custom" &&
      value.upperNodeIds.length + value.upperNodeGroupIds.length === 0
        ? m.tiered_cache_custom_empty()
        : null,
    mutation: {
      ...orpc.tieredCache.site.update.mutationOptions(),
      meta: { invalidates: [orpc.tieredCache.key(), orpc.sites.key()] },
    },
  });
  return (
    <Panel className="animate-enter" data-testid="tiered-cache-card">
      <form className="flex flex-col gap-(--panel-pad)" onSubmit={submit}>
        <PanelHeader>
          <PanelTitle>{m.tiered_cache_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent className="flex flex-col gap-4">
          <div className="sm:w-64">
            <FormSelect
              id="tiered-cache-topology"
              label={m.tiered_cache_topology()}
              value={draft.topology}
              testId="tiered-cache-topology"
              options={[
                {
                  value: "inherit" as const,
                  label: m.tiered_cache_topology_inherit({
                    topology: topologyLabel(globalTopology),
                  }),
                },
                ...topologyOptions(),
              ]}
              onChange={(topology) => set({ topology })}
            />
          </div>
          {draft.topology === "custom" ? (
            <TierUpperPicker
              idPrefix="tiered-cache-site"
              clusterId={site.clusterId}
              nodeIds={draft.upperNodeIds}
              groupIds={draft.upperNodeGroupIds}
              onChange={(change) => set(change)}
            />
          ) : null}
          <SafetyNote>{m.tiered_cache_cached_only()}</SafetyNote>
        </PanelContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="tiered-cache-save" />
      </form>
    </Panel>
  );
}

/** Which node fetches from which upper tiers for the site, and why. */
export function TierSelectionCard({ siteId }: { siteId: string }) {
  const selection = useQuery({
    ...orpc.tieredCache.site.selection.queryOptions({ input: { id: siteId } }),
    refetchInterval: 60_000,
  });
  return (
    <Panel className="animate-enter" data-testid="tier-selection-card">
      <PanelHeader className="flex flex-wrap items-center gap-2">
        <PanelTitle>{m.tiered_cache_selection_title()}</PanelTitle>
        {selection.data ? (
          <>
            <Badge size="sm" tone="neutral" data-testid="tier-selection-topology">
              {topologyLabel(selection.data.topology)}
            </Badge>
            {selection.data.inherited ? (
              <Badge size="sm" tone="neutral">
                {m.tiered_cache_inherited()}
              </Badge>
            ) : null}
          </>
        ) : null}
      </PanelHeader>
      <PanelContent className="flex flex-col gap-3">
        <QueryView query={selection}>{(data) => <SelectionView data={data} />}</QueryView>
      </PanelContent>
    </Panel>
  );
}

function SelectionView({ data }: { data: TierSelection }) {
  if (data.topology === "off") return <EmptyState compact title={m.tiered_cache_off()} />;
  return (
    <>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {data.target ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{m.tiered_cache_target()}</dt>
            <dd className="font-mono text-xs leading-5" data-testid="tier-selection-target">
              {data.target}
            </dd>
          </div>
        ) : null}
        {data.chosenAt ? (
          <div className="text-muted-foreground">
            {m.tiered_cache_chosen_at({ time: formatDateTime(data.chosenAt) })}
          </div>
        ) : null}
      </dl>
      {data.idleReason ? (
        <SafetyNote data-testid="tier-selection-idle">{IDLE_LABEL[data.idleReason]()}</SafetyNote>
      ) : null}
      <div className="flex flex-col rounded-lg faint-well">
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 px-3 pt-2.5 pb-1 text-xs text-muted-foreground sm:grid"
        >
          <span>{m.tiered_cache_node()}</span>
          <span>{m.tiered_cache_uppers()}</span>
        </div>
        <ul className="divide-y" data-testid="tier-selection-rows">
          {data.nodes.map((node) => (
            <li
              key={node.nodeId}
              className="grid gap-x-4 gap-y-1 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center"
              data-testid="tier-selection-row"
              data-node={node.nodeId}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{node.nodeName}</span>
                {node.regionName ? (
                  <span className="truncate text-xs text-muted-foreground">{node.regionName}</span>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {node.uppers.length === 0 ? (
                  <span className="text-muted-foreground">{m.tiered_cache_origin()}</span>
                ) : (
                  node.uppers.map((upper, index) => (
                    <span
                      key={upper.nodeId}
                      className="flex items-center gap-1.5"
                      data-testid="tier-selection-upper"
                      data-upper={upper.nodeId}
                    >
                      <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                      <span>{upper.nodeName}</span>
                      <Badge size="sm" tone="neutral">
                        {REASON_LABEL[upper.reason]()}
                      </Badge>
                      {upper.rttMs === null ? null : (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {m.tiered_cache_ms({ value: formatNumber(upper.rttMs) })}
                        </span>
                      )}
                    </span>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {data.unsupportedNodes > 0 ? (
        <SafetyNote data-testid="tier-selection-unsupported">
          {m.tiered_cache_unsupported({ count: data.unsupportedNodes })}
        </SafetyNote>
      ) : null}
    </>
  );
}

/** The upper tiers' hit ratio for the site's lower tiers over a range. */
export function TierStatsCard({
  siteId,
  range,
}: {
  siteId: string;
  /** The analytics tab's range: the card sits under its range picker and follows it. */
  range: AnalyticsRange;
}) {
  const stats = useQuery({
    ...orpc.tieredCache.site.stats.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  const sum = (counts: Record<string, number>) =>
    Object.values(counts).reduce((total, n) => total + n, 0);
  return (
    <Panel className="animate-enter" data-testid="tier-stats-card">
      <PanelHeader>
        <PanelTitle>{m.tiered_cache_stats_title()}</PanelTitle>
      </PanelHeader>
      <PanelContent>
        <QueryView
          query={stats}
          isEmpty={(data) => sum(data.fetches) + sum(data.served) === 0}
          empty={<EmptyState compact title={m.tiered_cache_stats_empty()} />}
        >
          {(data) => (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label={m.tiered_cache_stats_hit_ratio()}
                value={
                  data.hitRatio === null
                    ? "–"
                    : formatPercent(Math.round(data.hitRatio * 1000) / 10)
                }
                testId="tier-stats-hit-ratio"
              />
              <Stat
                label={m.tiered_cache_stats_fetches()}
                value={formatNumber(sum(data.fetches) - data.fallbacks)}
                testId="tier-stats-fetches"
              />
              <Stat
                label={m.tiered_cache_stats_fallbacks()}
                value={formatNumber(data.fallbacks)}
                testId="tier-stats-fallbacks"
              />
              <Stat
                label={m.tiered_cache_stats_served()}
                value={formatNumber(sum(data.served))}
                testId="tier-stats-served"
              />
            </dl>
          )}
        </QueryView>
      </PanelContent>
    </Panel>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-2xl font-medium tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
