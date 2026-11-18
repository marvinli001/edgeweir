import { oc } from "@orpc/contract";
import * as z from "zod";
import { authScope } from "./auth-rules";
import { expectedUpdatedAt, isoDateTime, uuid } from "./schemas";

export const API_SECURITY_FEATURE = "api-security-v1";
export const API_SECURITY_LIMITS = {
  documentBytes: 524_288,
  configBytes: 1_048_576,
  endpoints: 200,
  candidates: 500,
  schemaDepth: 8,
  schemaNodes: 2000,
  bodyBytes: 131_072,
  retentionDays: 7,
} as const;
export const API_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const apiCheck = z.enum(["schema", "jwt", "graphql"]);
const apiMode = z.enum(["off", "observe", "enforce"]);
export const apiMethod = z.enum(API_METHODS);
function wellFormedUnicode(value: string): boolean {
  for (const point of value) {
    const code = point.charCodeAt(0);
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
export const apiPath = z
  .string()
  .max(512)
  .regex(
    /^\/(?:[A-Za-z0-9_~.!$&'()+,=:@-]+|\{[A-Za-z][A-Za-z0-9_]{0,31}\})?(?:\/(?:[A-Za-z0-9_~.!$&'()+,=:@-]+|\{[A-Za-z][A-Za-z0-9_]{0,31}\}))*\/?$/,
  )
  .refine(
    (path) => !path.includes("//") && !path.split("/").some((s) => s === "." || s === ".."),
    "canonical path required",
  );

export interface ApiSchema {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  nullable?: boolean;
  properties?: Record<string, ApiSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ApiSchema;
  enum?: (string | number | boolean | null)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}
const apiSchemaNode: z.ZodType<ApiSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]),
    nullable: z.boolean().optional(),
    properties: z.record(z.string().max(128).refine(wellFormedUnicode), apiSchemaNode).optional(),
    required: z.array(z.string().max(128).refine(wellFormedUnicode)).max(128).optional(),
    additionalProperties: z.boolean().optional(),
    items: apiSchemaNode.optional(),
    enum: z
      .array(
        z.union([
          z.string().max(1024).refine(wellFormedUnicode),
          z.number(),
          z.boolean(),
          z.null(),
        ]),
      )
      .max(100)
      .optional(),
    minLength: z.number().int().min(0).max(131072).optional(),
    maxLength: z.number().int().min(0).max(131072).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minItems: z.number().int().min(0).max(10000).optional(),
    maxItems: z.number().int().min(0).max(10000).optional(),
  }),
);
export const apiSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
    const seen = new Set<object>();
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item) break;
      if (
        ++nodes > API_SECURITY_LIMITS.schemaNodes ||
        item.depth > API_SECURITY_LIMITS.schemaDepth
      ) {
        ctx.addIssue({ code: "custom", message: "schema budget exceeded" });
        return;
      }
      if (typeof item.value !== "object" || item.value === null) continue;
      if (seen.has(item.value)) {
        ctx.addIssue({ code: "custom", message: "recursive schema" });
        return;
      }
      seen.add(item.value);
      const node = item.value as Record<string, unknown>;
      if (node.items !== undefined) pending.push({ value: node.items, depth: item.depth + 1 });
      if (typeof node.properties === "object" && node.properties !== null) {
        for (const child of Object.values(node.properties))
          pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  })
  .pipe(apiSchemaNode);
