import {
  ExpressionError,
  fields,
  functions,
  type Phase,
  parseExpression,
  parseValueExpression,
  responsePhases,
} from "@edgeweir/rule-engine";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ExpressionFailure, expressionErrorText } from "@/lib/expressions";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * What an expression is: a rule condition, a redirect target or rewrite path computed per
 * request (value), or a cache rule condition (phase cache, longer).
 */
export type ExpressionKind = "condition" | "value" | "cacheRule";

/** Longest source of each kind (characters). */
const MAX_LENGTH: Record<ExpressionKind, number> = {
  condition: 4096,
  value: 4096,
  cacheRule: 16384,
};

const KEYWORDS = [
  "and",
  "or",
  "not",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "contains",
  "matches",
  "in",
  "true",
  "false",
];
const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const FUNCTION_SET: ReadonlySet<string> = new Set(Object.keys(functions));
/** String literals, keywords, function names and list references, captured for highlighting. */
const TOKENS = new RegExp(
  String.raw`("(?:\\.|[^"\\])*"|\b(?:${[...KEYWORDS, ...FUNCTION_SET].join("|")})\b|\$\w+)`,
  "g",
);

/**
 * Why and where the expression fails to parse (the same parser the server validates with), or
 * null. Cache rule conditions are checked in the phase cache.
 */
export function expressionFailure(
  source: string,
  phase: Phase,
  kind: ExpressionKind,
): ExpressionFailure | null {
  try {
    if (kind === "value") parseValueExpression(source, phase);
    else if (kind === "cacheRule")
      parseExpression(source, "cache", { maxLength: MAX_LENGTH.cacheRule });
    else parseExpression(source, phase);
    return null;
  } catch (err) {
    return err instanceof ExpressionError
      ? { code: err.code, position: err.position, params: err.params }
      : { code: "unexpected_token", position: 0, params: {} };
  }
}

/** Common conditions the template menu appends (request fields: every phase has them). */
const TEMPLATES = {
  path_prefix: 'http.request.uri.path matches "^/admin/"',
  ip_range: "ip.src in {192.0.2.0/24}",
  country: 'ip.geoip.country in {"CN"}',
  user_agent: 'http.request.headers["user-agent"] contains "bot"',
  method: 'http.request.method in {"POST" "PUT" "DELETE"}',
} as const;
type Template = keyof typeof TEMPLATES;
const templateLabel = (template: Template) =>
  ({
    path_prefix: m.rules_template_path_prefix,
    ip_range: m.rules_template_ip_range,
    country: m.rules_template_country,
    user_agent: m.rules_template_user_agent,
    method: m.rules_template_method,
  })[template]();
/** Select values of the template menu's IP list entries ("$" + list name). */
const LIST_PREFIX = "$";

/**
 * A highlighted expression editor that marks the first character the parser refuses. Conditions
 * append inserted fields and templates with "and"; values insert fields at the caret.
 */
export function ExpressionEditor({
  id,
  label,
  value,
  phase,
  kind = "condition",
  onChange,
  actions,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  phase: Phase;
  kind?: ExpressionKind;
  onChange: (value: string) => void;
  /** Controls shown beside the label, before the field picker. */
  actions?: React.ReactNode;
  testId?: string;
}) {
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const failure = expressionFailure(value, phase, kind);
  const position = failure?.position ?? null;
  const lists = useQuery({ ...orpc.ipLists.list.queryOptions(), enabled: kind === "condition" });
  const tokens = value.split(TOKENS);
  let offset = 0;
  const available = Object.keys(fields).filter(
    (field) =>
      (!field.startsWith("http.response.") || responsePhases.has(phase)) &&
      // A value is a string: string fields only.
      (kind !== "value" || fields[field] === "string"),
  );
  const insert = (field: string) => {
    if (kind === "value") {
      const at = textarea.current?.selectionStart ?? value.length;
      onChange(`${value.slice(0, at)}${field}${value.slice(at)}`);
    } else onChange(`${value.trimEnd()}${value.trim() ? " and " : ""}${field} `);
  };
  /** Appends a condition with "and"; a lone `true` (a new rule) is replaced. */
  const append = (condition: string) =>
    onChange(
      value.trim() === "" || value.trim() === "true"
        ? condition
        : `${value.trimEnd()} and ${condition}`,
    );
  return (
    <Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {kind === "condition" ? (
            <Select
              value={null}
              onValueChange={(choice: string | null) => {
                if (!choice) return;
                append(
                  choice.startsWith(LIST_PREFIX)
                    ? `ip.src in ${choice}`
                    : TEMPLATES[choice as Template],
                );
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={m.rules_insert_condition()}
                data-testid={`${id}-template`}
              >
                <SelectValue placeholder={m.rules_insert_condition()} />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TEMPLATES) as Template[]).map((template) => (
                  <SelectItem key={template} value={template}>
                    {templateLabel(template)}
                  </SelectItem>
                ))}
                {(lists.data ?? []).map((list) => (
                  <SelectItem key={list.id} value={`${LIST_PREFIX}${list.name}`}>
                    {m.rules_template_ip_list({ name: list.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select
            value={null}
            onValueChange={(field) => {
              if (field) insert(field);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={m.rules_insert_field()}
              data-testid={`${id}-field`}
            >
              <SelectValue placeholder={m.rules_insert_field()} />
            </SelectTrigger>
            <SelectContent>
              {available.map((field) => (
                <SelectItem key={field} value={field}>
                  {field}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div
        className={
          kind === "value"
            ? "relative min-h-16 rounded-lg border bg-background font-mono text-sm leading-6 focus-within:ring-2 focus-within:ring-ring"
            : "relative min-h-24 rounded-lg border bg-background font-mono text-sm leading-6 focus-within:ring-2 focus-within:ring-ring"
        }
      >
        <pre aria-hidden className="pointer-events-none whitespace-pre-wrap break-all p-3">
          {tokens.filter(Boolean).map((token) => {
            const start = offset;
            offset += token.length;
            const color = token.startsWith('"')
              ? "text-state-good"
              : KEYWORD_SET.has(token)
                ? "text-primary"
                : FUNCTION_SET.has(token)
                  ? "text-chart-2"
                  : "text-foreground";
            return (
              <span key={start} className={color}>
                {position !== null && position >= start && position < offset ? (
                  <>
                    {token.slice(0, position - start)}
                    <mark className="bg-destructive/20 text-destructive underline">
                      {token[position - start]}
                    </mark>
                    {token.slice(position - start + 1)}
                  </>
                ) : (
                  token
                )}
              </span>
            );
          })}
          {"\n"}
        </pre>
        <textarea
          ref={textarea}
          id={id}
          value={value}
          maxLength={MAX_LENGTH[kind]}
          spellCheck={false}
          aria-invalid={position !== null}
          aria-describedby={position !== null ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full resize-none whitespace-pre-wrap break-all bg-transparent p-3 text-transparent caret-foreground outline-none"
          data-testid={testId}
        />
      </div>
      {failure ? (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {expressionErrorText(failure)}
        </p>
      ) : null}
    </Field>
  );
}
