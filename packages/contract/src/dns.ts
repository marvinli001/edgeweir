import { oc } from "@orpc/contract";
import * as z from "zod";
import { formatIp, parseIp } from "./addresses";
import {
  type DnsProviderEntry,
  type DnsProviderId,
  dnsProviderCatalog,
  dnsProviderIds,
} from "./dns-providers";
import { domainName, isoDateTime, uuid } from "./schemas";

const zoneName = domainName.refine((name) => !name.startsWith("*."));
export const dnsProviderKind = z.enum(dnsProviderIds);
const ipAddress = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const ip = parseIp(value);
    if (!ip) {
      ctx.addIssue({ code: "custom", message: "invalid IP address" });
      return z.NEVER;
    }
    return formatIp(ip);
  });
const lineName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
  .refine((name) => name !== "all");
export const dnsLine = z.object({
  name: lineName,
  nodeGroupId: uuid,
  overrides: z
    .array(z.object({ nodeId: uuid, addresses: z.array(ipAddress).min(1).max(8) }))
    .max(1000)
    .default([]),
});
/** off: the console does not manage DNS; manual: records to create by hand; auto: written through the provider. */
export const dnsBindingMode = z.enum(["off", "manual", "auto"]);
/** A cluster's DNS binding as the administrator edits it. */
export const dnsBindingInput = z
  .object({
    mode: dnsBindingMode.default("off"),
    providerId: uuid.nullable().default(null),
    /** Parent name of the cluster's records; site targets are `<site id>.<domain>`. */
    domain: z.union([z.literal(""), zoneName]).default(""),
    ttl: z.number().int().min(30).max(3600).default(600),
    lines: z.array(dnsLine).max(128).default([]),
    /** Also keep `<line>.<site id>.<domain>` for every site (targets shown before cluster bindings). */
    lineAliases: z.boolean().default(false),
  })
  .superRefine((binding, ctx) => {
    if (binding.mode === "auto" && !binding.providerId)
      ctx.addIssue({ code: "custom", message: "provider required" });
    if (binding.mode !== "off" && !binding.domain)
      ctx.addIssue({ code: "custom", message: "domain required" });
    if (binding.domain.length > 180)
      ctx.addIssue({ code: "custom", message: "domain is too long" });
    if (
      new Set(binding.lines.map((l) => l.name)).size !== binding.lines.length ||
      new Set(binding.lines.map((l) => l.nodeGroupId)).size !== binding.lines.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate line or group" });
  });
export const dnsBinding = z.object({
  clusterId: uuid,
  mode: dnsBindingMode,
  providerId: uuid.nullable(),
  /** The provider account's zone (empty without an account). */
  zone: z.string(),
  domain: z.string(),
  ttl: z.number(),
  lines: z.array(dnsLine),
  lineAliases: z.boolean(),
  /** Label of the record with every line's addresses (`all`, or `all-N` for migrated shared domains). */
  allLabel: z.string(),
  updatedAt: isoDateTime,
});
const credentials = z.record(z.string().max(64), z.string().max(16384));
const providerInput = z.object({
  name: z.string().trim().min(1).max(100),
  provider: dnsProviderKind,
  zone: zoneName,
  credentials,
});
const provider = z.object({
  id: uuid,
  name: z.string(),
  provider: dnsProviderKind,
  zone: z.string(),
});
const record = z.object({
  name: z.string(),
  type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
  data: z.string(),
  ttl: z.number(),
});
const revision = z.object({
  revision: z.number(),
  /** blocked: the mass removal protection kept the previous records instead. */
  status: z.enum(["pending", "applied", "failed", "superseded", "blocked"]),
  reason: z.string(),
  recordCount: z.number(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  /** A code: dns_reconcile_failed, dns_auth_failed, dns_record_conflict, … */
  lastError: z.string(),
});
export const dnsProtection = z.object({
  /** Share of the previous address records (0.05-1, default 0.5). */
  massRemovalRatio: z.number().min(0.05).max(1),
});
/** Unsaved credentials, or a saved account by id. */
const credentialSource = z.union([
  z.object({ id: uuid }),
  z.object({ provider: dnsProviderKind, credentials }),
]);
export const dnsFieldDto = z.object({
  key: z.string(),
  type: z.enum(["text", "secret", "select", "textarea", "url"]),
  secret: z.boolean(),
  required: z.boolean(),
  placeholder: z.string().optional(),
  pattern: z.string().optional(),
  maxLength: z.number(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
});
export const dnsProviderDto = z.object({
  id: dnsProviderKind,
  name: z.string(),
  fields: z.array(dnsFieldDto),
  capabilities: z.object({
    recordTypes: z.array(z.enum(["A", "AAAA", "CNAME", "TXT"])),
    listZones: z.boolean(),
    lines: z.boolean(),
    apex: z.enum(["cname", "alias"]).nullable(),
    endpoint: z.enum(["fixed", "custom"]),
  }),
});
const clusterParam = z.object({ clusterId: uuid });
const bindingState = z.object({
  binding: dnsBinding,
  revision: revision.nullable(),
  /** The target revision is written and read back. */
  applied: z.boolean(),
  records: z.array(record),
  /** The latest plan the mass removal protection held back, until a publication passes. */
  blocked: revision
    .extend({ removedRecords: z.number().int(), previousRecords: z.number().int() })
    .nullable(),
});
export const dnsContract = {
  /** The provider catalog (every signed-in caller: forms for accounts and credentials). */
  catalog: oc
    .route({ method: "GET", path: "/dns/catalog", tags: ["dns"] })
    .output(z.array(dnsProviderDto)),
  updateProvider: oc
    .route({ method: "PUT", path: "/dns/providers/{id}", tags: ["dns"] })
    .input(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(100).optional(),
        credentials: credentials.optional(),
      }),
    )
    .output(provider),
  providers: oc
    .route({ method: "GET", path: "/dns/providers", tags: ["dns"] })
    .output(z.object({ items: z.array(provider), testEnabled: z.boolean() })),
  createProvider: oc
    .route({ method: "POST", path: "/dns/providers", tags: ["dns"] })
    .input(providerInput)
    .output(provider),
  deleteProvider: oc
    .route({ method: "DELETE", path: "/dns/providers/{id}", tags: ["dns"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  /** Zones the credentials can manage (providers that can list zones). */
  zones: oc
    .route({ method: "POST", path: "/dns/zones", tags: ["dns"] })
    .input(credentialSource)
    .output(z.object({ zones: z.array(z.string()) })),
  /** Reads the zone's records with the credentials (connection test). */
  testProvider: oc
    .route({ method: "POST", path: "/dns/test", tags: ["dns"] })
    .input(
      z.union([
        z.object({ id: uuid }),
        z.object({ provider: dnsProviderKind, credentials, zone: zoneName }),
      ]),
    )
    .output(z.object({ ok: z.literal(true), records: z.number().int() })),
  /** Every cluster's binding with its publication state. */
  bindings: oc.route({ method: "GET", path: "/dns/bindings", tags: ["dns"] }).output(
    z.array(
      z.object({
        clusterId: uuid,
        clusterName: z.string(),
        mode: dnsBindingMode,
        providerId: uuid.nullable(),
        zone: z.string(),
        domain: z.string(),
        revision: revision.nullable(),
        applied: z.boolean(),
        blocked: z.boolean(),
      }),
    ),
  ),
  binding: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/dns", tags: ["dns"] })
    .input(clusterParam)
    .output(bindingState),
  saveBinding: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/dns", tags: ["dns"] })
    .input(clusterParam.extend({ binding: dnsBindingInput }))
    .output(revision.nullable()),
  bindingRevisions: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/dns/revisions", tags: ["dns"] })
    .input(clusterParam)
    .output(z.array(revision)),
  rollbackBinding: oc
    .route({
      method: "POST",
      path: "/clusters/{clusterId}/dns/revisions/{revision}/rollback",
      tags: ["dns"],
    })
    .input(clusterParam.extend({ revision: z.number().int().positive() }))
    .output(revision),
  /** Publishes the held-back plan anyway (confirmed by an administrator, audited). */
  forcePublishBinding: oc
    .route({ method: "POST", path: "/clusters/{clusterId}/dns/force-publish", tags: ["dns"] })
    .input(clusterParam.extend({ revision: z.number().int().positive() }))
    .output(revision),
  /** The binding's records as absolute names and as a BIND zone file (manual mode). */
  exportBinding: oc
    .route({ method: "GET", path: "/clusters/{clusterId}/dns/export", tags: ["dns"] })
    .input(clusterParam)
    .output(
      z.object({
        origin: z.string(),
        records: z.array(record),
        zoneFile: z.string(),
      }),
    ),
  /** Mass removal protection: the largest share of address records one publication may remove. */
  protection: oc
    .route({ method: "GET", path: "/dns/protection", tags: ["dns"] })
    .output(dnsProtection),
  setProtection: oc
    .route({ method: "PUT", path: "/dns/protection", tags: ["dns"] })
    .input(dnsProtection)
    .output(dnsProtection),
  /** Recomputes and writes one cluster's records, or every cluster's. */
  reconcile: oc
    .route({ method: "POST", path: "/dns/reconcile", tags: ["dns"] })
    .input(z.object({ clusterId: uuid.optional() }).default({}))
    .output(z.object({ ok: z.literal(true) })),
  siteTarget: oc
    .route({ method: "GET", path: "/sites/{siteId}/cname", tags: ["dns"] })
    .input(z.object({ siteId: uuid }))
    .output(
      z.object({
        target: z.string().nullable(),
        mode: dnsBindingMode,
        published: z.boolean(),
        healthy: z.boolean(),
        lines: z.array(z.object({ name: z.string(), target: z.string() })),
      }),
    ),
};
/** The catalog as served by `dns.catalog`. */
export const dnsCatalogDto = (dnsProviderCatalog as readonly DnsProviderEntry[]).map((p) => ({
  id: p.id as DnsProviderId,
  name: p.name,
  fields: p.fields.map(({ options, ...field }) =>
    options ? { ...field, options: [...options] } : field,
  ),
  capabilities: { ...p.capabilities, recordTypes: [...p.capabilities.recordTypes] },
}));
export type DnsBindingInput = z.infer<typeof dnsBindingInput>;
export type DnsBinding = z.infer<typeof dnsBinding>;
export type DnsLine = z.infer<typeof dnsLine>;
export type DnsProviderInput = z.infer<typeof providerInput>;
export type DnsRecord = z.infer<typeof record>;
export type DnsRevision = z.infer<typeof revision>;
export type DnsProtection = z.infer<typeof dnsProtection>;
export type DnsProviderDto = z.infer<typeof dnsProviderDto>;
