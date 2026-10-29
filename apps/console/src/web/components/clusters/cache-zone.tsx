import { CACHE_SIZE_GB_RANGE, type Cluster } from "@edgeweir/contract";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const whole = (value: string, min: number, max: number) => {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
};

/** The cluster's cache zone: its size on every node and how long unrequested objects stay. */
export function ClusterCacheCard({ cluster }: { cluster: Cluster }) {
  const form = useSettingsForm({
    value: cluster.cache,
    toDraft: (cache) => ({ size: String(cache.maxSizeGb), days: String(cache.inactiveDays) }),
    toInput: (draft) => ({
      id: cluster.id,
      maxSizeGb: Number(draft.size),
      inactiveDays: Number(draft.days),
    }),
    mutation: {
      ...orpc.clusters.setCache.mutationOptions(),
      meta: { invalidates: [orpc.clusters.key()] },
    },
  });
  const { draft, set } = form;
  const sizeValid = whole(draft.size, CACHE_SIZE_GB_RANGE.min, CACHE_SIZE_GB_RANGE.max);
  const daysValid = whole(draft.days, 1, 90);
  const valid = sizeValid && daysValid;
  return (
    <Panel className="animate-enter" data-testid="cluster-cache">
      <form
        className="flex flex-col gap-(--panel-pad)"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void form.submit();
        }}
      >
        <PanelHeader>
          <PanelTitle>{m.cluster_cache_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
            <NumberField
              id="cluster-cache-size"
              label={m.cluster_cache_size()}
              value={draft.size}
              min={CACHE_SIZE_GB_RANGE.min}
              max={CACHE_SIZE_GB_RANGE.max}
              step={1}
              required
              error={
                sizeValid
                  ? undefined
                  : m.common_whole_number_range({
                      min: formatNumber(CACHE_SIZE_GB_RANGE.min),
                      max: formatNumber(CACHE_SIZE_GB_RANGE.max),
                    })
              }
              onChange={(size) => set({ size })}
              testId="cluster-cache-size"
            />
            <NumberField
              id="cluster-cache-days"
              label={m.cluster_cache_inactive()}
              value={draft.days}
              min={1}
              max={90}
              step={1}
              required
              error={daysValid ? undefined : m.common_whole_number_range({ min: "1", max: "90" })}
              onChange={(days) => set({ days })}
              testId="cluster-cache-days"
            />
          </div>
          <SafetyNote>{m.cluster_cache_note()}</SafetyNote>
        </PanelContent>
        <SaveBar
          dirty={form.dirty && valid}
          pending={form.pending}
          error={form.error}
          testId="cluster-cache-save"
        />
      </form>
    </Panel>
  );
}
