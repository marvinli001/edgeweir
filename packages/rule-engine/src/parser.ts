import { validFormName, validJsonPath } from "./body.ts";
import { toBytes } from "./bytes.ts";
import {
  isRulesV3Field,
  requestOnly,
  requestPhases,
  responsePhases,
  rulesV2Fields,
} from "./fields.ts";
import { canonicalCidr } from "./ip.ts";
import {
  checkReplacement,
  comparisonOps,
  type Field,
  functions,
  irFieldType,
  MAX_CALL_DEPTH,
  namedFields,
  patternGroups,
  rulesV3Functions,
  SUBSTRING_BOUNDS,
  stringOps,
  wildcardSegments,
} from "./language.ts";
import { type Expression, ExpressionError, type Phase, type ValueType } from "./model.ts";
import { validatePattern } from "./patterns.ts";

const node = (op: string, patch: Partial<Expression> = {}): Expression => ({
  op,
  field: "",
  valueType: "",
  value: "",
  values: [],
  children: [],
  ...patch,
});

type Token = { kind: "word" | "string" | "punct"; text: string; position: number };
function tokenize(source: string, maxLength: number): Token[] {
  if (source.length > maxLength)
    throw new ExpressionError("too_long", maxLength, { max: String(maxLength) });
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i] ?? "")) {
      i++;
      continue;
    }
    const position = i;
    const c = source[i];
    if (c === '"') {
      i++;
      let escaped = false;
      while (i < source.length) {
        const ch = source[i++];
        if (!escaped && ch === '"') break;
        if (!escaped && ch === "\\") escaped = true;
        else escaped = false;
      }
      let text: unknown;
      try {
        text = JSON.parse(source.slice(position, i));
      } catch {
        throw new ExpressionError("string_invalid", position);
      }
      if (typeof text !== "string") throw new ExpressionError("string_invalid", position);
      out.push({ kind: "string", text, position });
    } else if ("(){}[],".includes(c ?? "")) {
      out.push({ kind: "punct", text: c ?? "", position });
      i++;
    } else {
      while (i < source.length && !/[\s(){}[\]",]/.test(source[i] ?? "")) i++;
      if (i === position) throw new ExpressionError("unexpected_character", i);
      out.push({ kind: "word", text: source.slice(position, i), position });
    }
    if (out.length > 512) throw new ExpressionError("too_many_tokens", position, { max: "512" });
  }
  return out;
}

/** Source offset of character `index` of the quoted string token that starts at `start`. */
function stringOffset(source: string, start: number, index: number): number {
  let i = start + 1;
  for (let k = 0; k < index && i < source.length; k++)
    i += source[i] !== "\\" ? 1 : source[i + 1] === "u" ? 6 : 2;
  return i;
}

export interface ParseOptions {
  /** Longest source accepted; 4096 by default (cache rules: 16384). */
  maxLength?: number;
}

