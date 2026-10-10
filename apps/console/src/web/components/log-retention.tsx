import { logRetention } from "@edgeweir/contract";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** The days of the storage in use (PostgreSQL 1–30, ClickHouse 1–90). */
const range = (storage: "lite" | "clickhouse") =>
  logRetention.shape[storage === "clickhouse" ? "clickhouseDays" : "postgresDays"];

/**
 * System page card: how many days access logs are kept. Only the storage in use is shown; the
 * other one's days are saved as they are.
 */
export function LogRetentionCard() {
  const queryClient = useQueryClient();
  return (
    <SettingsCard
      title={m.system_log_retention_title()}
      className="animate-enter"
      style={{ animationDelay: "150ms" }}
      testId="log-retention-card"
      query={orpc.settings.logRetention.queryOptions()}
      mutation={orpc.settings.setLogRetention.mutationOptions({
        // Sites' log tabs show the days.
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.logs.key() }),
      })}
      toDraft={(s) => ({
        days: String(s.storage === "clickhouse" ? s.clickhouseDays : s.postgresDays),
      })}
      toInput={(d, s) => ({
        postgresDays: s.storage === "clickhouse" ? s.postgresDays : Number(d.days),
        clickhouseDays: s.storage === "clickhouse" ? Number(d.days) : s.clickhouseDays,
      })}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="log-retention-save"
      errorTestId="log-retention-error"
    >
      {({ value, draft, set }) => (
        <NumberField
          id="log-retention-days"
          label={m.system_log_retention_days()}
          value={draft.days}
          onChange={(days) => set({ days })}
          min={range(value.storage).minValue ?? 1}
          max={range(value.storage).maxValue ?? undefined}
          step={1}
          required
          testId="log-retention-days"
        />
      )}
    </SettingsCard>
  );
}
