import { staticRedirectTarget } from "@edgeweir/contract";
import { type Phase, QUERY_NAME_RE } from "@edgeweir/rule-engine";
import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { OptionSelect } from "@/components/form-select";
import { ExpressionEditor, expressionFailure } from "@/components/site/expression-editor";
import { ListInput, SwitchField } from "@/components/site/fields";
import { literalText, StatusSelect } from "@/components/site/rules/fields/common";
import { nextDraftKey } from "@/components/site/save-site";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { expressionErrorText } from "@/lib/expressions";
import { m } from "@/lib/i18n";
import type { ActionOf } from "@/lib/rule-actions";

type HeaderAction = ActionOf<"request_header"> | ActionOf<"response_header">;

/** Static or expression: which way a value is written (a header's value, a query parameter's). */
function ValueModeTabs({
  mode,
  onChange,
  expressionDisabled,
  testId,
}: {
  mode: "static" | "expression";
  onChange: (mode: "static" | "expression") => void;
  expressionDisabled: boolean;
  testId: string;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        if (next !== mode) onChange(next as "static" | "expression");
      }}
    >
      <TabsList aria-label={m.rules_value_mode()}>
        <TabsTrigger value="static" className="h-7 px-2.5 text-xs" data-testid={`${testId}-static`}>
          {m.rules_target_static()}
        </TabsTrigger>
        <TabsTrigger
          value="expression"
          className="h-7 px-2.5 text-xs"
          disabled={expressionDisabled && mode === "static"}
          data-testid={`${testId}-expression`}
        >
          {m.rules_target_expression()}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * A request or response header rule: its name, its value (static or, with rules-v3, computed
 * per request), removal and, for response headers, whether the value is added as another line.
 */
export function HeaderFields({
  id,
  phase,
  action: a,
  lockedV3,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: HeaderAction;
  lockedV3: boolean;
  onChange: (action: HeaderAction) => void;
}) {
  const [mode, setMode] = React.useState<"static" | "expression">(
    a.expression !== "" ? "expression" : "static",
  );
  // What the other mode held, so switching back and forth loses nothing.
  const stash = React.useRef({ value: a.value, expression: a.expression });
  const set = (change: Partial<HeaderAction>) => onChange({ ...a, ...change } as HeaderAction);
  const tabs = (
    <ValueModeTabs
      mode={mode}
      expressionDisabled={lockedV3}
      testId="rule-header-value"
      onChange={(next) => {
        if (next === "expression") {
          stash.current.value = a.value;
          set({
            value: "",
            expression:
              stash.current.expression || (a.value ? JSON.stringify(a.value) : "http.request.id"),
          });
        } else {
          stash.current.expression = a.expression;
          set({ expression: "", value: stash.current.value || literalText(a.expression) });
        }
        setMode(next);
      }}
    />
  );
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`header-${id}`}>{m.rules_header()}</FieldLabel>
        <Input
          id={`header-${id}`}
          value={a.header}
          onChange={(e) => set({ header: e.target.value })}
          data-testid="rule-header-name"
        />
      </Field>
      <SwitchField
        id={`remove-${id}`}
        label={m.rules_remove_header()}
        checked={a.remove}
        // A removed header has no value to set or add.
        onCheckedChange={(remove) =>
          set(
            remove
              ? {
                  remove,
                  value: "",
                  expression: "",
                  ...(a.kind === "response_header" ? { append: false } : {}),
                }
              : { remove },
          )
        }
        testId="rule-header-remove"
      />
      {a.remove ? null : (
        <div className="sm:col-span-2">
          {mode === "expression" ? (
            <ExpressionEditor
              id={`value-${id}`}
              label={m.rules_value()}
              value={a.expression}
              phase={phase}
              kind="value"
              onChange={(expression) => set({ expression })}
              actions={tabs}
              testId="rule-header-value"
              hideRulesV3={lockedV3}
            />
          ) : (
            <Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor={`value-${id}`}>{m.rules_value()}</FieldLabel>
                {tabs}
              </div>
              <Input
                id={`value-${id}`}
                value={a.value}
                maxLength={4096}
                onChange={(e) => set({ value: e.target.value })}
                data-testid="rule-header-value"
              />
            </Field>
          )}
        </div>
      )}
      {a.kind === "response_header" && !a.remove ? (
        <SwitchField
          id={`append-${id}`}
          label={m.rules_append_header()}
          checked={a.append}
          disabled={lockedV3 && !a.append}
          onCheckedChange={(append) => set({ append })}
          testId="rule-header-append"
        />
      ) : null}
    </>
  );
}

