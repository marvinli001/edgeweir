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
  // JA4 TLS client fingerprint of the connection; empty over plain HTTP.
  "tls.ja4": "string",
};

/** Challenge types of the `challenge` action and of Under Attack, levels 1 to 4. */
export const challengeTypes = ["cookie302", "js", "pow", "captcha"] as const;
export type ChallengeType = (typeof challengeTypes)[number];

/** Phases each rule action kind may run in. */
export const actionPhases: Record<string, readonly Phase[]> = {
  block: ["waf-custom"],
  log: ["waf-custom"],
  allow: ["waf-custom"],
  challenge: ["waf-custom"],
  redirect: ["redirect"],
  rewrite: ["request-transform"],
  request_header: ["request-transform", "origin"],
  response_header: ["response-transform"],
  config: ["config", "cache"],
  rate_limit: ["ratelimit"],
};

/** Keys a rate_limit rule counts by, besides one request header. */
export const rateLimitKeys = ["ip.src", "http.host", "tls.ja4"] as const;
export function isRateLimitKey(key: string): boolean {
  return (
    (rateLimitKeys as readonly string[]).includes(key) ||
    /^http\.request\.headers\.[a-z0-9-]{1,64}$/.test(key)
  );
}

/** A compiled rule action (config.proto RuleAction, JSON field names). */
export interface ActionIr {
  kind: string;
  value?: string;
  header?: string;
  statusCode?: number;
  limit?: number;
  windowSeconds?: number;
  key?: string;
  cacheBypass?: boolean;
  forceHttps?: boolean;
  gzip?: boolean;
  remove?: boolean;
  challenge?: string;
}

const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const protectedRuleHeaders = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "cdn-loop",
]);
const ruleHeader = (name: string) =>
  headerName.test(name) && !protectedRuleHeaders.has(name) && !name.startsWith("x-edgeweir-");

/**
 * Whether a compiled action is valid in `phase`, as the node validates it
 * (edgeweir-node configir/rules.go). The console validates its own input with
 * the stricter ruleAction schema of @edgeweir/contract.
 */
