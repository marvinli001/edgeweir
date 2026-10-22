import { ExpressionError } from "./model.ts";

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
  throw new ExpressionError("regex_escape", i);
}

function patternClassAtom(pattern: string, j: number, body: number): PatternItem {
  const c = pattern[j] ?? "";
  if (c === "\\") return patternEscape(pattern, j, true);
  if (c === "-" && (j === body || pattern[j + 1] === "]"))
    return { length: 1, kind: "dash", code: 45 };
  if (c === "-") throw new ExpressionError("regex_class_dash", j);
  if (c === "[") throw new ExpressionError("regex_class_bracket", j);
  if (c < " " || c > "~") throw new ExpressionError("regex_ascii", j);
  return { length: 1, kind: "char", code: c.charCodeAt(0) };
}

/** Checks the class that starts at pattern[i] ("[") and returns the index after its "]". */
function patternClass(pattern: string, i: number): number {
  const body = pattern[i + 1] === "^" ? i + 2 : i + 1;
  let j = body;
  while (pattern[j] !== "]") {
    if (j >= pattern.length) throw new ExpressionError("regex_class_unterminated", i);
    const low = patternClassAtom(pattern, j, body);
    let end = j + low.length;
    if (pattern[end] === "-" && end + 1 < pattern.length && pattern[end + 1] !== "]") {
      const high = low.kind === "char" ? patternClassAtom(pattern, end + 1, body) : undefined;
      if (high?.kind !== "char" || high.code < low.code)
        throw new ExpressionError("regex_class_range", j);
      end += 1 + high.length;
    }
    j = end;
  }
  if (j === body) throw new ExpressionError("regex_class_empty", i);
  // PCRE2 reads [:x:], [.x.] and [=x=] as POSIX syntax and refuses them outside a class.
  const text = pattern.slice(body, j);
  if (text.length > 1 && ":.=".includes(text[0] ?? "") && text.endsWith(text[0] ?? ""))
    throw new ExpressionError("regex_class_posix", i);
  return j + 1;
}

/** Returns the length of the {n}, {n,} or {n,m} quantifier at pattern[i] (n <= m <= 1000). */
function patternBraces(pattern: string, i: number): number {
  const q = /^\{(0|[1-9]\d{0,3})(,(0|[1-9]\d{0,3})?)?\}/.exec(pattern.slice(i));
  const low = Number(q?.[1]);
  const high = q?.[3] === undefined ? low : Number(q[3]);
  if (!q || low > 1000 || high > 1000 || high < low)
    throw new ExpressionError("regex_repetition", i);
  return q[0].length;
}

/** Validates `pattern` (see validatePattern) and returns its JavaScript source. */
export function compilePattern(pattern: string): string {
  if (pattern.length > 256) throw new ExpressionError("regex_too_long", 256, { max: "256" });
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
      if (pattern[i + 1] === "?") throw new ExpressionError("regex_group", i);
      depth++;
      next = "none";
    } else if (c === ")") {
      if (--depth < 0) throw new ExpressionError("regex_parenthesis", i);
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
          previous === "none" ? "regex_nothing_to_repeat" : "regex_repetition",
          i,
        );
      if (c === "{") length = patternBraces(pattern, i);
      next = "quantifier";
    } else if (c === "]" || c === "}") {
      throw new ExpressionError("regex_brackets", i);
    } else if (c < " " || c > "~") {
      throw new ExpressionError("regex_ascii", i);
    }
    // JavaScript's "." also skips "\r"; PCRE2 and RE2 skip only "\n".
    source += c === "." ? "[^\\n]" : pattern.slice(i, i + length);
    previous = next;
    i += length;
  }
  if (depth > 0) throw new ExpressionError("regex_parenthesis", pattern.length);
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

/**
 * A pattern of the subset (see validatePattern) as a JavaScript RegExp; `whole`
 * anchors it to the entire value, as `^(?:pattern)$`. Throws ExpressionError.
 */
export function patternRegExp(pattern: string, whole = false): RegExp {
  const source = compilePattern(pattern);
  return new RegExp(whole ? `^(?:${source})$` : source);
}
