import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/**
 * Node extensions (docs/reference/extensions.md): signed Lua packages in the
 * format edgeweir-node-extension-v1, installed by the operator and run by
 * nodes with feature extensions-v1. The manifest rules and the configuration
 * schema subset live here so that the server and the web console agree.
 */
export const EXTENSION_FORMAT = "edgeweir-node-extension-v1";
export const EXTENSIONS_FEATURE = "extensions-v1";
/** Lua API versions this console can deliver. */
export const EXTENSION_LUA_APIS = [1] as const;

export const EXTENSION_LIMITS = {
  archiveBytes: 4 * 1024 * 1024,
  unpackedBytes: 16 * 1024 * 1024,
  entries: 512,
  fileBytes: 4 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  pathBytes: 200,
} as const;

export const EXTENSION_ID_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED_IDS = new Set([
  "edgeweir",
  "core",
  "challenge",
  "session",
  "health",
  "ext",
  "settings",
  "verify",
]);
export const EXTENSION_PUBLISHER_RE = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SHORT_NAME_RE = /^[a-z][a-z0-9_]{0,15}$/;
const ENDPOINT_PATH_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const EXTENSION_HOOKS = [
  "init",
  "access",
  "access_late",
  "header_filter",
  "body_filter",
  "log",
  "endpoint",
] as const;
export const EXTENSION_CAPABILITIES = [
  "verdicts",
  "request_headers",
  "request_body",
  "response_headers",
  "html_inject",
  "body_rewrite",
  "http_client",
  "timers",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];
export const EXTENSION_ENDPOINT_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "OPTIONS",
] as const;
export const EXTENSION_FIELD_TYPES = ["string", "number", "boolean"] as const;
export type ExtensionFieldType = (typeof EXTENSION_FIELD_TYPES)[number];

// ---------------------------------------------------------------------------
// Semantic versions and ranges

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(value: string): SemVer | null {
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** Semantic Versioning 2.0.0 precedence: negative, zero or positive. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i] as string;
    const y = b.pre[i] as string;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=)?(\S+)$/;

/** Parses "op version" comparators separated by spaces; null when malformed. */
export function parseSemverRange(range: string): { op: string; version: SemVer }[] | null {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4 || parts[0] === "") return null;
  const out: { op: string; version: SemVer }[] = [];
  for (const part of parts) {
    const match = COMPARATOR_RE.exec(part);
    const version = match ? parseSemver(match[2] as string) : null;
    if (!match || !version) return null;
    out.push({ op: match[1] ?? "=", version });
  }
  return out;
}

