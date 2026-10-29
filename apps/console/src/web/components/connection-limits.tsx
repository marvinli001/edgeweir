import {
  type ClusterConnectionLimits,
  CONNECTION_BURST_MAX,
  CONNECTION_LIMIT_MAX,
  CONNECTION_LIMIT_PORT_RANGES,
  type ConnectionLimitsInput,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { OptionSelect } from "@/components/form-select";
import {
  GRID_CARD,
  SettingNumber,
  SettingRow,
  SettingRows,
} from "@/components/protection-settings";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { StatusDot } from "@/components/status-dot";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { formatPorts, parsePorts } from "@/lib/ports";
import { cn } from "@/lib/utils";

interface Draft {
  enabled: boolean;
  perIp: string;
  newPerSecond: string;
  burst: string;
  /** cluster: the cluster's own ports; custom: `ports`. */
  portMode: "cluster" | "custom";
  ports: string;
}

/** The nodes that enforce the limits, and the reason of each one that does not. */
function NodeStates({ value }: { value: ClusterConnectionLimits }) {
  const { nodes, settings } = value;
  if (!settings.enabled || nodes.total === 0) return null;
  return (
    <div className="flex flex-col gap-2 pt-3" data-testid="connection-limits-nodes">
      <StatusDot tone={nodes.enforcing === nodes.total ? "good" : "warn"}>
        {m.connection_limits_enforcing({ count: nodes.enforcing, total: nodes.total })}
      </StatusDot>
      {nodes.failing.map((node) => (
        <SafetyNote key={node.id}>
          {m.connection_limits_node_failing({ node: node.name, error: node.error || "—" })}
        </SafetyNote>
      ))}
      {nodes.unsupported.length ? (
        <SafetyNote>
          {m.connection_limits_unsupported({
            nodes: nodes.unsupported.map((n) => n.name).join(", "),
          })}
        </SafetyNote>
      ) : null}
    </div>
  );
}

/**
 * Protection page card: per-client TCP connection limits of a cluster, enforced in the kernel
 * by its nodes. One cluster at a time.
 */
export function ConnectionLimitsCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const [picked, setPicked] = React.useState<string | null>(null);
  const clusterId = picked ?? clusters.data?.[0]?.id ?? null;
  if (!clusterId) return null;
  const choices = (clusters.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  return (
    <SettingsCard
      indentSave={false}
      key={clusterId}
      title={m.connection_limits_title()}
      className={cn(GRID_CARD, className)}
      style={style}
      testId="connection-limits-card"
      query={orpc.clusters.connectionLimits.queryOptions({ input: { clusterId } })}
      mutation={orpc.clusters.setConnectionLimits.mutationOptions()}
      toDraft={(v): Draft => ({
        enabled: v.settings.enabled,
        perIp: String(v.settings.perIp),
        newPerSecond: String(v.settings.newPerSecond),
        burst: String(v.settings.burst),
        portMode: v.settings.ports ? "custom" : "cluster",
        ports: formatPorts(v.settings.ports ?? v.effectivePorts),
      })}
      toInput={(d): ConnectionLimitsInput => ({
        clusterId,
        settings: {
          enabled: d.enabled,
          perIp: Number(d.perIp),
          newPerSecond: Number(d.newPerSecond),
          burst: Number(d.burst),
          ports: d.portMode === "custom" ? (parsePorts(d.ports) ?? []) : null,
        },
      })}
      check={(input) => {
        const s = input.settings;
        if (s.ports && (s.ports.length === 0 || s.ports.length > CONNECTION_LIMIT_PORT_RANGES))
          return m.connection_limits_ports_invalid({ max: CONNECTION_LIMIT_PORT_RANGES });
        if (s.enabled && s.perIp === 0 && s.newPerSecond === 0) return m.connection_limits_none();
        if (s.burst > 0 && s.burst < s.newPerSecond) return m.connection_limits_burst_low();
        return null;
      }}
      saveTestId="connection-limits-save"
    >
      {({ value, draft, set }) => (
        <>
          <SettingRows>
            {choices.length > 1 ? (
              <SettingRow htmlFor="connection-limits-cluster" label={m.connection_limits_cluster()}>
                <OptionSelect
                  id="connection-limits-cluster"
                  label={m.connection_limits_cluster()}
                  className="w-56"
                  value={clusterId}
                  options={choices}
                  onChange={setPicked}
                  testId="connection-limits-cluster"
                />
              </SettingRow>
            ) : null}
            <SettingRow htmlFor="connection-limits-enabled" label={m.connection_limits_enabled()}>
              <Switch
                id="connection-limits-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => set({ enabled })}
                data-testid="connection-limits-enabled"
              />
            </SettingRow>
            <SettingRow htmlFor="connection-limits-per-ip" label={m.connection_limits_per_ip()}>
              <SettingNumber
                id="connection-limits-per-ip"
                value={draft.perIp}
                onChange={(perIp) => set({ perIp })}
                min={0}
                max={CONNECTION_LIMIT_MAX}
                testId="connection-limits-per-ip"
              />
            </SettingRow>
            <SettingRow htmlFor="connection-limits-rate" label={m.connection_limits_rate()}>
              <SettingNumber
                id="connection-limits-rate"
                value={draft.newPerSecond}
                onChange={(newPerSecond) => set({ newPerSecond })}
                min={0}
                max={CONNECTION_LIMIT_MAX}
                testId="connection-limits-rate"
              />
            </SettingRow>
            <SettingRow htmlFor="connection-limits-burst" label={m.connection_limits_burst()}>
              <SettingNumber
                id="connection-limits-burst"
                value={draft.burst}
                onChange={(burst) => set({ burst })}
                min={0}
                max={CONNECTION_BURST_MAX}
                testId="connection-limits-burst"
              />
            </SettingRow>
            <SettingRow htmlFor="connection-limits-port-mode" label={m.connection_limits_ports()}>
              <OptionSelect
                id="connection-limits-port-mode"
                label={m.connection_limits_ports()}
                className="w-56"
                value={draft.portMode}
                options={[
                  { value: "cluster", label: m.connection_limits_ports_cluster() },
                  { value: "custom", label: m.connection_limits_ports_custom() },
                ]}
                onChange={(portMode) => set({ portMode: portMode as Draft["portMode"] })}
                testId="connection-limits-port-mode"
              />
            </SettingRow>
            {draft.portMode === "custom" ? (
              <SettingRow
                htmlFor="connection-limits-port-list"
                label={m.connection_limits_port_list()}
              >
                <Input
                  id="connection-limits-port-list"
                  value={draft.ports}
                  onChange={(event) => set({ ports: event.target.value })}
                  aria-invalid={parsePorts(draft.ports) === null}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="80, 443, 10000-10999"
                  className="w-56 font-mono"
                  data-testid="connection-limits-port-list"
                />
              </SettingRow>
            ) : (
              <SettingRow
                htmlFor="connection-limits-port-mode"
                label={m.connection_limits_ports_effective()}
              >
                <span
                  className="font-mono text-sm text-muted-foreground"
                  data-testid="connection-limits-effective"
                >
                  {formatPorts(value.effectivePorts) || "—"}
                </span>
              </SettingRow>
            )}
          </SettingRows>
          <NodeStates value={value} />
        </>
      )}
    </SettingsCard>
  );
}
