import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/** What a service account may do; each procedure it can call needs one of these (or none). */
export const serviceAccountScope = z.enum([
  "organizations:read",
  "organizations:write",
  "members:read",
  "invitations:write",
  "clusters:read",
  "system:read",
  "sites:read",
  "sites:write",
  "sites:suspend",
  "limits:read",
  "limits:write",
  "usage:read",
]);
export type ServiceAccountScope = z.infer<typeof serviceAccountScope>;

/**
 * The only procedures a service account can call, with the scope each one
 * needs (null: any service account). Everything else answers 403
 * SERVICE_ACCOUNT_FORBIDDEN; a missing scope answers 403 SCOPE_REQUIRED.
 */
export const serviceAccountProcedures = {
  "system.status": null,
  "account.me": null,
  "settings.get": "system:read",
  "clusters.list": "clusters:read",
  "clusters.get": "clusters:read",
  "organizations.list": "organizations:read",
  "organizations.create": "organizations:write",
  "organizations.update": "organizations:write",
  "organizations.members": "members:read",
  "organizations.invite": "invitations:write",
  "sites.list": "sites:read",
  "sites.get": "sites:read",
  "sites.setEnabled": "sites:write",
  "admin.sites.suspend": "sites:suspend",
  "admin.sites.resume": "sites:suspend",
  "admin.organizations.getLimits": "limits:read",
  "admin.organizations.setLimits": "limits:write",
} as const satisfies Record<string, ServiceAccountScope | null>;

export function serviceAccountScopeFor(
  procedure: string,
): { allowed: false } | { allowed: true; scope: ServiceAccountScope | null } {
  if (!Object.hasOwn(serviceAccountProcedures, procedure)) return { allowed: false };
  return {
    allowed: true,
    scope: serviceAccountProcedures[procedure as keyof typeof serviceAccountProcedures],
  };
}

/** Service account keys start with this prefix; user AccessKeys start with "ewk_". */
export const SERVICE_ACCOUNT_KEY_PREFIX = "ews_";

const accountName = z.string().trim().min(1).max(64);
const scopes = z
  .array(serviceAccountScope)
  .max(serviceAccountScope.options.length)
  .transform((values) => [...new Set(values)].sort());

export const serviceAccountKey = z.object({
  id: uuid,
  name: z.string(),
  /** First characters of the key. */
  prefix: z.string(),
  createdAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
});

export const serviceAccount = z.object({
  id: uuid,
  name: z.string(),
  scopes: z.array(serviceAccountScope),
  enabled: z.boolean(),
  keys: z.array(serviceAccountKey),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const serviceAccountsContract = {
  list: oc
    .route({ method: "GET", path: "/service-accounts", tags: ["service-accounts"] })
    .output(z.array(serviceAccount)),
  create: oc
    .route({
      method: "POST",
      path: "/service-accounts",
      tags: ["service-accounts"],
      successStatus: 201,
    })
    .input(z.object({ name: accountName, scopes, enabled: z.boolean().default(true) }))
    .output(serviceAccount),
  update: oc
    .route({ method: "PATCH", path: "/service-accounts/{id}", tags: ["service-accounts"] })
    .input(
      z.object({
        id: uuid,
        name: accountName.optional(),
        scopes: scopes.optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .output(serviceAccount),
  /** Deletes the account and all of its keys. */
  delete: oc
    .route({ method: "DELETE", path: "/service-accounts/{id}", tags: ["service-accounts"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  /** The key is returned once and never again. */
  createKey: oc
    .route({
      method: "POST",
      path: "/service-accounts/{id}/keys",
      tags: ["service-accounts"],
      successStatus: 201,
    })
    .input(z.object({ id: uuid, name: z.string().trim().max(64).default("") }))
    .output(z.object({ key: serviceAccountKey, secret: z.string() })),
  revokeKey: oc
    .route({
      method: "POST",
      path: "/service-accounts/{id}/keys/{keyId}/revoke",
      tags: ["service-accounts"],
    })
    .input(z.object({ id: uuid, keyId: uuid }))
    .output(serviceAccountKey),
};

export type ServiceAccount = z.infer<typeof serviceAccount>;
export type ServiceAccountKey = z.infer<typeof serviceAccountKey>;
