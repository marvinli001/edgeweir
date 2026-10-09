import {
  ARG_FIELD,
  ARG_NAME_RE,
  bodyFields,
  botFields,
  COOKIE_FIELD,
  COOKIE_NAME_RE,
  ExpressionError,
  fields,
  functions,
  type Phase,
  parseExpression,
  parseValueExpression,
  requestPhases,
  responsePhases,
  rulesV3Fields,
} from "@edgeweir/rule-engine";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { OptionSelect } from "@/components/form-select";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  BOT_TEMPLATES,
  CONDITION_TEMPLATES,
  type ConditionTemplate,
  conditionTemplateLabel,
  type ExpressionFailure,
  expressionErrorText,
  insertCondition,
  RULES_BODY_TEMPLATES,
  RULES_V3_TEMPLATES,
  TEMPLATE_VALUES,
  templateInPhase,
} from "@/lib/expressions";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

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
  "wildcard",
  "strict",
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

/** Select values of the template menu's IP list entries ("$" + list name). */
const LIST_PREFIX = "$";

/**
 * Fields read by name: a cookie and a query parameter (rules-v3) and a request header. The field
 * menu offers them first (select value "@" + kind); a name field then inserts the field.
 */
const NAMED_FIELDS = {
  cookie: {
    field: COOKIE_FIELD,
    re: COOKIE_NAME_RE,
    label: () => m.rules_field_cookie(),
    v3: true,
  },
  arg: { field: ARG_FIELD, re: ARG_NAME_RE, label: () => m.rules_field_arg(), v3: true },
  header: {
    field: "http.request.headers",
    re: /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/,
    label: () => m.rules_field_header(),
    v3: false,
  },
} as const;
type NamedField = keyof typeof NAMED_FIELDS;
const NAMED_PREFIX = "@";

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
  hideRulesV3 = false,
  hideRulesBody = false,
  hideBotFields = false,
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
  /** Leave the rules-v3 fields and templates out of the menus (the cluster's nodes lack it). */
  hideRulesV3?: boolean;
  /** Leave the request body fields and templates out (no rules-body-v1 on the nodes). */
  hideRulesBody?: boolean;
  /** Leave the verified crawler fields and templates out (no challenge-v2 on the nodes). */
  hideBotFields?: boolean;
}) {
  // The field read by name being inserted, and its name so far.
  const [named, setNamed] = React.useState<NamedField | null>(null);
  const [name, setName] = React.useState("");
  const nameInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!named) return;
    // After the field menu has closed and handed focus back to its trigger.
    const frame = requestAnimationFrame(() => nameInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [named]);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  // The range to select once an inserted template is rendered (its example value).
  const selection = React.useRef<{ source: string; range: [number, number] } | null>(null);
  React.useEffect(() => {
    const pending = selection.current;
    if (!pending || pending.source !== value) return;
    selection.current = null;
    // After the template menu has closed and handed focus back to its trigger.
    const frame = requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(...pending.range);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  const failure = expressionFailure(value, phase, kind);
  const position = failure?.position ?? null;
  const lists = useQuery({ ...orpc.ipLists.list.queryOptions(), enabled: kind === "condition" });
  const tokens = value.split(TOKENS);
  let offset = 0;
  // Cache rule conditions are judged in the phase cache.
  const fieldPhase = kind === "cacheRule" ? "cache" : phase;
  const available = Object.keys(fields).filter(
    (field) =>
      (!field.startsWith("http.response.") || responsePhases.has(fieldPhase)) &&
      // The request body and crawler fields: the request phases only.
      (!(bodyFields.has(field) || botFields.has(field)) || requestPhases.has(fieldPhase)) &&
      // A value is a string: string fields only.
      (kind !== "value" || fields[field] === "string") &&
      !(hideRulesV3 && rulesV3Fields.has(field)) &&
      !(hideRulesBody && bodyFields.has(field)) &&
      !(hideBotFields && botFields.has(field)),
  );
  const namedKinds = (Object.keys(NAMED_FIELDS) as NamedField[]).filter(
    (key) => !(hideRulesV3 && NAMED_FIELDS[key].v3),
  );
  const insert = (field: string) => {
    if (kind === "value") {
      const at = textarea.current?.selectionStart ?? value.length;
      onChange(`${value.slice(0, at)}${field}${value.slice(at)}`);
    } else onChange(`${value.trimEnd()}${value.trim() ? " and " : ""}${field} `);
  };
  const namedField = named ? NAMED_FIELDS[named] : null;
  const insertNamed = () => {
    if (!namedField?.re.test(name)) return;
    insert(`${namedField.field}[${JSON.stringify(name)}]`);
    setNamed(null);
  };
  return (
    <Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {kind === "condition" ? (
            <OptionSelect
              value={null}
              options={[
                ...(Object.keys(CONDITION_TEMPLATES) as ConditionTemplate[])
                  .filter(
                    (template) =>
                      templateInPhase(template, phase) &&
                      !(hideRulesV3 && RULES_V3_TEMPLATES.has(template)) &&
                      !(hideRulesBody && RULES_BODY_TEMPLATES.has(template)) &&
                      !(hideBotFields && BOT_TEMPLATES.has(template)),
                  )
                  .map((template) => ({
                    value: template,
                    label: conditionTemplateLabel(template),
                  })),
                ...(lists.data ?? []).map((list) => ({
                  value: `${LIST_PREFIX}${list.name}`,
                  label: m.rules_template_ip_list({ name: list.name }),
                })),
              ]}
              onChange={(choice) => {
                const inserted = choice.startsWith(LIST_PREFIX)
                  ? insertCondition(value, `ip.src in ${choice}`, phase)
                  : insertCondition(
                      value,
                      CONDITION_TEMPLATES[choice as ConditionTemplate],
                      phase,
                      TEMPLATE_VALUES[choice as ConditionTemplate],
                    );
                selection.current = { source: inserted.source, range: inserted.selection };
                onChange(inserted.source);
              }}
              placeholder={m.rules_insert_condition()}
              label={m.rules_insert_condition()}
              size="sm"
              className="w-fit"
              testId={`${id}-template`}
            />
          ) : null}
          <OptionSelect
            value={null}
            options={[
              ...namedKinds.map((key) => ({
                value: `${NAMED_PREFIX}${key}`,
                label: NAMED_FIELDS[key].label(),
              })),
              ...available.map((field) => ({ value: field, label: field })),
            ]}
            onChange={(choice) => {
              if (!choice.startsWith(NAMED_PREFIX)) return insert(choice);
              setNamed(choice.slice(NAMED_PREFIX.length) as NamedField);
              setName("");
            }}
            placeholder={m.rules_insert_field()}
            label={m.rules_insert_field()}
            size="sm"
            className="w-fit"
            testId={`${id}-field`}
          />
        </div>
      </div>
      {namedField ? (
        <div
          className="flex flex-wrap items-center gap-2 animate-in fade-in"
          data-testid={`${id}-named`}
        >
          <span className="text-xs text-muted-foreground">{namedField.label()}</span>
          <Input
            ref={nameInput}
            aria-label={m.rules_field_name()}
            value={name}
            maxLength={64}
            aria-invalid={(name !== "" && !namedField.re.test(name)) || undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Enter inserts the field instead of submitting the rule form.
                e.preventDefault();
                insertNamed();
              } else if (e.key === "Escape") setNamed(null);
            }}
            className="h-8 w-48 font-mono"
            data-testid={`${id}-named-name`}
          />
          <Button
            type="button"
            size="sm"
            disabled={!namedField.re.test(name)}
            onClick={insertNamed}
            data-testid={`${id}-named-insert`}
          >
            {m.rules_field_insert()}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNamed(null)}>
            {m.common_cancel()}
          </Button>
        </div>
      ) : null}
      {/* A sunk editor: the highlighted source under a transparent textarea, in an input well. */}
      <div
        className={cn(
          "relative rounded-2xl border border-transparent input-well font-mono text-sm leading-6 transition-[color,box-shadow] duration-200 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
          kind === "value" ? "min-h-16" : "min-h-24",
        )}
      >
        <pre aria-hidden className="pointer-events-none whitespace-pre-wrap break-all p-3">
          {tokens.filter(Boolean).map((token) => {
            const start = offset;
            offset += token.length;
            // Text-strength token colors (4.5:1 on the well in both themes).
            const color = token.startsWith('"')
              ? "text-delta-good"
              : KEYWORD_SET.has(token)
                ? "text-primary-ink"
                : FUNCTION_SET.has(token)
                  ? "text-chart-4 dark:text-chart-2"
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