function parser(source: string, phase: Phase, options: ParseOptions) {
  const tokens = tokenize(source, options.maxLength ?? 4096);
  let cursor = 0;
  let nodes = 0;
  const replaceCalls = new Set<string>();
  const peek = () => tokens[cursor];
  const take = () => {
    const token = tokens[cursor++];
    if (!token) throw new ExpressionError("unexpected_end", source.length);
    return token;
  };
  const expect = (text: string) => {
    const token = take();
    if (token.text !== text)
      throw new ExpressionError("expected_token", token.position, { token: text });
  };
  const count = () => {
    if (++nodes > 128) throw new ExpressionError("too_complex", peek()?.position ?? source.length);
  };
  const readValue = (type: ValueType): string => {
    const token = take();
    if (type === "string") {
      if (token.kind !== "string") throw new ExpressionError("expected_string", token.position);
      return token.text;
    }
    if (type === "number") {
      if (!/^-?\d+$/.test(token.text) || !Number.isSafeInteger(Number(token.text)))
        throw new ExpressionError("expected_integer", token.position);
      return String(Number(token.text));
    }
    if (type === "boolean") {
      if (!["true", "false"].includes(token.text))
        throw new ExpressionError("expected_boolean", token.position);
      return token.text;
    }
    try {
      return canonicalCidr(token.text);
    } catch {
      throw new ExpressionError("expected_ip", token.position);
    }
  };
  /** Reads a field name (with the headers["name"] form) starting at `token`. */
  const readField = (token: Token): Field => {
    let field = token.text;
    if (field === "http.request.headers" || field === "http.response.headers") {
      expect("[");
      const key = take();
      if (key.kind !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i.test(key.text))
        throw new ExpressionError("header_name", key.position);
      expect("]");
      field += `.${key.text.toLowerCase()}`;
    }
    // Cookies and query parameters by name (rules-v3); names keep their case.
    const named = namedFields[field];
    if (named) {
      expect("[");
      const key = take();
      if (key.kind !== "string" || !named.re.test(key.text))
        throw new ExpressionError(named.code, key.position);
      expect("]");
      field += `.${key.text}`;
    }
    for (const prefix of ["http.request.headers.", "http.response.headers."]) {
      if (field.startsWith(prefix)) {
        const name = field.slice(prefix.length);
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i.test(name))
          throw new ExpressionError("header_name", token.position);
        field = prefix + name.toLowerCase();
      }
    }
    for (const [prefix, { re, code }] of Object.entries(namedFields))
      if (field.startsWith(`${prefix}.`) && !re.test(field.slice(prefix.length + 1)))
        throw new ExpressionError(code, token.position);
    const type = irFieldType(field);
    if (!type || token.kind !== "word") throw new ExpressionError("unknown_field", token.position);
    if (field.startsWith("http.response.") && !responsePhases.has(phase))
      throw new ExpressionError("response_field", token.position);
    if (requestOnly("field", field) && !requestPhases.has(phase))
      throw new ExpressionError("request_field", token.position);
    return { name: field, type, position: token.position };
  };
  /** A literal argument of `kind` (pattern, wildcard, replacement or flags). */
  const literal = (kind: string, captures: number): Expression => {
    const start = peek()?.position ?? source.length;
    const token = take();
    if (token.kind !== "string") throw new ExpressionError("literal_argument", token.position);
    try {
      if (kind === "pattern") validatePattern(token.text);
      if (kind === "wildcard") wildcardSegments(token.text);
      if (kind === "replacement") checkReplacement(token.text, captures);
      if (kind === "flags" && token.text !== "s") throw new ExpressionError("flags", 0);
      if (kind === "formname" && !validFormName(toBytes(token.text)))
        throw new ExpressionError("form_name", 0);
      if (kind === "jsonpath" && !validJsonPath(toBytes(token.text)))
        throw new ExpressionError("json_path", 0);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      throw error.at(stringOffset(source, start, error.position));
    }
    count();
    return node("const", { valueType: "string", value: token.text });
  };
  /** An integer literal argument of `kind` (start or length, see SUBSTRING_BOUNDS). */
  const integer = (kind: string): Expression => {
    const token = take();
    const [min, max] = SUBSTRING_BOUNDS[kind] as readonly [number, number];
    const n = Number(token.text);
    if (token.kind !== "word" || !/^-?(0|[1-9]\d{0,5})$/.test(token.text) || n < min || n > max)
      throw new ExpressionError("integer_argument", token.position, {
        min: String(min),
        max: String(max),
      });
    count();
    return node("const", { valueType: "number", value: String(n === 0 ? 0 : n) });
  };
  /** A function call whose name is `token`; "(" is next. */
  const call = (token: Token, depth: number, valueContext: boolean): Expression => {
    const spec = Object.hasOwn(functions, token.text) ? functions[token.text] : undefined;
    if (!spec) throw new ExpressionError("unknown_function", token.position);
    if (spec.valueOnly && !valueContext)
      throw new ExpressionError("value_only_function", token.position);
    if (requestOnly("call", token.text) && !requestPhases.has(phase))
      throw new ExpressionError("request_field", token.position);
    if (spec.valueOnly) {
      if (replaceCalls.has(token.text))
        throw new ExpressionError("function_repeated", token.position);
      replaceCalls.add(token.text);
    }
    if (depth > MAX_CALL_DEPTH) throw new ExpressionError("functions_too_deep", token.position);
    count();
    expect("(");
    const args: Expression[] = [];
    const kinds = spec.variadic ? [] : spec.args;
    const max = spec.variadic ? spec.variadic[1] : kinds.length;
    const min = spec.variadic ? spec.variadic[0] : kinds.length - (spec.optional ?? 0);
    let captures = 0;
    while (peek()?.text !== ")") {
      if (args.length) expect(",");
      if (args.length >= max)
        throw new ExpressionError("too_many_arguments", peek()?.position ?? source.length);
      const kind = kinds[args.length] ?? "string";
      if (kind === "string" || kind === "any") {
        const start = peek()?.position ?? source.length;
        const arg = value(depth + 1, valueContext);
        if (kind === "string" && arg.valueType !== "string")
          throw new ExpressionError("argument_not_string", start);
        args.push(arg);
      } else if (kind === "start" || kind === "length") {
        args.push(integer(kind));
      } else {
        const arg = literal(kind, captures);
        if (kind === "pattern") captures = patternGroups(arg.value);
        if (kind === "wildcard") captures = wildcardSegments(arg.value).length - 1;
        args.push(arg);
      }
    }
    expect(")");
    if (args.length < min) throw new ExpressionError("too_few_arguments", token.position);
    return node("call", { field: token.text, valueType: spec.returns, children: args });
  };
  /** A value: a string literal, a field or a function call. */
  const value = (depth: number, valueContext: boolean): Expression => {
    const token = take();
    if (token.kind === "string") {
      count();
      return node("const", { valueType: "string", value: token.text });
    }
    if (peek()?.text === "(" && token.kind === "word") return call(token, depth, valueContext);
    const field = readField(token);
    count();
    return node("field", { field: field.name, valueType: field.type });
  };
  function comparison(left: Expression | Field, depth: number): Expression {
    const computed = "op" in left;
    const type = computed ? (left.valueType as ValueType) : left.type;
    const target = computed ? { children: [left] } : { field: left.name };
    const operator = take();
    let op = operator.text;
    if (op === "strict") {
      // `strict wildcard` (rules-v3): the case-sensitive wildcard.
      if (take().text !== "wildcard")
        throw new ExpressionError("expected_token", tokens[cursor - 1]?.position ?? 0, {
          token: "wildcard",
        });
      op = "strict_wildcard";
    }
    if (!comparisonOps.has(op)) throw new ExpressionError("unknown_operator", operator.position);
    if (["lt", "le", "gt", "ge"].includes(op) && type !== "number")
      throw new ExpressionError("ordered_comparison", operator.position);
    if (stringOps.has(op) && type !== "string")
      throw new ExpressionError("string_operator", operator.position);
    if (op === "in") {
      if (peek()?.text.startsWith("$")) {
        const list = take();
        if (computed || type !== "ip" || !/^\$[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(list.text))
          throw new ExpressionError("list_reference", list.position);
        return node("in_list", { ...target, valueType: type, value: list.text.slice(1) });
      }
      expect("{");
      const values: string[] = [];
      while (peek()?.text !== "}") {
        values.push(readValue(type));
        if (values.length > 256)
          throw new ExpressionError("set_too_large", operator.position, { max: "256" });
      }
      expect("}");
      if (!values.length) throw new ExpressionError("set_empty", operator.position);
      return node("in", { ...target, valueType: type, values: [...new Set(values)].sort() });
    }
    const start = peek()?.position ?? source.length;
    const value = readValue(type);
    if (op === "matches" || op === "wildcard" || op === "strict_wildcard") {
      try {
        if (op === "matches") validatePattern(value);
        else wildcardSegments(value);
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        throw error.at(stringOffset(source, start, error.position));
      }
    }
    void depth;
    return node(op, { ...target, valueType: type, value });
  }
  const operators = new Set([...comparisonOps, "strict"]);
  function primary(depth: number): Expression {
    if (depth > 16) throw new ExpressionError("too_complex", peek()?.position ?? 0);
    count();
    if (peek()?.text === "not") {
      take();
      return node("not", { children: [primary(depth + 1)] });
    }
    if (peek()?.text === "(") {
      take();
      const expression = or(depth + 1);
      expect(")");
      return expression;
    }
    const token = take();
    if (["true", "false"].includes(token.text))
      return node("literal", { valueType: "boolean", value: token.text });
    if (peek()?.text === "(" && token.kind === "word") {
      nodes--; // the call counts itself
      const fn = call(token, 1, false);
      if (fn.valueType === "boolean" && !operators.has(peek()?.text ?? "")) return fn;
      return comparison(fn, depth);
    }
    return comparison(readField(token), depth);
  }
  function and(depth: number): Expression {
    const children = [primary(depth)];
    while (peek()?.text === "and") {
      take();
      children.push(primary(depth + 1));
    }
    return children.length === 1 ? (children[0] as Expression) : node("and", { children });
  }
  function or(depth: number): Expression {
    const children = [and(depth)];
    while (peek()?.text === "or") {
      take();
      children.push(and(depth + 1));
    }
    return children.length === 1 ? (children[0] as Expression) : node("or", { children });
  }
  const done = <T>(result: T) => {
    if (cursor !== tokens.length)
      throw new ExpressionError("unexpected_token", peek()?.position ?? source.length);
    return result;
  };
  return {
    condition: () => done(or(0)),
    value: () => {
      const start = peek()?.position ?? 0;
      const result = value(1, true);
      if (result.valueType !== "string") throw new ExpressionError("value_not_string", start);
      return done(result);
    },
  };
}

