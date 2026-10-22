import { nodeLogRetention } from "@edgeweir/contract";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const { days, perNode } = nodeLogRetention.shape;

/** System page card: how many days node logs are kept, and at most how many per node. */
export function NodeLogRetentionCard() {
  return (
    <SettingsCard
      title={m.system_node_log_retention_title()}
      className="animate-enter"
      style={{ animationDelay: "160ms" }}
      testId="node-log-retention-card"
      query={orpc.settings.nodeLogRetention.queryOptions()}
      mutation={{
        ...orpc.settings.setNodeLogRetention.mutationOptions(),
        meta: { invalidates: [orpc.settings.nodeLogRetention.key(), orpc.nodes.logs.key()] },
      }}
      toDraft={(s) => ({ days: String(s.days), perNode: String(s.perNode) })}
      toInput={(d) => ({ days: Number(d.days), perNode: Number(d.perNode) })}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="node-log-retention-save"
      errorTestId="node-log-retention-error"
    >
      {({ draft, set }) => (
        <>
          <NumberField
            id="node-log-retention-days"
            label={m.system_node_log_retention_days()}
            value={draft.days}
            onChange={(value) => set({ days: value })}
            min={days.minValue ?? 1}
            max={days.maxValue ?? undefined}
            step={1}
            required
            testId="node-log-retention-days"
          />
          <NumberField
            id="node-log-retention-per-node"
            label={m.system_node_log_retention_per_node()}
            value={draft.perNode}
            onChange={(value) => set({ perNode: value })}
            min={perNode.minValue ?? 1}
            max={perNode.maxValue ?? undefined}
            step={1000}
            required
            testId="node-log-retention-per-node"
          />
        </>
      )}
    </SettingsCard>
  );
}