/** Whether `version` ("v" prefix allowed) satisfies the range; an unparsable version does not. */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const parsed = parseSemver(version.replace(/^v/, ""));
  const comparators = parseSemverRange(range);
  if (!parsed || !comparators) return false;
  return comparators.every(({ op, version: bound }) => {
    const c = compareSemver(parsed, bound);
    switch (op) {
      case ">=":
        return c >= 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Configuration schema subset (JSON Schema 2020-12)

const localized = z.union([
  z.string().max(512),
  z.partialRecord(z.enum(["en", "zh-CN"]), z.string().max(512)),
]);
export type ExtensionText = z.infer<typeof localized>;

/** Whether a pattern compiles in JavaScript and avoids what PCRE reads differently. */
function portablePattern(pattern: string): boolean {
  if (pattern.length > 512 || /\(\?<[=!]|\\[1-9]|\\k</.test(pattern)) return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

const annotations = {
  title: localized.optional(),
  description: localized.optional(),
};

const stringProperty = z.strictObject({
  type: z.literal("string"),
  ...annotations,
  default: z.string().max(4096).optional(),
  enum: z.array(z.string().max(256)).min(1).max(64).optional(),
  minLength: z.number().int().min(0).max(4096).optional(),
  maxLength: z.number().int().min(0).max(4096).optional(),
  pattern: z.string().refine(portablePattern, "unsupported pattern").optional(),
  format: z.enum(["uri", "hostname"]).optional(),
  "x-secret": z.boolean().optional(),
});
const numberProperty = z.strictObject({
  type: z.enum(["integer", "number"]),
  ...annotations,
  default: z.number().optional(),
  enum: z.array(z.number()).min(1).max(64).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
const booleanProperty = z.strictObject({
  type: z.literal("boolean"),
  ...annotations,
  default: z.boolean().optional(),
});
const itemSchema = z.union([
  stringProperty.omit({ title: true, description: true, default: true, "x-secret": true }),
  numberProperty.omit({ title: true, description: true, default: true }).extend({
    type: z.literal("integer"),
  }),
]);
const arrayProperty = z.strictObject({
  type: z.literal("array"),
  ...annotations,
  items: itemSchema,
  default: z
    .array(z.union([z.string(), z.number()]))
    .max(256)
    .optional(),
  maxItems: z.number().int().min(0).max(256).optional(),
  uniqueItems: z.boolean().optional(),
});
export const extensionConfigProperty = z.union([
  stringProperty,
  numberProperty,
  booleanProperty,
  arrayProperty,
]);
export type ExtensionConfigProperty = z.infer<typeof extensionConfigProperty>;

export const extensionConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    type: z.literal("object"),
    ...annotations,
    properties: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), extensionConfigProperty)
      .default({})
      .refine((value) => Object.keys(value).length <= 64, "too many properties"),
    required: z.array(z.string()).max(64).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .superRefine((schema, ctx) => {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(schema.properties, name)) {
        ctx.addIssue({ code: "custom", path: ["required"], message: `unknown property ${name}` });
      }
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (property.default === undefined) continue;
      const errors = validateValue(property, property.default, [name]);
      if (errors.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["properties", name, "default"],
          message: "invalid default",
        });
      }
    }
  });
export type ExtensionConfigSchema = z.infer<typeof extensionConfigSchema>;

export interface ExtensionConfigIssue {
  path: string[];
  /** required | type | enum | min | max | pattern | format | unknown | unique */
  code: string;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function validateScalar(
  property: z.infer<typeof itemSchema> | ExtensionConfigProperty,
  value: unknown,
  path: string[],
): ExtensionConfigIssue[] {
  const issue = (code: string) => [{ path, code }];
  switch (property.type) {
    case "string": {
      if (typeof value !== "string") return issue("type");
      if (property.enum && !property.enum.includes(value)) return issue("enum");
      if (property.minLength !== undefined && [...value].length < property.minLength)
        return issue("min");
      if ([...value].length > (property.maxLength ?? 4096)) return issue("max");
      if (property.pattern && !new RegExp(property.pattern, "u").test(value))
        return issue("pattern");
      if (property.format === "hostname" && !HOSTNAME_RE.test(value)) return issue("format");
      if (property.format === "uri" && !URL.canParse(value)) return issue("format");
      return [];
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return issue("type");
      if (property.type === "integer" && !Number.isInteger(value)) return issue("type");
      if (property.enum && !property.enum.includes(value)) return issue("enum");
      if (property.minimum !== undefined && value < property.minimum) return issue("min");
      if (property.maximum !== undefined && value > property.maximum) return issue("max");
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : issue("type");
    default:
      return issue("type");
  }
}

function validateValue(
  property: ExtensionConfigProperty,
  value: unknown,
  path: string[],
): ExtensionConfigIssue[] {
  if (property.type !== "array") return validateScalar(property, value, path);
  if (!Array.isArray(value)) return [{ path, code: "type" }];
  if (value.length > (property.maxItems ?? 256)) return [{ path, code: "max" }];
  if (property.uniqueItems && new Set(value).size !== value.length)
    return [{ path, code: "unique" }];
  return value.flatMap((item, index) =>
    validateScalar(property.items, item, [...path, String(index)]),
  );
}

/**
 * Validates a configuration object against a schema and fills in defaults.
 * Unknown keys are rejected; a missing schema accepts only `{}`.
 */
export function applyExtensionConfig(
  schema: ExtensionConfigSchema | undefined,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: ExtensionConfigIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: [], code: "type" }] };
  }
  const properties = schema?.properties ?? {};
  const issues: ExtensionConfigIssue[] = [];
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(properties, key)) issues.push({ path: [key], code: "unknown" });
  }
  for (const [name, property] of Object.entries(properties)) {
    const given = (input as Record<string, unknown>)[name];
    if (given === undefined || given === null) {
      if (property.default !== undefined) value[name] = property.default;
      else if (schema?.required?.includes(name)) issues.push({ path: [name], code: "required" });
      continue;
    }
    const errors = validateValue(property, given, [name]);
    if (errors.length > 0) issues.push(...errors);
    else value[name] = given;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** The configuration with `x-secret` strings replaced by a mask (non-empty) for display. */
export const EXTENSION_SECRET_MASK = "••••••";
export function maskExtensionConfig(
  schema: ExtensionConfigSchema | undefined,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...value };
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (
      property.type === "string" &&
      property["x-secret"] &&
      typeof out[name] === "string" &&
      out[name]
    ) {
      out[name] = EXTENSION_SECRET_MASK;
    }
  }
  return out;
}

