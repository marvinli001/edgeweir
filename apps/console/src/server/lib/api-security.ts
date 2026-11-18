import { createPublicKey } from "node:crypto";
import {
  API_SECURITY_DEFAULTS,
  API_SECURITY_LIMITS,
  type ApiSchema,
  type ApiSecuritySettings,
  apiSecuritySettings,
} from "@edgeweir/contract";
import { fail } from "./errors";

function invalid(): never {
  return fail("API_SECURITY_INVALID", "invalid API security settings");
}
const scalar = (schema: ApiSchema) =>
  ["string", "integer", "number", "boolean"].includes(schema.type) && !schema.nullable;

export function validateApiSecurity(value: unknown): ApiSecuritySettings {
  const parsed = apiSecuritySettings.safeParse(value);
  if (!parsed.success) invalid();
  const settings = parsed.data;
  if (Buffer.byteLength(JSON.stringify(settings)) > API_SECURITY_LIMITS.configBytes) invalid();
  if (new Set(settings.exceptions.map((entry) => entry.id)).size !== settings.exceptions.length)
    invalid();
  const shapes = new Set<string>();
  for (const endpoint of settings.schema.endpoints) {
    const shape = `${endpoint.method} ${endpoint.path.replace(/\{[^}]+\}/g, "{}")}`;
    if (shapes.has(shape)) invalid();
    shapes.add(shape);
    const names = new Set<string>();
    const pathNames = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (new Set(pathNames).size !== pathNames.length) invalid();
    for (const parameter of endpoint.parameters) {
      const name = parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name;
      const key = `${parameter.in}:${name}`;
      if (names.has(key) || !scalar(parameter.schema)) invalid();
      names.add(key);
      if (parameter.in === "path" && (!parameter.required || !pathNames.includes(parameter.name)))
        invalid();
      if (parameter.in === "header" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) invalid();
      checkSchema(parameter.schema);
    }
    if (pathNames.some((name) => !names.has(`path:${name}`))) invalid();
    if (endpoint.body) checkSchema(endpoint.body.schema);
  }
  const { jwt } = settings;
  if (new Set(jwt.algorithms).size !== jwt.algorithms.length) invalid();
  for (const key of jwt.keys) {
    if (!jwt.algorithms.includes(key.alg)) invalid();
    const decode = (part: string | undefined, bytes?: number) => {
      if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) invalid();
      const value = Buffer.from(part, "base64url");
      if (value.toString("base64url") !== part || (bytes && value.length !== bytes)) invalid();
      return value;
    };
    if (key.alg === "RS256") {
      if (key.kty !== "RSA" || key.crv || key.x || key.y) invalid();
      const n = decode(key.n);
      const e = decode(key.e);
      if (!n[0] || !e[0] || n.length < 256 || e.length > 4) invalid();
      const bits = n.length * 8 - Math.clz32(n[0] ?? 0) + 24;
      const exponent = e.reduce((sum, byte) => sum * 256 + byte, 0);
      if (
        bits < 2048 ||
        bits > 8192 ||
        (n.at(-1) ?? 0) % 2 !== 1 ||
        exponent < 3 ||
        exponent > 2147483647 ||
        exponent % 2 !== 1
      )
        invalid();
    } else if (key.alg === "ES256") {
      if (key.kty !== "EC" || key.crv !== "P-256" || key.n || key.e) invalid();
      decode(key.x, 32);
      decode(key.y, 32);
    } else {
      if (key.kty !== "OKP" || key.crv !== "Ed25519" || key.n || key.e || key.y) invalid();
      decode(key.x, 32);
    }
    try {
      createPublicKey({ format: "jwk", key });
    } catch {
      invalid();
    }
  }
  return settings;
}

function checkSchema(schema: ApiSchema) {
  if (schema.enum && !schema.enum.length) invalid();
  if (
    (schema.properties || schema.required || schema.additionalProperties !== undefined) &&
    schema.type !== "object"
  )
    invalid();
  if (
    (schema.items || schema.minItems !== undefined || schema.maxItems !== undefined) &&
    schema.type !== "array"
  )
    invalid();
  if (schema.type === "array" && !schema.items) invalid();
  if (
    (schema.minLength !== undefined || schema.maxLength !== undefined) &&
    schema.type !== "string"
  )
    invalid();
  if (
    (schema.minimum !== undefined || schema.maximum !== undefined) &&
    schema.type !== "number" &&
    schema.type !== "integer"
  )
    invalid();
  for (const [min, max] of [
    [schema.minLength, schema.maxLength],
    [schema.minimum, schema.maximum],
    [schema.minItems, schema.maxItems],
  ])
    if (min !== undefined && max !== undefined && min > max) invalid();
  if (schema.required && new Set(schema.required).size !== schema.required.length) invalid();
  for (const value of schema.enum ?? []) {
    if (
      value === null
        ? schema.type !== "null" && !schema.nullable
        : schema.type === "integer"
          ? !Number.isInteger(value)
          : schema.type === "number"
            ? typeof value !== "number"
            : schema.type !== typeof value
    )
      invalid();
  }
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
}

export function readApiSecurity(value: Record<string, unknown>): ApiSecuritySettings {
  return Object.keys(value).length
    ? validateApiSecurity(value)
    : structuredClone(API_SECURITY_DEFAULTS);
}
