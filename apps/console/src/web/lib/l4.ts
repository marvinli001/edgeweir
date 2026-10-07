import type { AnalyticsRange, L4Protocol, PortPoolProtocol } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

/** Protocols of an application, in menu order. Labels are protocol names, the same in every language. */
export const L4_PROTOCOLS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
] as const satisfies readonly { value: L4Protocol; label: string }[];

export const POOL_PROTOCOLS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "both", label: "TCP + UDP" },
] as const satisfies readonly { value: PortPoolProtocol; label: string }[];

export const protocolLabel = (protocol: PortPoolProtocol) =>
  POOL_PROTOCOLS.find((p) => p.value === protocol)?.label ?? protocol;

/** "20000–20020 TCP", or the single port when a pool has one. */
export function poolLabel(pool: { protocol: PortPoolProtocol; from: number; to: number }) {
  const ports = pool.from === pool.to ? String(pool.from) : `${pool.from}–${pool.to}`;
  return `${ports} ${protocolLabel(pool.protocol)}`;
}

/** Whether a pool takes connections of the protocol on the port. */
export const poolCovers = (
  pool: { protocol: PortPoolProtocol; from: number; to: number },
  protocol: L4Protocol,
  port: number,
) =>
  (pool.protocol === "both" || pool.protocol === protocol) && pool.from <= port && port <= pool.to;

/** host:port, with IPv6 literals in brackets; origins on the arriving port (port 0) show the host alone. */
export const originLabel = (origin: { address: string; port: number }) => {
  const host = origin.address.includes(":") ? `[${origin.address}]` : origin.address;
  return origin.port ? `${host}:${origin.port}` : host;
};

/** "9000" or a range "9000-9099". */
export const portsLabel = (app: { port: number; portEnd: number | null }) =>
  app.portEnd ? `${app.port}-${app.portEnd}` : String(app.port);

/**
 * The IP lists an application uses, in its order, as chips keyed by id: a
 * list's name, or the start of its id while the lists load or once it is gone.
 */
export const listChips = (ids: string[], lists: readonly { id: string; name: string }[] = []) =>
  ids.map((id) => ({ id, name: lists.find((list) => list.id === id)?.name ?? id.slice(0, 8) }));

/** PROXY protocol versions sent to the origins (0 sends none). */
export const PROXY_VERSIONS = [0, 1, 2] as const;

export const proxyVersionLabel = (version: number) =>
  version === 0 ? m.l4_proxy_none() : `v${version}`;

/** Ranges of the statistics view; the console keeps the minute statistics for 7 days. */
export const L4_STATS_RANGES = [
  "1h",
  "6h",
  "24h",
  "7d",
] as const satisfies readonly AnalyticsRange[];

export type L4StatsRange = (typeof L4_STATS_RANGES)[number];

export const L4_STATS_RANGE_SECONDS: Record<L4StatsRange, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 86400,
  "7d": 7 * 86400,
};

/** The code and data of an API error, for errors a form shows next to the field they concern. */
export function apiError(error: unknown): { code?: string; data: Record<string, unknown> } {
  if (!error || typeof error !== "object") return { data: {} };
  const e = error as { code?: unknown; data?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    data: e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {},
  };
}