/** Keeps stored secrets where the client sent back the mask. */
export function unmaskExtensionConfig(
  schema: ExtensionConfigSchema | undefined,
  input: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...input };
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (property.type === "string" && property["x-secret"] && out[name] === EXTENSION_SECRET_MASK) {
      out[name] = stored[name];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest

const names = (re: RegExp, max: number) =>
  z
    .array(z.string().regex(re))
    .max(max)
    .refine((list) => new Set(list).size === list.length, "duplicate name");

export const extensionManifest = z
  .strictObject({
    format: z.literal(EXTENSION_FORMAT),
    id: z
      .string()
      .regex(EXTENSION_ID_RE)
      .refine((id) => !RESERVED_IDS.has(id), "reserved id"),
    version: z.string().regex(SEMVER_RE),
    publisher: z.string().regex(EXTENSION_PUBLISHER_RE),
    name: z.strictObject({
      en: z.string().min(1).max(64),
      "zh-CN": z.string().min(1).max(64).optional(),
    }),
    description: z
      .strictObject({ en: z.string().max(512), "zh-CN": z.string().max(512).optional() })
      .optional(),
    license: z.string().max(128).optional(),
    homepage: z
      .string()
      .max(2048)
      .refine((url) => url.startsWith("https://") && URL.canParse(url), "https URL")
      .optional(),
    requires: z.strictObject({
      lua_api: z.literal(1),
      node: z
        .string()
        .max(128)
        .refine((range) => parseSemverRange(range) !== null, "invalid range")
        .optional(),
    }),
    hooks: z
      .array(z.enum(EXTENSION_HOOKS))
      .min(1)
      .refine((list) => new Set(list).size === list.length, "duplicate hook"),
    capabilities: z
      .array(z.enum(EXTENSION_CAPABILITIES))
      .default([])
      .refine((list) => new Set(list).size === list.length, "duplicate capability"),
    config: z
      .strictObject({
        global: extensionConfigSchema.optional(),
        site: extensionConfigSchema.optional(),
      })
      .default({}),
    fields: z
      .array(
        z.strictObject({
          name: z.string().regex(NAME_RE),
          type: z.enum(EXTENSION_FIELD_TYPES),
          description: localized.optional(),
        }),
      )
      .max(16)
      .default([])
      .refine((list) => new Set(list.map((f) => f.name)).size === list.length, "duplicate field"),
    log_fields: names(NAME_RE, 8).default([]),
    counters: names(NAME_RE, 8)
      .refine((list) => !list.includes("faults"), "reserved counter")
      .default([]),
    endpoints: z
      .array(
        z.strictObject({
          path: z
            .string()
            .regex(ENDPOINT_PATH_RE)
            .refine((path) => path !== "assets", "reserved path"),
          methods: z
            .array(z.enum(EXTENSION_ENDPOINT_METHODS))
            .min(1)
            .refine((list) => new Set(list).size === list.length, "duplicate method"),
          max_body: z.number().int().min(0).max(65536).optional(),
        }),
      )
      .max(8)
      .default([])
      .refine(
        (list) => new Set(list.map((e) => e.path)).size === list.length,
        "duplicate endpoint",
      ),
    shared_dicts: z
      .array(
        z.strictObject({
          name: z.string().regex(SHORT_NAME_RE),
          size_kb: z.number().int().min(16).max(16384),
        }),
      )
      .max(4)
      .default([])
      .refine((list) => new Set(list.map((d) => d.name)).size === list.length, "duplicate dict")
      .refine((list) => list.reduce((sum, d) => sum + d.size_kb, 0) <= 32768, "too large"),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.hooks.includes("body_filter") && !manifest.capabilities.includes("body_rewrite")) {
      ctx.addIssue({ code: "custom", path: ["hooks"], message: "body_filter needs body_rewrite" });
    }
    if (manifest.hooks.includes("endpoint") !== manifest.endpoints.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoints"],
        message: "endpoint hook and endpoints go together",
      });
    }
  });
