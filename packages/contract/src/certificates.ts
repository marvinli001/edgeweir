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
  });

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
  lastError: z.string(),
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
  })
  .refine((s) => s.challenge !== "dns01" || !!s.dnsCredentialId, {
    message: "DNS-01 requires a DNS credential",
  })
  .refine((s) => s.challenge !== "http01" || !s.names.some((n) => n.startsWith("*.")), {
    message: "wildcards require DNS-01",
  })
  .refine((s) => s.ca !== "zerossl" || (!!s.eabKid && !!s.eabHmacKey), {
    message: "ZeroSSL requires EAB credentials",
  });

const id = z.object({ id: uuid });
export const certificatesContract = {
  list: oc
    .route({ method: "GET", path: "/certificates", tags: ["certificates"] })
    .output(z.array(certificateDto)),
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
export type DnsCredentialInput = z.infer<typeof dnsCredentialInput>;
