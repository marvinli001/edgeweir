import { oc } from "@orpc/contract";
import * as z from "zod";
import { parseIp } from "./addresses";
import { optionalHostname, uuid } from "./schemas";

/**
 * Origin protection: the origin client CA, whose certificates nodes present
 * to origins that verify clients (origin mutual TLS), and the Origin CA,
 * which signs origin server certificates only the edge trusts. Both are
 * ECDSA P-256 authorities separate from the node channel's CA.
 *
 * Rotation keeps the old and the new authority side by side. The origin
 * client CA: rotate (the new CA is only trusted: origins add it), activate
 * (clusters get certificates of the new CA; the old ones stay valid until
 * they expire), retire. The Origin CA: rotate (the new CA issues, nodes
 * trust both), retire (nodes trust the new one alone). Cancel undoes a
 * rotation before the new CA is in use.
 */

/** Lifetime of the origin client CA. */
export const ORIGIN_CLIENT_CA_YEARS = 10;
/** Lifetime of a cluster's origin client certificate and when it is replaced. */
export const ORIGIN_CLIENT_CERTIFICATE_DAYS = 90;
export const ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS = 30;
/** Lifetime of the Origin CA; origin certificates never outlive it. */
export const ORIGIN_CA_YEARS = 20;
export const ORIGIN_CERTIFICATE_VALIDITY_YEARS = [1, 3, 5, 10, 15] as const;
const ORIGIN_CERTIFICATE_KEY_TYPES = ["ec256", "rsa2048"] as const;
export type OriginCertificateKeyType = (typeof ORIGIN_CERTIFICATE_KEY_TYPES)[number];
const MAX_ORIGIN_CERTIFICATE_HOSTNAMES = 50;
const ORIGIN_CSR_MAX_BYTES = 16_384;

const hostName = (value: string) => value !== "" && optionalHostname.safeParse(value).success;

/**
 * The names of an origin certificate: what nodes verify, an origin's SNI or
 * address, i.e. a host name (single-label internal names too), optionally
 * "*."-prefixed, or an IP literal.
 */
export const originCertificateHostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (value) => parseIp(value) !== null || hostName(value.startsWith("*.") ? value.slice(2) : value),
    "invalid host name",
  );

const certificateAuthorityDto = z.object({
  certificatePem: z.string(),
  /** SHA-256 of the DER certificate, lowercase hex. */
  fingerprint: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
});

/**
 * Which authority of its kind signed a certificate: the active one, the
 * previous one of a rotation, or one retired (or cancelled) since.
 */
const issuingAuthority = z.enum(["active", "previous", "retired"]);

const originClientCertificateDto = z.object({
  id: uuid,
  clusterId: uuid,
  clusterName: z.string(),
  serial: z.string(),
  fingerprint: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  authority: issuingAuthority,
});

const clusterRef = z.object({ clusterId: uuid, clusterName: z.string() });

const originClientCa = z.object({
  /** The active authority (signs the clusters' certificates); null until the operator creates it. */
  authority: certificateAuthorityDto.nullable(),
  /** A rotation's new authority before it is activated: origins should trust it already. */
  next: certificateAuthorityDto.nullable(),
  /** The authority a rotation replaced, until it is retired. */
  previous: certificateAuthorityDto.nullable(),
  /**
   * PEM of every authority origins verifying clients should trust now:
   * the active one, then the next or previous one during a rotation.
   */
  trustBundlePem: z.string(),
  /** The current certificate of every cluster that has one, by cluster name. */
  certificates: z.array(originClientCertificateDto),
  /** With a previous authority: clusters whose sites still present its certificates. */
  pendingClusters: z.array(clusterRef),
});

const originCa = z.object({
  /** The active authority (issues origin certificates); null until the operator creates it. */
  authority: certificateAuthorityDto.nullable(),
  /** The authority a rotation replaced: nodes trust both until it is retired. */
  previous: certificateAuthorityDto.nullable(),
  /** Certificates of the previous authority, neither revoked nor expired, that retiring it ends. */
  previousCertificates: z.number().int(),
});

const originCertificateDto = z.object({
  id: uuid,
  hostnames: z.array(z.string()),
  /** ec256, ec384, rsa2048, rsa3072 or rsa4096 (the CSR's key). */
  keyType: z.string(),
  source: z.enum(["generated", "csr"]),
  serial: z.string(),
  fingerprint: z.string(),
  certificatePem: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  authority: issuingAuthority,
});

