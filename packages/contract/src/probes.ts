import { oc } from "@orpc/contract";
import * as z from "zod";
import { dnsLineName } from "./dns";
import { isoDateTime, uuid } from "./schemas";

/**
 * Regional probes (`edgeweir-node probe`, or a node that also probes from its
 * node group's region) and how often they measure the nodes' scheduling
 * addresses; an address counts as unreachable once more than half of the
 * probers that reported it in the last window lost at least lossPercent of
 * their attempts for ipDownSeconds, and as reachable again after
 * ipUpSeconds without that.
 */
export const probeSettings = z
  .object({
    /** Seconds between probe rounds. */
    intervalSeconds: z.number().int().min(5).max(60),
    /** Milliseconds one attempt may take. */
    timeoutMs: z.number().int().min(500).max(10000),
    /** Attempts per target and round. */
    attempts: z.number().int().min(1).max(10),
    /** Share of lost attempts (percent) that counts as a failing address. */
    lossPercent: z.number().int().min(1).max(100),
    /** How long an address fails before the node switches to its next level. */
    ipDownSeconds: z.number().int().min(5).max(3600),
    /** How long a failed address answers again before the node switches back. */
    ipUpSeconds: z.number().int().min(5).max(3600),
  })
  .refine((s) => s.timeoutMs <= s.intervalSeconds * 1000, {
    message: "timeout longer than the interval",
    path: ["timeoutMs"],
  });
export type ProbeSettings = z.infer<typeof probeSettings>;
export const PROBE_SETTINGS_DEFAULTS: ProbeSettings = {
  intervalSeconds: 10,
  timeoutMs: 3000,
  attempts: 3,
  lossPercent: 50,
  ipDownSeconds: 30,
  ipUpSeconds: 60,
};

export const probeMethod = z.enum(["tcp", "http", "https"]);

export const probe = z.object({
  id: uuid,
  name: z.string(),
  regionId: uuid,
  regionName: z.string(),
  regionCode: z.string(),
  enabled: z.boolean(),
  /** Asked for targets or reported within three intervals. */
  online: z.boolean(),
  lastSeenAt: isoDateTime.nullable(),
  enrolledAt: isoDateTime.nullable(),
  hostname: z.string(),
  agentVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  certNotAfter: isoDateTime.nullable(),
  /** Targets the probe gets now (every scheduling address × listener port). */
  targets: z.number().int(),
  /** Its latest results: when, how many targets, how many lost every attempt. */
  lastRound: z
    .object({
      checkedAt: isoDateTime,
      results: z.number().int(),
      failed: z.number().int(),
      /** Lost attempts / sent attempts, in percent. */
      lossPercent: z.number(),
      /** Mean of the median round-trip times of the answering targets. */
      avgRttMs: z.number().nullable(),
    })
    .nullable(),
  createdAt: isoDateTime,
});

export const probeTokenInput = z.object({
  name: z.string().trim().min(1).max(64),
  regionId: uuid,
  ttlMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .default(60),
});

export const probeTokenResult = z.object({
  tokenId: uuid,
  /** `ewp_…`, shown once; the console keeps its SHA-256 only. */
  token: z.string(),
  expiresAt: isoDateTime,
  /** Node channel URL (EDGEWEIR_SERVER). */
  serverUrl: z.string(),
  /** SHA-256 of the node CA certificate (EDGEWEIR_CA_SHA256). */
  caSha256: z.string(),
  /** `docker run` command that starts the probe with this token. */
  command: z.string(),
});

export const probeResult = z.object({
  /** probe: an enrolled probe; node: a node that also probes. */
  proberKind: z.enum(["probe", "node"]),
  proberId: uuid,
  proberName: z.string(),
  regionId: uuid.nullable(),
  regionName: z.string().nullable(),
  nodeId: uuid,
  nodeName: z.string(),
  address: z.string(),
  port: z.number().int(),
  method: probeMethod,
  sent: z.number().int(),
  lost: z.number().int(),
  lossPercent: z.number(),
  /** Median round-trip time of the answered attempts; 0 when none answered. */
  rttMs: z.number().int(),
  /** Code of the last failure (timeout, refused, reset, tls, status, unreachable). */
  error: z.string(),
  checkedAt: isoDateTime,
});

const idParam = z.object({ id: uuid });
const ok = z.object({ ok: z.literal(true) });