type TargetAction = ActionOf<"redirect"> | ActionOf<"rewrite">;
/** A static rewrite path: a single leading "/", no query, fragment or backslash. */
const staticRewritePath = (s: string) =>
  s.startsWith("/") && !s.startsWith("//") && !/[?\\#]/.test(s);
/**
 * Where a redirect or rewrite goes: a static value or a value expression computed per request,
 * then what happens to the query string.
 */
export function TargetFields({
  id,
  phase,
  action: a,
  locked,
  lockedV3,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: TargetAction;
  locked: boolean;
  lockedV3: boolean;
  onChange: (action: TargetAction) => void;
}) {
  const [mode, setMode] = React.useState<"static" | "expression">(
    a.target !== "" ? "expression" : "static",
  );
  // What the other mode held, so switching back and forth loses nothing.
  const stash = React.useRef({ value: a.value, target: a.target });
  const set = (change: Partial<TargetAction>) => onChange({ ...a, ...change } as TargetAction);
  const staticValid = a.kind === "redirect" ? staticRedirectTarget : staticRewritePath;
  const tabs = (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        if (next === mode) return;
        if (next === "expression") {
          stash.current.value = a.value;
          set({
            value: "",
            target:
              stash.current.target || (a.value ? JSON.stringify(a.value) : "http.request.uri.path"),
          });
          setMode("expression");
        } else {
          stash.current.target = a.target;
          set({ target: "", value: stash.current.value || literalText(a.target) || "/" });
          setMode("static");
        }
      }}
    >
      <TabsList aria-label={m.rules_target_mode()}>
        <TabsTrigger value="static" className="h-7 px-2.5 text-xs" data-testid="rule-target-static">
          {m.rules_target_static()}
        </TabsTrigger>
        <TabsTrigger
          value="expression"
          className="h-7 px-2.5 text-xs"
          disabled={locked && mode === "static"}
          data-testid="rule-target-expression"
        >
          {m.rules_target_expression()}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
  return (
    <>
      <div className="sm:col-span-2">
        {mode === "expression" ? (
          <ExpressionEditor
            id={`target-${id}`}
            label={m.rules_target()}
            value={a.target}
            phase={phase}
            kind="value"
            onChange={(target) => set({ target })}
            actions={tabs}
            testId="rule-target"
            hideRulesV3={lockedV3}
          />
        ) : (
          <Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor={`target-${id}`}>{m.rules_target()}</FieldLabel>
              {tabs}
            </div>
            <Input
              id={`target-${id}`}
              value={a.value}
              maxLength={4096}
              aria-invalid={!staticValid(a.value)}
              onChange={(e) => set({ value: e.target.value })}
              className="font-mono"
              data-testid="rule-target"
            />
          </Field>
        )}
      </div>
      {a.kind === "redirect" ? (
        <StatusSelect
          id={id}
          value={a.statusCode}
          // 303 is a rules-v3 addition.
          codes={[301, 302, 303, 307, 308].filter(
            (code) => code !== 303 || !lockedV3 || a.statusCode === 303,
          )}
          onChange={(statusCode) =>
            set({ statusCode: statusCode as ActionOf<"redirect">["statusCode"] })
          }
        />
      ) : null}
      <SwitchField
        id={`preserve-${id}`}
        label={m.rules_preserve_query()}
        checked={a.preserveQuery}
        // Rewrites keep the query and redirects drop it unless told otherwise (rules-v2).
        disabled={locked && a.preserveQuery === (a.kind === "rewrite")}
        onCheckedChange={(preserveQuery) => set({ preserveQuery })}
        testId="rule-preserve-query"
      />
      <SetQueryFields
        id={id}
        phase={phase}
        params={a.setQuery}
        locked={locked}
        lockedV3={lockedV3}
        onChange={(setQuery) => set({ setQuery })}
      />
      <Field
        className="sm:col-span-2"
        data-disabled={(locked && !a.removeQuery.length) || undefined}
      >
        <FieldLabel htmlFor={`remove-query-${id}`}>{m.rules_remove_query()}</FieldLabel>
        <ListInput
          id={`remove-query-${id}`}
          value={a.removeQuery}
          placeholder="utm_source, utm_medium"
          disabled={locked && !a.removeQuery.length}
          invalid={a.removeQuery.some((name) => !QUERY_NAME_RE.test(name))}
          onChange={(removeQuery) => set({ removeQuery })}
          testId="rule-remove-query"
        />
      </Field>
    </>
  );
}

