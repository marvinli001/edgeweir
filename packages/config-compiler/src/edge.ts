import { create } from "@bufbuild/protobuf";
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from "@edgeweir/contract";
import {
  type ClientAddress,
  ClientAddressSchema,
  type ConnectionLimits,
  ConnectionLimitsSchema,
  type L4App,
  L4Protocol,
  type Listener,
  ListenerProtocol,
  ListenerSchema,
  type NodeConfig,
  PortRangeSchema,
  type Site,
  type UnknownHosts,
  UnknownHostsSchema,
} from "@edgeweir/proto";
import type {
  ClientIpModel,
  ConnectionLimitsModel,
  EdgeModel,
  ListenerModel,
  UnknownHostsModel,
} from "./models";
import { sortedSet } from "./sort";

/**
 * The listeners of compiled sites: 80 and the cluster's extra HTTP ports;
 * 443 while a site with a certificate is served there and the extra HTTPS
 * ports. An HTTPS port takes HTTP/2 and HTTP/3 when a site with a
 * certificate served there enables them; every listener takes the PROXY
 * protocol in the proxy_protocol mode. Without extra ports and sites
 * bound to other ports this is 80 plus 443 once a site has a certificate,
 * as before edge-ports-v1.
 */
export function listenersFor(
  sites: Pick<Site, "certificateId" | "tls" | "ports">[],
  edge?: EdgeModel,
): ListenerModel[] {
  const tlsSites = sites.filter((s) => s.certificateId);
  const on = (site: Pick<Site, "ports">, port: number) =>
    site.ports.length === 0 || site.ports.includes(port);
  const proxyProtocol = edge?.clientIp?.mode === "proxy_protocol";
  const https = sortedSet([
    ...(tlsSites.some((s) => on(s, DEFAULT_HTTPS_PORT)) ? [DEFAULT_HTTPS_PORT] : []),
    ...(edge?.httpsPorts ?? []),
  ]);
  const extra = (listener: ListenerModel) =>
    proxyProtocol ? { ...listener, proxyProtocol } : listener;
  return [
    ...sortedSet([DEFAULT_HTTP_PORT, ...(edge?.httpPorts ?? [])]).map((port) =>
      extra({ port, protocol: "http" as const }),
    ),
    ...https.map((port) => {
      const served = tlsSites.filter((s) => on(s, port));
      return extra({
        port,
        protocol: "https" as const,
        http2: served.some((s) => s.tls?.http2),
        http3: served.some((s) => s.tls?.http3),
      });
    }),
  ].sort((a, b) => a.port - b.port);
}

/** NodeConfig.client_address: unset for direct without dropping X-Forwarded-For. */
export function compileClientAddress(
  model: ClientIpModel | null | undefined,
): ClientAddress | undefined {
  if (!model || (model.mode === "direct" && !model.dropForwardedFor)) return undefined;
  return create(ClientAddressSchema, {
    mode: model.mode,
    trustedCidrs: model.mode === "header" ? sortedSet(model.trustedCidrs) : [],
    header: model.mode === "header" ? model.header : "",
    dropForwardedFor: model.mode === "direct" && model.dropForwardedFor,
  });
}

/**
 * NodeConfig.unknown_hosts: unset for the defaults (the platform's page for
 * both cases, scan protection off). A default site that is not among the
 * compiled sites hands nothing over (page), and its certificate is only
 * offered when it has one.
 */
export function compileUnknownHosts(
  model: UnknownHostsModel | null | undefined,
  sites: Pick<Site, "id" | "certificateId">[],
): UnknownHosts | undefined {
  if (!model) return undefined;
  const site = model.defaultSiteId ? sites.find((s) => s.id === model.defaultSiteId) : undefined;
  const resolve = (action: UnknownHostsModel["unknownHost"]) =>
    action === "site" && !site ? "page" : action;
  const unknownHost = resolve(model.unknownHost);
  const ipAccess = resolve(model.ipAccess);
  const scan = model.scanThreshold > 0;
  if (unknownHost === "page" && ipAccess === "page" && !scan) return undefined;
  const handsOver = unknownHost === "site" || ipAccess === "site";
  return create(UnknownHostsSchema, {
    unknownHost,
    ipAccess,
    defaultSiteId: handsOver && site ? site.id : "",
    defaultCertificate: model.defaultCertificate && unknownHost === "site" && !!site?.certificateId,
    scanThreshold: scan ? model.scanThreshold : 0,
    scanBanSeconds: scan ? model.scanBanSeconds : 0,
  });
}

