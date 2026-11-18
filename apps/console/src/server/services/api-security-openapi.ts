import {
  API_METHODS,
  API_SECURITY_LIMITS,
  type ApiEndpoint,
  type ApiSchema,
  apiEndpoint,
  apiPath,
  apiSchema,
  apiTemplatesAmbiguous,
} from "@edgeweir/contract";
import { fail } from "../lib/errors";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (parent: string, key: string | number) =>
  `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const annotations = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
]);
const schemaKeys = new Set([
  "type",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);
const methodSet: ReadonlySet<string> = new Set(API_METHODS.map((method) => method.toLowerCase()));
const pathMetadata = new Set(["summary", "description", "parameters", "servers"]);
const operationKeys = new Set([
  "tags",
  "summary",
  "description",
  "externalDocs",
  "operationId",
  "parameters",
  "requestBody",
  "responses",
  "callbacks",
  "deprecated",
  "security",
  "servers",
]);
const parameterKeys = new Set([
  "name",
  "in",
  "description",
  "required",
  "deprecated",
  "schema",
  "style",
  "explode",
  "allowEmptyValue",
  "allowReserved",
  "example",
  "examples",
]);

function decimal(value: string): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 128) return;
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 308) return;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return `${match[1]}${significant}e${exponent - (match[3]?.length ?? 0) + digits.length - significant.length}`;
}

export function importOpenApi(document: string) {
  function invalid(): never {
    return fail("API_SECURITY_IMPORT_INVALID", "a JSON OpenAPI 3.0 or 3.1 document is required");
  }
  if (Buffer.byteLength(document) > API_SECURITY_LIMITS.documentBytes) invalid();
  let root: unknown;
  try {
    root = JSON.parse(document);
    const objects: (Set<string> | null)[] = [];
    for (let i = 0; i < document.length; i++) {
      const char = document[i];
      if (char === "{" || char === "[") {
        objects.push(char === "{" ? new Set<string>() : null);
        if (objects.length > 64) invalid();
      } else if (char === "}" || char === "]") objects.pop();
      else if (char === '"') {
        const start = i++;
        while (document[i] !== '"') i += document[i] === "\\" ? 2 : 1;
        let next = i + 1;
        while (/\s/.test(document[next] ?? "")) next++;
        if (document[next] === ":") {
          const key = JSON.parse(document.slice(start, i + 1)) as string;
          const keys = objects.at(-1);
          if (!keys || keys.has(key)) invalid();
          keys.add(key);
        }
      }
    }
    root = JSON.parse(document, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      const original = decimal(context?.source ?? "");
      return original !== undefined && original === decimal(String(value))
        ? value
        : Symbol("unsupported-number");
    });
  } catch {
    invalid();
  }
  if (!object(root) || typeof root.openapi !== "string" || !/^3\.[01]\.\d+$/.test(root.openapi))
    invalid();
  const documentRoot = root;
  const version = root.openapi;
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let documentNodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++documentNodes > 30000 || item.depth > 64) invalid();
    if (item.value !== null && typeof item.value === "object")
      for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 });
  }
  const issues: { location: string; code: string }[] = [];
  const issue = (location: string, code: string) => {
    if (issues.length < 200) issues.push({ location: location.slice(0, 1024), code });
    else issues[199] = { location: "#", code: "issue-limit" };
  };
  let expansions = 0;
  function resolve(value: unknown, location: string, ancestors = new Set<object>()) {
    const seen = new Set(ancestors);
    let current = value;
    while (object(current)) {
      if (++expansions > 8000) {
        issue(location, "reference-budget");
        return;
      }
      if (seen.has(current)) {
        issue(location, "reference-cycle");
        return;
      }
      seen.add(current);
      if (seen.size > 32) {
        issue(location, "reference-depth");
        return;
      }
      if (!Object.hasOwn(current, "$ref")) return { value: current, seen };
      for (const key of Object.keys(current))
        if (!["$ref", "summary", "description"].includes(key))
          issue(pointer(location, key), "reference-sibling-unsupported");
      const ref = current.$ref;
      if (typeof ref !== "string" || !(ref === "#" || ref.startsWith("#/"))) {
        issue(pointer(location, "$ref"), "external-reference");
        return;
      }
      let target: unknown = documentRoot;
      try {
        const parts = ref === "#" ? [] : decodeURIComponent(ref.slice(2)).split("/");
        for (const part of parts) {
          if (/~(?:[^01]|$)/.test(part)) throw new Error("invalid pointer");
          const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!object(target) && !Array.isArray(target)) throw new Error("missing pointer");
          if (!Object.hasOwn(target, key)) throw new Error("missing pointer");
          target = (target as ObjectValue)[key];
        }
      } catch {
        issue(pointer(location, "$ref"), "invalid-reference");
        return;
      }
      current = target;
    }
    issue(location, "object-required");
  }
  let schemaNodes = 0;
  function schema(
    value: unknown,
    location: string,
    depth = 1,
    ancestors?: Set<object>,
  ): ApiSchema | undefined {
    if (
      ++schemaNodes > API_SECURITY_LIMITS.schemaNodes ||
      depth > API_SECURITY_LIMITS.schemaDepth
    ) {
      issue(location, "schema-budget");
      return;
    }
    const resolved = resolve(value, location, ancestors);
    if (!resolved) return;
    const node = resolved.value;
    for (const key of Object.keys(node))
      if (!schemaKeys.has(key) && !annotations.has(key) && !key.startsWith("x-"))
        issue(pointer(location, key), "unsupported-constraint");
    if (
      !["string", "number", "integer", "boolean", "object", "array", "null"].includes(
        String(node.type),
      )
    ) {
      issue(pointer(location, "type"), "explicit-type-required");
      return;
    }
    if (version.startsWith("3.0") && node.type === "null") {
      issue(pointer(location, "type"), "unsupported-null-type");
      return;
    }
    if (version.startsWith("3.1") && node.nullable !== undefined)
      issue(pointer(location, "nullable"), "unsupported-constraint");
    const result: ObjectValue = { type: node.type };
    for (const key of schemaKeys)
      if (!["type", "properties", "items"].includes(key) && Object.hasOwn(node, key))
        result[key] = node[key];
    if (node.properties !== undefined) {
      if (!object(node.properties)) issue(pointer(location, "properties"), "object-required");
      else
        result.properties = Object.fromEntries(
          Object.entries(node.properties).flatMap(([name, child]) => {
            const parsed = schema(
              child,
              pointer(pointer(location, "properties"), name),
              depth + 1,
              resolved.seen,
            );
            return parsed ? [[name, parsed]] : [];
          }),
        );
    }
    if (node.items !== undefined) {
      const child = schema(node.items, pointer(location, "items"), depth + 1, resolved.seen);
      if (child) result.items = child;
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
      issue(pointer(location, "additionalProperties"), "schema-additional-properties-unsupported");
      delete result.additionalProperties;
    }
    const parsed = apiSchema.safeParse(result);
    if (!parsed.success) {
      for (const error of parsed.error.issues)
        issue(
          error.path.reduce<string>((at, key) => pointer(at, String(key)), location),
          "invalid-constraint",
        );
      return;
    }
    const output = parsed.data;
    if (output.enum && !output.enum.length) issue(pointer(location, "enum"), "invalid-constraint");
    if (output.required && new Set(output.required).size !== output.required.length)
      issue(pointer(location, "required"), "invalid-constraint");
    for (const value of output.enum ?? []) {
      if (
        value === null
          ? output.type !== "null" && !output.nullable
          : output.type === "integer"
            ? !Number.isInteger(value)
            : output.type === "number"
              ? typeof value !== "number"
              : output.type !== typeof value
      )
        issue(pointer(location, "enum"), "constraint-type-mismatch");
    }
    const fields: [boolean, string[]][] = [
      [output.type === "object", ["properties", "required", "additionalProperties"]],
      [output.type === "array", ["items", "minItems", "maxItems"]],
      [output.type === "string", ["minLength", "maxLength"]],
      [["integer", "number"].includes(output.type), ["minimum", "maximum"]],
    ];
    for (const [valid, keys] of fields)
      if (!valid)
        for (const key of keys)
          if (Object.hasOwn(result, key)) issue(pointer(location, key), "constraint-type-mismatch");
    if (output.type === "array" && !output.items) {
      issue(pointer(location, "items"), "array-items-required");
      return;
    }
    for (const [min, max] of [
      ["minLength", "maxLength"],
      ["minimum", "maximum"],
      ["minItems", "maxItems"],
    ] as const)
      if (Number(output[min]) > Number(output[max]))
        issue(pointer(location, min), "constraint-range");
    return output;
  }
  function servers(value: unknown, location: string) {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      issue(location, "invalid-servers");
      return;
    }
    for (const [index, item] of value.entries()) {
      if (!object(item) || typeof item.url !== "string" || item.url.includes("{")) {
        issue(pointer(location, index), "unsupported-server");
        continue;
      }
      try {
        const url = new URL(item.url, "https://openapi.invalid/");
        if (!["http:", "https:"].includes(url.protocol))
          issue(pointer(location, index), "unsupported-server");
        if (url.pathname !== "/" || url.search || url.hash)
          issue(pointer(pointer(location, index), "url"), "server-base-path");
      } catch {
        issue(pointer(location, index), "unsupported-server");
      }
    }
  }
  function parameters(value: unknown, location: string) {
    const parameters = new Map<string, ApiEndpoint["parameters"][number]>();
    if (value === undefined) return parameters;
    if (!Array.isArray(value)) {
      issue(location, "array-required");
      return parameters;
    }
    const declared = new Set<string>();
    for (const [index, item] of value.entries()) {
      const at = pointer(location, index);
      const resolved = resolve(item, at);
      if (!resolved) continue;
      const parameter = resolved.value;
      for (const key of Object.keys(parameter))
        if (!parameterKeys.has(key) && !key.startsWith("x-"))
          issue(pointer(at, key), "unsupported-parameter-field");
      const where = parameter.in;
      const name = parameter.name;
      if (
        !["path", "query", "header"].includes(String(where)) ||
        typeof name !== "string" ||
        !name.length ||
        name.length > 128
      ) {
        issue(at, "unsupported-parameter");
        continue;
      }
      const key = `${where}:${where === "header" ? name.toLowerCase() : name}`;
      if (declared.has(key)) issue(at, "duplicate-parameter");
      declared.add(key);
      if (
        (where === "path" && parameter.required !== true) ||
        (parameter.required !== undefined && typeof parameter.required !== "boolean")
      )
        issue(pointer(at, "required"), "invalid-required");
      const style = where === "query" ? "form" : "simple";
      if (
        (parameter.style !== undefined && parameter.style !== style) ||
        (parameter.explode !== undefined && parameter.explode !== (where === "query")) ||
        (parameter.allowReserved !== undefined && parameter.allowReserved !== false) ||
        (parameter.allowEmptyValue !== undefined && parameter.allowEmptyValue !== false)
      )
        issue(at, "unsupported-serialization");
      const parsed = schema(parameter.schema, pointer(at, "schema"), 1, resolved.seen);
      if (!parsed) continue;
      if (!["string", "number", "integer", "boolean"].includes(parsed.type) || parsed.nullable) {
        issue(pointer(at, "schema"), "scalar-parameter-required");
        continue;
      }
      if (where === "header" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        issue(pointer(at, "name"), "invalid-header-name");
        continue;
      }
      if (
        where === "header" &&
        ["accept", "content-type", "authorization"].includes(name.toLowerCase())
      ) {
        issue(pointer(at, "name"), "reserved-header-parameter");
        continue;
      }
      parameters.set(key, {
        in: where as "path" | "query" | "header",
        name,
        required: parameter.required === true,
        schema: parsed,
      });
    }
    return parameters;
  }
  function body(value: unknown, location: string): ApiEndpoint["body"] {
    const resolved = resolve(value, location);
    if (!resolved) return;
    const node = resolved.value;
    for (const key of Object.keys(node))
      if (!["description", "required", "content"].includes(key) && !key.startsWith("x-"))
        issue(pointer(location, key), "unsupported-body-field");
    if (node.required !== undefined && typeof node.required !== "boolean")
      issue(pointer(location, "required"), "invalid-required");
    if (!object(node.content)) {
      issue(pointer(location, "content"), "json-body-required");
      return;
    }
    for (const type of Object.keys(node.content))
      if (type !== "application/json")
        issue(pointer(pointer(location, "content"), type), "unsupported-media-type");
    const media = node.content["application/json"];
    if (!object(media)) {
      issue(pointer(location, "content"), "json-body-required");
      return;
    }
    for (const key of Object.keys(media))
      if (!["schema", "example", "examples"].includes(key) && !key.startsWith("x-"))
        issue(pointer(pointer(location, "content"), key), "unsupported-media-field");
    const parsed = schema(
      media.schema,
      pointer(pointer(pointer(location, "content"), "application/json"), "schema"),
      1,
      resolved.seen,
    );
    return parsed ? { required: node.required === true, schema: parsed } : undefined;
  }
  servers(root.servers, "#/servers");
  if (
    root.jsonSchemaDialect !== undefined &&
    root.jsonSchemaDialect !== "https://spec.openapis.org/oas/3.1/dialect/base"
  )
    issue("#/jsonSchemaDialect", "unsupported-dialect");
  if (root.webhooks !== undefined) issue("#/webhooks", "unsupported-operation");
  if (root.security !== undefined && (!Array.isArray(root.security) || root.security.length))
    issue("#/security", "security-requirements-unsupported");
  const endpoints: ApiEndpoint[] = [];
  const shapes = new Set<string>();
  if (!object(root.paths)) issue("#/paths", "paths-required");
  else
    for (const [path, raw] of Object.entries(root.paths)) {
      if (path.startsWith("x-")) continue;
      const location = pointer("#/paths", path);
      const item = resolve(raw, location);
      if (!item) continue;
      servers(item.value.servers, pointer(location, "servers"));
      const inherited = parameters(item.value.parameters, pointer(location, "parameters"));
      for (const [method, value] of Object.entries(item.value)) {
        if (pathMetadata.has(method) || method.startsWith("x-")) continue;
        const at = pointer(location, method);
        if (!methodSet.has(method)) {
          issue(at, "unsupported-operation");
          continue;
        }
        if (!apiPath.safeParse(path).success) {
          issue(location, "unsupported-path-template");
          continue;
        }
        if (!object(value)) {
          issue(at, "object-required");
          continue;
        }
        for (const key of Object.keys(value))
          if (!operationKeys.has(key) && !key.startsWith("x-"))
            issue(pointer(at, key), "unsupported-operation-field");
        if (value.callbacks !== undefined) issue(pointer(at, "callbacks"), "unsupported-operation");
        if (
          value.security !== undefined &&
          (!Array.isArray(value.security) || value.security.length)
        )
          issue(pointer(at, "security"), "security-requirements-unsupported");
        servers(value.servers, pointer(at, "servers"));
        const merged = new Map(inherited);
        for (const [key, parameter] of parameters(value.parameters, pointer(at, "parameters")))
          merged.set(key, parameter);
        const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        if (new Set(names).size !== names.length) issue(location, "duplicate-path-parameter");
        for (const name of names)
          if (!merged.has(`path:${name}`))
            issue(pointer(at, "parameters"), "missing-path-parameter");
        for (const parameter of merged.values())
          if (parameter.in === "path" && !names.includes(parameter.name))
            issue(pointer(at, "parameters"), "unused-path-parameter");
        const endpoint = {
          method: method.toUpperCase(),
          path,
          parameters: [...merged.values()],
          ...(value.requestBody !== undefined
            ? { body: body(value.requestBody, pointer(at, "requestBody")) }
            : {}),
        };
        const parsed = apiEndpoint.safeParse(endpoint);
        if (!parsed.success) {
          issue(at, "endpoint-budget");
          continue;
        }
        const shape = `${method} ${path.replace(/\{[^}]+\}/g, "{}")}`;
        if (
          shapes.has(shape) ||
          endpoints.some((previous) => apiTemplatesAmbiguous(previous, parsed.data))
        ) {
          issue(at, "ambiguous-path-template");
          continue;
        }
        shapes.add(shape);
        if (endpoints.length === API_SECURITY_LIMITS.endpoints) issue(at, "endpoint-limit");
        else endpoints.push(parsed.data);
      }
    }
  return { openapiVersion: version, endpoints, issues };
}
