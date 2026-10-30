import { tieredCacheSettings } from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { TierUpperPicker, topologyOptions } from "@/components/site/tiered-cache-card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * System page card: the tiered cache topology of every site that follows it
 * and the upper tiers' port. Saving publishes those sites' clusters.
 */
export function TieredCacheSettingsCard() {
  return (
    <SettingsCard
      title={m.tiered_cache_title()}
      className="animate-enter"
      style={{ animationDelay: "40ms" }}
      testId="tiered-cache-settings-card"
      query={orpc.tieredCache.get.queryOptions()}
      mutation={orpc.tieredCache.update.mutationOptions()}
      toDraft={(value) => ({ ...value, port: String(value.port) })}
      toInput={(d) => ({ ...d, port: d.port.trim() ? Number(d.port) : Number.NaN })}
      check={(input) => {
        if (!tieredCacheSettings.shape.port.safeParse(input.port).success)
          return m.tiered_cache_port_invalid();
        if (
          input.topology === "custom" &&
          input.upperNodeIds.length + input.upperNodeGroupIds.length === 0
        )
          return m.tiered_cache_custom_empty();
        return null;
      }}
      noValidate
      contentClassName="flex flex-col gap-4"
      saveTestId="tiered-cache-settings-save"
      errorTestId="tiered-cache-settings-error"
    >
      {({ draft, set }) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[16rem_10rem]">
            <FormSelect
              id="tiered-cache-global-topology"
              label={m.tiered_cache_topology()}
              value={draft.topology}
              options={topologyOptions()}
              testId="tiered-cache-global-topology"
              onChange={(topology) => set({ topology })}
            />
            <NumberField
              id="tiered-cache-port"
              label={m.tiered_cache_port()}
              value={draft.port}
              min={1}
              max={65535}
              step={1}
              required
              mono
              testId="tiered-cache-port"
              onChange={(port) => set({ port })}
            />
          </div>
          {draft.topology === "custom" ? (
            <TierUpperPicker
              idPrefix="tiered-cache-global"
              nodeIds={draft.upperNodeIds}
              groupIds={draft.upperNodeGroupIds}
              onChange={(change) => set(change)}
            />
          ) : null}
          <SafetyNote>{m.tiered_cache_cached_only()}</SafetyNote>
        </>
      )}
    </SettingsCard>
  );
}
