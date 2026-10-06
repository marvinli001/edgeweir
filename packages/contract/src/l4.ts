import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, originAddress, port, revision, uuid } from "./schemas";

/** Ports layer-4 applications and port pools may use. */
export const L4_PORT_MIN = 1024;
export const L4_PORT_MAX = 65535;
/** Port pools per cluster. */
export const MAX_PORT_POOLS = 64;
/** Origins of one application. */
export const MAX_L4_ORIGINS = 32;
/** Allow or block lists of one application. */
export const MAX_L4_APP_LISTS = 16;
/** Ports of one application's range. */
export const MAX_L4_RANGE_PORTS = 1000;
/** Listening ports of a cluster's applications, ranges counted in full (L4_PORT_LIMIT). */
export const MAX_L4_PORTS_PER_CLUSTER = 2048;
/**
 * l4-v2: port ranges, origins on the arriving port and TLS termination of
 * TCP applications.
 */
export const L4_V2_FEATURE = "l4-v2";
/** Longest range l4Apps.stats covers: the retention of the minute statistics. */
export const L4_STATS_MAX_RANGE_SECONDS = 7 * 86400;

/** Defaults of a new application; the idle timeout depends on the protocol. */
export const L4_APP_DEFAULTS = {
  maxFails: 3,
  failTimeoutSeconds: 30,
  connectTimeoutMs: 5000,
  idleTimeoutSeconds: { tcp: 600, udp: 30 },
} as const;

const l4Port = z.number().int().min(L4_PORT_MIN).max(L4_PORT_MAX);
export const l4Protocol = z.enum(["tcp", "udp"]);
/** `both` counts for TCP and UDP. */
export const portPoolProtocol = z.enum(["tcp", "udp", "both"]);

/** A range of ports, inclusive. */
export const portPool = z
  .object({ protocol: portPoolProtocol, from: l4Port, to: l4Port })
  .refine((pool) => pool.from <= pool.to, {
    message: "the first port must not be above the last",
    path: ["to"],
  });

/**
 * Replaces the cluster's port pools. Pools of a protocol must not overlap
 * (L4_PORT_POOL_OVERLAP), never contain a port of the cluster's HTTP(S)
 * listeners (L4_PORT_RESERVED) and must keep every application's port
 * (L4_PORT_IN_USE).
 */
export const portPoolsInput = z.object({
  clusterId: uuid,
  pools: z.array(portPool).max(MAX_PORT_POOLS),
});

export const clusterPortPools = z.object({
  clusterId: uuid,
  /** Sorted by first port, then protocol. */
  pools: z.array(
    z.object({ protocol: portPoolProtocol, from: z.number().int(), to: z.number().int() }),
  ),
  /** Ports of the cluster's HTTP(S) listeners; never part of a pool. */
  reservedPorts: z.array(z.number().int()),
  /**
   * Active nodes of the cluster that do not report l4-v1: they refuse
   * configurations with applications until they are upgraded.
   */
  nodesWithoutL4: z.array(z.object({ id: uuid, name: z.string() })),
  /** Active nodes without l4-v2: port ranges, origins on the arriving port and TLS wait for them. */
  nodesWithoutL4V2: z.array(z.object({ id: uuid, name: z.string() })),
});

export const l4OriginInput = z.object({
  /** Host name or IP literal; the origin address policy applies as for sites. */
  address: originAddress,
  /** Required unless the application's originPortMode is same (L4_ORIGIN_PORT_REQUIRED). */
  port: port.optional(),
  weight: z.number().int().min(1).max(100).default(1),
  /** Used only while every other origin is down. */
  backup: z.boolean().default(false),
});

/** 1-32 origins, at least one of them not a backup. */
export const l4Origins = z
  .array(l4OriginInput)
  .min(1)
  .max(MAX_L4_ORIGINS)
  .refine((origins) => origins.some((origin) => !origin.backup), {
    message: "at least one origin must not be a backup",
  });