export function validActionIr(phase: string, action: ActionIr): boolean {
  if (!(actionPhases[action.kind] as readonly string[] | undefined)?.includes(phase)) return false;
  const value = action.value ?? "";
  if (
    value.length > 4096 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return false;
  const status = action.statusCode ?? 0;
  switch (action.kind) {
    case "block":
      return status === 403 || status === 451;
    case "log":
    case "allow":
      return true;
    case "challenge":
      return (challengeTypes as readonly string[]).includes(action.challenge ?? "");
    case "redirect": {
      let absolute = false;
      try {
        const url = new URL(value);
        absolute = ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username;
      } catch {}
      const local = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
      return (local || absolute) && [301, 302, 307, 308].includes(status);
    }
    case "rewrite":
      return value.startsWith("/") && !value.startsWith("//") && !/[?\\#]/.test(value);
    case "request_header":
    case "response_header":
      return ruleHeader(action.header ?? "");
    case "config":
      return (
        action.gzip !== true &&
        (action.cacheBypass !== undefined ||
          action.forceHttps !== undefined ||
          action.gzip !== undefined)
      );
    case "rate_limit": {
      const limit = action.limit ?? 0;
      const window = action.windowSeconds ?? 0;
      return (
        (status === 403 || status === 429) &&
        limit >= 1 &&
        limit <= 100000 &&
        window >= 1 &&
        window <= 3600 &&
        isRateLimitKey(action.key ?? "")
      );
    }
  }
  return false;
}
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

// Regular expressions (`matches`) are one subset that JavaScript (this evaluator),
// Go (edgeweir-node configir/rules.go, a line-for-line port of this parser) and
// PCRE2 without UTF (the node's ngx.re) read alike, matched against the UTF-8
// bytes of the value. Keep the three in step with test/vectors.json.
const patternPunctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
type PatternItem = { length: number; kind: "char" | "set" | "assertion" | "dash"; code: number };
// What a quantifier at this point would repeat: nothing, an atom, a quantifier (only a lazy "?"
// may follow) or an anchor, group or lazy quantifier (never repeated).
type PatternState = "none" | "atom" | "quantifier" | "fixed";

function patternEscape(pattern: string, i: number, inClass: boolean): PatternItem {
  const e = pattern[i + 1] ?? "";
  switch (e) {
    case "d":
    case "D":
    case "w":
    case "W":
      return { length: 2, kind: "set", code: -1 };
    case "b":
    case "B":
      if (!inClass) return { length: 2, kind: "assertion", code: -1 };
      break;
    case "t":
      return { length: 2, kind: "char", code: 9 };
    case "n":
      return { length: 2, kind: "char", code: 10 };
    case "f":
      return { length: 2, kind: "char", code: 12 };
    case "r":
      return { length: 2, kind: "char", code: 13 };
    case "x": {
      const hex = pattern.slice(i + 2, i + 4);
      if (/^[0-7][0-9a-fA-F]$/.test(hex))
        return { length: 4, kind: "char", code: Number.parseInt(hex, 16) };
      break;
    }
    default:
      if (e && patternPunctuation.includes(e))
        return { length: 2, kind: "char", code: e.charCodeAt(0) };
  }
  throw new ExpressionError("unsupported escape in regular expression", i);
}

function patternClassAtom(pattern: string, j: number, body: number): PatternItem {
  const c = pattern[j] ?? "";
  if (c === "\\") return patternEscape(pattern, j, true);
  if (c === "-" && (j === body || pattern[j + 1] === "]"))
    return { length: 1, kind: "dash", code: 45 };
  if (c === "-") throw new ExpressionError("escape - inside a character class", j);
  if (c === "[") throw new ExpressionError("escape [ inside a character class", j);
  if (c < " " || c > "~")
    throw new ExpressionError("regular expressions accept printable ASCII only", j);
  return { length: 1, kind: "char", code: c.charCodeAt(0) };
}

/** Checks the class that starts at pattern[i] ("[") and returns the index after its "]". */
function patternClass(pattern: string, i: number): number {
  const body = pattern[i + 1] === "^" ? i + 2 : i + 1;
  let j = body;
  while (pattern[j] !== "]") {
    if (j >= pattern.length) throw new ExpressionError("unterminated character class", i);
    const low = patternClassAtom(pattern, j, body);
    let end = j + low.length;
    if (pattern[end] === "-" && end + 1 < pattern.length && pattern[end + 1] !== "]") {
      const high = low.kind === "char" ? patternClassAtom(pattern, end + 1, body) : undefined;
      if (high?.kind !== "char" || high.code < low.code)
        throw new ExpressionError("invalid character class range", j);
      end += 1 + high.length;
    }
    j = end;
  }
  if (j === body) throw new ExpressionError("empty character class", i);
  // PCRE2 reads [:x:], [.x.] and [=x=] as POSIX syntax and refuses them outside a class.
  const text = pattern.slice(body, j);
  if (text.length > 1 && ":.=".includes(text[0] ?? "") && text.endsWith(text[0] ?? ""))
    throw new ExpressionError("character class reads as a POSIX class", i);
  return j + 1;
}

/** Returns the length of the {n}, {n,} or {n,m} quantifier at pattern[i] (n <= m <= 1000). */
function patternBraces(pattern: string, i: number): number {
  const q = /^\{(0|[1-9]\d{0,3})(,(0|[1-9]\d{0,3})?)?\}/.exec(pattern.slice(i));
  const low = Number(q?.[1]);
  const high = q?.[3] === undefined ? low : Number(q[3]);
  if (!q || low > 1000 || high > 1000 || high < low)
    throw new ExpressionError("unsupported repetition", i);
  return q[0].length;
}

/** Validates `pattern` (see validatePattern) and returns its JavaScript source. */
function compilePattern(pattern: string): string {
  if (pattern.length > 256) throw new ExpressionError("regular expression is too long", 256);
  let source = "";
  let depth = 0;
  let previous: PatternState = "none";
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i] ?? "";
    let length = 1;
    let next: PatternState = "atom";
    if (c === "\\") {
      const item = patternEscape(pattern, i, false);
      length = item.length;
      if (item.kind === "assertion") next = "fixed";
    } else if (c === "[") {
      length = patternClass(pattern, i) - i;
    } else if (c === "(") {
      if (pattern[i + 1] === "?") throw new ExpressionError("unsupported group", i);
      depth++;
      next = "none";
    } else if (c === ")") {
      if (--depth < 0) throw new ExpressionError("unbalanced parenthesis", i);
      next = "fixed";
    } else if (c === "|") {
      next = "none";
    } else if (c === "^" || c === "$") {
      next = "fixed";
    } else if (c === "?" && previous === "quantifier") {
      next = "fixed";
    } else if (c === "*" || c === "+" || c === "?" || c === "{") {
      if (previous !== "atom")
        throw new ExpressionError(
          previous === "none" ? "nothing to repeat" : "unsupported repetition",
          i,
        );
      if (c === "{") length = patternBraces(pattern, i);
      next = "quantifier";
    } else if (c === "]" || c === "}") {
      throw new ExpressionError("escape literal brackets and braces", i);
    } else if (c < " " || c > "~") {
      throw new ExpressionError("regular expressions accept printable ASCII only", i);
    }
    // JavaScript's "." also skips "\r"; PCRE2 and RE2 skip only "\n".
    source += c === "." ? "[^\\n]" : pattern.slice(i, i + length);
    previous = next;
    i += length;
  }
  if (depth > 0) throw new ExpressionError("unbalanced parenthesis", pattern.length);
  return source;
}

