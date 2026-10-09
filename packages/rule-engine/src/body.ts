/**
 * Request body values of the rules (rules-body-v1): form_value, json_value and the field
 * http.request.body.filenames, over byte strings (one character per byte), exactly as the node
 * computes them (edgeweir-node lua/edgeweir/body.lua; shared vectors in test/body_vectors.json).
 * Bodies are read whole: the node reads only requests whose Content-Length is at most the
 * site's limit, so a body is never cut off here.
 */

/** The site's limit on the body the rules read, in bytes (Content-Length). */
export const RULES_BODY_LIMIT = { min: 1024, max: 1_048_576, default: 65_536 } as const;
/** Parts of a multipart body that are looked at; later ones are ignored. */
export const MAX_MULTIPART_PARTS = 1000;
/** Deepest nesting of arrays and objects a JSON body may have; deeper ones are invalid. */
export const MAX_JSON_DEPTH = 128;
/** form_value's name and json_value's path: bytes and, for paths, segments. */
export const MAX_FORM_NAME_BYTES = 256;
export const MAX_JSON_PATH_BYTES = 256;
export const MAX_JSON_PATH_SEGMENTS = 32;

const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const controlCharacter = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** The lowercase media type of a Content-Type value, parameters removed ("" when absent). */
export function bodyMediaType(contentType: string): string {
  const match = /^[ \t]*([^; \t]+)/.exec(contentType);
  return match ? asciiLower(match[1] ?? "") : "";
}

/** Whether `name` is a valid form_value argument (bytes): 1-256 bytes, no control characters. */
export function validFormName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_FORM_NAME_BYTES && !controlCharacter(name);
}

/**
 * Whether `path` is a valid json_value argument (bytes): 1-256 bytes without control characters,
 * 1-32 non-empty segments separated by ".".
 */
export function validJsonPath(path: string): boolean {
  if (path.length < 1 || path.length > MAX_JSON_PATH_BYTES || controlCharacter(path)) return false;
  const segments = path.split(".");
  return segments.length <= MAX_JSON_PATH_SEGMENTS && segments.every((s) => s !== "");
}

/** One pass of percent-decoding: %XX (either case) to a byte, "+" to a space. */
function urlDecode(value: string): string {
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

const isSpace = (c: string | undefined) => c === " " || c === "\t";

/**
 * Parameters of a header value from `start`: `name=value` pairs separated by ";", names
 * trimmed and ASCII-lowercased, values a token (up to ";", trailing spaces and tabs removed) or
 * a quoted string (a backslash takes the next byte as it is; an unterminated one runs to the
 * end; what follows it up to ";" is ignored). Pairs without "=" are skipped.
 */
export function headerParams(header: string, start: number): [string, string][] {
  const out: [string, string][] = [];
  let i = start;
  const n = header.length;
  while (i < n) {
    while (i < n && (isSpace(header[i]) || header[i] === ";")) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && header[i] !== "=" && header[i] !== ";") i++;
    const name = asciiLower(header.slice(nameStart, i).replace(/[ \t]+$/, ""));
    if (header[i] !== "=") continue;
    i++;
    while (i < n && isSpace(header[i])) i++;
    let value = "";
    if (header[i] === '"') {
      i++;
      while (i < n) {
        const c = header[i] as string;
        if (c === "\\" && i + 1 < n) {
          value += header[i + 1];
          i += 2;
        } else if (c === '"') {
          i++;
          break;
        } else {
          value += c;
          i++;
        }
      }
      while (i < n && header[i] !== ";") i++;
    } else {
      const valueStart = i;
      while (i < n && header[i] !== ";") i++;
      value = header.slice(valueStart, i).replace(/[ \t]+$/, "");
    }
    out.push([name, value]);
  }
  return out;
}

/** The boundary of a multipart Content-Type (1-70 bytes), or null. */
export function multipartBoundary(contentType: string): string | null {
  const semicolon = contentType.indexOf(";");
  if (semicolon < 0) return null;
  const param = headerParams(contentType, semicolon + 1).find(([name]) => name === "boundary");
  const boundary = param?.[1] ?? "";
  return boundary.length >= 1 && boundary.length <= 70 ? boundary : null;
}

/** What a multipart/form-data body holds: the first value of each field and the file names. */
export interface Multipart {
  fields: Map<string, string>;
  filenames: string[];
}