/** Ids of IP lists, without duplicates. */
const listIds = z
  .array(uuid)
  .max(MAX_L4_APP_LISTS)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

const fields = {
  name: z.string().trim().min(1).max(100),
  protocol: l4Protocol,
  /** Inside a port pool of the cluster for the protocol (L4_PORT_OUTSIDE_POOL). */
  port: l4Port,
  /**
   * The last port of a range port..portEnd (above port, at most 1000 ports,
   * every one inside one port pool); null: the single port.
   */
  portEnd: l4Port.nullable(),
  /** fixed: each origin's port; same: the port the connection arrived on (for ranges). */
  originPortMode: z.enum(["fixed", "same"]),
  /**
   * TCP only (L4_TLS_UNSUPPORTED): the node terminates TLS with this
   * certificate (L4_CERTIFICATE_UNAVAILABLE) and forwards plain TCP; the
   * SNI must be one of its names. null: plain TCP.
   */
  certificateId: uuid.nullable(),
  tlsMinimumVersion: z.enum(["1.2", "1.3"]),
  /** TCP only: the listener expects a PROXY protocol header (v1 or v2). */
  acceptProxyProtocol: z.boolean(),
  /** TCP only: PROXY protocol version sent to the origins; 0 sends none. */
  proxyProtocolVersion: z.number().int().min(0).max(2),
  origins: l4Origins,
  /** Passive health check: consecutive connection failures that take an origin out. */
  maxFails: z.number().int().min(1).max(100),
  /** Passive health check: seconds before a failed origin is tried again. */
  failTimeoutSeconds: z.number().int().min(1).max(3600),
  connectTimeoutMs: z.number().int().min(100).max(60_000),
  /** Idle timeout of a connection (TCP) or session (UDP). */
  idleTimeoutSeconds: z.number().int().min(1).max(86_400),
  /** IP lists whose addresses alone are accepted (none: every address). */
  allowListIds: listIds,
  /** IP lists whose addresses are refused. */
  blockListIds: listIds,
  /** Concurrent connections or sessions per node; 0 means no limit. */
  maxConnections: z.number().int().min(0).max(10_000_000),
  /** New connections or sessions per second and node; 0 means no limit. */
  newConnectionsPerSecond: z.number().int().min(0).max(1_000_000),
};

export const l4AppCreateInput = z.object({
  clusterId: uuid,
  name: fields.name,
  protocol: fields.protocol,
  port: fields.port,
  enabled: z.boolean().default(true),
  acceptProxyProtocol: fields.acceptProxyProtocol.default(false),
  proxyProtocolVersion: fields.proxyProtocolVersion.default(0),
  portEnd: fields.portEnd.default(null),
  originPortMode: fields.originPortMode.default("fixed"),
  certificateId: fields.certificateId.default(null),
  tlsMinimumVersion: fields.tlsMinimumVersion.default("1.2"),
  origins: fields.origins,
  maxFails: fields.maxFails.default(L4_APP_DEFAULTS.maxFails),
  failTimeoutSeconds: fields.failTimeoutSeconds.default(L4_APP_DEFAULTS.failTimeoutSeconds),
  connectTimeoutMs: fields.connectTimeoutMs.default(L4_APP_DEFAULTS.connectTimeoutMs),
  /** Omitted: 600 for TCP, 30 for UDP. */
  idleTimeoutSeconds: fields.idleTimeoutSeconds.optional(),
  allowListIds: fields.allowListIds.default([]),
  blockListIds: fields.blockListIds.default([]),
  maxConnections: fields.maxConnections.default(0),
  newConnectionsPerSecond: fields.newConnectionsPerSecond.default(0),
});

