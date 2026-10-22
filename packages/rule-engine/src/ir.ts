import { validFormName, validJsonPath } from "./body.ts";
import { toBytes } from "./bytes.ts";
import { requestOnly, requestPhases, responsePhases } from "./fields.ts";
import { canonicalCidr } from "./ip.ts";
import {
  byteLength,
  checkReplacement,
  comparisonOps,
  functions,
  irFieldType,
  MAX_CALL_DEPTH,
  patternGroups,
  SUBSTRING_BOUNDS,
  wildcardSegments,
} from "./language.ts";
import type { Expression } from "./model.ts";
import { validatePattern } from "./patterns.ts";

// ---- Typed IR validation (the node's check, edgeweir-node configir/rules.go) ----

function validIrValue(value: string, type: string): boolean {
  switch (type) {
    case "string":
      return byteLength(value) <= 16384;
    case "boolean":
      return value === "true" || value === "false";
    case "number":
      return /^(0|-?[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
    case "ip":
      try {
        // A mapped value becomes IPv4 text, so it never equals its canonical form (Go: Is4In6).
        return canonicalCidr(value) === value;
      } catch {
        return false;
      }
  }
  return false;
}

/**
 * Whether `e` is an expression IR the node accepts in `phase`: a condition, or a
 * value expression (redirect target, rewrite path) when `valueExpression`. Lists are
 * not checked. Mirrors edgeweir-node configir so that both read the shared vectors alike.
 */
export function validExpressionIr(e: Expression, phase: string, valueExpression = false): boolean {
  let budget = 256;
  const replaceCalls = new Set<string>();
  const responseOk = responsePhases.has(phase);
  const requestOk = requestPhases.has(phase);
  const fieldOk = (field: string, type: string) =>
    irFieldType(field) === type &&
    (!field.startsWith("http.response.") || responseOk) &&
    (!requestOnly("field", field) || requestOk);
  const empty = (x: Expression, keep: (keyof Expression)[]) =>
    (keep.includes("field") || x.field === "") &&
    (keep.includes("value") || x.value === "") &&
    (keep.includes("valueType") || x.valueType === "") &&
    (keep.includes("values") || x.values.length === 0) &&
    (keep.includes("children") || x.children.length === 0);
  // A value node: field, const or call; returns its type or undefined.
  const valueNode = (x: Expression, depth: number, inValue: boolean): string | undefined => {
    if (--budget < 0) return undefined;
    if (x.op === "field")
      return empty(x, ["field", "valueType"]) && fieldOk(x.field, x.valueType) && x.valueType !== ""
        ? x.valueType
        : undefined;
    if (x.op === "const")
      return empty(x, ["value", "valueType"]) &&
        x.valueType === "string" &&
        validIrValue(x.value, "string")
        ? "string"
        : undefined;
    if (x.op !== "call" || !empty(x, ["field", "valueType", "children"]) || depth > MAX_CALL_DEPTH)
      return undefined;
    const spec = Object.hasOwn(functions, x.field) ? functions[x.field] : undefined;
    if (!spec || spec.returns !== x.valueType) return undefined;
    if (requestOnly("call", x.field) && !requestOk) return undefined;
    if (spec.valueOnly) {
      if (!inValue || replaceCalls.has(x.field)) return undefined;
      replaceCalls.add(x.field);
    }
    const kinds = spec.variadic ? [] : spec.args;
    const max = spec.variadic ? spec.variadic[1] : kinds.length;
    const min = spec.variadic ? spec.variadic[0] : kinds.length - (spec.optional ?? 0);
    if (x.children.length < min || x.children.length > max) return undefined;
    let captures = 0;
    for (const [i, arg] of x.children.entries()) {
      const kind = kinds[i] ?? "string";
      if (kind === "string" || kind === "any") {
        const type = valueNode(arg, depth + 1, inValue);
        if (type === undefined || (kind === "string" && type !== "string")) return undefined;
        continue;
      }
      if (kind === "start" || kind === "length") {
        const [min, max] = SUBSTRING_BOUNDS[kind] as readonly [number, number];
        if (
          --budget < 0 ||
          arg.op !== "const" ||
          !empty(arg, ["value", "valueType"]) ||
          arg.valueType !== "number" ||
          !validIrValue(arg.value, "number") ||
          Number(arg.value) < min ||
          Number(arg.value) > max
        )
          return undefined;
        continue;
      }
      if (arg.op !== "const" || valueNode(arg, depth + 1, inValue) !== "string") return undefined;
      try {
        if (kind === "pattern") {
          validatePattern(arg.value);
          captures = patternGroups(arg.value);
        }
        if (kind === "wildcard") captures = wildcardSegments(arg.value).length - 1;
        if (kind === "replacement") checkReplacement(arg.value, captures);
        if (kind === "flags" && arg.value !== "s") return undefined;
        if (kind === "formname" && !validFormName(toBytes(arg.value))) return undefined;
        if (kind === "jsonpath" && !validJsonPath(toBytes(arg.value))) return undefined;
      } catch {
        return undefined;
      }
    }
    return x.valueType;
  };
  const condition = (x: Expression, depth: number): boolean => {
    if (depth > 64 || --budget < 0) return false;
    switch (x.op) {
      case "and":
      case "or":
      case "not":
        return (
          empty(x, ["children"]) &&
          x.children.length > 0 &&
          (x.op !== "not" || x.children.length === 1) &&
          x.children.every((c) => condition(c, depth + 1))
        );
      case "literal":
        return (
          empty(x, ["value", "valueType"]) &&
          x.valueType === "boolean" &&
          validIrValue(x.value, "boolean")
        );
      case "call":
        budget++;
        return valueNode(x, 1, false) === "boolean";
    }
    if (!comparisonOps.has(x.op) && x.op !== "in_list") return false;
    let type: string | undefined;
    if (x.field === "") {
      if (x.children.length !== 1 || x.op === "in_list") return false;
      type = valueNode(x.children[0] as Expression, 1, false);
      if (type !== x.valueType) return false;
    } else {
      if (x.children.length > 0 || !fieldOk(x.field, x.valueType)) return false;
      type = x.valueType;
    }
    if (x.op === "in_list") return type === "ip" && x.value !== "" && x.values.length === 0;
    if (x.op === "in")
      return (
        x.value === "" &&
        x.values.length > 0 &&
        x.values.length <= 256 &&
        x.values.every((v) => validIrValue(v, type as string))
      );
    if (x.values.length > 0 || !validIrValue(x.value, type)) return false;
    if (["lt", "le", "gt", "ge"].includes(x.op)) return type === "number";
    if (x.op === "contains") return type === "string";
    if (x.op === "matches" || x.op === "wildcard" || x.op === "strict_wildcard") {
      if (type !== "string") return false;
      try {
        if (x.op === "matches") validatePattern(x.value);
        else wildcardSegments(x.value);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  };
  return valueExpression ? valueNode(e, 1, true) === "string" : condition(e, 0);
}
