/**
 * The "nothing here" answer of a procedure the fixtures do not cover, derived from its output
 * schema: empty arrays and records, zero, false, the first enum value, null where allowed, the
 * schema's defaults; times are "now" and ids a fixed UUID so formatting never sees garbage.
 */
import { contract } from "@edgeweir/contract";

interface ZodDef {
  type: string;
  format?: string;
  shape?: Record<string, ZodLike>;
  element?: ZodLike;
  innerType?: ZodLike;
  defaultValue?: unknown;
  entries?: Record<string, string | number>;
  values?: unknown[];
  options?: ZodLike[];
  in?: ZodLike;
  left?: ZodLike;
  right?: ZodLike;
  items?: ZodLike[];
  getter?: () => ZodLike;
}

interface ZodLike {
  _zod: { def: ZodDef };
}

const NIL_UUID = "00000000-0000-4000-8000-000000000000";

export function emptyOf(schema: ZodLike): unknown {
  const def = schema._zod.def;
  switch (def.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(def.shape ?? {})) {
        const v = emptyOf(value);
        if (v !== undefined) out[key] = v;
      }
      return out;
    }
    case "array":
    case "set":
      return [];
    case "record":
    case "map":
      return {};
    case "tuple":
      return (def.items ?? []).map(emptyOf);
    case "string":
      if (def.format === "datetime") return new Date().toISOString();
      if (def.format === "uuid" || def.format === "guid") return NIL_UUID;
      return "";
    case "number":
    case "int":
    case "bigint":
      return 0;
    case "boolean":
      return false;
    case "date":
      return new Date();
    case "enum":
      return Object.values(def.entries ?? {})[0];
    case "literal":
      return def.values?.[0];
    case "nullable":
      return null;
    case "optional":
    case "undefined":
    case "void":
      return undefined;
    case "default":
    case "prefault": {
      const value = def.defaultValue;
      return typeof value === "function" ? (value as () => unknown)() : value;
    }
    case "union":
      return def.options?.[0] ? emptyOf(def.options[0]) : null;
    case "intersection":
      return {
        ...(emptyOf(def.left as ZodLike) as object),
        ...(emptyOf(def.right as ZodLike) as object),
      };
    case "pipe":
      return emptyOf(def.in as ZodLike);
    case "lazy":
      return def.getter ? emptyOf(def.getter()) : null;
    case "readonly":
    case "catch":
    case "nonoptional":
    case "success":
      return def.innerType ? emptyOf(def.innerType) : null;
    default:
      return null;
  }
}

/** The procedure's contract entry (`["sites", "list"]` → contract.sites.list). */
function procedureAt(path: readonly string[]): unknown {
  let node: unknown = contract;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function outputSchema(path: readonly string[]): ZodLike | undefined {
  const procedure = procedureAt(path) as { "~orpc"?: { outputSchema?: ZodLike } } | undefined;
  return procedure?.["~orpc"]?.outputSchema;
}

export function emptyOutput(path: readonly string[]): unknown {
  const schema = outputSchema(path);
  return schema ? emptyOf(schema) : null;
}
