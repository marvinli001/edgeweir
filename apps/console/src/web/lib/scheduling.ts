import {
  PROBE_METRICS,
  type SchedulingAction,
  type SchedulingCondition,
  type SchedulingMetric,
  type SchedulingPreview,
} from "@edgeweir/contract";
import { formatNumber, formatPercent, getLocale, m } from "@/lib/i18n";

type Aggregate = SchedulingCondition["aggregate"];
type Comparator = SchedulingCondition["comparator"];
type State = SchedulingPreview["rules"][number]["nodes"][number]["state"];

export const SCHEDULING_METRICS: readonly SchedulingMetric[] = [
  "cpu_percent",
  "load1",
  "memory_percent",
  "egress_mbps",
  "connections",
  "probe_loss_percent",
  "probe_latency_ms",
];
export const SCHEDULING_AGGREGATES: readonly Aggregate[] = ["avg", "max", "min"];
export const SCHEDULING_COMPARATORS: readonly Comparator[] = ["gt", "ge", "lt", "le"];
export const SCHEDULING_ACTIONS: readonly SchedulingAction[] = [
  "remove_node",
  "backup_group",
  "backup_ip",
];

export const isProbeMetric = (metric: SchedulingMetric) => PROBE_METRICS.includes(metric);

export const metricLabel = (metric: SchedulingMetric) =>
  ({
    cpu_percent: m.scheduling_metric_cpu_percent,
    load1: m.scheduling_metric_load1,
    memory_percent: m.scheduling_metric_memory_percent,
    egress_mbps: m.scheduling_metric_egress_mbps,
    connections: m.scheduling_metric_connections,
    probe_loss_percent: m.scheduling_metric_probe_loss_percent,
    probe_latency_ms: m.scheduling_metric_probe_latency_ms,
  })[metric]();

/** The unit a threshold is entered in; empty for plain numbers (load, connections). */
export const metricUnit = (metric: SchedulingMetric) =>
  ({
    cpu_percent: "%",
    load1: "",
    memory_percent: "%",
    egress_mbps: "Mbps",
    connections: "",
    probe_loss_percent: "%",
    probe_latency_ms: "ms",
  })[metric];

export const aggregateLabel = (aggregate: Aggregate) =>
  ({
    avg: m.scheduling_aggregate_avg,
    max: m.scheduling_aggregate_max,
    min: m.scheduling_aggregate_min,
  })[aggregate]();

/** Comparison signs are the same in every language. */
export const comparatorSign = (comparator: Comparator) =>
  ({ gt: ">", ge: "≥", lt: "<", le: "≤" })[comparator];

export const actionLabel = (action: SchedulingAction) =>
  ({
    remove_node: m.scheduling_action_remove_node,
    backup_group: m.scheduling_action_backup_group,
    backup_ip: m.scheduling_action_backup_ip,
  })[action]();

export const stateLabel = (state: State) =>
  ({
    idle: m.scheduling_state_idle,
    pending: m.scheduling_state_pending,
    active: m.scheduling_state_active,
    recovering: m.scheduling_state_recovering,
  })[state]();

export const matchLabel = (match: "all" | "any") =>
  match === "all" ? m.scheduling_match_all() : m.scheduling_match_any();

const decimal = (value: number, digits = 2) =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: digits }).format(value);

/** A metric value (or threshold) with its unit: "87.5%", "1.25", "120 Mbps", "38 ms". */
export function formatMetric(metric: SchedulingMetric, value: number): string {
  switch (metric) {
    case "cpu_percent":
    case "memory_percent":
    case "probe_loss_percent":
      return formatPercent(value);
    case "connections":
      return formatNumber(value);
    case "egress_mbps":
      return `${decimal(value)} Mbps`;
    case "probe_latency_ms":
      return `${decimal(value, 0)} ms`;
    default:
      return decimal(value);
  }
}

/** "CPU usage", or "Probe loss (Maximum · East China)" for probe metrics. */
export function conditionSubject(
  condition: Pick<SchedulingCondition, "metric" | "aggregate" | "regionId">,
  regionName?: (id: string) => string | undefined,
): string {
  if (!isProbeMetric(condition.metric)) return metricLabel(condition.metric);
  const scope = [
    aggregateLabel(condition.aggregate),
    ...(condition.regionId ? [regionName?.(condition.regionId) ?? ""] : []),
  ].filter(Boolean);
  return `${metricLabel(condition.metric)} (${scope.join(" · ")})`;
}

/** "CPU usage > 90%" or "Probe loss (Maximum · East China) ≥ 50%". */
export function conditionText(
  condition: Pick<
    SchedulingCondition,
    "metric" | "aggregate" | "comparator" | "threshold" | "regionId"
  >,
  regionName?: (id: string) => string | undefined,
): string {
  return `${conditionSubject(condition, regionName)} ${comparatorSign(condition.comparator)} ${formatMetric(condition.metric, condition.threshold)}`;
}
