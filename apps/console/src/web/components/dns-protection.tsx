import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** The plan the mass removal protection held back for a cluster, with a confirmed force publish. */
export function DnsHeldBack({
  clusterId,
  blocked,
}: {
  clusterId: string;
  blocked: { revision: number; removedRecords: number; previousRecords: number };
}) {
  const force = useMutation({
    ...orpc.dns.forcePublishBinding.mutationOptions(),
    meta: { invalidates: [orpc.dns.key()], success: m.common_saved },
  });
  return (
    <Alert
      tone="danger"
      title={m.dns_held_back({
        removed: formatNumber(blocked.removedRecords),
        previous: formatNumber(blocked.previousRecords),
      })}
      className="animate-enter"
      data-testid="dns-held-back"
    >
      <span className="flex">
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="danger" data-testid="dns-force-publish">
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
          }}
        />
      </span>
    </Alert>
  );
}

/** DNS page card: the largest share of address records one publication may remove. */
export function DnsProtectionCard() {
  return (
    <SettingsCard
      title={m.dns_protection_title()}
      query={orpc.dns.protection.queryOptions()}
      mutation={orpc.dns.setProtection.mutationOptions()}
      toDraft={(protection) => ({ percent: String(Math.round(protection.massRemovalRatio * 100)) })}
      toInput={(draft) => ({ massRemovalRatio: Number(draft.percent) / 100 })}
      contentClassName="max-w-sm"
      saveTestId="dns-protection-save"
    >
      {({ draft, set }) => (
        <NumberField
          id="dns-mass-removal"
          label={m.dns_protection_ratio()}
          value={draft.percent}
          onChange={(percent) => set({ percent })}
          min={5}
          max={100}
          step={1}
          required
          testId="dns-mass-removal-ratio"
        />
      )}
    </SettingsCard>
  );
}
