import { SettingsCard } from "@/components/settings-card";
import { NumberField, SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Protection page card: platform limit of manual bans and sharing of automatic bans in a cluster. */
export function BanSettingsCard() {
  return (
    <SettingsCard
      title={m.system_bans_title()}
      className="animate-enter"
      style={{ animationDelay: "140ms" }}
      query={orpc.settings.bans.queryOptions()}
      mutation={orpc.settings.setBans.mutationOptions()}
      toDraft={(s) => ({ maxTotal: String(s.maxTotal), shareAutoBans: s.shareAutoBans })}
      toInput={(d) => ({ maxTotal: Number(d.maxTotal), shareAutoBans: d.shareAutoBans })}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="ban-settings-save"
    >
      {({ draft, set }) => (
        <>
          <NumberField
            id="bans-max-total"
            label={m.system_bans_max_total()}
            value={draft.maxTotal}
            onChange={(maxTotal) => set({ maxTotal })}
            min={100}
            max={100000}
            step={1}
            required
            testId="bans-max-total"
          />
          <SwitchField
            id="bans-share-auto"
            label={m.system_bans_share_auto()}
            checked={draft.shareAutoBans}
            onCheckedChange={(shareAutoBans) => set({ shareAutoBans })}
            testId="bans-share-auto"
          />
        </>
      )}
    </SettingsCard>
  );
}