export const apiEndpoint = z.strictObject({
  method: apiMethod,
  path: apiPath,
  parameters: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128).refine(wellFormedUnicode),
        in: z.enum(["path", "query", "header"]),
        required: z.boolean(),
        schema: apiSchema,
      }),
    )
    .max(64),
  body: z.strictObject({ required: z.boolean(), schema: apiSchema }).optional(),
});
export function apiTemplatesAmbiguous(
  a: { method: string; path: string },
  b: { method: string; path: string },
): boolean {
  if (a.method !== b.method || a.path.endsWith("/") !== b.path.endsWith("/")) return false;
  const left = a.path.split("/").filter(Boolean),
    right = b.path.split("/").filter(Boolean);
  const parameter = (part: string) => /^\{[^}]+\}$/.test(part);
  return (
    left.length === right.length &&
    left.filter((part) => !parameter(part)).length ===
      right.filter((part) => !parameter(part)).length &&
    left.every(
      (part, index) => part === right[index] || parameter(part) || parameter(right[index] ?? ""),
    )
  );
}
const apiImportIssue = z.object({ location: z.string().max(1024), code: z.string().max(80) });
const publicJwk = z.strictObject({
  kid: z.string().min(1).max(128),
  alg: z.enum(["RS256", "ES256", "EdDSA"]),
  kty: z.enum(["RSA", "EC", "OKP"]),
  n: z.string().max(1400).optional(),
  e: z.string().max(16).optional(),
  crv: z.enum(["P-256", "Ed25519"]).optional(),
  x: z.string().max(128).optional(),
  y: z.string().max(128).optional(),
});
export const apiException = z.strictObject({
  id: uuid,
  enabled: z.boolean(),
  method: z.union([apiMethod, z.literal("*")]),
  path: apiPath,
  check: apiCheck,
  reason: z.string().trim().min(1).max(256),
});
export const apiSecuritySettings = z
  .strictObject({
    version: z.literal(1),
    discovery: z.strictObject({
      enabled: z.boolean(),
      sampleRate: z.number().int().min(1).max(10000),
    }),
    schema: z.strictObject({
      mode: apiMode,
      unknownEndpoints: z.enum(["allow", "block"]),
      endpoints: z.array(apiEndpoint).max(API_SECURITY_LIMITS.endpoints),
      issues: z.array(apiImportIssue).max(200),
    }),
    jwt: z.strictObject({
      mode: apiMode,
      scope: authScope,
      issuer: z.string().max(512),
      audiences: z.array(z.string().min(1).max(256)).max(16),
      algorithms: z
        .array(z.enum(["RS256", "ES256", "EdDSA"]))
        .min(1)
        .max(3),
      keys: z.array(publicJwk).max(8),
      clockToleranceSeconds: z.number().int().min(0).max(120),
    }),
    graphql: z.strictObject({
      mode: apiMode,
      pathPrefixes: z.array(apiPath).min(1).max(16),
      maxDepth: z.number().int().min(1).max(30),
      maxFields: z.number().int().min(1).max(1000),
      maxAliases: z.number().int().min(0).max(200),
      maxBatch: z.number().int().min(1).max(20),
      maxDocumentBytes: z.number().int().min(256).max(65536),
      introspection: z.boolean(),
    }),
    exceptions: z.array(apiException).max(100),
  })
  .superRefine((value, ctx) => {
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        if (!wellFormedUnicode(item)) {
          ctx.addIssue({ code: "custom", message: "well-formed Unicode required" });
          return;
        }
      } else if (item !== null && typeof item === "object") {
        if (seen.has(item)) continue;
        seen.add(item);
        for (const [key, child] of Object.entries(item)) pending.push(key, child);
      }
    }
    if (value.schema.mode === "enforce" && value.schema.issues.length)
      ctx.addIssue({
        code: "custom",
        path: ["schema", "issues"],
        message: "unsupported constraints prevent enforcement",
      });
    if (
      value.jwt.mode !== "off" &&
      (!value.jwt.issuer || !value.jwt.audiences.length || !value.jwt.keys.length)
    )
      ctx.addIssue({
        code: "custom",
        path: ["jwt"],
        message: "issuer, audience and public keys required",
      });
    if (new Set(value.jwt.keys.map((key) => key.kid)).size !== value.jwt.keys.length)
      ctx.addIssue({ code: "custom", path: ["jwt", "keys"], message: "duplicate kid" });
    if (
      new Set(value.schema.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`))
        .size !== value.schema.endpoints.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["schema", "endpoints"],
        message: "duplicate endpoint",
      });
    for (const [index, endpoint] of value.schema.endpoints.entries())
      if (
        value.schema.endpoints
          .slice(0, index)
          .some((previous) => apiTemplatesAmbiguous(previous, endpoint))
      )
        ctx.addIssue({
          code: "custom",
          path: ["schema", "endpoints", index],
          message: "ambiguous endpoint templates",
        });
    let nodes = 0;
    const visit = (schema: ApiSchema, depth: number): boolean => {
      nodes++;
      if (depth > API_SECURITY_LIMITS.schemaDepth || nodes > API_SECURITY_LIMITS.schemaNodes)
        return false;
      return (
        Object.values(schema.properties ?? {}).every((child) => visit(child, depth + 1)) &&
        (!schema.items || visit(schema.items, depth + 1))
      );
    };
    for (const endpoint of value.schema.endpoints) {
      const schemas = [
        ...endpoint.parameters.map((parameter) => parameter.schema),
        ...(endpoint.body ? [endpoint.body.schema] : []),
      ];
      if (!schemas.every((schema) => visit(schema, 1))) {
        ctx.addIssue({
          code: "custom",
          path: ["schema", "endpoints"],
          message: "schema budget exceeded",
        });
        break;
      }
    }
  });
export type ApiSecuritySettings = z.infer<typeof apiSecuritySettings>;
export type ApiEndpoint = z.infer<typeof apiEndpoint>;
export const API_SECURITY_DEFAULTS: ApiSecuritySettings = {
  version: 1,
  discovery: { enabled: false, sampleRate: 1000 },
  schema: { mode: "off", unknownEndpoints: "allow", endpoints: [], issues: [] },
  jwt: {
    mode: "off",
    scope: { domains: [], pathPrefixes: [], extensions: [], excludePathPrefixes: [] },
    issuer: "",
    audiences: [],
    algorithms: ["RS256"],
    keys: [],
    clockToleranceSeconds: 30,
  },
  graphql: {
    mode: "off",
    pathPrefixes: ["/graphql"],
    maxDepth: 10,
    maxFields: 200,
    maxAliases: 30,
    maxBatch: 5,
    maxDocumentBytes: 65536,
    introspection: false,
  },
  exceptions: [],
};
export const apiSecurityLog = z.strictObject({
  template: apiPath,
  source: z.enum(["traffic", "schema"]),
  issues: z
    .array(
      z.strictObject({
        check: apiCheck,
        code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        mode: z.enum(["observe", "enforce"]),
      }),
    )
    .max(8),
  exceptionIds: z.array(uuid).max(8),
});
const state = z.object({
  settings: apiSecuritySettings,
  updatedAt: isoDateTime,
  unsupportedNodes: z.number().int(),
});
const discoveredEndpoint = z.object({
  id: uuid,
  method: apiMethod,
  path: apiPath,
  source: z.enum(["traffic", "schema", "manual"]),
  confirmed: z.boolean(),
  firstSeen: isoDateTime,
  lastSeen: isoDateTime,
  sampledRequests: z.number(),
  violations: z.number(),
});
export const apiSecurityContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/api-security", tags: ["sites"] })
    .input(z.object({ id: uuid }))
    .output(state),
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/api-security", tags: ["sites"] })
    .input(z.object({ id: uuid, settings: apiSecuritySettings, expectedUpdatedAt }))
    .output(state),
  importOpenApi: oc
    .route({ method: "POST", path: "/sites/{id}/api-security/import", tags: ["sites"] })
    .input(z.object({ id: uuid, document: z.string().max(API_SECURITY_LIMITS.documentBytes) }))
    .output(
      z.object({
        openapiVersion: z.string(),
        endpoints: z.array(apiEndpoint),
        issues: z.array(apiImportIssue),
      }),
    ),
  results: oc
    .route({ method: "GET", path: "/sites/{id}/api-security/results", tags: ["sites"] })
    .input(z.object({ id: uuid }))
    .output(
      z.object({
        endpoints: z.array(discoveredEndpoint),
        events: z.array(
          z.object({
            time: isoDateTime,
            requestId: z.string(),
            method: z.string(),
            status: z.number(),
            detail: apiSecurityLog,
          }),
        ),
        sampleRate: z.number().int(),
        retentionDays: z.number().int(),
        unsupportedNodes: z.number().int(),
      }),
    ),
  confirmEndpoint: oc
    .route({
      method: "PUT",
      path: "/sites/{id}/api-security/endpoints/{endpointId}",
      tags: ["sites"],
    })
    .input(z.object({ id: uuid, endpointId: uuid, path: apiPath }))
    .output(discoveredEndpoint),
};
export type ApiSecurityState = z.infer<typeof state>;
export type ApiSecurityResults = {
  endpoints: z.infer<typeof discoveredEndpoint>[];
  events: {
    time: string;
    requestId: string;
    method: string;
    status: number;
    detail: z.infer<typeof apiSecurityLog>;
  }[];
  sampleRate: number;
  retentionDays: number;
  unsupportedNodes: number;
};
