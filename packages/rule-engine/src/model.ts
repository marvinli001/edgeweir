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
/**
 * Why an expression is refused: stable codes the console localizes, the parameters their
 * messages interpolate and the English text (the error's `message`).
 */
export const expressionErrorDefs = {
  too_long: { params: ["max"], en: "expression is too long" },
  string_invalid: { params: [], en: "invalid quoted string" },
  unexpected_character: { params: [], en: "unexpected character" },
  too_many_tokens: { params: ["max"], en: "too many tokens" },
  unexpected_end: { params: [], en: "unexpected end of expression" },
  unexpected_token: { params: [], en: "unexpected token" },
  expected_token: { params: ["token"], en: "expected {token}" },
  too_complex: { params: [], en: "expression is too complex" },
  expected_string: { params: [], en: "expected quoted string" },
  expected_integer: { params: [], en: "expected integer" },
  expected_boolean: { params: [], en: "expected boolean" },
  expected_ip: { params: [], en: "expected IP address or CIDR" },
  header_name: { params: [], en: "invalid header name" },
  cookie_name: { params: [], en: "invalid cookie name" },
  argument_name: { params: [], en: "invalid query parameter name" },
  unknown_field: { params: [], en: "unknown field" },
  response_field: { params: [], en: "response field is unavailable in this phase" },
  request_field: {
    params: [],
    en: "request body and crawler fields are only available in the request phases",
  },
  form_name: { params: [], en: "invalid form field name" },
  json_path: { params: [], en: "invalid JSON path" },
  unknown_operator: { params: [], en: "unknown operator" },
  ordered_comparison: { params: [], en: "ordered comparison needs integers" },
  string_operator: { params: [], en: "operator needs a string field" },
  list_reference: { params: [], en: "invalid named IP list" },
  unknown_list: { params: ["list"], en: "unknown IP list {list}" },
  set_empty: { params: [], en: "empty set" },
  set_too_large: { params: ["max"], en: "set is too large" },
  unknown_function: { params: [], en: "unknown function" },
  value_only_function: { params: [], en: "function is only available in value expressions" },
  function_repeated: { params: [], en: "function may appear once per expression" },
  functions_too_deep: { params: [], en: "functions are nested too deeply" },
  too_many_arguments: { params: [], en: "too many arguments" },
  too_few_arguments: { params: [], en: "too few arguments" },
  argument_not_string: { params: [], en: "argument must be a string" },
  literal_argument: { params: [], en: "this argument must be a quoted string" },
  integer_argument: {
    params: ["min", "max"],
    en: "this argument must be an integer from {min} to {max}",
  },
  flags: { params: [], en: 'the only flag is "s"' },
  value_not_string: { params: [], en: "value expressions must be strings" },
  value_too_long: { params: ["max"], en: "value is too long" },
  regex_too_long: { params: ["max"], en: "regular expression is too long" },
  regex_ascii: { params: [], en: "regular expressions accept printable ASCII only" },
  regex_escape: { params: [], en: "unsupported escape in regular expression" },
  regex_group: { params: [], en: "unsupported group" },
  regex_parenthesis: { params: [], en: "unbalanced parenthesis" },
  regex_nothing_to_repeat: { params: [], en: "nothing to repeat" },
  regex_repetition: { params: [], en: "unsupported repetition" },
  regex_brackets: { params: [], en: "escape literal brackets and braces" },
  regex_class_unterminated: { params: [], en: "unterminated character class" },
  regex_class_empty: { params: [], en: "empty character class" },
  regex_class_range: { params: [], en: "invalid character class range" },
  regex_class_dash: { params: [], en: "escape - inside a character class" },
  regex_class_bracket: { params: [], en: "escape [ inside a character class" },
  regex_class_posix: { params: [], en: "character class reads as a POSIX class" },
  wildcard_too_long: { params: ["max"], en: "wildcard pattern is too long" },
  wildcard_invalid: { params: [], en: "invalid wildcard pattern" },
  wildcard_escape: { params: [], en: "escape only * and \\ in wildcard patterns" },
  wildcard_too_many: { params: ["max"], en: "too many wildcards" },
  replacement_invalid: { params: [], en: "invalid replacement" },
  replacement_capture: { params: [], en: "replacement references a missing capture" },
} as const satisfies Record<string, { params: readonly string[]; en: string }>;
export type ExpressionErrorCode = keyof typeof expressionErrorDefs;
export const expressionErrorCodes = Object.keys(expressionErrorDefs) as ExpressionErrorCode[];
export type ExpressionErrorParams = Readonly<Record<string, string>>;

// Fields are declared explicitly (no parameter properties) so that Node runs this file with
// its built-in type stripping (scripts/vectors.mjs).
export class ExpressionError extends Error {
  readonly code: ExpressionErrorCode;
  /** Offset in the source (a character index) where the expression stops making sense. */
  readonly position: number;
  /** The values the code's message interpolates (expressionErrorDefs[code].params). */
  readonly params: ExpressionErrorParams;
  constructor(code: ExpressionErrorCode, position: number, params: ExpressionErrorParams = {}) {
    super(
      expressionErrorDefs[code].en.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? ""),
    );
    this.code = code;
    this.position = position;
    this.params = params;
    this.name = "ExpressionError";
  }
  /** The same error at another position (e.g. a literal's error placed in the whole source). */
  at(position: number): ExpressionError {
    return new ExpressionError(this.code, position, this.params);
  }
}
