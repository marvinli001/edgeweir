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
  // Since rules-v2: response fields available, like response-transform.
  "compression",
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
  // rules-v2: scheme://host followed by the request URI as received.
  "http.request.full_uri": "string",
  // rules-v2: lowercase text after the last "." of the last path segment ("" without one).
  "http.request.uri.path.extension": "string",
  // rules-v2: lowercase media type of the response's Content-Type, parameters removed.
  "http.response.content_type.media_type": "string",
};
/** Fields only nodes with rules-v2 provide. */
export const rulesV2Fields: ReadonlySet<string> = new Set([
  "http.request.full_uri",
  "http.request.uri.path.extension",
  "http.response.content_type.media_type",
]);
/** Phases that may read response fields. */
export const responsePhases: ReadonlySet<string> = new Set(["response-transform", "compression"]);

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
  origin: ["origin"],
  compression: ["compression"],
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
  // rules-v2 (config phase only)
  brotli?: boolean;
  zstd?: boolean;
  websocket?: boolean;
  underAttack?: boolean;
  ccEnabled?: boolean;
  ccMaxLevel?: string;
  originConnectTimeoutMs?: number;
  originSendTimeoutMs?: number;
  originReadTimeoutMs?: number;
  logSampleRate?: number;
  // rules-v2: redirect and rewrite
  target?: Expression;
  preserveQuery?: boolean;
  setQuery?: { name: string; value: string }[];
  removeQuery?: string[];
  // rules-v2: origin
  originGroup?: string;
  hostHeader?: string;
  sni?: string;
  port?: number;
  // rules-v2: compression
  compression?: string[];
}

/** Codings of compression rules and of the config switches, node names. */
export const compressionCodings = ["zstd", "br", "gzip"] as const;
/** Query parameter names redirects and rewrites may set or remove (RFC 3986 unreserved). */
export const QUERY_NAME_RE = /^[A-Za-z0-9._~-]{1,64}$/;
/** Origin groups inside a site; "" is the default group. */
export const ORIGIN_GROUP_RE = /^[a-z0-9_-]{1,32}$/;
const hostnameRe =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

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

/** Whether `value` is a static redirect target nodes accept. */
export function validRedirectTarget(value: string): boolean {
  let absolute = false;
  try {
    const url = new URL(value);
    absolute = ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username;
  } catch {}
  const local = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
  return local || absolute;
}

/** Fields each action kind may carry besides `kind` (everything else must stay empty). */
const actionFields: Record<string, readonly (keyof ActionIr)[]> = {
  block: ["statusCode"],
  log: [],
  allow: [],
  challenge: ["challenge"],
  redirect: ["value", "statusCode", "target", "preserveQuery", "setQuery", "removeQuery"],
  rewrite: ["value", "target", "preserveQuery", "setQuery", "removeQuery"],
  request_header: ["header", "value", "remove"],
  response_header: ["header", "value", "remove"],
  config: [
    "cacheBypass",
    "forceHttps",
    "gzip",
    "brotli",
    "zstd",
    "websocket",
    "underAttack",
    "ccEnabled",
    "ccMaxLevel",
    "originConnectTimeoutMs",
    "originSendTimeoutMs",
    "originReadTimeoutMs",
    "logSampleRate",
  ],
  rate_limit: ["statusCode", "limit", "windowSeconds", "key"],
  origin: ["originGroup", "hostHeader", "sni", "port"],
  compression: ["compression"],
};
const configV2Fields: readonly (keyof ActionIr)[] = [
  "brotli",
  "zstd",
  "websocket",
  "underAttack",
  "ccEnabled",
  "ccMaxLevel",
  "originConnectTimeoutMs",
  "originSendTimeoutMs",
  "originReadTimeoutMs",
  "logSampleRate",
];
const isSet = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  value !== 0 &&
  !(Array.isArray(value) && value.length === 0);

function validQueryEdits(action: ActionIr): boolean {
  const set = action.setQuery ?? [];
  const remove = action.removeQuery ?? [];
  if (set.length > 16 || remove.length > 16) return false;
  const names = set.map((p) => p.name);
  const sortedUnique = (list: string[]) =>
    list.every((name, i) => QUERY_NAME_RE.test(name) && (i === 0 || (list[i - 1] ?? "") < name));
  return (
    sortedUnique(names) &&
    sortedUnique(remove) &&
    !names.some((name) => remove.includes(name)) &&
    set.every((p) => p.value.length <= 256 && /^[\x20-\x7e]*$/.test(p.value))
  );
}