/**
 * Without csrPem the console generates a keyType key and returns it once;
 * with it the CSR (signature checked, RSA 2048-4096 or ECDSA P-256 / P-384)
 * only supplies the public key. The validity ends at the Origin CA's expiry
 * if that comes first.
 */
export const originCertificateIssue = z.object({
  hostnames: z
    .array(originCertificateHostname)
    .min(1)
    .max(MAX_ORIGIN_CERTIFICATE_HOSTNAMES)
    .transform((names) => [...new Set(names)]),
  validityYears: z.literal(ORIGIN_CERTIFICATE_VALIDITY_YEARS).default(15),
  keyType: z.enum(ORIGIN_CERTIFICATE_KEY_TYPES).default("ec256"),
  csrPem: z.string().trim().max(ORIGIN_CSR_MAX_BYTES).optional(),
});

const originCertificateIssued = originCertificateDto.extend({
  /** PKCS#8 PEM of the generated key, shown once; "" for a CSR. */
  privateKeyPem: z.string(),
});

export type CertificateAuthorityDto = z.infer<typeof certificateAuthorityDto>;
export type OriginClientCa = z.infer<typeof originClientCa>;
export type OriginCa = z.infer<typeof originCa>;
export type OriginCertificateDto = z.infer<typeof originCertificateDto>;
export type OriginCertificateIssue = z.infer<typeof originCertificateIssue>;
export type OriginCertificateIssued = z.infer<typeof originCertificateIssued>;

const id = z.object({ id: uuid });
export const originClientCaContract = {
  get: oc
    .route({ method: "GET", path: "/origin-client-ca", tags: ["certificates"] })
    .output(originClientCa),
  /** Creates the authority; when it exists already, returns it unchanged. */
  create: oc
    .route({ method: "POST", path: "/origin-client-ca", tags: ["certificates"] })
    .output(originClientCa),
  /** Creates the next authority, which origins should trust before it is activated. */
  rotate: oc
    .route({ method: "POST", path: "/origin-client-ca/rotation", tags: ["certificates"] })
    .output(originClientCa),
  /**
   * Makes the next authority the active one and gives every cluster a certificate it signed
   * (clusters that fail are retried hourly); the previous one stays trusted until retired.
   */
  activate: oc
    .route({ method: "POST", path: "/origin-client-ca/rotation/activate", tags: ["certificates"] })
    .output(originClientCa),
  /** Deletes the previous authority once no cluster presents its certificates (CA_ROTATION_INCOMPLETE). */
  retire: oc
    .route({ method: "POST", path: "/origin-client-ca/rotation/retire", tags: ["certificates"] })
    .output(originClientCa),
  /** Deletes the next authority before it is activated. */
  cancel: oc
    .route({ method: "DELETE", path: "/origin-client-ca/rotation", tags: ["certificates"] })
    .output(originClientCa),
};
export const originCaContract = {
  get: oc.route({ method: "GET", path: "/origin-ca", tags: ["certificates"] }).output(originCa),
  /** Creates the authority; when it exists already, returns it unchanged. */
  create: oc.route({ method: "POST", path: "/origin-ca", tags: ["certificates"] }).output(originCa),
  /**
   * Creates a new authority that issues from now on; every cluster trusting the Origin CA gets a
   * revision trusting both (nodes need origin-ca-rotation-v1).
   */
  rotate: oc
    .route({ method: "POST", path: "/origin-ca/rotation", tags: ["certificates"] })
    .output(originCa),
  /** Deletes the previous authority: nodes stop trusting the certificates it issued. */
  retire: oc
    .route({ method: "POST", path: "/origin-ca/rotation/retire", tags: ["certificates"] })
    .output(originCa),
  /**
   * Deletes the new authority and makes the previous one active again, while the new one has no
   * valid certificates (CA_ROTATION_IN_USE).
   */
  cancel: oc
    .route({ method: "DELETE", path: "/origin-ca/rotation", tags: ["certificates"] })
    .output(originCa),
};
export const originCertificatesContract = {
  list: oc
    .route({ method: "GET", path: "/origin-certificates", tags: ["certificates"] })
    .output(z.array(originCertificateDto)),
  issue: oc
    .route({ method: "POST", path: "/origin-certificates", tags: ["certificates"] })
    .input(originCertificateIssue)
    .output(originCertificateIssued),
  /** Nodes refuse the certificate from the next revision of every cluster trusting the Origin CA. */
  revoke: oc
    .route({ method: "POST", path: "/origin-certificates/{id}/revoke", tags: ["certificates"] })
    .input(id)
    .output(originCertificateDto),
};
