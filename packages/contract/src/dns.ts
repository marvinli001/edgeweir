import { oc } from "@orpc/contract";
import * as z from "zod";
import { formatIp, parseIp } from "./addresses";
import { domainName, uuid } from "./schemas";

const zoneName = domainName.refine((name) => !name.startsWith("*."));
export const dnsProviderKind = z.enum(["cloudflare", "alidns", "huaweicloud", "dnspod", "test"]);
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
export const dnsPolicy = z
  .object({
    enabled: z.boolean().default(false),
    providerId: uuid.nullable().default(null),
    cnameSuffix: z.union([z.literal(""), zoneName]).default(""),
    ttl: z.number().int().min(30).max(3600).default(600),
    lines: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
            .refine((name) => name !== "all"),
          nodeGroupId: uuid,
          overrides: z
            .array(z.object({ nodeId: uuid, addresses: z.array(ipAddress).min(1).max(8) }))
            .max(1000)
            .default([]),
        }),
      )
      .max(128)
      .default([]),
  })
  .superRefine((policy, ctx) => {
    if (policy.enabled && (!policy.providerId || !policy.cnameSuffix || !policy.lines.length))
      ctx.addIssue({ code: "custom", message: "provider, CNAME suffix and lines required" });
    if (policy.cnameSuffix.length > 180)
      ctx.addIssue({ code: "custom", message: "CNAME suffix is too long" });
    if (
      new Set(policy.lines.map((l) => l.name)).size !== policy.lines.length ||
      new Set(policy.lines.map((l) => l.nodeGroupId)).size !== policy.lines.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate line or group" });
  });
const providerInput = z.object({
  name: z.string().trim().min(1).max(100),
  provider: dnsProviderKind,
  zone: zoneName,
  credentials: z.record(z.string().max(64), z.string().max(4096)),
});
const provider = z.object({
  id: uuid,
  name: z.string(),
  provider: dnsProviderKind,
  zone: z.string(),
});
const record = z.object({
  name: z.string(),
  type: z.enum(["A", "AAAA", "CNAME"]),
  data: z.string(),
  ttl: z.number(),
});
const revision = z.object({
  revision: z.number(),
  status: z.enum(["pending", "applied", "failed", "superseded"]),
  reason: z.string(),
  recordCount: z.number(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  lastError: z.string(),
});
export const dnsContract = {
  updateProvider: oc
    .route({ method: "PUT", path: "/dns/providers/{id}", tags: ["dns"] })
    .input(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(100).optional(),
        credentials: z.record(z.string().max(64), z.string().max(4096)).optional(),
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
  get: oc
    .route({ method: "GET", path: "/dns/config", tags: ["dns"] })
    .output(
      z.object({ policy: dnsPolicy, revision: revision.nullable(), records: z.array(record) }),
    ),
  save: oc
    .route({ method: "PUT", path: "/dns/config", tags: ["dns"] })
    .input(dnsPolicy)
    .output(revision),
  revisions: oc
    .route({ method: "GET", path: "/dns/revisions", tags: ["dns"] })
    .output(z.array(revision)),
  rollback: oc
    .route({ method: "POST", path: "/dns/revisions/{revision}/rollback", tags: ["dns"] })
    .input(z.object({ revision: z.number().int().positive() }))
    .output(revision),
  reconcile: oc
    .route({ method: "POST", path: "/dns/reconcile", tags: ["dns"] })
    .output(z.object({ ok: z.literal(true) })),
  siteTarget: oc
    .route({ method: "GET", path: "/sites/{siteId}/cname", tags: ["dns"] })
    .input(z.object({ siteId: uuid }))
    .output(
      z.object({
        target: z.string().nullable(),
        published: z.boolean(),
        healthy: z.boolean(),
        lines: z.array(z.object({ name: z.string(), target: z.string() })),
      }),
    ),
};
export type DnsPolicy = z.infer<typeof dnsPolicy>;
export type DnsProviderInput = z.infer<typeof providerInput>;
export type DnsRecord = z.infer<typeof record>;
export type DnsRevision = z.infer<typeof revision>;