/**
 * Parses a multipart/form-data body: the first delimiter `--boundary` is at the start of the
 * body or after "\r\n"; after a delimiter comes "--" (the end) or optional spaces and tabs and
 * "\r\n"; a part's headers end at the first "\r\n\r\n" (none: "\r\n" right away), its body at
 * the next "\r\n--boundary". A part needs a Content-Disposition of type form-data: with a
 * `filename` parameter it is a file (its name, when not empty, goes to `filenames`), else a field
 * named by `name` (the first part of a name wins). Parsing stops at the first malformed part and
 * after 1000 parts, keeping what came before.
 */
export function parseMultipart(body: string, contentType: string): Multipart {
  const out: Multipart = { fields: new Map(), filenames: [] };
  const boundary = multipartBoundary(contentType);
  if (boundary === null) return out;
  const dash = `--${boundary}`;
  let pos: number;
  if (body.startsWith(dash)) pos = 0;
  else {
    const first = body.indexOf(`\r\n${dash}`);
    if (first < 0) return out;
    pos = first + 2;
  }
  for (let parts = 0; parts < MAX_MULTIPART_PARTS; parts++) {
    pos += dash.length;
    if (body.startsWith("--", pos)) break;
    while (isSpace(body[pos])) pos++;
    if (!body.startsWith("\r\n", pos)) break;
    pos += 2;
    let headers: string;
    let contentStart: number;
    if (body.startsWith("\r\n", pos)) {
      headers = "";
      contentStart = pos + 2;
    } else {
      const end = body.indexOf("\r\n\r\n", pos);
      if (end < 0) break;
      headers = body.slice(pos, end);
      contentStart = end + 4;
    }
    const next = body.indexOf(`\r\n${dash}`, contentStart);
    if (next < 0) break;
    part(headers, body.slice(contentStart, next), out);
    pos = next + 2;
  }
  return out;
}

function part(headers: string, content: string, out: Multipart): void {
  let disposition: string | undefined;
  for (const line of headers.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (
      asciiLower(line.slice(0, colon).replace(/^[ \t]+|[ \t]+$/g, "")) === "content-disposition"
    ) {
      disposition = line.slice(colon + 1);
      break;
    }
  }
  if (disposition === undefined) return;
  const semicolon = disposition.indexOf(";");
  const type = semicolon < 0 ? disposition : disposition.slice(0, semicolon);
  if (asciiLower(type.replace(/^[ \t]+|[ \t]+$/g, "")) !== "form-data") return;
  const params = semicolon < 0 ? [] : headerParams(disposition, semicolon + 1);
  const filename = params.find(([name]) => name === "filename");
  if (filename) {
    if (filename[1] !== "") out.filenames.push(filename[1]);
    return;
  }
  const name = params.find(([key]) => key === "name");
  if (name && !out.fields.has(name[1])) out.fields.set(name[1], content);
}

/**
 * form_value: the first value of the field `name` of a body: application/x-www-form-urlencoded
 * (elements separated by "&", empty ones skipped; the name is the text before the first "=",
 * all of it without one, the value then ""; both url-decoded once) or multipart/form-data
 * (fields, not files, as they are). "" for other types and absent fields.
 */
export function formValue(body: string, contentType: string, name: string): string {
  const media = bodyMediaType(contentType);
  if (media === "application/x-www-form-urlencoded") {
    for (const element of body.split("&")) {
      if (element === "") continue;
      const eq = element.indexOf("=");
      if (urlDecode(eq < 0 ? element : element.slice(0, eq)) === name)
        return eq < 0 ? "" : urlDecode(element.slice(eq + 1));
    }
    return "";
  }
  if (media === "multipart/form-data")
    return parseMultipart(body, contentType).fields.get(name) ?? "";
  return "";
}

/** http.request.body.filenames: the non-empty file names of a multipart body, joined by "\n". */
export function bodyFilenames(body: string, contentType: string): string {
  if (bodyMediaType(contentType) !== "multipart/form-data") return "";
  return parseMultipart(body, contentType).filenames.join("\n");
}

/** A parsed JSON value: strings as bytes, numbers as their text. */
export type JsonValue =
  | { t: "s"; v: string }
  | { t: "n"; v: string }
  | { t: "b"; v: boolean }
  | { t: "z" }
  | { t: "o"; m: Map<string, JsonValue> }
  | { t: "a"; items: JsonValue[] };

/** Whether a media type is JSON: application/json or a type ending in "+json". */
export function isJsonMediaType(media: string): boolean {
  return media === "application/json" || media.endsWith("+json");
}

