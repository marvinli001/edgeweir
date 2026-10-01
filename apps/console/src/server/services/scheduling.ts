import {
  type DnsLine,
  type ProbeSettings,
  type SchedulingPreview,
  type SchedulingRule,
  type SchedulingRuleInput,
  type SchedulingRuleUpdateInput,
  withLineDefaults,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit, systemActor } from "./audit";
import { publishClusterDns, reconcileBinding } from "./dns";
import { withLease } from "./dns-lease";
import { nodeIpRows, type SchedulingAddress, schedulingAddressesOf } from "./node-addresses";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import { getProbeSettings, probeWindowSeconds } from "./probes";
import type { Executor, Tx } from "./revisions";

/** The worker evaluates every cluster this often (and after each probe report). */
export const SCHEDULING_INTERVAL_MS = 10_000;
/** Node metrics older than this (four missed heartbeats) count as missing. */
export const METRICS_FRESH_MS = 60_000;
/** A probe report evaluates its clusters at most this often per console process. */
const TRIGGER_DEBOUNCE_MS = 2000;

type RuleRow = typeof schema.schedulingRule.$inferSelect;
type StateRow = typeof schema.schedulingState.$inferSelect;
type NodeRow = typeof schema.node.$inferSelect;
type ResultRow = typeof schema.probeResult.$inferSelect;
type State = "idle" | "pending" | "active" | "recovering";
type Condition = RuleRow["conditions"][number];

/** What one evaluation knows about a cluster. */
interface ClusterData {
  cluster: { id: string; name: string };
  nodes: NodeRow[];
  addresses: Map<string, SchedulingAddress[]>;
  /** Fresh results (inside the window) of enabled probers about the cluster's nodes. */
  results: ResultRow[];
  rules: RuleRow[];
  states: StateRow[];
  lines: DnsLine[];
}

/** Null once the cluster is gone. */
async function loadClusterData(
  db: Executor,
  clusterId: string,
  settings: ProbeSettings,
  now: Date,
): Promise<ClusterData | null> {
  const [cluster] = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  if (!cluster) return null;
  const nodes = await db.select().from(schema.node).where(eq(schema.node.clusterId, clusterId));
  const nodeIds = nodes.map((n) => n.id);
  const ips = await nodeIpRows(db, nodeIds);
  const addresses = new Map(nodeIds.map((id) => [id, schedulingAddressesOf(ips.get(id) ?? [])]));
  const since = new Date(now.getTime() - probeWindowSeconds(settings) * 1000);
  const fresh = nodeIds.length
    ? await db
        .select()
        .from(schema.probeResult)
        .where(
          and(
            inArray(schema.probeResult.nodeId, nodeIds),
            gte(schema.probeResult.checkedAt, since),
          ),
        )
    : [];
  // Only probers that are still allowed to probe count.
  const proberIds = [...new Set(fresh.map((r) => r.proberId))];
  const probes = proberIds.length
    ? await db
        .select({ id: schema.probe.id })
        .from(schema.probe)
        .where(and(inArray(schema.probe.id, proberIds), eq(schema.probe.enabled, true)))
    : [];
  const nodeProbers = proberIds.length
    ? await db
        .select({ id: schema.node.id })
        .from(schema.node)
        .where(
          and(
            inArray(schema.node.id, proberIds),
            eq(schema.node.probeEnabled, true),
            eq(schema.node.status, "active"),
          ),
        )
    : [];
  const allowed = new Set([...probes, ...nodeProbers].map((p) => p.id));
  const results = fresh.filter((r) => allowed.has(r.proberId));
  const rules = await db
    .select()
    .from(schema.schedulingRule)
    .where(eq(schema.schedulingRule.clusterId, clusterId))
    .orderBy(schema.schedulingRule.createdAt, schema.schedulingRule.id);
  const states = rules.length
    ? await db
        .select()
        .from(schema.schedulingState)
        .where(
          inArray(
            schema.schedulingState.ruleId,
            rules.map((r) => r.id),
          ),
        )
    : [];
  const [binding] = await db
    .select({ lines: schema.dnsBinding.lines })
    .from(schema.dnsBinding)
    .where(eq(schema.dnsBinding.clusterId, clusterId));
  return {
    cluster,
    nodes,
    addresses,
    results,
    rules,
    states,
    lines: (binding?.lines ?? []).map(withLineDefaults),
  };
}