export type ExtensionManifest = z.infer<typeof extensionManifest>;

// ---------------------------------------------------------------------------
// API

const extensionId = z.string().regex(EXTENSION_ID_RE);
const version = z.string().regex(SEMVER_RE);
export const extensionFailureMode = z.enum(["open", "closed"]);
const configObject = z.record(z.string(), z.unknown());

const packageInput = z.object({
  /** The .ewx bytes, base64. */
  package: z
    .string()
    .min(1)
    .max(Math.ceil((EXTENSION_LIMITS.archiveBytes * 4) / 3) + 4),
  /** The .ewx.sig JWS (compact serialization). */
  signature: z.string().trim().min(1).max(4096),
});

const extensionKeyView = z.object({
  kid: z.string(),
  publisher: z.string(),
  /** OKP / Ed25519 JWK of the public key. */
  jwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string() }),
  label: z.string(),
  createdAt: isoDateTime,
  /** Versions signed by the key. */
  versions: z.number().int(),
});

const verifiedPackage = z.object({
  manifest: extensionManifest,
  sha256: z.string(),
  size: z.number().int(),
  key: z.object({ kid: z.string(), publisher: z.string(), label: z.string() }),
  /** Installed active version of the same id, if any. */
  installedVersion: z.string().nullable(),
  /** Whether the version is already stored. */
  stored: z.boolean(),
});

const extensionVersionView = z.object({
  version: z.string(),
  sha256: z.string(),
  size: z.number().int(),
  kid: z.string(),
  uploadedAt: isoDateTime,
  active: z.boolean(),
});

const nodeExtensionState = z.object({
  nodeId: uuid,
  nodeName: z.string(),
  clusterId: uuid,
  /** loaded | failed | incompatible | disabled | pending (not reported yet) | unsupported (no extensions-v1) */
  state: z.string(),
  version: z.string(),
  message: z.string(),
  faults: z.number().int(),
  trips: z.number().int(),
});

const extensionSummary = z.object({
  id: z.string(),
  version: z.string(),
  publisher: z.string(),
  name: extensionManifest.shape.name,
  enabled: z.boolean(),
  failureMode: extensionFailureMode,
  sites: z.number().int(),
  /** Nodes that report the active version loaded, and nodes with a problem. */
  nodesLoaded: z.number().int(),
  nodesFailing: z.number().int(),
  installedAt: isoDateTime,
  updatedAt: isoDateTime,
});

const extensionDetail = extensionSummary.extend({
  manifest: extensionManifest,
  sha256: z.string(),
  /** Global configuration; `x-secret` values masked. */
  config: configObject,
  versions: z.array(extensionVersionView),
  siteList: z.array(z.object({ id: uuid, name: z.string(), config: configObject })),
  nodes: z.array(nodeExtensionState),
  /** Rules that read the extension's fields (uninstall is refused while any exist). */
  ruleReferences: z.number().int(),
});

const siteExtensionView = z.object({
  id: z.string(),
  name: extensionManifest.shape.name,
  version: z.string(),
  /** Extension enabled globally. */
  installedEnabled: z.boolean(),
  enabled: z.boolean(),
  /** Site configuration (masked) and its schema. */
  config: configObject,
  schema: extensionConfigSchema.nullable(),
  capabilities: z.array(z.enum(EXTENSION_CAPABILITIES)),
  updatedAt: isoDateTime.nullable(),
});