/**
 * Whether a compiled action is valid in `phase`, as the node validates it
 * (edgeweir-node configir/rules.go). The console validates its own input with
 * the stricter ruleAction schema of @edgeweir/contract.
 */
export function validActionIr(phase: string, action: ActionIr): boolean {
  if (!(actionPhases[action.kind] as readonly string[] | undefined)?.includes(phase)) return false;
  const allowed = actionFields[action.kind] ?? [];
  for (const [field, value] of Object.entries(action))
    if (field !== "kind" && isSet(value) && !allowed.includes(field as keyof ActionIr)) {
      // `false` booleans are values too; only the kind's own fields may be present.
      return false;
    }
  for (const [field, value] of Object.entries(action))
    if (field !== "kind" && value === false && !allowed.includes(field as keyof ActionIr))
      return false;
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
      if (!validQueryEdits(action) || ![301, 302, 307, 308].includes(status)) return false;
      if (action.target) return value === "" && validExpressionIr(action.target, phase, true);
      return validRedirectTarget(value);
    }
    case "rewrite":
      if (!validQueryEdits(action)) return false;
      if (action.target) return value === "" && validExpressionIr(action.target, phase, true);
      return value.startsWith("/") && !value.startsWith("//") && !/[?\\#]/.test(value);
    case "request_header":
    case "response_header":
      return ruleHeader(action.header ?? "");
    case "config": {
      if (phase !== "config" && configV2Fields.some((field) => action[field] !== undefined))
        return false;
      const level = action.ccMaxLevel ?? "";
      const timeout = (ms: number | undefined, max: number) =>
        ms === undefined || ms === 0 || (Number.isInteger(ms) && ms >= 100 && ms <= max);
      const rate = action.logSampleRate;
      return (
        (level === "" || (challengeTypes as readonly string[]).includes(level)) &&
        timeout(action.originConnectTimeoutMs, 120_000) &&
        timeout(action.originSendTimeoutMs, 3_600_000) &&
        timeout(action.originReadTimeoutMs, 3_600_000) &&
        (rate === undefined || (Number.isInteger(rate) && rate >= 0 && rate <= 10000)) &&
        (action.cacheBypass !== undefined ||
          action.forceHttps !== undefined ||
          action.gzip !== undefined ||
          configV2Fields.some(
            (field) =>
              action[field] !== undefined &&
              !(field === "ccMaxLevel" && action[field] === "") &&
              !(field.endsWith("TimeoutMs") && action[field] === 0),
          ))
      );
    }
    case "origin": {
      const group = action.originGroup ?? "";
      const host = action.hostHeader ?? "";
      const sni = action.sni ?? "";
      const port = action.port ?? 0;
      return (
        (group === "" || ORIGIN_GROUP_RE.test(group)) &&
        (host === "" || hostnameRe.test(host)) &&
        (sni === "" || hostnameRe.test(sni)) &&
        Number.isInteger(port) &&
        port >= 0 &&
        port <= 65535 &&
        (group !== "" || host !== "" || sni !== "" || port !== 0)
      );
    }
    case "compression": {
      const list = action.compression ?? [];
      return (
        new Set(list).size === list.length &&
        list.every((c) => (compressionCodings as readonly string[]).includes(c))
      );
    }
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
function tokenize(source: string, maxLength: number): Token[] {
  if (source.length > maxLength) throw new ExpressionError("expression is too long", maxLength);
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
    } else if ("(){}[],".includes(c ?? "")) {
      out.push({ kind: "punct", text: c ?? "", position });
      i++;
    } else {
      while (i < source.length && !/[\s(){}[\]",]/.test(source[i] ?? "")) i++;
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

/** Functions of the expression language (rules-v2), all over byte strings. */
interface FunctionSpec {
  /** Argument types; "pattern", "wildcard", "replacement" and "flags" are string literals. */
  args: readonly string[];
  /** Extra trailing optional arguments of the last listed kind... see variadic. */
  optional?: number;
  variadic?: [min: number, max: number];
  returns: ValueType;
  /** Only in value expressions (redirect targets, rewrite paths), at most once each. */
  valueOnly?: boolean;
}
export const functions: Record<string, FunctionSpec> = {
  lower: { args: ["string"], returns: "string" },
  upper: { args: ["string"], returns: "string" },
  len: { args: ["string"], returns: "number" },
  starts_with: { args: ["string", "string"], returns: "boolean" },
  ends_with: { args: ["string", "string"], returns: "boolean" },
  url_decode: { args: ["string"], returns: "string" },
  concat: { args: [], variadic: [2, 8], returns: "string" },
  regex_replace: { args: ["string", "pattern", "replacement"], returns: "string", valueOnly: true },
  wildcard_replace: {
    args: ["string", "wildcard", "replacement", "flags"],
    optional: 1,
    returns: "string",
    valueOnly: true,
  },
};
const MAX_CALL_DEPTH = 4;
/** Longest value an expression computes on the node; longer results fail the request. */
export const MAX_VALUE_BYTES = 8192;

const byteLength = (value: string) => new TextEncoder().encode(value).length;
const controlCharacter = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Number of capturing groups of a pattern that validatePattern accepted. */
function patternGroups(pattern: string): number {
  let groups = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") groups++;
  }
  return groups;
}

/**
 * Splits a wildcard_replace pattern into its literal segments (one more than the
 * number of `*`). `\*` and `\\` are literals; any other backslash, control
 * characters, more than 8 wildcards or more than 1024 bytes are rejected.
 */
export function wildcardSegments(pattern: string): string[] {
  if (byteLength(pattern) > 1024) throw new ExpressionError("wildcard pattern is too long", 0);
  if (controlCharacter(pattern)) throw new ExpressionError("invalid wildcard pattern", 0);
  const segments = [""];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next !== "*" && next !== "\\")
        throw new ExpressionError("escape only * and \\ in wildcard patterns", i);
      segments[segments.length - 1] += next;
      i++;
    } else if (c === "*") {
      segments.push("");
      if (segments.length > 9) throw new ExpressionError("too many wildcards", i);
    } else segments[segments.length - 1] += c;
  }
  return segments;
}

