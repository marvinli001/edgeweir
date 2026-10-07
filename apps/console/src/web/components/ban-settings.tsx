import type * as React from "react";
import {
  GRID_CARD,
  SettingNumber,
  SettingRow,
  SettingRows,
} from "@/components/protection-settings";
import { SettingsCard } from "@/components/settings-card";
import { Switch } from "@/components/ui/switch";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** Platform limit of manual bans and sharing of automatic bans in a cluster. */
export function BanSettingsCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <SettingsCard
      title={m.system_bans_title()}
      className={cn(GRID_CARD, className)}
      style={style}
      query={orpc.settings.bans.queryOptions()}
      mutation={orpc.settings.setBans.mutationOptions()}
      toDraft={(s) => ({ maxTotal: String(s.maxTotal), shareAutoBans: s.shareAutoBans })}
      toInput={(d) => ({ maxTotal: Number(d.maxTotal), shareAutoBans: d.shareAutoBans })}
      contentClassName="flex-1"
      saveTestId="ban-settings-save"
    >
      {({ draft, set }) => (
        <SettingRows>
          <SettingRow htmlFor="bans-max-total" label={m.system_bans_max_total()}>
            <SettingNumber
              id="bans-max-total"
              value={draft.maxTotal}
              onChange={(maxTotal) => set({ maxTotal })}
              min={100}
              max={100000}
              testId="bans-max-total"
            />
          </SettingRow>
          <SettingRow htmlFor="bans-share-auto" label={m.system_bans_share_auto()}>
            <Switch
              id="bans-share-auto"
              checked={draft.shareAutoBans}
              onCheckedChange={(shareAutoBans) => set({ shareAutoBans })}
              data-testid="bans-share-auto"
            />
          </SettingRow>
        </SettingRows>
      )}
    </SettingsCard>
  );
}