type QueryParam = TargetAction["setQuery"][number];

/**
 * Query parameters a redirect or rewrite sets, at most 16; a value is static or (rules-v3) a value
 * expression computed per request.
 */
function SetQueryFields({
  id,
  phase,
  params,
  locked,
  lockedV3,
  onChange,
}: {
  id: string;
  phase: Phase;
  params: QueryParam[];
  locked: boolean;
  lockedV3: boolean;
  onChange: (params: QueryParam[]) => void;
}) {
  // Row keys live beside the data: parameters have no identity of their own.
  const [keys, setKeys] = React.useState(() => params.map(() => nextDraftKey()));
  const rowKeys = params.map((_, index) => keys[index] ?? -index - 1);
  const names = params.map((param) => param.name);
  const update = (index: number, change: Partial<QueryParam>) =>
    onChange(params.map((param, i) => (i === index ? { ...param, ...change } : param)));
  return (
    <FieldSet className="gap-2 sm:col-span-2">
      <FieldLegend variant="label" className="mb-1">
        {m.rules_set_query()}
      </FieldLegend>
      {params.map((param, index) => (
        <div
          key={rowKeys[index]}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-2 animate-enter"
          data-testid="rule-set-query"
        >
          <Input
            id={`set-query-name-${id}-${index}`}
            aria-label={m.rules_query_name()}
            value={param.name}
            maxLength={64}
            aria-invalid={
              !QUERY_NAME_RE.test(param.name) || names.indexOf(param.name) !== index || undefined
            }
            onChange={(e) => update(index, { name: e.target.value })}
            className="font-mono"
            data-testid="rule-set-query-name"
          />
          <QueryValue
            param={param}
            phase={phase}
            lockedV3={lockedV3}
            onChange={(change) => update(index, change)}
          />
          <Button
            className="icon-button"
            type="button"
            size="sm"
            variant="ghost"
            aria-label={m.common_remove()}
            onClick={() => {
              setKeys(rowKeys.filter((_, i) => i !== index));
              onChange(params.filter((_, i) => i !== index));
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={params.length >= 16 || locked}
        onClick={() => {
          setKeys([...rowKeys, nextDraftKey()]);
          onChange([...params, { name: "", value: "", expression: "" }]);
        }}
        data-testid="rule-set-query-add"
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {m.rules_query_add()}
      </Button>
    </FieldSet>
  );
}

/** A set query parameter's value: static, or a value expression with the parser's error below. */
function QueryValue({
  param,
  phase,
  lockedV3,
  onChange,
}: {
  param: QueryParam;
  phase: Phase;
  lockedV3: boolean;
  onChange: (change: Partial<QueryParam>) => void;
}) {
  const [mode, setMode] = React.useState<"static" | "expression">(
    param.expression !== "" ? "expression" : "static",
  );
  const failure =
    mode === "expression" ? expressionFailure(param.expression, phase, "value") : null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <OptionSelect
          value={mode}
          // A select rather than tabs: the row's target already has static / expression tabs.
          options={[
            { value: "static" as const, label: m.rules_target_static() },
            ...(lockedV3 && mode === "static"
              ? []
              : [{ value: "expression" as const, label: m.rules_target_expression() }]),
          ]}
          onChange={(next) => {
            if (next === mode) return;
            onChange(
              next === "expression"
                ? { value: "", expression: param.value ? JSON.stringify(param.value) : "http.host" }
                : { expression: "", value: literalText(param.expression).slice(0, 256) },
            );
            setMode(next);
          }}
          label={m.rules_value_mode()}
          size="sm"
          className="w-24 shrink-0"
          testId="rule-set-query-mode"
        />
        {mode === "expression" ? (
          <Input
            aria-label={m.rules_query_expression()}
            value={param.expression}
            maxLength={4096}
            spellCheck={false}
            aria-invalid={failure !== null || undefined}
            onChange={(e) => onChange({ expression: e.target.value })}
            className="min-w-0 font-mono"
            data-testid="rule-set-query-expression"
          />
        ) : (
          <Input
            aria-label={m.rules_query_value()}
            value={param.value}
            maxLength={256}
            onChange={(e) => onChange({ value: e.target.value })}
            className="min-w-0"
            data-testid="rule-set-query-value"
          />
        )}
      </div>
      {failure ? (
        <p className="text-xs text-destructive" role="alert">
          {expressionErrorText(failure)}
        </p>
      ) : null}
    </div>
  );
}
