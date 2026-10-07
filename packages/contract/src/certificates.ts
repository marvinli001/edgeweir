import { oc } from "@orpc/contract";
import * as z from "zod";
import { type DnsProviderId, dnsProviderIds } from "./dns-providers";
import { domainName, uuid } from "./schemas";

/** A MIME type compression applies to, without parameters. */
export const MIME_TYPE_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
/** Response compression: MIME types, the defaults of every algorithm. */
const compressionTypes = z.array(z.string().regex(MIME_TYPE_RE)).max(32);
export const DEFAULT_COMPRESSION_TYPES = [
  "text/html",
  "text/plain",
  "text/css",
  "application/javascript",
  "application/json",
  "image/svg+xml",
];
/** Minimum response size compressed, in bytes (every algorithm). */
export const COMPRESSION_MIN_LENGTH_RANGE = { min: 1, max: 1_048_576 } as const;
/** Compression levels; nodes read 0 as their default, so the console never sends it. */
export const BROTLI_LEVEL_RANGE = { min: 1, max: 11 } as const;
export const ZSTD_LEVEL_RANGE = { min: 1, max: 19 } as const;
const minLength = z
  .number()
  .int()
  .min(COMPRESSION_MIN_LENGTH_RANGE.min)
  .max(COMPRESSION_MIN_LENGTH_RANGE.max)
  .default(256);

export const tlsSettings = z
  .object({
    certificateId: uuid.nullable().default(null),
    forceHttps: z.boolean().default(false),
    hstsMaxAge: z.number().int().min(0).max(63_072_000).default(0),
    hstsIncludeSubdomains: z.boolean().default(false),
    hstsPreload: z.boolean().default(false),
    minimumVersion: z.enum(["1.2", "1.3"]).default("1.2"),
    cipherProfile: z.enum(["modern", "compatible"]).default("modern"),
    http2: z.boolean().default(true),
    // The stock engine is capability-checked; unsupported modules cannot be enabled.
    http3: z.boolean().default(false),
    /**
     * Brotli and Zstandard need every active node of the site's cluster to
     * report brotli-v1 / zstd-v1 (see sites.features). Clients that accept
     * several encodings get zstd, then br, then gzip at equal q-values.
     */
    brotli: z.boolean().default(false),
    brotliLevel: z
      .number()
      .int()
      .min(BROTLI_LEVEL_RANGE.min)
      .max(BROTLI_LEVEL_RANGE.max)
      .default(6),
    brotliMinLength: minLength,
    brotliTypes: compressionTypes.default(() => [...DEFAULT_COMPRESSION_TYPES]),
    zstd: z.boolean().default(false),
    zstdLevel: z.number().int().min(ZSTD_LEVEL_RANGE.min).max(ZSTD_LEVEL_RANGE.max).default(3),
    zstdMinLength: minLength,
    zstdTypes: compressionTypes.default(() => [...DEFAULT_COMPRESSION_TYPES]),
    gzip: z.boolean().default(true),
    gzipMinLength: minLength,
    gzipTypes: compressionTypes.default(() => [...DEFAULT_COMPRESSION_TYPES]),
    ocspStapling: z.boolean().default(false),
  })
  .refine((s) => (!s.forceHttps && s.hstsMaxAge === 0) || s.certificateId !== null, {
    message: "HTTPS redirect and HSTS require a certificate",
    path: ["certificateId"],
  });

/**
 * Why the last issuance or renewal of an ACME certificate failed
 * (`lastError`): codes of the certificate helper (ACME problem types,
 * timeouts) and of the console. DNS provider failures of DNS-01 keep the
 * DNS codes (dns_auth_failed, …, rendered like a DNS revision's error).
 * The UI shows `cert_error_<code>`; codes are never the CA's or the
 * provider's text.
 */
