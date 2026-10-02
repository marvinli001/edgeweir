import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Admin card: usage record retention and when an offline node stops holding back completeness. */
export function UsageSettingsCard() {
  return (
    <SettingsCard
      title={m.system_usage_title()}
      className="animate-enter"
      style={{ animationDelay: "120ms" }}
      query={orpc.settings.usage.queryOptions()}
      mutation={orpc.settings.setUsage.mutationOptions()}
      toDraft={(s) => ({
        retentionDays: String(s.retentionDays),
        offlineThresholdMinutes: String(s.offlineThresholdMinutes),
      })}
      toInput={(d) => ({
        retentionDays: Number(d.retentionDays),
        offlineThresholdMinutes: Number(d.offlineThresholdMinutes),
      })}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="usage-settings-save"
    >
      {({ draft, set }) => (
        <>
          <NumberField
            id="usage-retention"
            label={m.system_usage_retention()}
            value={draft.retentionDays}
            onChange={(retentionDays) => set({ retentionDays })}
            min={35}
            max={400}
            step={1}
            required
            testId="usage-retention"
          />
          <NumberField
            id="usage-offline"
            label={m.system_usage_offline_threshold()}
            value={draft.offlineThresholdMinutes}
            onChange={(offlineThresholdMinutes) => set({ offlineThresholdMinutes })}
            min={5}
            max={1440}
            step={1}
            required
            testId="usage-offline-threshold"
          />
        </>
      )}
    </SettingsCard>
  );
}