/**
 * Throws ExpressionError (positioned in `pattern`) unless `pattern` is in the subset:
 * printable ASCII, at most 256 characters; literals; `.` (any byte except "\n"); `^` and
 * `$` (start and end of the value); `\b` `\B`; `\d` `\D` `\w` `\W` (ASCII); `\t` `\n` `\r`
 * `\f`; `\x00`-`\x7f`; a backslash before ASCII punctuation; classes `[...]` `[^...]` of
 * those characters, `\d` `\D` `\w` `\W` and ranges, with a bare `-` only first or last;
 * `* + ? {n} {n,} {n,m}` (n <= m <= 1000, no leading zeros), optionally lazy, after a
 * character, class or escape; `|` and capturing groups, never repeated. Everything else is
 * rejected, among it `(?...)`, backreferences, `\s`, `\v`, `\z`, `\p{...}`, possessive
 * quantifiers and unescaped `]`, `{` or `}`.
 */
export function validatePattern(pattern: string): void {
  compilePattern(pattern);
}

/** Source offset of character `index` of the quoted string token that starts at `start`. */
function stringOffset(source: string, start: number, index: number): number {
  let i = start + 1;
  for (let k = 0; k < index && i < source.length; k++)
    i += source[i] !== "\\" ? 1 : source[i + 1] === "u" ? 6 : 2;
  return i;
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
    const start = peek()?.position ?? source.length;
    const value = readValue(type);
    if (op === "matches") {
      try {
        validatePattern(value);
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        throw new ExpressionError(error.message, stringOffset(source, start, error.position));
      }
    }
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
/** Whether the expression reads the JA4 fingerprint (node feature ja4-v1). */
export function usesJa4(expression: Expression): boolean {
  return expression.field === "tls.ja4" || expression.children.some(usesJa4);
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
    // One character per UTF-8 byte, as PCRE2 without UTF reads the value on the node.
    const bytes = Array.from(new TextEncoder().encode(String(actual)), (b) =>
      String.fromCharCode(b),
    ).join("");
    return new RegExp(compilePattern(e.value)).test(bytes);
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