export const certificateErrorDefs = {
  /** Anything not classified; the console log has the console's reason. */
  certificate_operation_failed: { params: [] },
  certd_failed: { params: [] },
  certd_timeout: { params: [] },
  certd_invalid_output: { params: [] },
  acme_external_account_required: { params: [] },
  acme_unauthorized: { params: [] },
  acme_caa: { params: [] },
  acme_dns: { params: [] },
  acme_connection: { params: [] },
  acme_tls: { params: [] },
  acme_incorrect_response: { params: [] },
  acme_rejected_identifier: { params: [] },
  acme_unsupported_identifier: { params: [] },
  acme_rate_limited: { params: [] },
  acme_bad_csr: { params: [] },
  acme_invalid_contact: { params: [] },
  acme_unsupported_contact: { params: [] },
  acme_user_action_required: { params: [] },
  acme_account_does_not_exist: { params: [] },
  acme_order_not_ready: { params: [] },
  acme_malformed: { params: [] },
  acme_server_internal: { params: [] },
  /** An ACME problem of another type. */
  acme_error: { params: [] },
  acme_validation_timeout: { params: [] },
  acme_order_timeout: { params: [] },
  acme_unreachable: { params: [] },
  acme_directory_invalid: { params: [] },
  acme_directory_unreachable: { params: [] },
  /** EDGEWEIR_ACME_CA_FILE holds no certificate. */
  acme_ca_file_invalid: { params: [] },
  dns_propagation_timeout: { params: [] },
  dns_credential_not_found: { params: [] },
  /** HTTP-01: a name no site has (no cluster answers its challenge). */
  http01_unserved: { params: [] },
  /** HTTP-01: a serving cluster has no online node, or one without http01-v1. */
  http01_no_nodes: { params: [] },
  http01_apply_timeout: { params: [] },
  /** HTTP-01: a name resolves to no node, or to other addresses too. */
  http01_dns_not_pointing: { params: [] },
  issued_names_mismatch: { params: [] },
  issued_certificate_invalid: { params: [] },
  /**
   * An uploaded certificate stored before EC keys with explicit curve
   * parameters were refused, which nodes cannot load: a certificate of its
   * chain, or its private key (unloadableCertificateErrors).
   */
  certificate_chain_explicit_curve: { params: [] },
  certificate_key_explicit_curve: { params: [] },
} as const satisfies Record<string, { params: readonly string[] }>;

export type CertificateErrorCode = keyof typeof certificateErrorDefs;

export function isCertificateErrorCode(code: unknown): code is CertificateErrorCode {
  return typeof code === "string" && Object.hasOwn(certificateErrorDefs, code);
}

/** `lastError` codes of a stored certificate nodes cannot load; it cannot be bound. */
export const unloadableCertificateErrors: readonly CertificateErrorCode[] = [
  "certificate_chain_explicit_curve",
  "certificate_key_explicit_curve",
];

/** Whether a stored certificate is marked as one nodes cannot load. */
export const certificateUnloadable = (cert: { status: string; lastError: string }) =>
  cert.status === "error" &&
  (unloadableCertificateErrors as readonly string[]).includes(cert.lastError);

export const certificateDto = z.object({
  id: uuid,
  name: z.string(),
  names: z.array(z.string()),
  source: z.enum(["upload", "acme"]),
  status: z.enum(["pending", "issuing", "ready", "error"]),
  fingerprint: z.string(),
  notBefore: z.string().nullable(),
  notAfter: z.string().nullable(),
  autoRenew: z.boolean(),
  renewAt: z.string().nullable(),
  /** Why the last issuance failed: a certificateErrorDefs or DNS error code, or "". */
  lastError: z.string(),
  /** The site the certificate is bound to once issued (certificateRequest.bindSiteId), or null. */
  bindSiteId: uuid.nullable(),
});
const label = z.string().trim().min(1).max(100);
const names = z
  .array(domainName)
  .min(1)
  .max(100)
  .refine((xs) => new Set(xs).size === xs.length);