/** Loss per prober (percent of attempts) over the rows, and the mean RTT of answered targets. */
function perProber(rows: ResultRow[]) {
  const by = new Map<string, ResultRow[]>();
  for (const r of rows) by.set(r.proberId, [...(by.get(r.proberId) ?? []), r]);
  return [...by.values()].map((own) => {
    const sent = own.reduce((n, r) => n + r.sent, 0);
    const lost = own.reduce((n, r) => n + r.lost, 0);
    const answered = own.filter((r) => r.sent > r.lost);
    return {
      loss: sent ? (100 * lost) / sent : null,
      latency: answered.length ? answered.reduce((n, r) => n + r.rttMs, 0) / answered.length : null,
    };
  });
}

function aggregate(values: number[], how: string): number | null {
  if (!values.length) return null;
  if (how === "max") return Math.max(...values);
  if (how === "min") return Math.min(...values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * A condition's current value for a node: its own heartbeat metrics (fresh
 * within a minute), or the probers' view of its primary scheduling
 * addresses (the lowest level), aggregated over the probers of the region
 * (or all), each prober's loss or latency over its fresh results.
 */
function metricValue(data: ClusterData, node: NodeRow, c: Condition, now: Date): number | null {
  if (c.metric === "probe_loss_percent" || c.metric === "probe_latency_ms") {
    const own = data.addresses.get(node.id) ?? [];
    const primary = new Set(own.filter((a) => a.level === own[0]?.level).map((a) => a.address));
    const rows = data.results.filter(
      (r) =>
        r.nodeId === node.id &&
        primary.has(r.address) &&
        (c.regionId === null || r.regionId === c.regionId),
    );
    const values = perProber(rows)
      .map((p) => (c.metric === "probe_loss_percent" ? p.loss : p.latency))
      .filter((v): v is number => v !== null);
    return aggregate(values, c.aggregate);
  }
  const m = node.metrics;
  if (!m || now.getTime() - new Date(m.reportedAt).getTime() > METRICS_FRESH_MS) return null;
  switch (c.metric) {
    case "cpu_percent":
      return m.cpuPercent;
    case "load1":
      return m.load1;
    case "memory_percent":
      return m.memoryTotalBytes > 0 ? (100 * m.memoryUsedBytes) / m.memoryTotalBytes : null;
    case "egress_mbps":
      return m.egressBps / 1e6;
    case "connections":
      return m.activeConnections;
    default:
      return null;
  }
}

function compare(value: number, comparator: string, threshold: number) {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "ge":
      return value >= threshold;
    case "lt":
      return value < threshold;
    default:
      return value <= threshold;
  }
}

/**
 * Nodes a rule looks at: the cluster's enabled nodes, or with a line those
 * of the line's group (and of its backup groups, except for backup_group,
 * which switches the line when one of its own group's nodes matches).
 */
function applicableNodes(rule: RuleRow, data: ClusterData): Set<string> {
  const active = data.nodes.filter((n) => n.status === "active");
  if (!rule.lineName) return new Set(active.map((n) => n.id));
  const line = data.lines.find((l) => l.name === rule.lineName);
  if (!line) return new Set();
  const groups = new Set([
    line.nodeGroupId,
    ...(rule.action === "backup_group" ? [] : line.backupNodeGroupIds),
  ]);
  return new Set(active.filter((n) => n.nodeGroupId && groups.has(n.nodeGroupId)).map((n) => n.id));
}

interface Step {
  state: State;
  conditionSince: (string | null)[];
  activeSince: Date | null;
  clearSince: Date | null;
  values: (number | null)[];
  holds: boolean[];
  heldSeconds: number[];
  satisfied: boolean[];
  matches: boolean;
  rawMatch: boolean;
  event: "activated" | "recovered" | null;
}

