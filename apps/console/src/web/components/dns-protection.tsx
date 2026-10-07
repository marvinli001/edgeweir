import type { DnsProtection } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** The plan the mass removal protection held back for a cluster, with a confirmed force publish. */
export function DnsHeldBack({
  clusterId,
  blocked,
}: {
  clusterId: string;
  blocked: { revision: number; removedRecords: number; previousRecords: number };
}) {
  const queryClient = useQueryClient();
  const force = useMutation(orpc.dns.forcePublishBinding.mutationOptions());
  return (
    <Alert variant="destructive" className="animate-enter" data-testid="dns-held-back">
      <AlertTitle className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          {m.dns_held_back({
            removed: formatNumber(blocked.removedRecords),
            previous: formatNumber(blocked.previousRecords),
          })}
        </span>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="destructive" data-testid="dns-force-publish">
              {m.dns_force_publish()}
            </Button>
          }
          destructive
          title={m.dns_force_publish_confirm()}
          note={m.dns_held_back({
            removed: formatNumber(blocked.removedRecords),
            previous: formatNumber(blocked.previousRecords),
          })}
          confirmLabel={m.dns_force_publish()}
          onConfirm={async () => {
            await force.mutateAsync({ clusterId, revision: blocked.revision });
            await queryClient.invalidateQueries({ queryKey: orpc.dns.key() });
            toast.success(m.common_saved());
          }}
        />
      </AlertTitle>
    </Alert>
  );
}

/** DNS page card: the largest share of address records one publication may remove. */
export function DnsProtectionCard() {
  const query = useQuery(orpc.dns.protection.queryOptions());
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dns_protection_title()}</CardTitle>
      </CardHeader>
      <QueryView query={query} frame={CardContent}>
        {(protection) => <ProtectionForm key={JSON.stringify(protection)} initial={protection} />}
      </QueryView>
    </Card>
  );
}

function ProtectionForm({ initial }: { initial: DnsProtection }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.dns.setProtection.mutationOptions());
  const initialPercent = String(Math.round(initial.massRemovalRatio * 100));
  const [percent, setPercent] = React.useState(initialPercent);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync({ massRemovalRatio: Number(percent) / 100 });
          await queryClient.invalidateQueries({ queryKey: orpc.dns.protection.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="max-w-sm">
        <NumberField
          id="dns-mass-removal"
          label={m.dns_protection_ratio()}
          value={percent}
          onChange={setPercent}
          min={5}
          max={100}
          step={1}
          required
          testId="dns-mass-removal-ratio"
        />
      </CardContent>
      <SaveBar
        dirty={percent !== initialPercent}
        pending={save.isPending}
        error={error}
        testId="dns-protection-save"
      />
    </form>
  );
}