/** Parses a condition (filter expression) of `phase`. */
export function parseExpression(
  source: string,
  phase: Phase = "waf-custom",
  options: ParseOptions = {},
): Expression {
  return parser(source, phase, options).condition();
}

/**
 * Parses a value expression (a redirect target or rewrite path): a string literal,
 * a string field or a function call that returns a string; regex_replace and
 * wildcard_replace are allowed once each (rules-v2).
 */
export function parseValueExpression(source: string, phase: Phase): Expression {
  return parser(source, phase, {}).value();
}

export function listReferences(expression: Expression): string[] {
  return [
    ...new Set([
      ...(expression.op === "in_list" ? [expression.value] : []),
      ...expression.children.flatMap(listReferences),
    ]),
  ];
}
/** Whether the expression reads the JA4 fingerprint (node feature ja4-v1). */
export function usesJa4(expression: Expression): boolean {
  return (
    (expression.op !== "call" && expression.field === "tls.ja4") ||
    expression.children.some(usesJa4)
  );
}
export function usesGeo(expression: Expression): boolean {
  return (
    (expression.op !== "call" && expression.field.startsWith("ip.geoip.")) ||
    expression.children.some(usesGeo)
  );
}
/** Whether the expression uses functions or fields only rules-v2 nodes know. */
export function needsRulesV2(expression: Expression): boolean {
  return (
    ["call", "field", "const"].includes(expression.op) ||
    (expression.op !== "call" && rulesV2Fields.has(expression.field)) ||
    expression.children.some(needsRulesV2)
  );
}
/**
 * Whether the expression uses fields, functions, operators or integer arguments only rules-v3
 * nodes know.
 */
export function needsRulesV3(expression: Expression): boolean {
  return (
    expression.op === "wildcard" ||
    expression.op === "strict_wildcard" ||
    (expression.op === "call" && rulesV3Functions.has(expression.field)) ||
    (expression.op === "const" && expression.valueType === "number") ||
    (expression.op !== "call" && isRulesV3Field(expression.field)) ||
    expression.children.some(needsRulesV3)
  );
}
export function bindLists(expression: Expression, lists: Record<string, string>): Expression {
  if (expression.op === "in_list" && !Object.hasOwn(lists, expression.value))
    throw new ExpressionError("unknown_list", 0, { list: expression.value });
  return {
    ...expression,
    value: expression.op === "in_list" ? (lists[expression.value] ?? "") : expression.value,
    children: expression.children.map((c) => bindLists(c, lists)),
  };
}