/**
 * One evaluation of a rule for a node. A condition is satisfied once its
 * comparison held for its duration; the rule matches when all (or any)
 * conditions are satisfied, and starts its action then. An active action
 * stays while the comparisons hold (without durations); once they do not,
 * it is recovering, and it ends after recoverSeconds clear and at least
 * holdSeconds after it started. A comparison that holds again while
 * recovering makes it active again (the recovery wait restarts).
 */
function step(
  rule: RuleRow,
  prev: StateRow | undefined,
  values: (number | null)[],
  applicable: boolean,
  now: Date,
): Step {
  const t = now.getTime();
  const holds = rule.conditions.map((c, i) => {
    const v = values[i];
    return (
      applicable &&
      rule.enabled &&
      v !== null &&
      v !== undefined &&
      compare(v, c.comparator, c.threshold)
    );
  });
  const conditionSince = holds.map((h, i) =>
    h ? (prev?.conditionSince[i] ?? now.toISOString()) : null,
  );
  const heldMs = conditionSince.map((s) => (s ? Math.max(0, t - new Date(s).getTime()) : 0));
  const satisfied = holds.map(
    (h, i) => h && (heldMs[i] ?? 0) >= (rule.conditions[i]?.durationSeconds ?? 0) * 1000,
  );
  const combine = (xs: boolean[]) => (rule.match === "any" ? xs.some(Boolean) : xs.every(Boolean));
  const matches = holds.length > 0 && combine(satisfied);
  const rawMatch = holds.length > 0 && combine(holds);
  const base = {
    conditionSince,
    values,
    holds,
    heldSeconds: heldMs.map((ms) => Math.floor(ms / 1000)),
    satisfied,
    matches,
    rawMatch,
  };
  const previous = (prev?.state ?? "idle") as State;
  if (previous === "idle" || previous === "pending") {
    if (matches)
      return { ...base, state: "active", activeSince: now, clearSince: null, event: "activated" };
    return {
      ...base,
      state: rawMatch ? "pending" : "idle",
      activeSince: null,
      clearSince: null,
      event: null,
    };
  }
  const activeSince = prev?.activeSince ?? now;
  if (rawMatch) return { ...base, state: "active", activeSince, clearSince: null, event: null };
  const clearSince = previous === "recovering" ? (prev?.clearSince ?? now) : now;
  if (
    t - clearSince.getTime() >= rule.recoverSeconds * 1000 &&
    t - activeSince.getTime() >= rule.holdSeconds * 1000
  )
    return { ...base, state: "idle", activeSince: null, clearSince: null, event: "recovered" };
  return { ...base, state: "recovering", activeSince, clearSince, event: null };
}

/** The nodes a rule is evaluated for: those it applies to and those it still has a state for. */
function evaluated(rule: RuleRow, data: ClusterData) {
  const applicable = applicableNodes(rule, data);
  const stated = new Set(data.states.filter((s) => s.ruleId === rule.id).map((s) => s.nodeId));
  return {
    applicable,
    nodes: data.nodes.filter((n) => applicable.has(n.id) || stated.has(n.id)),
  };
}

const alertResource = (ruleId: string, nodeId: string) => `${ruleId}:${nodeId}`;
const alertName = (rule: { name: string }, node: { name: string }) => `${rule.name} · ${node.name}`;

/**
 * Probe-driven reachability of every scheduling address of the cluster's
 * enabled nodes: failing while more than half of the probers that reported
 * it in the window lost at least lossPercent of their attempts (all ports);
 * down once failing lasted ipDownSeconds; up again once it did not fail
 * for ipUpSeconds. Returns whether an address went down or up.
 */
