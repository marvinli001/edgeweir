import ipaddr from "ipaddr.js";

export const phases = [
  "request-transform",
  "redirect",
  "config",
  "waf-custom",
  "ratelimit",
  "cache",
  "origin",
  "response-transform",
] as const;
export type Phase = (typeof phases)[number];
export type ValueType = "string" | "number" | "boolean" | "ip";
export interface Expression {
  op: string;
  field: string;
  valueType: string;
  value: string;
  values: string[];
  children: Expression[];
}
export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
    this.name = "ExpressionError";
  }
}
export const fields: Record<string, ValueType> = {
  "http.host": "string",
  "http.request.method": "string",
  "http.request.uri.path": "string",
  "http.request.uri.query": "string",
  "http.request.uri": "string",
  "http.response.code": "number",
  "ip.src": "ip",
  ssl: "boolean",
  "ip.geoip.country": "string",
  "ip.geoip.subdivision": "string",
  "ip.geoip.asnum": "number",
};
const node = (op: string, patch: Partial<Expression> = {}): Expression => ({
  op,
  field: "",
  valueType: "",
  value: "",
  values: [],
  children: [],
  ...patch,
});

export function canonicalCidr(value: string): string {
  const [address, prefix] = value.split("/");
  if (!address || value.includes("%") || value.split("/").length > 2)
    throw new Error("invalid IP/CIDR");
  if (!address.includes(":") && !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address))
    throw new Error("invalid IPv4");
  const embedded =
    address.includes(":") && address.includes(".")
      ? address.slice(address.lastIndexOf(":") + 1)
      : null;
  if (embedded && !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(embedded))
    throw new Error("invalid embedded IPv4");
  let parsed = ipaddr.parse(address);
  let bits = prefix === undefined ? (parsed.kind() === "ipv4" ? 32 : 128) : Number(prefix);
  if (prefix !== undefined && !/^(0|[1-9]\d{0,2})$/.test(prefix)) throw new Error("invalid prefix");
  if (!Number.isInteger(bits) || bits < 0 || bits > (parsed.kind() === "ipv4" ? 32 : 128))
    throw new Error("invalid prefix");
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    if (bits < 96) throw new Error("ambiguous mapped IPv4 prefix");
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    bits -= 96;
  }
  const bytes = parsed.toByteArray();
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    bytes[i] = (bytes[i] ?? 0) & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  }
  return `${ipaddr.fromByteArray(bytes).toString()}/${bits}`;
}
export function ipMatches(address: string, cidr: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    const [network, bits] = ipaddr.parseCIDR(canonicalCidr(cidr));
    return parsed.kind() === network.kind() && parsed.match(network, bits);
  } catch {
    return false;
  }
}

type Token = { kind: "word" | "string" | "punct"; text: string; position: number };
function tokenize(source: string): Token[] {
  if (source.length > 4096) throw new ExpressionError("expression is too long", 4096);
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
        throw new ExpressionError("invalid quoted string", position);
      }
      if (typeof text !== "string") throw new ExpressionError("expected string", position);
      out.push({ kind: "string", text, position });
    } else if ("(){}[]".includes(c ?? "")) {
      out.push({ kind: "punct", text: c ?? "", position });
      i++;
    } else {
      while (i < source.length && !/[\s(){}[\]"]/.test(source[i] ?? "")) i++;
      if (i === position) throw new ExpressionError("unexpected character", i);
      out.push({ kind: "word", text: source.slice(position, i), position });
    }
    if (out.length > 512) throw new ExpressionError("too many tokens", position);
  }
  return out;
}

/** ASCII PCRE subset, also executable by the reference evaluator. */
export function validatePattern(pattern: string, position = 0) {
  if (
    pattern.length > 256 ||
    /[^\x20-\x7e]/.test(pattern) ||
    /\\[1-9]|\(\?|\\[pPkKgG]|\)[+*?{]|[+*}]\s*[+*{]/.test(pattern)
  )
    throw new ExpressionError("unsupported or unsafe regular expression", position);
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const escaped = pattern[++i] ?? "";
      if (escaped === "x") {
        if (!/^[0-9a-f]{2}$/i.test(pattern.slice(i + 1, i + 3)))
          throw new ExpressionError("unsupported escape", position);
        i += 2;
      } else if (
        !"dDsSwWbBtrnfv\\.^$|?*+()[]{}-/".includes(escaped) ||
        (inClass && ["b", "B"].includes(escaped))
      ) {
        throw new ExpressionError("unsupported escape", position);
      }
    } else if (c === "[") {
      if (pattern[i + 1] === "]" || pattern.slice(i + 1, i + 3) === "^]")
        throw new ExpressionError("empty character class", position);
      inClass = true;
    } else if (c === "]") inClass = false;
    else if (!inClass && c === "{") {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (!quantifier || Number(quantifier[1]) > 1000 || Number(quantifier[2] ?? 0) > 1000)
        throw new ExpressionError("unsupported repetition", position);
      i += quantifier[0].length - 1;
    } else if (!inClass && c === "}") throw new ExpressionError("escape literal braces", position);
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new ExpressionError("invalid regular expression", position);
  }
}