export const probesContract = {
  list: oc.route({ method: "GET", path: "/probes", tags: ["probes"] }).output(z.array(probe)),
  /** A one-time token (1 hour by default) that enrolls one probe in a region. */
  createToken: oc
    .route({ method: "POST", path: "/probe-tokens", tags: ["probes"] })
    .input(probeTokenInput)
    .output(probeTokenResult),
  update: oc
    .route({ method: "PATCH", path: "/probes/{id}", tags: ["probes"] })
    .input(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(64).optional(),
        /** A disabled probe's certificate is refused (except for renewal) and its results ignored. */
        enabled: z.boolean().optional(),
      }),
    )
    .output(probe),
  /** Deletes the probe and revokes its certificate. */
  delete: oc
    .route({ method: "DELETE", path: "/probes/{id}", tags: ["probes"] })
    .input(idParam)
    .output(ok),
  /** Latest result per prober, node, address and port; filtered by prober and/or node. */
  results: oc
    .route({ method: "GET", path: "/probe-results", tags: ["probes"] })
    .input(z.object({ probeId: uuid.optional(), nodeId: uuid.optional() }))
    .output(z.array(probeResult)),
};

/**
 * A node's scheduling address as the operator configures it
 * (nodes.setAddresses): a unicast IP literal, private ranges included
 * (NODE_ADDRESS_INVALID otherwise).
 */
const schedulingAddressInput = z.object({
  address: z.string().trim().min(1).max(64),
  /** 0 primary, 1 first backup, 2 second backup. */
  level: z.number().int().min(0).max(2),
});
export const nodeAddressesInput = z
  .object({
    id: uuid,
    /** Replaces the configured addresses; empty: back to the addresses the node reports. */
    addresses: z.array(schedulingAddressInput).max(8),
  })
  .superRefine((input, ctx) => {
    if (input.addresses.length && !input.addresses.some((a) => a.level === 0))
      ctx.addIssue({
        code: "custom",
        message: "a primary address is required",
        path: ["addresses"],
      });
  });
export const nodeProbeInput = z.object({ id: uuid, enabled: z.boolean() });

export const schedulingMetric = z.enum([
  "cpu_percent",
  "load1",
  "memory_percent",
  "egress_mbps",
  "connections",
  "probe_loss_percent",
  "probe_latency_ms",
]);
export type SchedulingMetric = z.infer<typeof schedulingMetric>;
export const PROBE_METRICS: readonly SchedulingMetric[] = [
  "probe_loss_percent",
  "probe_latency_ms",
];
export const schedulingCondition = z
  .object({
    metric: schedulingMetric,
    /** Over the probers (probe metrics); a node metric is the node's own value. */
    aggregate: z.enum(["avg", "max", "min"]).default("avg"),
    comparator: z.enum(["gt", "ge", "lt", "le"]),
    threshold: z.number().min(0).max(1e12),
    /** How long the comparison must hold before the condition counts. */
    durationSeconds: z.number().int().min(0).max(3600).default(0),
    /** Probe metrics only: count the probers of this region alone. */
    regionId: uuid.nullable().default(null),
  })
  .refine((c) => c.regionId === null || PROBE_METRICS.includes(c.metric), {
    message: "a region applies to probe metrics only",
    path: ["regionId"],
  });
export type SchedulingCondition = z.infer<typeof schedulingCondition>;
/**
 * remove_node: the matching node leaves the rule's line (or every line);
 * backup_group: the rule's line answers with its backup node groups;
 * backup_ip: the matching node answers with its next address level.
 */
