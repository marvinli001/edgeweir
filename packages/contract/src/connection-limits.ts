import { oc } from "@orpc/contract";
import * as z from "zod";
import { uuid } from "./schemas";

/**
 * Per-client TCP connection limits of a cluster, enforced by its nodes in
 * the kernel (nftables, after the allow and ban sets): concurrent
 * connections and new connections per second of an IPv4 address or an IPv6
 * /64, on the cluster's listener and TCP layer-4 application ports or on
 * the ports named. Packets over a limit are dropped. UDP is not limited.
 * Nodes without nftables (CAP_NET_ADMIN) accept the setting without
 * enforcing it and say so.
 */

/** conn-limit-v1: the node understands the limits and reports whether it enforces them. */
export const CONN_LIMIT_FEATURE = "conn-limit-v1";

export const CONNECTION_LIMIT_MAX = 100_000;
export const CONNECTION_BURST_MAX = 1_000_000;
/** Port ranges the operator may name. */
export const CONNECTION_LIMIT_PORT_RANGES = 64;
export const CONNECTION_LIMIT_DEFAULTS = { perIp: 256, newPerSecond: 50, burst: 100 } as const;

const port = z.number().int().min(1).max(65_535);
const portRange = z
  .object({ start: port, end: port })
  .refine((r) => r.end >= r.start, { message: "end before start", path: ["end"] });

export const connectionLimitSettings = z
  .object({
    enabled: z.boolean(),
    /** Concurrent connections per client; 0: no limit. */
    perIp: z.number().int().min(0).max(CONNECTION_LIMIT_MAX),
    /** New connections per second per client; 0: no limit. */
    newPerSecond: z.number().int().min(0).max(CONNECTION_LIMIT_MAX),
    /** New connections above the rate a client may open at once; 0 is newPerSecond. */
    burst: z.number().int().min(0).max(CONNECTION_BURST_MAX),
    /** Null: the cluster's listener and TCP layer-4 application ports. */
    ports: z.array(portRange).min(1).max(CONNECTION_LIMIT_PORT_RANGES).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.enabled && s.perIp === 0 && s.newPerSecond === 0)
      ctx.addIssue({ code: "custom", message: "set a limit", path: ["perIp"] });
    if (s.burst > 0 && s.burst < s.newPerSecond)
      ctx.addIssue({ code: "custom", message: "burst below the rate", path: ["burst"] });
    if (s.burst > 0 && s.newPerSecond === 0)
      ctx.addIssue({ code: "custom", message: "burst without a rate", path: ["burst"] });
    const sorted = [...(s.ports ?? [])].sort((a, b) => a.start - b.start);
    sorted.forEach((r, i) => {
      const prev = sorted[i - 1];
      if (prev && r.start <= prev.end)
        ctx.addIssue({ code: "custom", message: "port ranges overlap", path: ["ports"] });
    });
  });

const connectionLimitsInput = z.object({ clusterId: uuid, settings: connectionLimitSettings });

const clusterConnectionLimits = z.object({
  clusterId: uuid,
  settings: z.object({
    enabled: z.boolean(),
    perIp: z.number().int(),
    newPerSecond: z.number().int(),
    burst: z.number().int(),
    ports: z.array(z.object({ start: z.number().int(), end: z.number().int() })).nullable(),
  }),
  /** The ports the nodes limit (the cluster's ports when settings.ports is null). */
  effectivePorts: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  /** Active nodes: those that enforce the limits, and those that do not with the reason. */
  nodes: z.object({
    total: z.number().int(),
    enforcing: z.number().int(),
    /** Without conn-limit-v1 (an older version). */
    unsupported: z.array(z.object({ id: uuid, name: z.string() })),
    /** With conn-limit-v1 but not enforcing (no nftables, refused); error is the node's. */
    failing: z.array(z.object({ id: uuid, name: z.string(), error: z.string() })),
  }),
});

/** clusters.connectionLimits and clusters.setConnectionLimits. */
export const connectionLimitProcedures = {
  connectionLimits: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/connection-limits", tags: ["clusters"] })
    .input(z.object({ clusterId: uuid }))
    .output(clusterConnectionLimits),
  setConnectionLimits: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/connection-limits", tags: ["clusters"] })
    .input(connectionLimitsInput)
    .output(clusterConnectionLimits),
};

export type ConnectionLimitsInput = z.infer<typeof connectionLimitsInput>;
export type ClusterConnectionLimits = z.infer<typeof clusterConnectionLimits>;