async function updateAddressStates(
  tx: Tx,
  data: ClusterData,
  settings: ProbeSettings,
  now: Date,
): Promise<boolean> {
  const nodeIds = data.nodes.map((n) => n.id);
  const existing = nodeIds.length
    ? await tx
        .select()
        .from(schema.nodeAddressState)
        .where(inArray(schema.nodeAddressState.nodeId, nodeIds))
    : [];
  const t = now.getTime();
  let flipped = false;
  const keep = new Set<string>();
  for (const node of data.nodes.filter((n) => n.status === "active")) {
    for (const { address } of data.addresses.get(node.id) ?? []) {
      keep.add(`${node.id}|${address}`);
      const probers = perProber(
        data.results.filter((r) => r.nodeId === node.id && r.address === address),
      ).filter((p) => p.loss !== null);
      // A strict majority: one region losing an address is for region-scoped rules.
      const failing =
        probers.filter((p) => (p.loss ?? 0) >= settings.lossPercent).length * 2 > probers.length;
      const prev = existing.find((e) => e.nodeId === node.id && e.address === address);
      let down = prev?.down ?? false;
      let failingSince = prev?.failingSince ?? null;
      let answeringSince = prev?.answeringSince ?? null;
      let changedAt = prev?.changedAt ?? now;
      if (!down) {
        answeringSince = null;
        if (!failing) failingSince = null;
        else {
          failingSince ??= now;
          if (t - failingSince.getTime() >= settings.ipDownSeconds * 1000) {
            down = true;
            failingSince = null;
            changedAt = now;
            flipped = true;
          }
        }
      } else {
        failingSince = null;
        if (failing) answeringSince = null;
        else {
          answeringSince ??= now;
          if (t - answeringSince.getTime() >= settings.ipUpSeconds * 1000) {
            down = false;
            answeringSince = null;
            changedAt = now;
            flipped = true;
          }
        }
      }
      const same =
        prev &&
        prev.down === down &&
        prev.failingSince?.getTime() === failingSince?.getTime() &&
        prev.answeringSince?.getTime() === answeringSince?.getTime();
      if (same || (!prev && !down && !failingSince)) continue;
      const values = { nodeId: node.id, address, down, failingSince, answeringSince, changedAt };
      await tx
        .insert(schema.nodeAddressState)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.nodeAddressState.nodeId, schema.nodeAddressState.address],
          set: { down, failingSince, answeringSince, changedAt },
        });
    }
  }
  // Addresses no longer scheduled (or of disabled nodes) lose their state.
  for (const row of existing)
    if (!keep.has(`${row.nodeId}|${row.address}`)) {
      if (row.down) flipped = true;
      await tx
        .delete(schema.nodeAddressState)
        .where(
          and(
            eq(schema.nodeAddressState.nodeId, row.nodeId),
            eq(schema.nodeAddressState.address, row.address),
          ),
        );
    }
  return flipped;
}

async function writeState(tx: Tx, ruleId: string, nodeId: string, st: Step, now: Date) {
  const values = {
    ruleId,
    nodeId,
    state: st.state,
    conditionSince: st.conditionSince,
    activeSince: st.activeSince,
    clearSince: st.clearSince,
    evaluatedAt: now,
  };
  await tx
    .insert(schema.schedulingState)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.schedulingState.ruleId, schema.schedulingState.nodeId],
      set: values,
    });
}

const sameState = (prev: StateRow | undefined, st: Step) =>
  !!prev &&
  prev.state === st.state &&
  JSON.stringify(prev.conditionSince) === JSON.stringify(st.conditionSince) &&
  prev.activeSince?.getTime() === st.activeSince?.getTime() &&
  prev.clearSince?.getTime() === st.clearSince?.getTime();

/**
 * Evaluates one cluster in a transaction (serialized per cluster): address
 * reachability, then every rule for every node. A changed address level
 * publishes the cluster's DNS (reason health); each activation and recovery
 * publishes it (reason scheduling, with rule, node, action and event), is
 * audited with the system identity and raises or resolves the
 * scheduling_action platform alert. Returns whether a DNS revision was
 * published.
 */