export const schedulingAction = z.enum(["remove_node", "backup_group", "backup_ip"]);
export type SchedulingAction = z.infer<typeof schedulingAction>;
const ruleFields = {
  /** Name of a line of the cluster's DNS binding; null: every line. backup_group needs one. */
  lineName: dnsLineName.nullable(),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  /** all: every condition must hold (and); any: one is enough (or). */
  match: z.enum(["all", "any"]),
  conditions: z.array(schedulingCondition).min(1).max(8),
  action: schedulingAction,
  /** The action stays at least this long. */
  holdSeconds: z.number().int().min(0).max(86400),
  /** The conditions must stay clear this long before the action recovers. */
  recoverSeconds: z.number().int().min(0).max(86400),
};
export const schedulingRuleInput = z.object({
  clusterId: uuid,
  lineName: ruleFields.lineName.default(null),
  name: ruleFields.name,
  enabled: ruleFields.enabled.default(true),
  match: ruleFields.match.default("all"),
  conditions: ruleFields.conditions,
  action: ruleFields.action,
  holdSeconds: ruleFields.holdSeconds.default(300),
  recoverSeconds: ruleFields.recoverSeconds.default(300),
});
export const schedulingRuleUpdateInput = z.object({
  id: uuid,
  lineName: ruleFields.lineName.optional(),
  name: ruleFields.name.optional(),
  enabled: ruleFields.enabled.optional(),
  match: ruleFields.match.optional(),
  conditions: ruleFields.conditions.optional(),
  action: ruleFields.action.optional(),
  holdSeconds: ruleFields.holdSeconds.optional(),
  recoverSeconds: ruleFields.recoverSeconds.optional(),
});
/** idle: conditions clear; pending: met but not yet for their durations; recovering: clear, waiting. */
export const schedulingState = z.enum(["idle", "pending", "active", "recovering"]);
export const schedulingRule = z.object({
  id: uuid,
  clusterId: uuid,
  lineName: z.string().nullable(),
  name: z.string(),
  enabled: z.boolean(),
  match: z.enum(["all", "any"]),
  conditions: z.array(schedulingCondition),
  action: schedulingAction,
  holdSeconds: z.number().int(),
  recoverSeconds: z.number().int(),
  /** Nodes the action applies to now (active or recovering). */
  activeNodes: z.array(z.object({ nodeId: uuid, nodeName: z.string(), since: isoDateTime })),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
const previewCondition = z.object({
  metric: schedulingMetric,
  aggregate: z.enum(["avg", "max", "min"]),
  comparator: z.enum(["gt", "ge", "lt", "le"]),
  threshold: z.number(),
  durationSeconds: z.number().int(),
  regionId: uuid.nullable(),
  /** Current value; null without data (no fresh metrics or no prober results). */
  value: z.number().nullable(),
  /** The comparison holds now. */
  holds: z.boolean(),
  /** How long it has held, as of the last evaluation. */
  heldSeconds: z.number().int(),
  /** It has held for at least durationSeconds. */
  satisfied: z.boolean(),
});
export const schedulingPreview = z.object({
  clusterId: uuid,
  evaluatedAt: isoDateTime,
  rules: z.array(
    z.object({
      ruleId: uuid,
      ruleName: z.string(),
      enabled: z.boolean(),
      lineName: z.string().nullable(),
      match: z.enum(["all", "any"]),
      action: schedulingAction,
      nodes: z.array(
        z.object({
          nodeId: uuid,
          nodeName: z.string(),
          state: schedulingState,
          conditions: z.array(previewCondition),
          /** The conditions are met now, with their durations. */
          matches: z.boolean(),
          /** The action applies now (active or recovering). */
          inEffect: z.boolean(),
          /** The next evaluation starts the action. */
          wouldActivate: z.boolean(),
          /** The next evaluation ends the action. */
          wouldRecover: z.boolean(),
          activeSince: isoDateTime.nullable(),
          recoveringSince: isoDateTime.nullable(),
          /** Earliest end of the action if the conditions stay clear. */
          recoversAt: isoDateTime.nullable(),
        }),
      ),
    }),
  ),
});

export const schedulingContract = {
  list: oc
    .route({ method: "GET", path: "/scheduling/rules", tags: ["scheduling"] })
    .input(z.object({ clusterId: uuid.optional() }))
    .output(z.array(schedulingRule)),
  create: oc
    .route({ method: "POST", path: "/scheduling/rules", tags: ["scheduling"], successStatus: 201 })
    .input(schedulingRuleInput)
    .output(schedulingRule),
  update: oc
    .route({ method: "PATCH", path: "/scheduling/rules/{id}", tags: ["scheduling"] })
    .input(schedulingRuleUpdateInput)
    .output(schedulingRule),
  /** Deletes the rule; an action it applies ends with a DNS revision. */
  delete: oc
    .route({ method: "DELETE", path: "/scheduling/rules/{id}", tags: ["scheduling"] })
    .input(idParam)
    .output(ok),
  /** Every rule of the cluster against every node under the current metrics; writes nothing. */
  preview: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/scheduling/preview",
      tags: ["scheduling"],
    })
    .input(z.object({ clusterId: uuid }))
    .output(schedulingPreview),
};

export type Probe = z.infer<typeof probe>;
export type ProbeResultDto = z.infer<typeof probeResult>;
export type ProbeTokenResult = z.infer<typeof probeTokenResult>;
export type SchedulingRule = z.infer<typeof schedulingRule>;
export type SchedulingRuleInput = z.infer<typeof schedulingRuleInput>;
export type SchedulingRuleUpdateInput = z.infer<typeof schedulingRuleUpdateInput>;
export type SchedulingPreview = z.infer<typeof schedulingPreview>;
export type NodeAddressesInput = z.infer<typeof nodeAddressesInput>;
