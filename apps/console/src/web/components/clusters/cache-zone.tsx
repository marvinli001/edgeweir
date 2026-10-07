import { CACHE_SIZE_GB_RANGE, type Cluster } from "@edgeweir/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const whole = (value: string, min: number, max: number) => {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
};

/** The cluster's cache zone: its size on every node and how long unrequested objects stay. */
export function ClusterCacheCard({ cluster }: { cluster: Cluster }) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.clusters.setCache.mutationOptions());
  const saved = {
    size: String(cluster.cache.maxSizeGb),
    days: String(cluster.cache.inactiveDays),
  };
  const [draft, setDraft] = React.useState(saved);
  const [error, setError] = React.useState<string | null>(null);
  const sizeValid = whole(draft.size, CACHE_SIZE_GB_RANGE.min, CACHE_SIZE_GB_RANGE.max);
  const daysValid = whole(draft.days, 1, 90);
  const valid = sizeValid && daysValid;
  const dirty = draft.size !== saved.size || draft.days !== saved.days;
  return (
    <Card className="animate-enter" data-testid="cluster-cache">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid) return;
          setError(null);
          try {
            await mutation.mutateAsync({
              id: cluster.id,
              maxSizeGb: Number(draft.size),
              inactiveDays: Number(draft.days),
            });
            await queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
            toast.success(m.common_saved());
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.cluster_cache_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
              onChange={(size) => setDraft({ ...draft, size })}
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
              onChange={(days) => setDraft({ ...draft, days })}
              testId="cluster-cache-days"
            />
          </div>
          <SafetyNote>{m.cluster_cache_note()}</SafetyNote>
        </CardContent>
        <SaveBar
          dirty={dirty && valid}
          pending={mutation.isPending}
          error={error}
          testId="cluster-cache-save"
        />
      </form>
    </Card>
  );
}
