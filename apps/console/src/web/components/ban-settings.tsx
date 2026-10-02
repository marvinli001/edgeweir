import type { BanSettings } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Admin card: platform limit of manual bans and sharing of automatic bans in a cluster. */
export function BanSettingsCard() {
  const query = useQuery(orpc.settings.bans.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "140ms" }}>
      <CardHeader>
        <CardTitle>{m.system_bans_title()}</CardTitle>
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
        <BanSettingsForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function BanSettingsForm({ initial }: { initial: BanSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setBans.mutationOptions());
  const [maxTotal, setMaxTotal] = React.useState(String(initial.maxTotal));
  const [share, setShare] = React.useState(initial.shareAutoBans);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = maxTotal !== String(initial.maxTotal) || share !== initial.shareAutoBans;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync({ maxTotal: Number(maxTotal), shareAutoBans: share });
          await queryClient.invalidateQueries({ queryKey: orpc.settings.bans.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="bans-max-total"
          label={m.system_bans_max_total()}
          value={maxTotal}
          onChange={setMaxTotal}
          min={100}
          max={100000}
          step={1}
          required
          testId="bans-max-total"
        />
        <SwitchField
          id="bans-share-auto"
          label={m.system_bans_share_auto()}
          checked={share}
          onCheckedChange={setShare}
          testId="bans-share-auto"
        />
      </CardContent>
      <SaveBar dirty={dirty} pending={save.isPending} error={error} testId="ban-settings-save" />
    </form>
  );
}