/** Changes the fields given; `origins` replaces the list. */
export const l4AppUpdateInput = z.object({
  id: uuid,
  /** Optimistic concurrency: the `updatedAt` last read (UPDATED_AT_MISMATCH). */
  expectedUpdatedAt: isoDateTime.optional(),
  name: fields.name.optional(),
  protocol: fields.protocol.optional(),
  port: fields.port.optional(),
  acceptProxyProtocol: fields.acceptProxyProtocol.optional(),
  proxyProtocolVersion: fields.proxyProtocolVersion.optional(),
  portEnd: fields.portEnd.optional(),
  originPortMode: fields.originPortMode.optional(),
  certificateId: fields.certificateId.optional(),
  tlsMinimumVersion: fields.tlsMinimumVersion.optional(),
  origins: fields.origins.optional(),
  maxFails: fields.maxFails.optional(),
  failTimeoutSeconds: fields.failTimeoutSeconds.optional(),
  connectTimeoutMs: fields.connectTimeoutMs.optional(),
  idleTimeoutSeconds: fields.idleTimeoutSeconds.optional(),
  allowListIds: fields.allowListIds.optional(),
  blockListIds: fields.blockListIds.optional(),
  maxConnections: fields.maxConnections.optional(),
  newConnectionsPerSecond: fields.newConnectionsPerSecond.optional(),
});

export const l4AppSetEnabledInput = z.object({
  id: uuid,
  enabled: z.boolean(),
  expectedUpdatedAt: isoDateTime.optional(),
});

export const l4Origin = z.object({
  id: uuid,
  address: z.string(),
  /** 0 with originPortMode same. */
  port: z.number().int(),
  weight: z.number().int(),
  backup: z.boolean(),
});

