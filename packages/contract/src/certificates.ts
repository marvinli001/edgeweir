import { oc } from "@orpc/contract";
import * as z from "zod";
import { type DnsProviderId, dnsProviderIds } from "./dns-providers";
import { domainName, uuid } from "./schemas";

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
    brotli: z.literal(false).default(false),
    zstd: z.literal(false).default(false),
    gzip: z.boolean().default(true),
    gzipMinLength: z.number().int().min(1).max(1_048_576).default(256),
    gzipTypes: z
      .array(z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/))
      .max(32)
      .default([
        "text/html",
        "text/plain",
        "text/css",
        "application/javascript",
        "application/json",
        "image/svg+xml",
      ]),
    ocspStapling: z.boolean().default(false),
  })
  .refine((s) => (!s.forceHttps && s.hstsMaxAge === 0) || s.certificateId !== null, {
    message: "HTTPS redirect and HSTS require a certificate",
  });

export const certificateDto = z.object({
  id: uuid,
  organizationId: z.string(),
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
  organizationId: z.string().max(100).optional(),
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
const tenantProviders = dnsProviderIds.filter((id) => id !== "test") as [
  Exclude<DnsProviderId, "test">,
  ...Exclude<DnsProviderId, "test">[],
];
const credentialFields = z
  .record(z.string().max(64), z.string().max(16384))
  .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 10);
export const dnsCredentialInput = z.object({
  name: label,
  provider: z.enum(tenantProviders),
  zone: domainName.refine((s) => !s.startsWith("*.")),
  credentials: credentialFields,
  /** Write ownership TXT and CNAME records for the organization's domains in this zone. */
  autoRecords: z.boolean().default(false),
});
export const dnsCredentialDto = z.object({
  id: uuid,
  name: z.string(),
  provider: z.string(),
  zone: z.string(),
  autoRecords: z.boolean(),
});
const credentialSource = z.union([
  z.object({ id: uuid }),
  z.object({ provider: z.enum(tenantProviders), credentials: credentialFields }),
]);
export const dnsCredentialsContract = {
  list: oc
    .route({ method: "GET", path: "/dns-credentials", tags: ["certificates"] })
    .output(z.array(dnsCredentialDto)),
  create: oc
    .route({ method: "POST", path: "/dns-credentials", tags: ["certificates"] })
    .input(dnsCredentialInput)
    .output(dnsCredentialDto),
  /** Renames, rotates the credentials (all fields again) or turns automatic records on or off. */
  update: oc
    .route({ method: "PUT", path: "/dns-credentials/{id}", tags: ["certificates"] })
    .input(
      z.object({
        id: uuid,
        name: label.optional(),
        credentials: credentialFields.optional(),
        autoRecords: z.boolean().optional(),
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
          provider: z.enum(tenantProviders),
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
