import { create } from "@bufbuild/protobuf";
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from "@edgeweir/contract";
import {
  type ClientAddress,
  ClientAddressSchema,
  type Listener,
  ListenerProtocol,
  ListenerSchema,
  type NodeConfig,
  type Site,
  type UnknownHosts,
  UnknownHostsSchema,
} from "@edgeweir/proto";
import type { ClientIpModel, EdgeModel, ListenerModel, UnknownHostsModel } from "./models";
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
