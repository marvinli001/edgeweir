import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type RuleDto, type RuleInput, ruleInput } from "@edgeweir/contract";
import { ExpressionError, type Phase, parseExpression, phases } from "@edgeweir/rule-engine";
import { Delete02Icon, DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

const phaseLabel = (phase: Phase) =>
  ({
    "request-transform": m.rules_phase_request,
    redirect: m.rules_phase_redirect,
    config: m.rules_phase_config,
    "waf-custom": m.rules_phase_waf,
    ratelimit: m.rules_phase_rate,
    cache: m.rules_phase_cache,
    origin: m.rules_phase_origin,
    "response-transform": m.rules_phase_response,
  })[phase]();
const kinds = {
  "request-transform": ["rewrite", "request_header"],
  redirect: ["redirect"],
  config: ["config"],
  "waf-custom": ["block", "log", "allow"],
  ratelimit: ["rate_limit"],
  cache: ["config"],
  origin: ["request_header"],
  "response-transform": ["response_header"],
} satisfies Record<Phase, RuleInput["action"]["kind"][]>;
const actionLabel = (kind: RuleInput["action"]["kind"]) =>
  ({
    block: m.rules_block,
    log: m.rules_log,
    allow: m.rules_allow,
    redirect: m.rules_redirect,
    rewrite: m.rules_rewrite,
    request_header: m.rules_request_header,
    response_header: m.rules_response_header,
    config: m.rules_config,
    rate_limit: m.rules_rate,
  })[kind]();
function defaultAction(kind: RuleInput["action"]["kind"]): RuleInput["action"] {
  switch (kind) {
    case "block":
      return { kind, statusCode: 403 };
    case "redirect":
      return { kind, value: "/", statusCode: 301 };
    case "rewrite":
      return { kind, value: "/" };
    case "request_header":
    case "response_header":
      return { kind, header: "x-custom", value: "", remove: false };
    case "config":
      return { kind, cacheBypass: true };
    case "rate_limit":
      return { kind, limit: 100, windowSeconds: 60, key: "ip.src", statusCode: 429 };
    default:
      return { kind };
  }
}

export function RulesTab({ siteId }: { siteId?: string }) {
  const query = useQuery(
    siteId
      ? orpc.rules.get.queryOptions({ input: { id: siteId } })
      : orpc.platformRules.get.queryOptions(),
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <RulesEditor key={JSON.stringify(query.data)} initial={query.data} siteId={siteId} />;
}
function RulesEditor({ initial, siteId }: { initial: RuleDto[]; siteId?: string }) {
  const [rows, setRows] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      const rules = rows.map((row) => ruleInput.parse(row));
      if (siteId) await client.rules.save({ id: siteId, rules });
      else await client.platformRules.save({ rules });
      await queries.invalidateQueries();
    },
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const patch = (id: string, update: Partial<RuleDto>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...update } : row)));
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync();
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      {rows.length === 0 ? <EmptyState title={m.rules_empty()} /> : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{
          screenReaderInstructions: { draggable: m.site_rule_drag_instructions() },
          announcements: {
            onDragStart: ({ active }) =>
              m.site_rule_drag_start({ index: rows.findIndex((r) => r.id === active.id) + 1 }),
            onDragOver: ({ active, over }) =>
              over
                ? m.site_rule_drag_over({
                    index: rows.findIndex((r) => r.id === active.id) + 1,
                    position: rows.findIndex((r) => r.id === over.id) + 1,
                  })
                : undefined,
            onDragEnd: ({ active, over }) =>
              over
                ? m.site_rule_drag_end({
                    index: rows.findIndex((r) => r.id === active.id) + 1,
                    position: rows.findIndex((r) => r.id === over.id) + 1,
                  })
                : m.site_rule_drag_cancel({ index: rows.findIndex((r) => r.id === active.id) + 1 }),
            onDragCancel: ({ active }) =>
              m.site_rule_drag_cancel({ index: rows.findIndex((r) => r.id === active.id) + 1 }),
          },
        }}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          const from = rows.findIndex((r) => r.id === active.id),
            to = rows.findIndex((r) => r.id === over.id);
          if (from >= 0 && to >= 0 && rows[from]?.phase === rows[to]?.phase)
            setRows(arrayMove(rows, from, to));
        }}
      >
        {phases.map((phase) => {
          const group = rows.filter((row) => row.phase === phase);
          return (
            <section key={phase} className="flex flex-col gap-3 animate-enter">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{phaseLabel(phase)}</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rows.length >= (siteId ? 64 : 32)}
                  data-testid={`rule-add-${phase}`}
                  onClick={() =>
                    setRows([
                      ...rows,
                      {
                        id: crypto.randomUUID(),
                        name: m.rules_new(),
                        phase,
                        expression: "true",
                        enabled: true,
                        action: defaultAction(kinds[phase][0] ?? "block"),
                      },
                    ])
                  }
                >
                  {m.rules_add()}
                </Button>
              </div>
              <SortableContext
                items={group.map((r) => r.id)}
                strategy={verticalListSortingStrategy}
              >
                {group.map((row) => (
                  <RuleRow
                    key={row.id}
                    row={row}
                    patch={(update) => patch(row.id, update)}
                    remove={() => setRows(rows.filter((r) => r.id !== row.id))}
                  />
                ))}
              </SortableContext>
            </section>
          );
        })}
      </DndContext>
      <SaveBar
        dirty={JSON.stringify(initial) !== JSON.stringify(rows)}
        pending={save.isPending}
        error={error}
        testId="rules-save"
      />
    </form>
  );
}
function RuleRow({
  row,
  patch,
  remove,
}: {
  row: RuleDto;
  patch: (update: Partial<RuleDto>) => void;
  remove: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({
      id: row.id,
      attributes: { roleDescription: m.site_rule_role() },
      transition: reducedMotion ? null : undefined,
    });
  const a = row.action;
  return (
    <Card
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="rule-row"
    >
      <CardContent className="grid gap-4 pt-5">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            ref={setActivatorNodeRef}
            className="cursor-grab touch-none active:cursor-grabbing"
            aria-label={m.rules_drag()}
            {...attributes}
            {...listeners}
          >
            <HugeiconsIcon icon={DragDropVerticalIcon} />
          </Button>
          <Input
            aria-label={m.rules_name()}
            value={row.name}
            required
            maxLength={100}
            onChange={(e) => patch({ name: e.target.value })}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={m.common_delete()}
            onClick={remove}
          >
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        </div>
        <ExpressionEditor
          id={`expr-${row.id}`}
          value={row.expression}
          phase={row.phase}
          onChange={(expression) => patch({ expression })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormSelect
            id={`action-${row.id}`}
            label={m.rules_action()}
            value={a.kind}
            options={kinds[row.phase].map((kind) => ({ value: kind, label: actionLabel(kind) }))}
            onChange={(kind) => patch({ action: defaultAction(kind as typeof a.kind) })}
          />
          <SwitchField
            id={`enabled-${row.id}`}
            label={m.rules_enabled()}
            checked={row.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
          {"value" in a ? (
            <Field>
              <FieldLabel htmlFor={`value-${row.id}`}>{m.rules_value()}</FieldLabel>
              <Input
                id={`value-${row.id}`}
                value={a.value}
                onChange={(e) => patch({ action: { ...a, value: e.target.value } })}
              />
            </Field>
          ) : null}
          {"header" in a ? (
            <>
              <Field>
                <FieldLabel htmlFor={`header-${row.id}`}>{m.rules_header()}</FieldLabel>
                <Input
                  id={`header-${row.id}`}
                  value={a.header}
                  onChange={(e) => patch({ action: { ...a, header: e.target.value } })}
                />
              </Field>
              <SwitchField
                id={`remove-${row.id}`}
                label={m.rules_remove_header()}
                checked={a.remove}
                onCheckedChange={(remove) => patch({ action: { ...a, remove } })}
              />
            </>
          ) : null}
          {a.kind === "redirect" || a.kind === "block" || a.kind === "rate_limit" ? (
            <FormSelect
              id={`status-${row.id}`}
              label={m.rules_status()}
              value={String(a.statusCode)}
              options={(a.kind === "block"
                ? [403, 451]
                : a.kind === "rate_limit"
                  ? [403, 429]
                  : [301, 302, 307, 308]
              ).map((code) => ({
                value: String(code),
                label: String(code),
              }))}
              onChange={(code) => patch({ action: { ...a, statusCode: Number(code) } as typeof a })}
            />
          ) : null}
          {a.kind === "rate_limit" ? (
            <>
              <NumberField
                id={`limit-${row.id}`}
                label={m.rules_limit()}
                value={String(a.limit)}
                min={1}
                max={100000}
                onChange={(value) => patch({ action: { ...a, limit: Number(value) } })}
              />
              <NumberField
                id={`window-${row.id}`}
                label={m.rules_window()}
                value={String(a.windowSeconds)}
                min={1}
                max={3600}
                onChange={(value) => patch({ action: { ...a, windowSeconds: Number(value) } })}
              />
              <Field>
                <FieldLabel htmlFor={`key-${row.id}`}>{m.rules_key()}</FieldLabel>
                <Input
                  id={`key-${row.id}`}
                  value={a.key}
                  onChange={(e) => patch({ action: { ...a, key: e.target.value } })}
                />
              </Field>
            </>
          ) : null}
          {a.kind === "config"
            ? (["cacheBypass", "forceHttps", "gzip"] as const).map((key) => (
                <FormSelect
                  key={key}
                  id={`${key}-${row.id}`}
                  label={
                    {
                      cacheBypass: m.rules_bypass(),
                      forceHttps: m.cert_force_https(),
                      gzip: m.cert_gzip(),
                    }[key]
                  }
                  value={a[key] === undefined ? "unchanged" : String(a[key])}
                  options={[
                    { value: "unchanged", label: m.rules_unchanged() },
                    ...(key === "gzip" ? [] : [{ value: "true", label: m.rules_on() }]),
                    { value: "false", label: m.rules_off() },
                  ]}
                  onChange={(value) =>
                    patch({
                      action: { ...a, [key]: value === "unchanged" ? undefined : value === "true" },
                    })
                  }
                />
              ))
            : null}
        </div>
      </CardContent>
    </Card>
  );
}
function ExpressionEditor({
  id,
  value,
  phase,
  onChange,
}: {
  id: string;
  value: string;
  phase: Phase;
  onChange: (value: string) => void;
}) {
  let position: number | null = null;
  try {
    parseExpression(value, phase);
  } catch (err) {
    position = err instanceof ExpressionError ? err.position : 0;
  }
  const tokens = value.split(
    /("(?:\\.|[^"\\])*"|\b(?:and|or|not|eq|ne|lt|le|gt|ge|contains|matches|in|true|false)\b|\$[\w]+)/g,
  );
  let offset = 0;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{m.rules_expression()}</FieldLabel>
      <div className="relative min-h-24 rounded-lg border bg-background font-mono text-sm leading-6 focus-within:ring-2 focus-within:ring-ring">
        <pre aria-hidden className="pointer-events-none whitespace-pre-wrap break-all p-3">
          {tokens.filter(Boolean).map((token) => {
            const start = offset;
            offset += token.length;
            const color = token.startsWith('"')
              ? "text-state-good"
              : /^(and|or|not|eq|ne|lt|le|gt|ge|contains|matches|in|true|false)$/.test(token)
                ? "text-primary"
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
          id={id}
          value={value}
          maxLength={4096}
          spellCheck={false}
          aria-invalid={position !== null}
          aria-describedby={position !== null ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full resize-none whitespace-pre-wrap break-all bg-transparent p-3 text-transparent caret-foreground outline-none"
        />
      </div>
      {position !== null ? (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {m.rules_expression_error({ position: position + 1 })}
        </p>
      ) : null}
    </Field>
  );
}