const settingsView = z.object({ disabled: z.boolean() });

const tags = ["extensions"];

export const extensionsContract = {
  list: oc.route({ method: "GET", path: "/extensions", tags }).output(z.array(extensionSummary)),
  get: oc
    .route({ method: "GET", path: "/extensions/{id}", tags })
    .input(z.object({ id: extensionId }))
    .output(extensionDetail),
  /** Checks a package and its signature without storing anything. */
  verify: oc
    .route({ method: "POST", path: "/extensions/verify", tags })
    .input(packageInput)
    .output(verifiedPackage),
  /** Installs a new extension (disabled) or stores a version and makes it active. */
  install: oc
    .route({ method: "POST", path: "/extensions", tags, successStatus: 201 })
    .input(packageInput)
    .output(extensionDetail),
  /** Makes another stored version active (upgrade or rollback). */
  activate: oc
    .route({ method: "POST", path: "/extensions/{id}/activate", tags })
    .input(z.object({ id: extensionId, version }))
    .output(extensionDetail),
  deleteVersion: oc
    .route({ method: "DELETE", path: "/extensions/{id}/versions/{version}", tags })
    .input(z.object({ id: extensionId, version }))
    .output(extensionDetail),
  update: oc
    .route({ method: "PATCH", path: "/extensions/{id}", tags })
    .input(
      z.object({
        id: extensionId,
        enabled: z.boolean().optional(),
        failureMode: extensionFailureMode.optional(),
        config: configObject.optional(),
      }),
    )
    .output(extensionDetail),
  uninstall: oc
    .route({ method: "DELETE", path: "/extensions/{id}", tags })
    .input(z.object({ id: extensionId }))
    .output(z.object({ ok: z.literal(true) })),
  settings: oc.route({ method: "GET", path: "/extensions/settings", tags }).output(settingsView),
  updateSettings: oc
    .route({ method: "PUT", path: "/extensions/settings", tags })
    .input(settingsView)
    .output(settingsView),
  /** Extensions of a site: every installed one, with the site's state. */
  forSite: oc
    .route({ method: "GET", path: "/sites/{siteId}/extensions", tags })
    .input(z.object({ siteId: uuid }))
    .output(z.array(siteExtensionView)),
  updateSite: oc
    .route({ method: "PUT", path: "/sites/{siteId}/extensions/{id}", tags })
    .input(
      z.object({
        siteId: uuid,
        id: extensionId,
        enabled: z.boolean(),
        config: configObject.default({}),
      }),
    )
    .output(siteExtensionView),
};

export const extensionKeysContract = {
  list: oc
    .route({ method: "GET", path: "/extension-keys", tags })
    .output(z.array(extensionKeyView)),
  add: oc
    .route({ method: "POST", path: "/extension-keys", tags, successStatus: 201 })
    .input(
      z.object({
        publisher: z.string().trim().toLowerCase().regex(EXTENSION_PUBLISHER_RE),
        /** The public key as JWK JSON, or the bare base64url "x". */
        key: z.string().trim().min(1).max(1024),
        label: z.string().trim().max(64).default(""),
      }),
    )
    .output(extensionKeyView),
  remove: oc
    .route({ method: "DELETE", path: "/extension-keys/{kid}", tags })
    .input(z.object({ kid: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
    .output(z.object({ ok: z.literal(true) })),
};

export type ExtensionSummary = z.infer<typeof extensionSummary>;
export type ExtensionDetail = z.infer<typeof extensionDetail>;
export type ExtensionKeyView = z.infer<typeof extensionKeyView>;
export type VerifiedExtensionPackage = z.infer<typeof verifiedPackage>;
export type SiteExtensionView = z.infer<typeof siteExtensionView>;
export type NodeExtensionState = z.infer<typeof nodeExtensionState>;

/** Rule field of an extension: `ext.<id>.<name>`. */
export const EXTENSION_FIELD_RE = /^ext\.([a-z][a-z0-9-]{1,38}[a-z0-9])\.([a-z][a-z0-9_]{0,31})$/;