async function evaluateCluster(
  db: Database,
  clusterId: string,
  settings: ProbeSettings,
  now: Date,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.scheduling.${clusterId}`}))`,
    );
    const data = await loadClusterData(tx, clusterId, settings, now);
    if (!data) return false;
    let published = false;
    if (await updateAddressStates(tx, data, settings, now))
      published = !!(await publishClusterDns(tx, clusterId, "health")) || published;
    const transitions: { rule: RuleRow; node: NodeRow; st: Step }[] = [];
    for (const rule of data.rules) {
      const { applicable, nodes } = evaluated(rule, data);
      for (const node of nodes) {
        const prev = data.states.find((s) => s.ruleId === rule.id && s.nodeId === node.id);
        const values = rule.conditions.map((c) => metricValue(data, node, c, now));
        const st = step(rule, prev, values, applicable.has(node.id), now);
        if (st.event) transitions.push({ rule, node, st });
        else if (st.state === "idle" && !st.conditionSince.some(Boolean)) {
          if (prev)
            await tx
              .delete(schema.schedulingState)
              .where(
                and(
                  eq(schema.schedulingState.ruleId, rule.id),
                  eq(schema.schedulingState.nodeId, node.id),
                ),
              );
        } else if (!sameState(prev, st)) await writeState(tx, rule.id, node.id, st, now);
      }
    }
    for (const { rule, node, st } of transitions) {
      await writeState(tx, rule.id, node.id, st, now);
      const event = st.event as "activated" | "recovered";
      const revision = await publishClusterDns(tx, clusterId, "scheduling", {
        ruleId: rule.id,
        rule: rule.name,
        nodeId: node.id,
        node: node.name,
        action: rule.action,
        event,
      });
      if (revision) published = true;
      await recordAudit(tx, systemActor, {
        action: event === "activated" ? "scheduling.activate" : "scheduling.recover",
        targetType: "scheduling_rule",
        targetId: rule.id,
        targetName: rule.name,
        metadata: {
          clusterId,
          nodeId: node.id,
          nodeName: node.name,
          action: rule.action,
          lineName: rule.lineName,
          values: st.values,
          dnsRevision: revision?.revision ?? null,
        },
      });
      if (event === "activated")
        await raisePlatformAlert(
          tx,
          "scheduling_action",
          alertResource(rule.id, node.id),
          alertName(rule, node),
          now,
        );
      else
        await resolvePlatformAlert(
          tx,
          "scheduling_action",
          alertResource(rule.id, node.id),
          alertName(rule, node),
          now,
        );
    }
    return published;
  });
}

/**
 * Evaluates the given clusters (default: every cluster). Returns the
 * clusters whose DNS binding got a new revision, for the caller to write.
 */
export async function evaluateScheduling(
  app: Pick<AppContext, "db">,
  opts: { now?: Date; clusterIds?: readonly string[] } = {},
) {
  const now = opts.now ?? new Date();
  const settings = await getProbeSettings(app.db);
  const ids =
    opts.clusterIds ??
    (await app.db.select({ id: schema.cluster.id }).from(schema.cluster)).map((c) => c.id);
  const published: string[] = [];
  for (const clusterId of [...new Set(ids)].sort())
    if (await evaluateCluster(app.db, clusterId, settings, now)) published.push(clusterId);
  return { published };
}

/** Writes the clusters' DNS now (each binding under its own lease), logging failures. */
export async function writeClusterDns(app: AppContext, clusterIds: readonly string[]) {
  for (const clusterId of clusterIds)
    await reconcileBinding(app, clusterId).catch((error: unknown) =>
      app.log.warn("scheduled DNS write failed", { clusterId, error }),
    );
}

/** The worker's 10-second evaluation; one console process at a time (lease). */
export async function schedulingTick(app: AppContext) {
  await withLease(app.db, "scheduling:evaluate", 60, async () => {
    const { published } = await evaluateScheduling(app);
    await writeClusterDns(app, published);
  });
}

const lastTriggered = new Map<string, number>();
/**
 * Evaluates the clusters a probe report concerns right away (at most every
 * 2 s per cluster and process); the DNS write runs in the background.
 */
export async function evaluateAfterProbeReport(app: AppContext, clusterIds: readonly string[]) {
  const now = Date.now();
  const due = clusterIds.filter((id) => now - (lastTriggered.get(id) ?? 0) >= TRIGGER_DEBOUNCE_MS);
  if (!due.length) return;
  for (const id of due) lastTriggered.set(id, now);
  try {
    const { published } = await evaluateScheduling(app, { clusterIds: due });
    if (published.length) void writeClusterDns(app, published);
  } catch (error) {
    app.log.warn("scheduling evaluation after a probe report failed", { error });
  }
}