export const certificateUpload = z.object({
  name: label,
  chainPem: z.string().min(32).max(131_072),
  privateKeyPem: z.string().min(32).max(32_768),
});
export const certificateRequest = z
  .object({
    name: label,
    names,
    email: z.email(),
    ca: z.enum(["letsencrypt", "zerossl"]).default("letsencrypt"),
    challenge: z.enum(["http01", "dns01"]).default("http01"),
    dnsCredentialId: uuid.optional(),
    eabKid: z.string().max(256).optional(),
    eabHmacKey: z.string().max(1024).optional(),
    autoRenew: z.boolean().default(true),
    /**
     * HTTP-01: skip checking that every name resolves to the nodes of the
     * cluster serving it (at the request and before each issuance).
     */
    skipDnsCheck: z.boolean().default(false),
    /**
     * Once issued, the certificate is bound to this site and its HTTP
     * requests redirect to HTTPS (the HTTPS tab's one-click request). The
     * names must cover every domain of the site; a site that has another
     * usable certificate by then keeps it.
     */
    bindSiteId: uuid.optional(),
  })
  .refine((s) => s.challenge !== "dns01" || !!s.dnsCredentialId, {
    message: "DNS-01 requires a DNS credential",
    path: ["dnsCredentialId"],
  })
  .refine((s) => s.challenge !== "http01" || !s.names.some((n) => n.startsWith("*.")), {
    message: "wildcards require DNS-01",
    path: ["names"],
  })
  .refine((s) => s.ca !== "zerossl" || (!!s.eabKid && !!s.eabHmacKey), {
    message: "ZeroSSL requires EAB credentials",
    path: ["eabKid"],
  });

/**
 * What stops one-click HTTPS for a site (https.check), every blocker at
 * once. HTTP-01: `nodes_offline` (the cluster has no online active node),
 * `nodes_lack_http01` (online nodes without http01-v1), `dns_not_pointing`
 * (a name resolves to no node, or to other addresses too). DNS-01 (a site
 * with a wildcard domain): `dns_credential_missing` (no DNS credential's
 * zone covers every name), `dns_credential_failed` (its test failed;
 * `error` is the API error code). Both: `caa_forbidden` (CAA records of the
 * name or a parent domain do not allow the CA).
 */
export const httpsBlocker = z.discriminatedUnion("code", [
  z.object({ code: z.literal("nodes_offline"), cluster: z.string() }),
  z.object({ code: z.literal("nodes_lack_http01"), nodes: z.array(z.string()) }),
  z.object({
    code: z.literal("dns_not_pointing"),
    name: z.string(),
    pointing: z.enum(["unresolved", "elsewhere"]),
  }),
  z.object({ code: z.literal("dns_credential_missing"), names: z.array(z.string()) }),
  z.object({
    code: z.literal("dns_credential_failed"),
    credential: z.string(),
    error: z.string(),
  }),
  z.object({ code: z.literal("caa_forbidden"), name: z.string() }),
]);
export const httpsCheckInput = z.object({
  id: uuid,
  /** The CA whose CAA permission is checked. */
  ca: z.enum(["letsencrypt", "zerossl"]).default("letsencrypt"),
});
export const httpsCheck = z.object({
  /**
   * The request one-click HTTPS sends (certificates.request with
   * bindSiteId): the site's name and domains, HTTP-01, or DNS-01 with the
   * first DNS credential whose zone covers every name when the site has a
   * wildcard domain; the email of the last ACME account or request, else
   * the operator's.
   */
  request: z.object({
    name: z.string(),
    names: z.array(z.string()),
    email: z.string(),
    challenge: z.enum(["http01", "dns01"]),
    dnsCredentialId: uuid.nullable(),
  }),
  blockers: z.array(httpsBlocker),
  /** Issued, unexpired certificates that cover every domain of the site. */
  certificates: z.array(z.object({ id: uuid, name: z.string() })),
});

/** How the console issues ACME certificates. */
export const certificateSettings = z.object({
  /**
   * The ACME directory EDGEWEIR_ACME_DIRECTORY sets for every certificate
   * (the CA chosen per certificate is not used), or null.
   */
  acmeDirectory: z.string().nullable(),
});