export const l4App = z.object({
  id: uuid,
  clusterId: uuid,
  clusterName: z.string(),
  name: z.string(),
  protocol: l4Protocol,
  port: z.number().int(),
  /** A disabled application is not shipped to nodes and has no DNS record. */
  enabled: z.boolean(),
  acceptProxyProtocol: z.boolean(),
  proxyProtocolVersion: z.number().int(),
  /** The last port of the range; null: a single port. */
  portEnd: z.number().int().nullable(),
  originPortMode: z.enum(["fixed", "same"]),
  certificateId: uuid.nullable(),
  /** The certificate's name; null without TLS. */
  certificateName: z.string().nullable(),
  tlsMinimumVersion: z.enum(["1.2", "1.3"]),
  /** In the order they were saved. */
  origins: z.array(l4Origin),
  maxFails: z.number().int(),
  failTimeoutSeconds: z.number().int(),
  connectTimeoutMs: z.number().int(),
  idleTimeoutSeconds: z.number().int(),
  allowListIds: z.array(uuid),
  blockListIds: z.array(uuid),
  maxConnections: z.number().int(),
  newConnectionsPerSecond: z.number().int(),
  /**
   * The CNAME clients connect to, `<application id>.<cluster DNS domain>`
   * (published while the application is enabled); null while the
   * cluster's DNS is off.
   */
  dnsTarget: z.string().nullable(),
  /** Per DNS line: `<line>.<application id>.<domain>` with line aliases, else `<line>.<domain>`. */
  dnsLines: z.array(z.object({ name: z.string(), target: z.string() })),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const l4AppMutationResult = z.object({ app: l4App, revision });

/** A range of at most 7 days (the minute statistics are kept that long). */
export const l4StatsInput = z
  .object({ id: uuid, from: isoDateTime, to: isoDateTime })
  .refine((input) => Date.parse(input.from) < Date.parse(input.to), {
    message: "the range must start before it ends",
    path: ["from"],
  })
  .refine(
    (input) => Date.parse(input.to) - Date.parse(input.from) <= L4_STATS_MAX_RANGE_SECONDS * 1000,
    { message: "the range must not be longer than 7 days", path: ["from"] },
  );

const l4Counters = {
  /** Connections (TCP) or sessions (UDP) accepted. */
  connections: z.number().int(),
  /** Connections or sessions refused by the IP lists or the limits. */
  refused: z.number().int(),
  /**
   * Highest concurrency: per minute the sum over nodes of their peaks,
   * the highest such minute in a point or the range.
   */
  peakConcurrent: z.number().int(),
  /** Bytes received from clients. */
  bytesReceived: z.number().int(),
  /** Bytes sent to clients. */
  bytesSent: z.number().int(),
};

export const l4Stats = z.object({
  appId: uuid,
  from: isoDateTime,
  to: isoDateTime,
  /** Width of a point: 60 s for ranges up to a day, 300 s up to five days, else 3600 s. */
  bucketSeconds: z.number().int(),
  /** One point per bucket from the bucket of `from`, oldest first; empty buckets are zero. */
  points: z.array(z.object({ time: isoDateTime, ...l4Counters })),
  totals: z.object(l4Counters),
  /** The range per node that reported, busiest first. */
  nodes: z.array(z.object({ nodeId: uuid, nodeName: z.string(), ...l4Counters })),
});

const idParam = z.object({ id: uuid });

/** Port pools of a cluster (procedures clusters.portPools and clusters.setPortPools). */
export const portPoolProcedures = {
  portPools: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/port-pools", tags: ["l4"] })
    .input(z.object({ clusterId: uuid }))
    .output(clusterPortPools),
  setPortPools: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/port-pools", tags: ["l4"] })
    .input(portPoolsInput)
    .output(clusterPortPools),
};

/** Layer-4 (TCP / UDP) applications forwarded by every node of their cluster. */
export const l4AppsContract = {
  list: oc
    .route({ method: "GET", path: "/l4-apps", tags: ["l4"] })
    .input(z.object({ clusterId: uuid.optional() }))
    .output(z.array(l4App)),
  get: oc
    .route({ method: "GET", path: "/l4-apps/{id}", tags: ["l4"] })
    .input(idParam)
    .output(l4App),
  create: oc
    .route({ method: "POST", path: "/l4-apps", tags: ["l4"], successStatus: 201 })
    .input(l4AppCreateInput)
    .output(l4AppMutationResult),
  update: oc
    .route({ method: "PATCH", path: "/l4-apps/{id}", tags: ["l4"] })
    .input(l4AppUpdateInput)
    .output(l4AppMutationResult),
  delete: oc
    .route({ method: "DELETE", path: "/l4-apps/{id}", tags: ["l4"] })
    .input(idParam)
    .output(z.object({ revision })),
  /** A disabled application keeps its port; it is not shipped to nodes and loses its DNS record. */
  setEnabled: oc
    .route({ method: "PUT", path: "/l4-apps/{id}/enabled", tags: ["l4"] })
    .input(l4AppSetEnabledInput)
    .output(l4AppMutationResult),
  /** Per-minute counters the nodes reported, with totals and the nodes' shares. */
  stats: oc
    .route({ method: "GET", path: "/l4-apps/{id}/stats", tags: ["l4"] })
    .input(l4StatsInput)
    .output(l4Stats),
};

export type L4Protocol = z.infer<typeof l4Protocol>;
export type PortPoolProtocol = z.infer<typeof portPoolProtocol>;
export type PortPool = z.infer<typeof portPool>;
export type PortPoolsInput = z.infer<typeof portPoolsInput>;
export type ClusterPortPools = z.infer<typeof clusterPortPools>;
export type L4App = z.infer<typeof l4App>;
export type L4AppCreateInput = z.infer<typeof l4AppCreateInput>;
export type L4AppUpdateInput = z.infer<typeof l4AppUpdateInput>;
export type L4AppSetEnabledInput = z.infer<typeof l4AppSetEnabledInput>;
export type L4AppMutationResult = z.infer<typeof l4AppMutationResult>;
export type L4StatsInput = z.infer<typeof l4StatsInput>;
export type L4Stats = z.infer<typeof l4Stats>;