// ---- rules ----

async function findRule(db: Executor, id: string) {
  const [row] = await db
    .select()
    .from(schema.schedulingRule)
    .where(eq(schema.schedulingRule.id, id));
  if (!row) fail("SCHEDULING_RULE_NOT_FOUND", "scheduling rule not found");
  return row;
}

async function toRuleDtos(db: Executor, rules: RuleRow[]): Promise<SchedulingRule[]> {
  if (!rules.length) return [];
  const states = await db
    .select({ state: schema.schedulingState, nodeName: schema.node.name })
    .from(schema.schedulingState)
    .innerJoin(schema.node, eq(schema.node.id, schema.schedulingState.nodeId))
    .where(
      and(
        inArray(
          schema.schedulingState.ruleId,
          rules.map((r) => r.id),
        ),
        inArray(schema.schedulingState.state, ["active", "recovering"]),
      ),
    );
  return rules.map((r) => ({
    id: r.id,
    clusterId: r.clusterId,
    lineName: r.lineName,
    name: r.name,
    enabled: r.enabled,
    match: r.match === "any" ? "any" : "all",
    conditions: r.conditions as SchedulingRule["conditions"],
    action: r.action as SchedulingRule["action"],
    holdSeconds: r.holdSeconds,
    recoverSeconds: r.recoverSeconds,
    activeNodes: states
      .filter((s) => s.state.ruleId === r.id)
      .map((s) => ({
        nodeId: s.state.nodeId,
        nodeName: s.nodeName,
        since: (s.state.activeSince ?? s.state.evaluatedAt).toISOString(),
      }))
      .sort((a, b) => a.nodeName.localeCompare(b.nodeName)),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function ruleDto(db: Executor, id: string) {
  const [dto] = await toRuleDtos(db, [await findRule(db, id)]);
  if (!dto) fail("SCHEDULING_RULE_NOT_FOUND", "scheduling rule not found");
  return dto;
}

export async function listSchedulingRules(db: Executor, clusterId?: string) {
  if (clusterId) await assertCluster(db, clusterId);
  const rules = await db
    .select()
    .from(schema.schedulingRule)
    .where(clusterId ? eq(schema.schedulingRule.clusterId, clusterId) : undefined)
    .orderBy(schema.schedulingRule.createdAt, schema.schedulingRule.id);
  return toRuleDtos(db, rules);
}

async function assertCluster(db: Executor, clusterId: string) {
  const [cluster] = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return cluster;
}

/**
 * A line the rule names must exist in the cluster's binding; backup_group
 * needs one. `changed` false skips the line lookup (an update that leaves
 * line and action alone keeps working after the binding renamed the line).
 */
async function validateRule(
  db: Executor,
  clusterId: string,
  rule: Pick<RuleRow, "lineName" | "action" | "conditions">,
  changed = { line: true, conditions: true },
) {
  if (rule.action === "backup_group" && !rule.lineName)
    fail("SCHEDULING_RULE_INVALID", "backup_group needs a line");
  if (rule.lineName && changed.line) {
    const [binding] = await db
      .select({ lines: schema.dnsBinding.lines })
      .from(schema.dnsBinding)
      .where(eq(schema.dnsBinding.clusterId, clusterId));
    if (!binding?.lines.some((l) => l.name === rule.lineName))
      fail("SCHEDULING_RULE_INVALID", "the cluster's DNS binding has no such line");
  }
  const regionIds = [
    ...new Set(rule.conditions.map((c) => c.regionId).filter((r): r is string => !!r)),
  ];
  if (regionIds.length && changed.conditions) {
    const found = await db
      .select({ id: schema.region.id })
      .from(schema.region)
      .where(inArray(schema.region.id, regionIds));
    if (found.length !== regionIds.length) fail("REGION_NOT_FOUND", "region not found");
  }
}

export async function createSchedulingRule(
  db: Database,
  input: SchedulingRuleInput,
  actor: Actor,
): Promise<SchedulingRule> {
  await assertCluster(db, input.clusterId);
  await validateRule(db, input.clusterId, input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.schedulingRule)
      .values({
        clusterId: input.clusterId,
        lineName: input.lineName,
        name: input.name,
        enabled: input.enabled,
        match: input.match,
        conditions: input.conditions,
        action: input.action,
        holdSeconds: input.holdSeconds,
        recoverSeconds: input.recoverSeconds,
      })
      .returning();
    if (!row) throw new Error("scheduling rule insert failed");
    await recordAudit(tx, actor, {
      action: "scheduling.rule_create",
      targetType: "scheduling_rule",
      targetId: row.id,
      targetName: row.name,
      metadata: { ...input },
    });
    return ruleDto(tx, row.id);
  });
}

/**
 * Ends what a rule does now (its state rows go): resolves its alerts and
 * publishes the cluster's DNS once per node it acted on (reason scheduling,
 * event recovered). Returns the nodes and whether DNS was published.
 */
async function endRuleEffects(tx: Tx, rule: RuleRow) {
  const states = await tx
    .select({ state: schema.schedulingState, nodeName: schema.node.name })
    .from(schema.schedulingState)
    .innerJoin(schema.node, eq(schema.node.id, schema.schedulingState.nodeId))
    .where(eq(schema.schedulingState.ruleId, rule.id));
  await tx.delete(schema.schedulingState).where(eq(schema.schedulingState.ruleId, rule.id));
  let published = false;
  const ended: string[] = [];
  for (const { state, nodeName } of states) {
    if (state.state !== "active" && state.state !== "recovering") continue;
    ended.push(state.nodeId);
    const node = { name: nodeName };
    await resolvePlatformAlert(
      tx,
      "scheduling_action",
      alertResource(rule.id, state.nodeId),
      alertName(rule, node),
    );
    const revision = await publishClusterDns(tx, rule.clusterId, "scheduling", {
      ruleId: rule.id,
      rule: rule.name,
      nodeId: state.nodeId,
      node: nodeName,
      action: rule.action,
      event: "recovered",
    });
    if (revision) published = true;
  }
  return { ended, published };
}

export async function updateSchedulingRule(
  app: AppContext,
  input: SchedulingRuleUpdateInput,
  actor: Actor,
): Promise<SchedulingRule> {
  const before = await findRule(app.db, input.id);
  const next = {
    lineName: input.lineName !== undefined ? input.lineName : before.lineName,
    action: input.action ?? before.action,
    conditions: input.conditions ?? before.conditions,
  };
  await validateRule(app.db, before.clusterId, next, {
    line: input.lineName !== undefined || input.action !== undefined,
    conditions: input.conditions !== undefined,
  });
  const { dto, published } = await app.db.transaction(async (tx) => {
    const current = await findRule(tx, input.id);
    // What the rule matches or does changes: its states and effects start over.
    const reset =
      (input.enabled === false && current.enabled) ||
      (input.lineName !== undefined && input.lineName !== current.lineName) ||
      (input.match !== undefined && input.match !== current.match) ||
      (input.action !== undefined && input.action !== current.action) ||
      (input.conditions !== undefined &&
        JSON.stringify(input.conditions) !== JSON.stringify(current.conditions));
    const effects = reset ? await endRuleEffects(tx, current) : { ended: [], published: false };
    const [row] = await tx
      .update(schema.schedulingRule)
      .set({
        ...(input.lineName !== undefined ? { lineName: input.lineName } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.match !== undefined ? { match: input.match } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.holdSeconds !== undefined ? { holdSeconds: input.holdSeconds } : {}),
        ...(input.recoverSeconds !== undefined ? { recoverSeconds: input.recoverSeconds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.schedulingRule.id, input.id))
      .returning();
    if (!row) throw new Error("scheduling rule update failed");
    const { id: _id, ...changes } = input;
    await recordAudit(tx, actor, {
      action: "scheduling.rule_update",
      targetType: "scheduling_rule",
      targetId: row.id,
      targetName: row.name,
      metadata: {
        clusterId: row.clusterId,
        from: {
          name: current.name,
          enabled: current.enabled,
          lineName: current.lineName,
          match: current.match,
          conditions: current.conditions,
          action: current.action,
          holdSeconds: current.holdSeconds,
          recoverSeconds: current.recoverSeconds,
        },
        to: changes,
        ...(reset ? { endedNodeIds: effects.ended } : {}),
      },
    });
    return { dto: await ruleDto(tx, row.id), published: effects.published };
  });
  if (published) void writeClusterDns(app, [before.clusterId]);
  return dto;
}

export async function deleteSchedulingRule(app: AppContext, id: string, actor: Actor) {
  const { clusterId, published } = await app.db.transaction(async (tx) => {
    const rule = await findRule(tx, id);
    const effects = await endRuleEffects(tx, rule);
    await tx.delete(schema.schedulingRule).where(eq(schema.schedulingRule.id, id));
    await recordAudit(tx, actor, {
      action: "scheduling.rule_delete",
      targetType: "scheduling_rule",
      targetId: id,
      targetName: rule.name,
      metadata: { clusterId: rule.clusterId, action: rule.action, endedNodeIds: effects.ended },
    });
    return { clusterId: rule.clusterId, published: effects.published };
  });
  if (published) void writeClusterDns(app, [clusterId]);
  return { ok: true as const };
}

/**
 * Every rule of the cluster against every node it looks at, under the
 * current metrics: each condition's value, whether it holds and for how
 * long, the state and what the next evaluation would do. Writes nothing.
 */
export async function previewScheduling(
  db: Executor,
  clusterId: string,
  now = new Date(),
): Promise<SchedulingPreview> {
  await assertCluster(db, clusterId);
  const settings = await getProbeSettings(db);
  const data = await loadClusterData(db, clusterId, settings, now);
  if (!data) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return {
    clusterId,
    evaluatedAt: now.toISOString(),
    rules: data.rules.map((rule) => {
      const { applicable, nodes } = evaluated(rule, data);
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        enabled: rule.enabled,
        lineName: rule.lineName,
        match: rule.match === "any" ? ("any" as const) : ("all" as const),
        action: rule.action as SchedulingRule["action"],
        nodes: nodes.map((node) => {
          const prev = data.states.find((s) => s.ruleId === rule.id && s.nodeId === node.id);
          const values = rule.conditions.map((c) => metricValue(data, node, c, now));
          const st = step(rule, prev, values, applicable.has(node.id), now);
          const stored = (prev?.state ?? "idle") as State;
          const inEffect = stored === "active" || stored === "recovering";
          const activeSince = prev?.activeSince ?? null;
          const recoveringSince = stored === "recovering" ? (prev?.clearSince ?? null) : null;
          const clearStart = st.clearSince ?? now;
          return {
            nodeId: node.id,
            nodeName: node.name,
            state: inEffect ? stored : st.rawMatch && applicable.has(node.id) ? "pending" : "idle",
            conditions: rule.conditions.map((c, i) => ({
              metric: c.metric as SchedulingRule["conditions"][number]["metric"],
              aggregate: c.aggregate as "avg" | "max" | "min",
              comparator: c.comparator as "gt" | "ge" | "lt" | "le",
              threshold: c.threshold,
              durationSeconds: c.durationSeconds,
              regionId: c.regionId,
              value: st.values[i] ?? null,
              holds: st.holds[i] ?? false,
              heldSeconds: st.heldSeconds[i] ?? 0,
              satisfied: st.satisfied[i] ?? false,
            })),
            matches: st.matches,
            inEffect,
            wouldActivate: st.event === "activated",
            wouldRecover: st.event === "recovered",
            activeSince: activeSince?.toISOString() ?? null,
            recoveringSince: recoveringSince?.toISOString() ?? null,
            recoversAt:
              inEffect && activeSince
                ? new Date(
                    Math.max(
                      activeSince.getTime() + rule.holdSeconds * 1000,
                      clearStart.getTime() + rule.recoverSeconds * 1000,
                    ),
                  ).toISOString()
                : null,
          };
        }),
      };
    }),
  };
}