const id = z.object({ id: uuid });
export const certificatesContract = {
  list: oc
    .route({ method: "GET", path: "/certificates", tags: ["certificates"] })
    .output(z.array(certificateDto)),
  settings: oc
    .route({ method: "GET", path: "/certificates/settings", tags: ["certificates"] })
    .output(certificateSettings),
  upload: oc
    .route({ method: "POST", path: "/certificates/upload", tags: ["certificates"] })
    .input(certificateUpload)
    .output(certificateDto),
  request: oc
    .route({ method: "POST", path: "/certificates/request", tags: ["certificates"] })
    .input(certificateRequest)
    .output(certificateDto),
  renew: oc
    .route({ method: "POST", path: "/certificates/{id}/renew", tags: ["certificates"] })
    .input(id)
    .output(certificateDto),
  delete: oc
    .route({ method: "DELETE", path: "/certificates/{id}", tags: ["certificates"] })
    .input(id)
    .output(z.object({ ok: z.literal(true) })),
};
export const httpsContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/https", tags: ["sites"] })
    .input(id)
    .output(tlsSettings),
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/https", tags: ["sites"] })
    .input(id.extend({ settings: tlsSettings }))
    .output(tlsSettings),
  /** What a one-click certificate for the site would request, and what stops it. */
  check: oc
    .route({ method: "GET", path: "/sites/{id}/https/check", tags: ["sites"] })
    .input(httpsCheckInput)
    .output(httpsCheck),
};
const credentialProviders = dnsProviderIds.filter((id) => id !== "test") as [
  Exclude<DnsProviderId, "test">,
  ...Exclude<DnsProviderId, "test">[],
];
const credentialFields = z
  .record(z.string().max(64), z.string().max(16384))
  .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 10);
export const dnsCredentialInput = z.object({
  name: label,
  provider: z.enum(credentialProviders),
  zone: domainName.refine((s) => !s.startsWith("*.")),
  credentials: credentialFields,
});
export const dnsCredentialDto = z.object({
  id: uuid,
  name: z.string(),
  provider: z.string(),
  zone: z.string(),
});
const credentialSource = z.union([
  z.object({ id: uuid }),
  z.object({ provider: z.enum(credentialProviders), credentials: credentialFields }),
]);
export const dnsCredentialsContract = {
  list: oc
    .route({ method: "GET", path: "/dns-credentials", tags: ["certificates"] })
    .output(z.array(dnsCredentialDto)),
  create: oc
    .route({ method: "POST", path: "/dns-credentials", tags: ["certificates"] })
    .input(dnsCredentialInput)
    .output(dnsCredentialDto),
  /** Renames or rotates the credentials (all fields again). */
  update: oc
    .route({ method: "PUT", path: "/dns-credentials/{id}", tags: ["certificates"] })
    .input(
      z.object({
        id: uuid,
        name: label.optional(),
        credentials: credentialFields.optional(),
      }),
    )
    .output(dnsCredentialDto),
  delete: oc
    .route({ method: "DELETE", path: "/dns-credentials/{id}", tags: ["certificates"] })
    .input(id)
    .output(z.object({ ok: z.literal(true) })),
  /** Zones the credentials can manage (providers that can list zones). */
  zones: oc
    .route({ method: "POST", path: "/dns-credentials/zones", tags: ["certificates"] })
    .input(credentialSource)
    .output(z.object({ zones: z.array(z.string()) })),
  /** Reads the zone's records with the credentials (connection test). */
  test: oc
    .route({ method: "POST", path: "/dns-credentials/test", tags: ["certificates"] })
    .input(
      z.union([
        z.object({ id: uuid }),
        z.object({
          provider: z.enum(credentialProviders),
          credentials: credentialFields,
          zone: domainName.refine((s) => !s.startsWith("*.")),
        }),
      ]),
    )
    .output(z.object({ ok: z.literal(true), records: z.number().int() })),
};
export type TlsSettings = z.infer<typeof tlsSettings>;
export type CertificateDto = z.infer<typeof certificateDto>;
export type CertificateUpload = z.infer<typeof certificateUpload>;
export type CertificateRequest = z.infer<typeof certificateRequest>;
export type CertificateSettings = z.infer<typeof certificateSettings>;
export type HttpsBlocker = z.infer<typeof httpsBlocker>;
export type HttpsCheck = z.infer<typeof httpsCheck>;
export type DnsCredentialInput = z.infer<typeof dnsCredentialInput>;
