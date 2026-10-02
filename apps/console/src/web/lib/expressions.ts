import { type ExpressionErrorCode, type Phase, parseExpression } from "@edgeweir/rule-engine";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

type MessageFn = (params?: Record<string, string | number>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

/** An expression the parser refused: its code, source offset and the values its text names. */
export interface ExpressionFailure {
  code: ExpressionErrorCode;
  position: number;
  params: Readonly<Record<string, string>>;
}

/** Why the parser refused an expression, localized (`rules_expr_<code>`). */
export function expressionReason(failure: Pick<ExpressionFailure, "code" | "params">): string {
  const fn = messages[`rules_expr_${failure.code}`];
  return fn ? fn({ ...failure.params }) : failure.code;
}

/** "Character N: reason", N counted from 1. */
export function expressionErrorText(failure: ExpressionFailure): string {
  return m.rules_expression_error({
    position: failure.position + 1,
    reason: expressionReason(failure),
  });
}

/** Common conditions the editor's template menu appends (request fields: every phase has them). */
export const CONDITION_TEMPLATES = {
  path_prefix: 'http.request.uri.path matches "^/admin/"',
  ip_range: "ip.src in {192.0.2.0/24}",
  country: 'ip.geoip.country in {"CN"}',
  user_agent: 'http.request.headers["user-agent"] contains "bot"',
  method: 'http.request.method in {"POST" "PUT" "DELETE"}',
} as const;
export type ConditionTemplate = keyof typeof CONDITION_TEMPLATES;

export const conditionTemplateLabel = (template: ConditionTemplate) =>
  ({
    path_prefix: m.rules_template_path_prefix,
    ip_range: m.rules_template_ip_range,
    country: m.rules_template_country,
    user_agent: m.rules_template_user_agent,
    method: m.rules_template_method,
  })[template]();

/**
 * `source` and `condition` joined with "and": an empty source or a lone `true` (a new rule) is
 * replaced, and a source whose top level is an "or" is parenthesized first so the condition
 * applies to all of it.
 */
export function appendCondition(source: string, condition: string, phase: Phase): string {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed === "true") return condition;
  let grouped = trimmed;
  try {
    if (parseExpression(trimmed, phase).op === "or") grouped = `(${trimmed})`;
  } catch {
    // An expression being edited is appended to as it is.
  }
  return `${grouped} and ${condition}`;
}
