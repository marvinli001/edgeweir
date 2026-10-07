import { parseExpression } from "@edgeweir/rule-engine";
import type { CompileInput, SiteModel } from "../src/index";

export const site = (id: string, extra: Partial<SiteModel> = {}): SiteModel => ({
  id,
  name: id,
  enabled: true,
  cacheGeneration: 1,
  domains: [{ name: `${id}.test`, wildcard: false }],
  originPool: {
    id: `p-${id}`,
    policy: "weighted_random",
    origins: [
      {
        id: `o-${id}`,
        address: "origin.test",
        port: 80,
        scheme: "http",
        weight: 1,
        backup: false,
        hostHeader: "",
        sni: "",
      },
    ],
  },
  cacheRules: [],
  ...extra,
});

export const tls = (
  extra: Partial<NonNullable<SiteModel["tls"]>> = {},
): NonNullable<SiteModel["tls"]> => ({
  forceHttps: false,
  hstsMaxAge: 0,
  hstsIncludeSubdomains: false,
  hstsPreload: false,
  minimumVersion: "1.2",
  cipherProfile: "modern",
  http2: true,
  http3: false,
  gzip: true,
  gzipMinLength: 256,
  gzipTypes: ["text/html"],
  ocspStapling: false,
  ...extra,
});

export const certificate = {
  id: "cert",
  names: ["*.test"],
  sha256Fingerprint: "a".repeat(64),
};

/**
 * The console models behind the v0.23.0 vector: listeners 80, 443, 8081
 * and 9443 (HTTP/3 there), a site on 8081 and 9443 with a 308 redirect to
 * 9443 that leaves one domain alone, a site on the defaults, a header mode
 * client address setting, a rule reading ip.peer and layer-4 applications
 * with a port range on the arriving port and with TLS.
 */
export const v0230Models = (): CompileInput => ({
  clusterId: "c1",
  certificates: [{ ...certificate } as never],
  sites: [
    site("a", {
      domains: [
        { name: "a.test", wildcard: false },
        { name: "b.test", wildcard: false },
        { name: "w.test", wildcard: true },
      ],
      certificateId: "cert",
      tls: tls({
        forceHttps: true,
        http3: true,
        redirectStatus: 308,
        redirectPort: 9443,
        redirectExcludedDomains: ["*.w.test", "b.test"],
      }),
      ports: { http: [8081], https: [9443] },
      rules: [
        {
          id: "peer",
          phase: "waf-custom",
          expression: parseExpression("ip.peer in {10.0.0.0/8}", "waf-custom"),
          action: { kind: "block", statusCode: 403 },
        },
      ],
    }),
    site("d", { certificateId: "cert", tls: tls() }),
  ],
  edge: {
    httpPorts: [8081],
    httpsPorts: [9443],
    clientIp: {
      mode: "header",
      trustedCidrs: ["192.0.2.0/24", "10.0.0.0/8"],
      header: "x-forwarded-for",
      dropForwardedFor: false,
    },
  },
  l4Apps: [
    {
      id: "range",
      enabled: true,
      protocol: "tcp",
      port: 20000,
      portEnd: 20099,
      originPortMode: "same",
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      origins: [{ id: "o1", address: "198.51.100.7", port: 1, weight: 1, backup: false }],
      maxFails: 3,
      failTimeoutSeconds: 30,
      connectTimeoutMs: 5000,
      idleTimeoutSeconds: 600,
      allowListIds: [],
      blockListIds: [],
      maxConnections: 0,
      newConnectionsPerSecond: 0,
    },
    {
      id: "tls",
      enabled: true,
      protocol: "tcp",
      port: 21000,
      certificateId: "cert",
      tlsMinimumVersion: "1.3",
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      origins: [{ id: "o1", address: "198.51.100.8", port: 7000, weight: 1, backup: false }],
      maxFails: 3,
      failTimeoutSeconds: 30,
      connectTimeoutMs: 5000,
      idleTimeoutSeconds: 600,
      allowListIds: [],
      blockListIds: [],
      maxConnections: 0,
      newConnectionsPerSecond: 0,
    },
  ],
});