export function parseExpression(source: string, phase: Phase = "waf-custom"): Expression {
  const tokens = tokenize(source);
  let cursor = 0;
  let nodes = 0;
  const peek = () => tokens[cursor];
  const take = () => {
    const token = tokens[cursor++];
    if (!token) throw new ExpressionError("unexpected end of expression", source.length);
    return token;
  };
  const expect = (text: string) => {
    const token = take();
    if (token.text !== text) throw new ExpressionError(`expected ${text}`, token.position);
  };
  const readValue = (type: ValueType): string => {
    const token = take();
    if (type === "string") {
      if (token.kind !== "string")
        throw new ExpressionError("expected quoted string", token.position);
      return token.text;
    }
    if (type === "number") {
      if (!/^-?\d+$/.test(token.text) || !Number.isSafeInteger(Number(token.text)))
        throw new ExpressionError("expected integer", token.position);
      return String(Number(token.text));
    }
    if (type === "boolean") {
      if (!["true", "false"].includes(token.text))
        throw new ExpressionError("expected boolean", token.position);
      return token.text;
    }
    try {
      return canonicalCidr(token.text);
    } catch {
      throw new ExpressionError("expected IP address or CIDR", token.position);
    }
  };
  function primary(depth: number): Expression {
    if (depth > 16 || ++nodes > 128)
      throw new ExpressionError("expression is too complex", peek()?.position ?? source.length);
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
    let field = token.text;
    if (field === "http.request.headers" || field === "http.response.headers") {
      expect("[");
      const key = take();
      if (key.kind !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i.test(key.text))
        throw new ExpressionError("invalid header name", key.position);
      expect("]");
      field += `.${key.text.toLowerCase()}`;
    }
    for (const prefix of ["http.request.headers.", "http.response.headers."]) {
      if (field.startsWith(prefix)) {
        const name = field.slice(prefix.length);
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i.test(name))
          throw new ExpressionError("invalid header name", token.position);
        field = prefix + name.toLowerCase();
      }
    }
    const type =
      field.startsWith("http.request.headers.") || field.startsWith("http.response.headers.")
        ? "string"
        : Object.hasOwn(fields, field)
          ? fields[field]
          : undefined;
    if (!type) throw new ExpressionError("unknown field", token.position);
    if (field.startsWith("http.response.") && phase !== "response-transform")
      throw new ExpressionError("response field is unavailable in this phase", token.position);
    const operator = take();
    const op = operator.text;
    if (!["eq", "ne", "lt", "le", "gt", "ge", "contains", "matches", "in"].includes(op))
      throw new ExpressionError("unknown operator", operator.position);
    if (["lt", "le", "gt", "ge"].includes(op) && type !== "number")
      throw new ExpressionError("ordered comparison needs integers", operator.position);
    if (["contains", "matches"].includes(op) && type !== "string")
      throw new ExpressionError("operator needs a string field", operator.position);
    if (op === "in") {
      if (peek()?.text.startsWith("$")) {
        const list = take();
        if (type !== "ip" || !/^\$[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(list.text))
          throw new ExpressionError("invalid named IP list", list.position);
        return node("in_list", { field, valueType: type, value: list.text.slice(1) });
      }
      expect("{");
      const values: string[] = [];
      while (peek()?.text !== "}") {
        values.push(readValue(type));
        if (values.length > 256) throw new ExpressionError("set is too large", operator.position);
      }
      expect("}");
      if (!values.length) throw new ExpressionError("empty set", operator.position);
      return node("in", { field, valueType: type, values: [...new Set(values)].sort() });
    }
    const value = readValue(type);
    if (op === "matches") validatePattern(value, operator.position);
    return node(op, { field, valueType: type, value });
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
  const result = or(0);
  if (cursor !== tokens.length)
    throw new ExpressionError("unexpected token", peek()?.position ?? source.length);
  return result;
}

export function listReferences(expression: Expression): string[] {
  return [
    ...new Set([
      ...(expression.op === "in_list" ? [expression.value] : []),
      ...expression.children.flatMap(listReferences),
    ]),
  ];
}
export function usesGeo(expression: Expression): boolean {
  return expression.field.startsWith("ip.geoip.") || expression.children.some(usesGeo);
}
export function bindLists(expression: Expression, lists: Record<string, string>): Expression {
  if (expression.op === "in_list" && !Object.hasOwn(lists, expression.value))
    throw new ExpressionError("unknown IP list", 0);
  return {
    ...expression,
    value: expression.op === "in_list" ? (lists[expression.value] ?? "") : expression.value,
    children: expression.children.map((c) => bindLists(c, lists)),
  };
}

export function evaluate(
  expression: Expression,
  request: Record<string, string | number | boolean>,
  lists: Record<string, string[]> = {},
): boolean {
  const e = expression;
  if (e.op === "literal") return e.value === "true";
  if (e.op === "and") return e.children.every((c) => evaluate(c, request, lists));
  if (e.op === "or") return e.children.some((c) => evaluate(c, request, lists));
  if (e.op === "not") return !evaluate(e.children[0] as Expression, request, lists);
  const actual =
    request[e.field] ?? (e.valueType === "number" ? 0 : e.valueType === "boolean" ? false : "");
  const equal = (value: string) =>
    e.valueType === "ip"
      ? ipMatches(String(actual), value)
      : e.valueType === "number"
        ? Number(actual) === Number(value)
        : e.valueType === "boolean"
          ? actual === (value === "true")
          : String(actual) === value;
  if (e.op === "in_list") return (lists[e.value] ?? []).some(equal);
  if (e.op === "in") return e.values.some(equal);
  if (e.op === "eq") return equal(e.value);
  if (e.op === "ne") return !equal(e.value);
  if (e.op === "contains") return String(actual).includes(e.value);
  if (e.op === "matches") {
    const bytes = Array.from(new TextEncoder().encode(String(actual)), (b) =>
      String.fromCharCode(b),
    ).join("");
    return new RegExp(e.value).test(bytes);
  }
  const a = Number(actual),
    b = Number(e.value);
  return e.op === "lt"
    ? a < b
    : e.op === "le"
      ? a <= b
      : e.op === "gt"
        ? a > b
        : e.op === "ge"
          ? a >= b
          : false;
}
