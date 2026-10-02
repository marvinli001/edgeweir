import type { UsageSettings } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Admin card: usage record retention and when an offline node stops holding back completeness. */
export function UsageSettingsCard() {
  const query = useQuery(orpc.settings.usage.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
      <CardHeader>
        <CardTitle>{m.system_usage_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : query.isLoadingError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </CardContent>
      ) : (
        <UsageSettingsForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function UsageSettingsForm({ initial }: { initial: UsageSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setUsage.mutationOptions());
  const [retention, setRetention] = React.useState(String(initial.retentionDays));
  const [threshold, setThreshold] = React.useState(String(initial.offlineThresholdMinutes));
  const [error, setError] = React.useState<string | null>(null);
  const dirty =
    retention !== String(initial.retentionDays) ||
    threshold !== String(initial.offlineThresholdMinutes);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync({
            retentionDays: Number(retention),
            offlineThresholdMinutes: Number(threshold),
          });
          await queryClient.invalidateQueries({ queryKey: orpc.settings.usage.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="usage-retention"
          label={m.system_usage_retention()}
          value={retention}
          onChange={setRetention}
          min={35}
          max={400}
          step={1}
          required
          testId="usage-retention"
        />
        <NumberField
          id="usage-offline"
          label={m.system_usage_offline_threshold()}
          value={threshold}
          onChange={setThreshold}
          min={5}
          max={1440}
          step={1}
          required
          testId="usage-offline-threshold"
        />
      </CardContent>
      <SaveBar dirty={dirty} pending={save.isPending} error={error} testId="usage-settings-save" />
    </form>
  );
}
