import {
  type ExpressionErrorCode,
  type Phase,
  parseExpression,
  requestPhases,
} from "@edgeweir/rule-engine";
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

/**
 * Common conditions the editor's template menu appends. Request fields: every phase has them,
 * except the request body and crawler fields (REQUEST_PHASE_TEMPLATES).
 */
export const CONDITION_TEMPLATES = {
  path_prefix: 'http.request.uri.path matches "^/admin/"',
  host: 'http.host eq "www.example.com"',
  extension: 'http.request.uri.path.extension in {"php"}',
  ip_range: "ip.src in {192.0.2.0/24}",
  country: 'ip.geoip.country in {"CN"}',
  asn: "ip.geoip.asnum in {64496}",
  user_agent: 'http.request.headers["user-agent"] contains "bot"',
  method: 'http.request.method in {"POST" "PUT" "DELETE"}',
  // rules-v3
  cookie: 'http.request.cookies["session"] eq "value"',
  arg: 'http.request.uri.args["page"] eq "1"',
  user_agent_wildcard: 'http.user_agent wildcard "*bot*"',
  referer_wildcard: 'http.referer wildcard "*://*.example.com/*"',
  // rules-body-v1
  form_value: 'form_value("username") eq "admin"',
  json_value: 'json_value("user.role") eq "admin"',
  body_contains: 'http.request.body.raw contains "<script"',
  upload_name: 'http.request.body.filenames contains ".php"',
  // challenge-v2
  verified_bot: "http.request.bot.verified eq true",
} as const;
export type ConditionTemplate = keyof typeof CONDITION_TEMPLATES;
/** Templates only nodes with rules-v3 run; the menu leaves them out while the cluster lacks it. */
export const RULES_V3_TEMPLATES: ReadonlySet<ConditionTemplate> = new Set([
  "cookie",
  "arg",
  "user_agent_wildcard",
  "referer_wildcard",
]);

/** Templates that read the request body: only nodes with rules-body-v1 run them. */
export const RULES_BODY_TEMPLATES: ReadonlySet<ConditionTemplate> = new Set([
  "form_value",
  "json_value",
  "body_contains",
  "upload_name",
]);
/** Templates that read the verified crawler fields: only nodes with challenge-v2 run them. */
export const BOT_TEMPLATES: ReadonlySet<ConditionTemplate> = new Set(["verified_bot"]);
/** Templates the request phases alone accept (requestPhases of the rule engine). */
export const REQUEST_PHASE_TEMPLATES: ReadonlySet<ConditionTemplate> = new Set([
  ...RULES_BODY_TEMPLATES,
  ...BOT_TEMPLATES,
]);

/** Whether the template menu offers `template` in `phase`. */
export const templateInPhase = (template: ConditionTemplate, phase: Phase) =>
  !REQUEST_PHASE_TEMPLATES.has(template) || requestPhases.has(phase);

/** The example value of each template: selected once inserted, so typing replaces it. */
export const TEMPLATE_VALUES: Record<ConditionTemplate, string> = {
  path_prefix: "^/admin/",
  host: "www.example.com",
  extension: "php",
  ip_range: "192.0.2.0/24",
  country: "CN",
  asn: "64496",
  user_agent: "bot",
  method: 'POST" "PUT" "DELETE',
  cookie: "session",
  arg: "page",
  user_agent_wildcard: "*bot*",
  referer_wildcard: "*://*.example.com/*",
  form_value: "username",
  json_value: "user.role",
  body_contains: "<script",
  upload_name: ".php",
  verified_bot: "",
};

export const conditionTemplateLabel = (template: ConditionTemplate) =>
  ({
    path_prefix: m.rules_template_path_prefix,
    host: m.rules_template_host,
    extension: m.rules_template_extension,
    ip_range: m.rules_template_ip_range,
    country: m.rules_template_country,
    asn: m.rules_template_asn,
    user_agent: m.rules_template_user_agent,
    method: m.rules_template_method,
    cookie: m.rules_template_cookie,
    arg: m.rules_template_arg,
    user_agent_wildcard: m.rules_template_user_agent_wildcard,
    referer_wildcard: m.rules_template_referer_wildcard,
    form_value: m.rules_template_form_value,
    json_value: m.rules_template_json_value,
    body_contains: m.rules_template_body_contains,
    upload_name: m.rules_template_upload_name,
    verified_bot: m.rules_template_verified_bot,
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

/**
 * `source` with `condition` appended (appendCondition) and the range to select afterwards: the
 * condition's `value`, or the end when it has none.
 */
export function insertCondition(
  source: string,
  condition: string,
  phase: Phase,
  value?: string,
): { source: string; selection: [number, number] } {
  const next = appendCondition(source, condition, phase);
  // appendCondition always ends with the condition.
  const at = value ? condition.indexOf(value) : -1;
  if (!value || at < 0) return { source: next, selection: [next.length, next.length] };
  const start = next.length - condition.length + at;
  return { source: next, selection: [start, start + value.length] };
}
