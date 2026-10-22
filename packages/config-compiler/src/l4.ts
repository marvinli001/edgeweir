import { create } from "@bufbuild/protobuf";
import { type L4App, L4AppSchema, L4OriginSchema, L4Protocol } from "@edgeweir/proto";
import type { L4AppModel } from "./models";
import { byBytes, sortedByteSet } from "./sort";

/**
 * NodeConfig.l4_apps of the enabled applications: PROXY protocol only for
 * TCP, origins by id and list ids as sorted sets (canonicalize sorts the
 * applications).
 */
export function compileL4Apps(apps: readonly L4AppModel[] | undefined): L4App[] {
  return (apps ?? [])
    .filter((app) => app.enabled)
    .map((app) => {
      const tcp = app.protocol === "tcp";
      return create(L4AppSchema, {
        id: app.id,
        protocol: tcp ? L4Protocol.TCP : L4Protocol.UDP,
        port: app.port,
        acceptProxyProtocol: tcp && app.acceptProxyProtocol,
        proxyProtocolVersion: tcp ? app.proxyProtocolVersion : 0,
        // l4-v2: ranges, origins on the arriving port and TLS; unset
        // otherwise, so applications without them encode as before.
        portEnd: app.portEnd && app.portEnd > app.port ? app.portEnd : 0,
        certificateId: tcp && app.certificateId ? app.certificateId : "",
        tlsMinimumVersion: tcp && app.certificateId ? (app.tlsMinimumVersion ?? "1.2") : "",
        origins: [...app.origins].sort(byBytes((origin) => origin.id)).map((origin) =>
          create(L4OriginSchema, {
            id: origin.id,
            address: origin.address,
            port: app.originPortMode === "same" ? 0 : origin.port,
            weight: Math.max(1, origin.weight),
            backup: origin.backup,
          }),
        ),
        maxFails: app.maxFails,
        failTimeoutSeconds: app.failTimeoutSeconds,
        connectTimeoutMs: app.connectTimeoutMs,
        idleTimeoutSeconds: app.idleTimeoutSeconds,
        allowListIds: sortedByteSet(app.allowListIds),
        blockListIds: sortedByteSet(app.blockListIds),
        maxConnections: app.maxConnections,
        newConnectionsPerSecond: app.newConnectionsPerSecond,
      });
    });
}
