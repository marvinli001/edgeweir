import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/** domains-v2: site domains of the forms `.a.com` (any depth) and `~pattern`. */
export const DOMAINS_V2_FEATURE = "domains-v2";
/**
 * unknown-host-v1: the cluster's handling of unknown hosts and of requests
 * by node IP or without a Host (the platform's page, closing the
 * connection, or the default site), the default site's certificate for
 * unknown SNI, and scan protection (platform-wide automatic bans).
 */
export const UNKNOWN_HOST_FEATURE = "unknown-host-v1";

/** page: the platform's unknown host page (404); close: no response (444); site: the default site. */
export const unknownHostAction = z.enum(["page", "close", "site"]);

export const SCAN_THRESHOLD = { min: 10, max: 10_000, default: 100 } as const;
export const SCAN_BAN_SECONDS = { min: 60, max: 86_400, default: 3_600 } as const;
/** Scan protection counts requests per client address over this window. */
export const SCAN_WINDOW_SECONDS = 60;

export const scanProtection = z.object({
  enabled: z.boolean().default(false),
  /** Requests to unknown hosts or by node IP within 60 seconds; one more bans. */
  threshold: z
    .number()
    .int()
    .min(SCAN_THRESHOLD.min)
    .max(SCAN_THRESHOLD.max)
    .default(SCAN_THRESHOLD.default),
  banSeconds: z
    .number()
    .int()
    .min(SCAN_BAN_SECONDS.min)
    .max(SCAN_BAN_SECONDS.max)
    .default(SCAN_BAN_SECONDS.default),
});

/**
 * How the cluster's nodes answer a host no site serves (unknownHost) and a
 * request by node IP or without a Host (ipAccess). `site` hands it to
 * defaultSiteId, an enabled site of the cluster (DEFAULT_SITE_INVALID);
 * defaultCertificate (unknownHost site only) completes TLS handshakes for
 * unknown SNI with the default site's certificate
 * (DEFAULT_SITE_CERTIFICATE_REQUIRED).
 */
export const unknownHostSettings = z
  .object({
    unknownHost: unknownHostAction.default("page"),
    ipAccess: unknownHostAction.default("page"),
    defaultSiteId: uuid.nullable().default(null),
    defaultCertificate: z.boolean().default(false),
    scan: scanProtection.prefault({}),
  })
  .superRefine((s, ctx) => {
    if ((s.unknownHost === "site" || s.ipAccess === "site") && !s.defaultSiteId)
      ctx.addIssue({
        code: "custom",
        message: "handing requests to the default site needs one",
        path: ["defaultSiteId"],
      });
    if (s.defaultCertificate && s.unknownHost !== "site")
      ctx.addIssue({
        code: "custom",
        message: "the default site's certificate is for unknown hosts handed to it",
        path: ["defaultCertificate"],
      });
  });

export const unknownHostsInput = z.object({ clusterId: uuid, settings: unknownHostSettings });

export const clusterUnknownHosts = z.object({
  clusterId: uuid,
  settings: z.object({
    unknownHost: unknownHostAction,
    ipAccess: unknownHostAction,
    defaultSiteId: uuid.nullable(),
    defaultCertificate: z.boolean(),
    scan: z.object({ enabled: z.boolean(), threshold: z.number(), banSeconds: z.number() }),
  }),
  /**
   * The default site; `enabled` false or a missing certificate makes nodes
   * answer as with `page` (and abort unknown SNI) until it is fixed.
   */
  defaultSite: z
    .object({
      id: uuid,
      name: z.string(),
      enabled: z.boolean(),
      certificate: z.boolean(),
    })
    .nullable(),
  /** Active nodes without unknown-host-v1: settings other than the defaults wait for them. */
  nodesWithout: z.array(z.object({ id: uuid, name: z.string() })),
});

/** clusters.unknownHosts and clusters.setUnknownHosts. */
export const unknownHostProcedures = {
  unknownHosts: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/unknown-hosts", tags: ["clusters"] })
    .input(z.object({ clusterId: uuid }))
    .output(clusterUnknownHosts),
  setUnknownHosts: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/unknown-hosts", tags: ["clusters"] })
    .input(unknownHostsInput)
    .output(clusterUnknownHosts),
};

/**
 * The first label of a CNAME target `<prefix>.<cluster domain>`: 1-30 of
 * `[a-z0-9-]`, not starting or ending with "-". New sites and layer-4
 * applications get 8 random characters (a letter first); older ones keep
 * their id.
 */
export const CNAME_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export const cnamePrefix = z.string().trim().toLowerCase().regex(CNAME_PREFIX_RE);
/** How long a replaced prefix keeps resolving. */
export const CNAME_RETIRE_HOURS = 24;

/**
 * Sets the CNAME prefix of a site or layer-4 application; without `prefix`
 * a new random one. A prefix is unique across sites and applications
 * (including replaced ones still resolving), never `all`, `all-<n>` or a
 * record name of a DNS binding, and, with automatic DNS, not a name the
 * provider zone already holds a record at that the cluster does not manage
 * (checked best effort; CNAME_PREFIX_CONFLICT). A UUID is accepted only as
 * the object's own prefix from before CNAME prefixes while it still
 * resolves: its current prefix, or a replaced one still in its 24-hour
 * transition (taking it back). Any other UUID, such as the id of an
 * object created with a random prefix, is CNAME_PREFIX_INVALID.
 */
export const cnamePrefixInput = z.object({
  id: uuid,
  prefix: z.union([cnamePrefix, uuid.transform((v) => v.toLowerCase())]).optional(),
});

/** The prefix and the replaced ones still in the DNS plan. */
export const cnamePrefixState = z.object({
  prefix: z.string(),
  retired: z.array(z.object({ prefix: z.string(), expiresAt: isoDateTime })),
});

export type UnknownHostAction = z.infer<typeof unknownHostAction>;
export type UnknownHostSettings = z.infer<typeof unknownHostSettings>;
export type UnknownHostsInput = z.infer<typeof unknownHostsInput>;
export type ClusterUnknownHosts = z.infer<typeof clusterUnknownHosts>;
export type CnamePrefixInput = z.infer<typeof cnamePrefixInput>;
export type CnamePrefixState = z.infer<typeof cnamePrefixState>;
