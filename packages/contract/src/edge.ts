import { oc } from "@orpc/contract";
import * as z from "zod";
import { normalizeCidr } from "./addresses";
import { uuid } from "./schemas";

/** Extra HTTP and extra HTTPS listener ports of a cluster, each. */
export const MAX_EXTRA_LISTEN_PORTS = 16;
/** The ports every cluster listens on: HTTP 80 and HTTPS 443. */
export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
/** Trusted proxy CIDRs of the header mode. */
export const MAX_TRUSTED_PROXY_CIDRS = 64;
/** Domains of a site the HTTPS redirect may leave alone. */
export const MAX_REDIRECT_EXCLUDED_DOMAINS = 50;
/** Status codes of the HTTPS redirect. */
export const HTTPS_REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

/**
 * edge-ports-v1: listeners besides 80 and 443, the ports a site is served
 * on and the HTTPS redirect's status, port and excluded domains.
 */
export const EDGE_PORTS_FEATURE = "edge-ports-v1";
/**
 * client-ip-v1: the cluster's client address setting (PROXY protocol on the
 * HTTP(S) listeners or a header of trusted proxies) and the rule field
 * ip.peer.
 */
export const CLIENT_IP_FEATURE = "client-ip-v1";

const extraPort = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .refine((port) => port !== DEFAULT_HTTP_PORT && port !== DEFAULT_HTTPS_PORT, {
    message: "80 and 443 are always listened on",
  });

/** Sorted, without duplicates. */
const extraPorts = z
  .array(extraPort)
  .max(MAX_EXTRA_LISTEN_PORTS)
  .transform((ports) => [...new Set(ports)].sort((a, b) => a - b));

/**
 * Replaces a cluster's extra listener ports. A port is HTTP or HTTPS, never
 * both (LISTEN_PORT_CONFLICT), never inside a port pool of the cluster
 * (LISTEN_PORT_IN_POOL), and stays while a site uses it (LISTEN_PORT_IN_USE).
 */
export const listenPortsInput = z.object({
  clusterId: uuid,
  httpPorts: extraPorts,
  httpsPorts: extraPorts,
});

export const clusterListenPorts = z.object({
  clusterId: uuid,
  /** Sorted; 80 and 443 are not listed (always there). */
  httpPorts: z.array(z.number().int()),
  httpsPorts: z.array(z.number().int()),
  /** Active nodes without edge-ports-v1: extra ports wait until they are upgraded. */
  nodesWithout: z.array(z.object({ id: uuid, name: z.string() })),
});

/** Header names the header mode offers; any other lowercase token may be named too. */
export const CLIENT_IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

/** Headers that can never name the client (the node refuses them as well). */
const REFUSED_CLIENT_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
  "content-type",
  "cookie",
  "authorization",
  "cdn-loop",
  "x-request-id",
];

export const clientIpHeader = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,64}$/)
  .refine((name) => !name.startsWith("x-edgeweir-") && !REFUSED_CLIENT_HEADERS.includes(name), {
    message: "this header cannot name the client",
  });

/**
 * A trusted proxy range in canonical form ("10.1.2.3/8" is 10.0.0.0/8, a
 * bare address one host). IPv4-mapped IPv6 ranges are refused: write them as
 * IPv4.
 */
export const trustedProxyCidr = z
  .string()
  .trim()
  .transform((text, ctx) => {
    const cidr = normalizeCidr(text);
    if (!cidr || cidr.startsWith("::ffff:")) {
      ctx.addIssue({ code: "custom", message: "not an IP address or CIDR range" });
      return z.NEVER;
    }
    return cidr;
  });

export const clientIpMode = z.enum(["direct", "proxy_protocol", "header"]);

/**
 * How the cluster's HTTP(S) listeners find the client address (ip.src):
 * the TCP peer (direct), the PROXY protocol header every TCP connection must
 * start with (QUIC keeps the UDP peer), or a header that peers inside the
 * trusted ranges send (X-Forwarded-For from right to left past trusted
 * addresses). dropForwardedFor (direct only) sends the origins the TCP peer
 * alone as X-Forwarded-For.
 */
export const clientIpSettings = z
  .object({
    mode: clientIpMode.default("direct"),
    /** Header mode: 1-64 ranges, sorted and unique once saved. */
    trustedCidrs: z
      .array(trustedProxyCidr)
      .max(MAX_TRUSTED_PROXY_CIDRS)
      .default([])
      .transform((cidrs) => [...new Set(cidrs)].sort()),
    /** Header mode: the lowercase header name. */
    header: z.union([clientIpHeader, z.literal("")]).default(""),
    dropForwardedFor: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (s.mode === "header") {
      if (s.trustedCidrs.length === 0)
        ctx.addIssue({
          code: "custom",
          message: "the header mode needs trusted ranges",
          path: ["trustedCidrs"],
        });
      if (!s.header)
        ctx.addIssue({
          code: "custom",
          message: "the header mode needs a header",
          path: ["header"],
        });
    }
    if (s.dropForwardedFor && s.mode !== "direct")
      ctx.addIssue({
        code: "custom",
        message: "dropping X-Forwarded-For is for the direct mode",
        path: ["dropForwardedFor"],
      });
  });

export const clientIpInput = z.object({ clusterId: uuid, settings: clientIpSettings });

export const clusterClientIp = z.object({
  clusterId: uuid,
  settings: z.object({
    mode: clientIpMode,
    trustedCidrs: z.array(z.string()),
    header: z.string(),
    dropForwardedFor: z.boolean(),
  }),
  /** Active nodes without client-ip-v1: a mode other than direct waits until they are upgraded. */
  nodesWithout: z.array(z.object({ id: uuid, name: z.string() })),
});

/** Cluster listener ports and client address (procedures clusters.listenPorts, clusters.clientIp and their setters). */
export const edgeProcedures = {
  listenPorts: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/listen-ports", tags: ["clusters"] })
    .input(z.object({ clusterId: uuid }))
    .output(clusterListenPorts),
  setListenPorts: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/listen-ports", tags: ["clusters"] })
    .input(listenPortsInput)
    .output(clusterListenPorts),
  clientIp: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/client-ip", tags: ["clusters"] })
    .input(z.object({ clusterId: uuid }))
    .output(clusterClientIp),
  setClientIp: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/client-ip", tags: ["clusters"] })
    .input(clientIpInput)
    .output(clusterClientIp),
};

export type ListenPortsInput = z.infer<typeof listenPortsInput>;
export type ClusterListenPorts = z.infer<typeof clusterListenPorts>;
export type ClientIpMode = z.infer<typeof clientIpMode>;
export type ClientIpSettings = z.infer<typeof clientIpSettings>;
export type ClientIpInput = z.infer<typeof clientIpInput>;
export type ClusterClientIp = z.infer<typeof clusterClientIp>;