/**
 * The listener ports, client address setting and unknown host handling a
 * compiled configuration was made with (refreshDerived keeps them when no
 * current ones are given).
 */
export function edgeOf(config: NodeConfig): EdgeModel {
  const extra = (protocol: ListenerProtocol, standard: number) =>
    config.listeners
      .filter((l) => l.protocol === protocol && l.port !== standard)
      .map((l) => l.port)
      .filter((port) => port !== DEFAULT_HTTP_PORT && port !== DEFAULT_HTTPS_PORT);
  const ca = config.clientAddress;
  const uh = config.unknownHosts;
  return {
    httpPorts: extra(ListenerProtocol.HTTP, DEFAULT_HTTP_PORT),
    httpsPorts: extra(ListenerProtocol.HTTPS, DEFAULT_HTTPS_PORT),
    clientIp: ca
      ? {
          mode: ca.mode as ClientIpModel["mode"],
          trustedCidrs: [...ca.trustedCidrs],
          header: ca.header,
          dropForwardedFor: ca.dropForwardedFor,
        }
      : null,
    // Only configurations with unknown host handling carry it.
    ...(uh
      ? {
          unknownHosts: {
            unknownHost: uh.unknownHost as UnknownHostsModel["unknownHost"],
            ipAccess: uh.ipAccess as UnknownHostsModel["ipAccess"],
            defaultSiteId: uh.defaultSiteId || null,
            defaultCertificate: uh.defaultCertificate,
            scanThreshold: uh.scanThreshold,
            scanBanSeconds: uh.scanBanSeconds,
          },
        }
      : {}),
  };
}

export const compileListener = (l: ListenerModel): Listener =>
  create(ListenerSchema, {
    port: l.port,
    protocol: l.protocol === "https" ? ListenerProtocol.HTTPS : ListenerProtocol.HTTP,
    http2: l.http2 ?? false,
    http3: l.http3 ?? false,
    proxyProtocol: l.proxyProtocol ?? false,
  });

/** Port ranges nodes accept in ConnectionLimits.ports. */
const NODE_PORT_RANGES = 256;

/**
 * Sorted ranges, overlapping and adjacent ones merged. Beyond `max` ranges
 * the two separated by the smallest gap are merged (the gap's ports are
 * limited too) until they fit.
 */
export function mergePortRanges(
  ranges: readonly { start: number; end: number }[],
  max = NODE_PORT_RANGES,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  while (out.length > max) {
    let at = 1;
    for (let i = 2; i < out.length; i++) {
      const gap = (out[i]?.start ?? 0) - (out[i - 1]?.end ?? 0);
      if (gap < (out[at]?.start ?? 0) - (out[at - 1]?.end ?? 0)) at = i;
    }
    const [next] = out.splice(at, 1);
    const prev = out[at - 1];
    if (prev && next) prev.end = next.end;
  }
  return out;
}

/** The TCP ports the cluster's nodes listen on: listeners and TCP layer-4 applications. */
export function clusterTcpPorts(
  listeners: readonly Pick<Listener, "port">[],
  l4Apps: readonly Pick<L4App, "protocol" | "port" | "portEnd">[],
): { start: number; end: number }[] {
  return mergePortRanges([
    ...listeners.map((l) => ({ start: l.port, end: l.port })),
    ...l4Apps
      .filter((app) => app.protocol === L4Protocol.TCP)
      .map((app) => ({ start: app.port, end: Math.max(app.port, app.portEnd) })),
  ]);
}

/**
 * NodeConfig.connection_limits: unset without limits; the ports are the
 * operator's ranges or the cluster's TCP ports, merged and sorted (unset
 * when there are none).
 */
export function compileConnectionLimits(
  model: ConnectionLimitsModel | null | undefined,
  listeners: readonly Pick<Listener, "port">[],
  l4Apps: readonly Pick<L4App, "protocol" | "port" | "portEnd">[],
): ConnectionLimits | undefined {
  if (!model || (model.perIp === 0 && model.newPerSecond === 0)) return undefined;
  const ports = model.ports ? mergePortRanges(model.ports) : clusterTcpPorts(listeners, l4Apps);
  if (ports.length === 0) return undefined;
  return create(ConnectionLimitsSchema, {
    perIpConnections: model.perIp,
    newPerSecond: model.newPerSecond,
    burst: model.newPerSecond > 0 ? Math.max(model.burst, model.newPerSecond) : 0,
    ports: ports.map((r) => create(PortRangeSchema, r)),
  });
}