/** Checks a replacement literal: `${1}`-`${8}` up to `captures`, other `$` literal. */
function checkReplacement(replacement: string, captures: number): void {
  if (byteLength(replacement) > 1024 || controlCharacter(replacement))
    throw new ExpressionError("invalid replacement", 0);
  for (const m of replacement.matchAll(/\$\{([1-8])\}/g))
    if (Number(m[1]) > captures)
      throw new ExpressionError("replacement references a missing capture", m.index ?? 0);
}

type Field = { name: string; type: ValueType; position: number };

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
    if (!token) throw new ExpressionError("unexpected end of expression", source.length);
    return token;
  };
  const expect = (text: string) => {
    const token = take();
    if (token.text !== text) throw new ExpressionError(`expected ${text}`, token.position);
  };
  const count = () => {
    if (++nodes > 128)
      throw new ExpressionError("expression is too complex", peek()?.position ?? source.length);
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
  /** Reads a field name (with the headers["name"] form) starting at `token`. */
  const readField = (token: Token): Field => {
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
    if (!type || token.kind !== "word") throw new ExpressionError("unknown field", token.position);
    if (field.startsWith("http.response.") && !responsePhases.has(phase))
      throw new ExpressionError("response field is unavailable in this phase", token.position);
    return { name: field, type, position: token.position };
  };
  /** A literal argument of `kind` (pattern, wildcard, replacement or flags). */
  const literal = (kind: string, captures: number): Expression => {
    const start = peek()?.position ?? source.length;
    const token = take();
    if (token.kind !== "string")
      throw new ExpressionError(`the ${kind} must be a quoted string`, token.position);
    try {
      if (kind === "pattern") validatePattern(token.text);
      if (kind === "wildcard") wildcardSegments(token.text);
      if (kind === "replacement") checkReplacement(token.text, captures);
      if (kind === "flags" && token.text !== "s")
        throw new ExpressionError('the only flag is "s"', 0);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      throw new ExpressionError(error.message, stringOffset(source, start, error.position));
    }
    count();
    return node("const", { valueType: "string", value: token.text });
  };
  /** A function call whose name is `token`; "(" is next. */
  const call = (token: Token, depth: number, valueContext: boolean): Expression => {
    const spec = Object.hasOwn(functions, token.text) ? functions[token.text] : undefined;
    if (!spec) throw new ExpressionError("unknown function", token.position);
    if (spec.valueOnly && !valueContext)
      throw new ExpressionError("function is only available in value expressions", token.position);
    if (spec.valueOnly) {
      if (replaceCalls.has(token.text))
        throw new ExpressionError("function may appear once per expression", token.position);
      replaceCalls.add(token.text);
    }
    if (depth > MAX_CALL_DEPTH)
      throw new ExpressionError("functions are nested too deeply", token.position);
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
        throw new ExpressionError("too many arguments", peek()?.position ?? source.length);
      const kind = kinds[args.length] ?? "string";
      if (kind === "string") {
        const start = peek()?.position ?? source.length;
        const arg = value(depth + 1, valueContext);
        if (arg.valueType !== "string")
          throw new ExpressionError("argument must be a string", start);
        args.push(arg);
      } else {
        const arg = literal(kind, captures);
        if (kind === "pattern") captures = patternGroups(arg.value);
        if (kind === "wildcard") captures = wildcardSegments(arg.value).length - 1;
        args.push(arg);
      }
    }
    expect(")");
    if (args.length < min) throw new ExpressionError("too few arguments", token.position);
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
        if (computed || type !== "ip" || !/^\$[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(list.text))
          throw new ExpressionError("invalid named IP list", list.position);
        return node("in_list", { ...target, valueType: type, value: list.text.slice(1) });
      }
      expect("{");
      const values: string[] = [];
      while (peek()?.text !== "}") {
        values.push(readValue(type));
        if (values.length > 256) throw new ExpressionError("set is too large", operator.position);
      }
      expect("}");
      if (!values.length) throw new ExpressionError("empty set", operator.position);
      return node("in", { ...target, valueType: type, values: [...new Set(values)].sort() });
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
    void depth;
    return node(op, { ...target, valueType: type, value });
  }
  const operators = new Set(["eq", "ne", "lt", "le", "gt", "ge", "contains", "matches", "in"]);
  function primary(depth: number): Expression {
    if (depth > 16) throw new ExpressionError("expression is too complex", peek()?.position ?? 0);
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
      throw new ExpressionError("unexpected token", peek()?.position ?? source.length);
    return result;
  };
  return {
    condition: () => done(or(0)),
    value: () => {
      const start = peek()?.position ?? 0;
      const result = value(1, true);
      if (result.valueType !== "string")
        throw new ExpressionError("value expressions must be strings", start);
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
export function bindLists(expression: Expression, lists: Record<string, string>): Expression {
  if (expression.op === "in_list" && !Object.hasOwn(lists, expression.value))
    throw new ExpressionError("unknown IP list", 0);
  return {
    ...expression,
    value: expression.op === "in_list" ? (lists[expression.value] ?? "") : expression.value,
    children: expression.children.map((c) => bindLists(c, lists)),
  };
}

// ---- Typed IR validation (the node's check, edgeweir-node configir/rules.go) ----

const comparisonOps = new Set(["eq", "ne", "lt", "le", "gt", "ge", "contains", "matches", "in"]);

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
        return canonicalCidr(value) === value && !value.startsWith("::ffff:");
      } catch {
        return false;
      }
  }
  return false;
}

