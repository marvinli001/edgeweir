import { MAX_HEADER_VALUE_BYTES } from "./actions.ts";
import { bodyFilenames, formValue, jsonValue } from "./body.ts";
import {
  asciiLower,
  asciiUpper,
  base64DecodeBytes,
  base64EncodeBytes,
  fromBytes,
  regexReplaceBytes,
  substringBytes,
  toBytes,
  urlDecodeBytes,
  urlEncodeBytes,
  wildcardMatchBytes,
  wildcardReplaceBytes,
} from "./bytes.ts";
import { md5Hex, sha1Hex, sha256Hex } from "./digest.ts";
import { ipMatches } from "./ip.ts";
import { controlCharacter, MAX_VALUE_BYTES } from "./language.ts";
import { type Expression, ExpressionError } from "./model.ts";
import { compilePattern } from "./patterns.ts";

type Request = Record<string, string | number | boolean>;

const BODY_RAW = "http.request.body.raw";
const CONTENT_TYPE = "http.request.headers.content-type";
const bodyOf = (request: Request) => [
  toBytes(String(request[BODY_RAW] ?? "")),
  toBytes(String(request[CONTENT_TYPE] ?? "")),
];

function fieldValue(field: string, type: string, request: Request): string | number | boolean {
  // Derived from the body like the node does, unless the request names it.
  if (field === "http.request.body.filenames" && request[field] === undefined) {
    const [body = "", contentType = ""] = bodyOf(request);
    return bodyFilenames(body, contentType);
  }
  const actual = request[field];
  if (actual === undefined) return type === "number" ? 0 : type === "boolean" ? false : "";
  return typeof actual === "string" ? toBytes(actual) : actual;
}

function evaluateNode(e: Expression, request: Request): string | number | boolean {
  if (e.op === "field") return fieldValue(e.field, e.valueType, request);
  if (e.op === "const") return e.valueType === "number" ? Number(e.value) : toBytes(e.value);
  if (e.field === "to_string") {
    const v = evaluateNode(e.children[0] as Expression, request);
    return typeof v === "string" ? v : String(v);
  }
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
    case "url_encode":
      result = urlEncodeBytes(a);
      break;
    case "base64_encode":
      result = base64EncodeBytes(a);
      break;
    case "base64_decode":
      result = base64DecodeBytes(a);
      break;
    case "md5":
      result = md5Hex(a);
      break;
    case "sha1":
      result = sha1Hex(a);
      break;
    case "sha256":
      result = sha256Hex(a);
      break;
    case "substring":
      result = substringBytes(a, Number(b), e.children[2] ? Number(c) : undefined);
      break;
    // rules-body-v1: like reading a field, not bounded by MAX_VALUE_BYTES.
    case "form_value": {
      const [body = "", contentType = ""] = bodyOf(request);
      return formValue(body, contentType, a);
    }
    case "json_value": {
      const [body = "", contentType = ""] = bodyOf(request);
      return jsonValue(body, contentType, a);
    }
    default:
      throw new ExpressionError("unknown_function", 0);
  }
  if (typeof result === "string" && result.length > MAX_VALUE_BYTES)
    throw new ExpressionError("value_too_long", 0, { max: String(MAX_VALUE_BYTES) });
  return result;
}

/** Evaluates a value expression to the string the node computes (UTF-8 decoded). */
export function evaluateValue(expression: Expression, request: Request): string {
  return fromBytes(String(evaluateNode(expression, request)));
}

/**
 * The value a header action with a value expression sets (rules-v3), UTF-8 decoded, or null
 * when the node skips the action: the evaluation fails or the value has more than 4096 bytes
 * or a control character.
 */
export function evaluateHeaderValue(expression: Expression, request: Request): string | null {
  let value: string;
  try {
    value = String(evaluateNode(expression, request));
  } catch {
    return null;
  }
  if (value.length > MAX_HEADER_VALUE_BYTES || controlCharacter(value)) return null;
  return fromBytes(value);
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
  if (e.op === "wildcard" || e.op === "strict_wildcard")
    return wildcardMatchBytes(String(actual), toBytes(e.value), e.op === "strict_wildcard");
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