/** UTF-8 bytes of a code point (U+FFFD for surrogates). */
function utf8(code: number): string {
  const c = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
  const bytes =
    c < 0x80
      ? [c]
      : c < 0x800
        ? [0xc0 | (c >> 6), 0x80 | (c & 0x3f)]
        : c < 0x10000
          ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)]
          : [
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 0x3f),
              0x80 | ((c >> 6) & 0x3f),
              0x80 | (c & 0x3f),
            ];
  return String.fromCharCode(...bytes);
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Parses a JSON text (RFC 8259) of bytes: whitespace is space, tab, "\n" and "\r"; no byte
 * order mark; at most 128 levels of nesting; strings may hold any byte but control characters
 * (\u escapes become UTF-8, surrogate pairs combined, lone surrogates U+FFFD); a key given
 * twice keeps its last value. Returns null for anything invalid.
 */
export function parseJson(text: string): JsonValue | null {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
  const string = (): string | null => {
    // text[i] is the opening quote.
    i++;
    let out = "";
    while (i < n) {
      const c = text[i] as string;
      const code = c.charCodeAt(0);
      if (code < 0x20) return null;
      if (c === '"') {
        i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = text[i + 1];
      if (e === undefined) return null;
      const simple = SIMPLE_ESCAPES[e];
      if (simple !== undefined) {
        out += simple;
        i += 2;
        continue;
      }
      if (e !== "u") return null;
      const hex = text.slice(i + 2, i + 6);
      if (!HEX4_RE.test(hex)) return null;
      const high = Number.parseInt(hex, 16);
      i += 6;
      if (high >= 0xd800 && high <= 0xdbff && text[i] === "\\" && text[i + 1] === "u") {
        const next = text.slice(i + 2, i + 6);
        const low = HEX4_RE.test(next) ? Number.parseInt(next, 16) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += utf8(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
          i += 6;
          continue;
        }
      }
      out += utf8(high);
    }
    return null;
  };
  const value = (depth: number): JsonValue | null => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth >= MAX_JSON_DEPTH) return null;
      i++;
      ws();
      if (c === "{") {
        const m = new Map<string, JsonValue>();
        if (text[i] === "}") {
          i++;
          return { t: "o", m };
        }
        for (;;) {
          ws();
          if (text[i] !== '"') return null;
          const key = string();
          if (key === null) return null;
          ws();
          if (text[i] !== ":") return null;
          i++;
          const v = value(depth + 1);
          if (v === null) return null;
          m.set(key, v);
          ws();
          if (text[i] === ",") {
            i++;
            continue;
          }
          if (text[i] === "}") {
            i++;
            return { t: "o", m };
          }
          return null;
        }
      }
      const items: JsonValue[] = [];
      if (text[i] === "]") {
        i++;
        return { t: "a", items };
      }
      for (;;) {
        const v = value(depth + 1);
        if (v === null) return null;
        items.push(v);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { t: "a", items };
        }
        return null;
      }
    }
    if (c === '"') {
      const s = string();
      return s === null ? null : { t: "s", v: s };
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      if (!m) return null;
      i += m[0].length;
      return { t: "n", v: m[0] };
    }
    for (const [word, v] of [
      ["true", { t: "b", v: true }],
      ["false", { t: "b", v: false }],
      ["null", { t: "z" }],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return null;
  };
  const result = value(0);
  if (result === null) return null;
  ws();
  return i === n ? result : null;
}

/**
 * json_value over a parsed document: the path's segments select object keys (bytes) and array
 * indexes (a canonical non-negative integer); strings come out as their bytes, numbers as their
 * text, booleans as "true" or "false"; null, objects, arrays and missing values as "".
 */
export function jsonPathValue(doc: JsonValue | null, path: string): string {
  let v: JsonValue | undefined = doc ?? undefined;
  for (const segment of path.split(".")) {
    if (v?.t === "o") v = v.m.get(segment);
    else if (v?.t === "a" && /^(0|[1-9][0-9]*)$/.test(segment)) v = v.items[Number(segment)];
    else return "";
  }
  if (v?.t === "s" || v?.t === "n") return v.v;
  if (v?.t === "b") return v.v ? "true" : "false";
  return "";
}

/** json_value: the value at `path` of a JSON body (see parseJson and jsonPathValue). */
export function jsonValue(body: string, contentType: string, path: string): string {
  if (!isJsonMediaType(bodyMediaType(contentType))) return "";
  return jsonPathValue(parseJson(body), path);
}