function irFieldType(field: string): string | undefined {
  for (const prefix of ["http.request.headers.", "http.response.headers."])
    if (
      field.startsWith(prefix) &&
      /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/.test(field.slice(prefix.length))
    )
      return "string";
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
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
  const fieldOk = (field: string, type: string) =>
    irFieldType(field) === type && (!field.startsWith("http.response.") || responseOk);
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
      if (kind === "string") {
        if (valueNode(arg, depth + 1, inValue) !== "string") return undefined;
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
    if (x.op === "matches") {
      if (type !== "string") return false;
      try {
        validatePattern(x.value);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  };
  return valueExpression ? valueNode(e, 1, true) === "string" : condition(e, 0);
}

// ---- Reference evaluation over byte strings (one char per UTF-8 byte) ----

/** The UTF-8 bytes of `value`, one character per byte. */
export function toBytes(value: string): string {
  return Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join("");
}
/** Decodes a byte string (one character per byte) as UTF-8. */
export function fromBytes(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiUpper = (value: string) => value.replace(/[a-z]/g, (c) => c.toUpperCase());

/** url_decode over a byte string: one pass, %XX to a byte, "+" to a space. */
export function urlDecodeBytes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const hex = value.slice(i + 1, i + 3);
    if (c === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
    } else out += c === "+" ? " " : c;
  }
  return out;
}

function expandReplacement(replacement: string, captures: (string | undefined)[]): string {
  return replacement.replace(/\$\{([1-8])\}/g, (_, n: string) => captures[Number(n)] ?? "");
}

/**
 * wildcard_replace over byte strings: full match of the literal segments with
 * leftmost placement (the lazy reading of every `*`), ASCII case-insensitive unless
 * `caseSensitive`. Returns the source unchanged without a match.
 */
export function wildcardReplaceBytes(
  source: string,
  pattern: string,
  replacement: string,
  caseSensitive = false,
): string {
  const segments = wildcardSegments(fromBytes(pattern)).map(toBytes);
  const fold = caseSensitive ? (x: string) => x : asciiLower;
  const subject = fold(source);
  const parts = segments.map(fold);
  const first = parts[0] ?? "";
  if (parts.length === 1) return subject === first ? expandReplacement(replacement, []) : source;
  if (!subject.startsWith(first)) return source;
  let pos = first.length;
  const captures: (string | undefined)[] = [undefined];
  for (let i = 1; i < parts.length - 1; i++) {
    const at = subject.indexOf(parts[i] ?? "", pos);
    if (at < 0) return source;
    captures.push(source.slice(pos, at));
    pos = at + (parts[i] ?? "").length;
  }
  const last = parts[parts.length - 1] ?? "";
  if (subject.length - last.length < pos || !subject.endsWith(last)) return source;
  captures.push(source.slice(pos, subject.length - last.length));
  return expandReplacement(replacement, captures);
}

/** regex_replace over byte strings: replaces the first match of a validated pattern. */
export function regexReplaceBytes(source: string, pattern: string, replacement: string): string {
  const match = new RegExp(compilePattern(fromBytes(pattern))).exec(source);
  if (!match) return source;
  return (
    source.slice(0, match.index) +
    expandReplacement(replacement, [...match]) +
    source.slice(match.index + match[0].length)
  );
}

type Request = Record<string, string | number | boolean>;

function fieldValue(field: string, type: string, request: Request): string | number | boolean {
  const actual = request[field];
  if (actual === undefined) return type === "number" ? 0 : type === "boolean" ? false : "";
  return typeof actual === "string" ? toBytes(actual) : actual;
}

function evaluateNode(e: Expression, request: Request): string | number | boolean {
  if (e.op === "field") return fieldValue(e.field, e.valueType, request);
  if (e.op === "const") return toBytes(e.value);
  const args = e.children.map((c) => evaluateNode(c, request) as string);
  const [a = "", b = "", c = "", d = ""] = args;
  let result: string | number | boolean;
  switch (e.field) {
    case "lower":
      result = asciiLower(a);
      break;
    case "upper":
      result = asciiUpper(a);
      break;
    case "len":
      return a.length;
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "url_decode":
      result = urlDecodeBytes(a);
      break;
    case "concat":
      result = args.join("");
      break;
    case "regex_replace":
      result = regexReplaceBytes(a, b, c);
      break;
    case "wildcard_replace":
      result = wildcardReplaceBytes(a, b, c, d === "s");
      break;
    default:
      throw new ExpressionError("unknown function", 0);
  }
  if (typeof result === "string" && result.length > MAX_VALUE_BYTES)
    throw new ExpressionError("value is too long", 0);
  return result;
}

/** Evaluates a value expression to the string the node computes (UTF-8 decoded). */
export function evaluateValue(expression: Expression, request: Request): string {
  return fromBytes(String(evaluateNode(expression, request)));
}

export function evaluate(
  expression: Expression,
  request: Request,
  lists: Record<string, string[]> = {},
): boolean {
  const e = expression;
  if (e.op === "literal") return e.value === "true";
  if (e.op === "and") return e.children.every((c) => evaluate(c, request, lists));
  if (e.op === "or") return e.children.some((c) => evaluate(c, request, lists));
  if (e.op === "not") return !evaluate(e.children[0] as Expression, request, lists);
  if (e.op === "call") return evaluateNode(e, request) === true;
  const actual =
    e.field === ""
      ? evaluateNode(e.children[0] as Expression, request)
      : e.valueType === "ip"
        ? String(request[e.field] ?? "")
        : fieldValue(e.field, e.valueType, request);
  const equal = (value: string) =>
    e.valueType === "ip"
      ? ipMatches(String(actual), value)
      : e.valueType === "number"
        ? Number(actual) === Number(value)
        : e.valueType === "boolean"
          ? actual === (value === "true")
          : actual === toBytes(value);
  if (e.op === "in_list") return (lists[e.value] ?? []).some(equal);
  if (e.op === "in") return e.values.some(equal);
  if (e.op === "eq") return equal(e.value);
  if (e.op === "ne") return !equal(e.value);
  if (e.op === "contains") return String(actual).includes(toBytes(e.value));
  if (e.op === "matches") return new RegExp(compilePattern(e.value)).test(String(actual));
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

// ---- Derived request fields ----

/** http.request.uri.path.extension of a path (edgeweir-node rules.extension). */
export function pathExtension(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot < 0 ? "" : asciiLower(last.slice(dot + 1));
}
/** http.response.content_type.media_type of a Content-Type value. */
export function mediaType(contentType: string): string {
  const match = /^[ \t]*([^; \t]+)/.exec(contentType);
  return match ? asciiLower(match[1] ?? "") : "";
}

// ---- Cache rule conditions: the structured builder and its expression ----

export interface StructuredCacheCondition {
  pathPrefixes: string[];
  paths: string[];
  extensions: string[];
}
const PATH = "http.request.uri.path";
const EXTENSION = "http.request.uri.path.extension";

/** The expression of a structured cache condition (the builder's output). */
export function cacheConditionExpression(condition: StructuredCacheCondition): string {
  const parts: string[] = [];
  const prefixes = condition.pathPrefixes.map((p) => `starts_with(${PATH}, ${JSON.stringify(p)})`);
  if (prefixes.length)
    parts.push(prefixes.length > 1 ? `(${prefixes.join(" or ")})` : (prefixes[0] as string));
  if (condition.paths.length)
    parts.push(`${PATH} in {${condition.paths.map((p) => JSON.stringify(p)).join(" ")}}`);
  if (condition.extensions.length)
    parts.push(`${EXTENSION} in {${condition.extensions.map((e) => JSON.stringify(e)).join(" ")}}`);
  return parts.join(" and ") || "true";
}

const structuredPrefix = (p: string) => p.startsWith("/") && p.length <= 1024 && !/\s/.test(p);
/**
 * The structured form of a parsed cache condition when it is one (what the builder
 * shows and what older nodes understand), else null. Lists keep the limits of the
 * structured model (32 prefixes, 32 paths, 64 extensions).
 */
export function structuredCacheCondition(expression: Expression): StructuredCacheCondition | null {
  const out: StructuredCacheCondition = { pathPrefixes: [], paths: [], extensions: [] };
  if (expression.op === "literal") return expression.value === "true" ? out : null;
  const seen = new Set<string>();
  const prefixCall = (x: Expression) =>
    x.op === "call" &&
    x.field === "starts_with" &&
    x.children[0]?.op === "field" &&
    x.children[0].field === PATH &&
    x.children[1]?.op === "const" &&
    structuredPrefix(x.children[1].value);
  const parts = expression.op === "and" ? expression.children : [expression];
  for (const part of parts) {
    if (prefixCall(part) || (part.op === "or" && part.children.every(prefixCall))) {
      if (seen.has("prefix")) return null;
      seen.add("prefix");
      const calls = part.op === "or" ? part.children : [part];
      out.pathPrefixes = calls.map((c) => c.children[1]?.value ?? "");
    } else if (part.op === "in" && part.field === PATH) {
      if (seen.has("path") || !part.values.every(structuredPrefix)) return null;
      seen.add("path");
      out.paths = [...part.values];
    } else if (part.op === "in" && part.field === EXTENSION) {
      if (seen.has("extension") || !part.values.every((v) => /^[a-z0-9]{1,16}$/.test(v)))
        return null;
      seen.add("extension");
      out.extensions = [...part.values];
    } else return null;
  }
  if (out.pathPrefixes.length > 32 || out.paths.length > 32 || out.extensions.length > 64)
    return null;
  return out;
}

/** The structured cache rule matcher of nodes without rules-v2 (edgeweir-node rules.lua). */
export function structuredCacheMatch(condition: StructuredCacheCondition, path: string): boolean {
  const p = toBytes(path);
  if (
    condition.pathPrefixes.length &&
    !condition.pathPrefixes.some((x) => p.startsWith(toBytes(x)))
  )
    return false;
  if (condition.paths.length && !condition.paths.some((x) => toBytes(x) === p)) return false;
  if (condition.extensions.length) {
    const last = path.slice(path.lastIndexOf("/") + 1);
    const ext = /\.([^.]+)$/.exec(last)?.[1];
    if (!ext || !condition.extensions.includes(asciiLower(ext))) return false;
  }
  return true;
}
