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
import {
  expressionIssue,
  type FeatureAvailability,
  RATE_LIMIT_PRESETS,
  type RuleDto,
  type RuleInput,
  ruleInput,
  staticRedirectTarget,
} from "@edgeweir/contract";
import {
  type ChallengeType,
  challengeTypes,
  compressionCodings,
  type Phase,
  phases,
  QUERY_NAME_RE,
  rateLimitKeys,
} from "@edgeweir/rule-engine";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import type * as z from "zod";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { PresetSelect, usePreset } from "@/components/preset-select";
import { SafetyNote } from "@/components/safety-note";
import { ExpressionEditor } from "@/components/site/expression-editor";
import { ListInput, NumberField, SwitchField } from "@/components/site/fields";
import { nextDraftKey, SaveBar } from "@/components/site/save-site";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { expressionReason } from "@/lib/expressions";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";
import { randomUuid } from "@/lib/uuid";

type Action = RuleDto["action"];
type Kind = Action["kind"];
type ActionOf<K extends Kind> = Extract<Action, { kind: K }>;
type Coding = (typeof compressionCodings)[number];

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
    compression: m.rules_phase_compression,
  })[phase]();
/** Action kinds of each phase; the first is what a new rule of the phase starts with. */
const kinds: Record<Phase, readonly Kind[]> = {
  "request-transform": ["rewrite", "request_header"],
  redirect: ["redirect"],
  config: ["config"],
  "waf-custom": ["block", "log", "allow", "challenge"],
  ratelimit: ["rate_limit"],
  cache: ["config"],
  origin: ["request_header", "origin"],
  "response-transform": ["response_header"],
  compression: ["compression"],
};
/** Kinds only nodes with the rule engine extensions (rules-v2) run. */
const v2Kinds: ReadonlySet<Kind> = new Set(["origin", "compression"]);
const actionLabel = (kind: Kind) =>
  ({
    block: m.rules_block,
    log: m.rules_log,
    allow: m.rules_allow,
    challenge: m.rules_challenge,
    redirect: m.rules_redirect,
    rewrite: m.rules_rewrite,
    request_header: m.rules_request_header,
    response_header: m.rules_response_header,
    config: m.rules_config,
    rate_limit: m.rules_rate,
    origin: m.rules_origin,
    compression: m.rules_compression,
  })[kind]();
const codingLabel = (coding: Coding) =>
  ({ zstd: m.compression_zstd, br: m.compression_brotli, gzip: m.cert_gzip })[coding]();
function defaultAction(kind: Kind): RuleInput["action"] {
  switch (kind) {
    case "block":
      return { kind, statusCode: 403 };
    case "redirect":
      return {
        kind,
        value: "/",
        target: "",
        statusCode: 301,
        preserveQuery: false,
        setQuery: [],
        removeQuery: [],
      };
    case "rewrite":
      return { kind, value: "/", target: "", preserveQuery: true, setQuery: [], removeQuery: [] };
    case "request_header":
    case "response_header":
      return { kind, header: "x-custom", value: "", remove: false };
    case "config":
      return { kind, cacheBypass: true };
    case "rate_limit":
      return { kind, ...RATE_LIMIT_PRESETS.standard, key: "ip.src", statusCode: 429 };
    case "challenge":
      return { kind, type: "js" };
    case "origin":
      return { kind, originGroup: "", hostHeader: "", sni: "", port: 0 };
    case "compression":
      return { kind, algorithms: [] };
    default:
      return { kind };
  }
}
const HEADER_KEY = "http.request.headers.";
/** Rate limit keys offered in the select; a request header is the last choice. */
const keyChoice = (key: string) => (key.startsWith(HEADER_KEY) ? "header" : key);
/** The origin group select's value for the default group (not a valid group name). */
const DEFAULT_GROUP = ":default";
/** Select value of an unset config override. */
const UNCHANGED = "unchanged";

/** Labels of the action fields an issue can point at (the form's own labels). */
const actionFieldLabels: Record<string, () => string> = {
  target: m.rules_target,
  header: m.rules_header,
  setQuery: m.rules_set_query,
  removeQuery: m.rules_remove_query,
  statusCode: m.rules_status,
  limit: m.rules_limit,
  windowSeconds: m.rules_window,
  key: m.rules_key,
  type: m.rules_challenge_type,
  originGroup: m.rules_origin_group,
  hostHeader: m.site_form_host_header,
  sni: m.site_origin_sni,
  port: m.site_form_port,
  algorithms: m.rules_compression,
  ccMaxLevel: m.rules_cc_max_level,
  originConnectTimeoutMs: m.rules_connect_timeout,
  originSendTimeoutMs: m.rules_send_timeout,
  originReadTimeoutMs: m.rules_read_timeout,
  logSampleRate: m.rules_log_sample_rate,
};
/** The label of the field an issue of `row` points at. */
function issueField(row: RuleDto, path: readonly PropertyKey[]): string {
  const [head, field] = path;
  if (head === "name") return m.rules_name();
  if (head === "expression") return m.rules_expression();
  if (head !== "action" || typeof field !== "string") return m.rules_action();
  // Redirects and rewrites label their static value as the target.
  if (field === "value")
    return row.action.kind === "redirect" || row.action.kind === "rewrite"
      ? m.rules_target()
      : m.rules_value();
  return (actionFieldLabels[field] ?? m.rules_action)();
}
/** Why a rule cannot be saved: the field, and where and why an expression fails. */
function ruleIssueText(row: RuleDto, issue: z.core.$ZodIssue | undefined): string {
  const field = issueField(row, issue?.path ?? []);
  const failure = issue ? expressionIssue(issue) : null;
  return failure
    ? m.rules_check_rule_expression({
        name: row.name,
        field,
        position: failure.position + 1,
        reason: expressionReason(failure),
      })
    : m.rules_check_rule({ name: row.name, field });
}

/**
 * Rules of a site (siteId) or of the platform. A site's rules can send requests to its origin
 * groups; the rule engine extensions stay locked while the cluster's nodes lack them.
 */
export function RulesTab({ siteId, originGroups }: { siteId?: string; originGroups?: string[] }) {
  const query = useQuery(
    siteId
      ? orpc.rules.get.queryOptions({ input: { id: siteId } })
      : orpc.platformRules.get.queryOptions(),
  );
  const features = useQuery({
    ...orpc.sites.features.queryOptions({ input: { id: siteId ?? "" } }),
    enabled: !!siteId,
  });
  const editor = (rules: RuleDto[], availability?: FeatureAvailability) => (
    <RulesEditor
      key={JSON.stringify(rules)}
      initial={rules}
      siteId={siteId}
      originGroups={siteId ? (originGroups ?? []) : undefined}
      availability={availability}
      locked={availability?.available === false}
    />
  );
  // Platform rules have no site features to wait for.
  return (
    <QueryView query={query}>
      {(rules) =>
        siteId ? (
          <QueryView query={features}>{({ rulesV2 }) => editor(rules, rulesV2)}</QueryView>
        ) : (
          editor(rules)
        )
      }
    </QueryView>
  );
}
function RulesEditor({
  initial,
  siteId,
  originGroups,
  availability,
  locked,
}: {
  initial: RuleDto[];
  siteId?: string;
  originGroups?: string[];
  availability?: FeatureAvailability;
  locked: boolean;
}) {
  const [rows, setRows] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async (rules: RuleInput[]) => {
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
        const rules: RuleInput[] = [];
        for (const row of rows) {
          const parsed = ruleInput.safeParse(row);
          if (!parsed.success) {
            setError(ruleIssueText(row, parsed.error.issues[0]));
            return;
          }
          rules.push(parsed.data);
        }
        try {
          await save.mutateAsync(rules);
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      {availability && !availability.available ? (
        <SafetyNote
          className="animate-in fade-in"
          data-testid="rules-v2-unavailable"
          data-reason={availability.reason ?? undefined}
        >
          {m.rules_v2_unavailable()}
        </SafetyNote>
      ) : null}
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
          const first = kinds[phase][0] ?? "block";
          return (
            <section
              key={phase}
              className="flex flex-col gap-3 animate-enter"
              data-testid={`rules-phase-${phase}`}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{phaseLabel(phase)}</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rows.length >= (siteId ? 64 : 32) || (locked && v2Kinds.has(first))}
                  data-testid={`rule-add-${phase}`}
                  onClick={() =>
                    setRows([
                      ...rows,
                      {
                        id: randomUuid(),
                        name: m.rules_new(),
                        phase,
                        expression: "true",
                        // Saved with an edit elsewhere, an enabled `true` rule would redirect or
                        // block every request.
                        enabled: false,
                        action: defaultAction(first),
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
                    originGroups={originGroups}
                    locked={locked}
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
  originGroups,
  locked,
  patch,
  remove,
}: {
  row: RuleDto;
  /** The site's origin groups besides the default one; undefined for platform rules. */
  originGroups?: string[];
  locked: boolean;
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
  const kindOptions = kinds[row.phase]
    .filter((kind) => kind === a.kind || !(locked && v2Kinds.has(kind)))
    .map((kind) => ({ value: kind, label: actionLabel(kind) }));
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
          label={m.rules_expression()}
          value={row.expression}
          phase={row.phase}
          onChange={(expression) => patch({ expression })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormSelect
            id={`action-${row.id}`}
            label={m.rules_action()}
            value={a.kind}
            options={kindOptions}
            onChange={(kind) => {
              const action = defaultAction(kind as Kind);
              // An origin rule usually picks a group: start with the first one.
              if (action.kind === "origin" && originGroups?.[0])
                action.originGroup = originGroups[0];
              patch({ action });
            }}
          />
          <SwitchField
            id={`enabled-${row.id}`}
            label={m.rules_enabled()}
            checked={row.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
          <ActionFields
            id={row.id}
            phase={row.phase}
            action={a}
            originGroups={originGroups}
            locked={locked}
            onChange={(action) => patch({ action })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** The fields of a rule's action, as cells of the row's two-column grid. */
function ActionFields({
  id,
  phase,
  action: a,
  originGroups,
  locked,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: Action;
  originGroups?: string[];
  locked: boolean;
  onChange: (action: Action) => void;
}) {
  switch (a.kind) {
    case "redirect":
    case "rewrite":
      return <TargetFields id={id} phase={phase} action={a} locked={locked} onChange={onChange} />;
    case "request_header":
    case "response_header":
      return (
        <>
          <Field>
            <FieldLabel htmlFor={`header-${id}`}>{m.rules_header()}</FieldLabel>
            <Input
              id={`header-${id}`}
              value={a.header}
              onChange={(e) => onChange({ ...a, header: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`value-${id}`}>{m.rules_value()}</FieldLabel>
            <Input
              id={`value-${id}`}
              value={a.value}
              onChange={(e) => onChange({ ...a, value: e.target.value })}
            />
          </Field>
          <SwitchField
            id={`remove-${id}`}
            label={m.rules_remove_header()}
            checked={a.remove}
            onCheckedChange={(remove) => onChange({ ...a, remove })}
          />
        </>
      );
    case "block":
      return (
        <StatusSelect
          id={id}
          value={a.statusCode}
          codes={[403, 451]}
          onChange={(statusCode) => onChange({ ...a, statusCode: statusCode as 403 | 451 })}
        />
      );
    case "rate_limit":
      return <RateLimitFields id={id} action={a} onChange={onChange} />;
    case "challenge":
      return (
        <FormSelect
          id={`challenge-${id}`}
          label={m.rules_challenge_type()}
          value={a.type}
          options={challengeTypes.map((type) => ({ value: type, label: challengeLabel(type) }))}
          onChange={(type) => onChange({ ...a, type: type as ChallengeType })}
        />
      );
    case "config":
      return <ConfigFields id={id} phase={phase} action={a} locked={locked} onChange={onChange} />;
    case "origin":
      return <OriginFields id={id} action={a} originGroups={originGroups} onChange={onChange} />;
    case "compression":
      return <CompressionFields action={a} onChange={onChange} />;
    default:
      return null;
  }
}

/** A rate limit's status, preset (or limit and window), and key. */
function RateLimitFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"rate_limit">;
  onChange: (action: Action) => void;
}) {
  const preset = usePreset(
    RATE_LIMIT_PRESETS,
    { limit: a.limit, windowSeconds: a.windowSeconds },
    (rate) => onChange({ ...a, ...rate }),
  );
  return (
    <>
      <StatusSelect
        id={id}
        value={a.statusCode}
        codes={[403, 429]}
        onChange={(statusCode) => onChange({ ...a, statusCode: statusCode as 403 | 429 })}
      />
      <PresetSelect id={`rate-preset-${id}`} value={preset.choice} onChange={preset.choose} />
      {preset.choice === "custom" ? (
        <>
          <NumberField
            id={`limit-${id}`}
            label={m.rules_limit()}
            value={String(a.limit)}
            min={1}
            max={100000}
            onChange={(value) => onChange({ ...a, limit: Number(value) })}
          />
          <NumberField
            id={`window-${id}`}
            label={m.rules_window()}
            value={String(a.windowSeconds)}
            min={1}
            max={3600}
            onChange={(value) => onChange({ ...a, windowSeconds: Number(value) })}
          />
        </>
      ) : null}
      <FormSelect
        id={`key-${id}`}
        label={m.rules_key()}
        value={keyChoice(a.key)}
        options={[
          ...rateLimitKeys.map((key) => ({ value: key, label: key })),
          { value: "header", label: m.rules_key_header() },
        ]}
        onChange={(choice) =>
          onChange({ ...a, key: choice === "header" ? `${HEADER_KEY}x-client-id` : choice })
        }
      />
      {keyChoice(a.key) === "header" ? (
        <Field>
          <FieldLabel htmlFor={`key-header-${id}`}>{m.rules_header()}</FieldLabel>
          <Input
            id={`key-header-${id}`}
            value={a.key.slice(HEADER_KEY.length)}
            onChange={(e) =>
              onChange({ ...a, key: `${HEADER_KEY}${e.target.value.toLowerCase()}` })
            }
          />
        </Field>
      ) : null}
    </>
  );
}

function StatusSelect({
  id,
  value,
  codes,
  onChange,
}: {
  id: string;
  value: number;
  codes: number[];
  onChange: (code: number) => void;
}) {
  return (
    <FormSelect
      id={`status-${id}`}
      label={m.rules_status()}
      value={String(value)}
      options={codes.map((code) => ({ value: String(code), label: String(code) }))}
      onChange={(code) => onChange(Number(code))}
    />
  );
}

type TargetAction = ActionOf<"redirect"> | ActionOf<"rewrite">;
/** A static rewrite path: a single leading "/", no query, fragment or backslash. */
const staticRewritePath = (s: string) =>
  s.startsWith("/") && !s.startsWith("//") && !/[?\\#]/.test(s);
/** The text of a value expression that is just a string literal, else "". */
function literalText(source: string): string {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Where a redirect or rewrite goes: a static value or a value expression computed per request,
 * then what happens to the query string.
 */
function TargetFields({
  id,
  phase,
  action: a,
  locked,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: TargetAction;
  locked: boolean;
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
          codes={[301, 302, 307, 308]}
          onChange={(statusCode) => set({ statusCode: statusCode as 301 | 302 | 307 | 308 })}
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
        params={a.setQuery}
        locked={locked}
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

/** Query parameters a redirect or rewrite sets, at most 16. */
function SetQueryFields({
  id,
  params,
  locked,
  onChange,
}: {
  id: string;
  params: { name: string; value: string }[];
  locked: boolean;
  onChange: (params: { name: string; value: string }[]) => void;
}) {
  // Row keys live beside the data: parameters have no identity of their own.
  const [keys, setKeys] = React.useState(() => params.map(() => nextDraftKey()));
  const rowKeys = params.map((_, index) => keys[index] ?? -index - 1);
  const names = params.map((param) => param.name);
  const update = (index: number, change: Partial<{ name: string; value: string }>) =>
    onChange(params.map((param, i) => (i === index ? { ...param, ...change } : param)));
  return (
    <FieldSet className="gap-2 sm:col-span-2">
      <FieldLegend variant="label" className="mb-1">
        {m.rules_set_query()}
      </FieldLegend>
      {params.map((param, index) => (
        <div
          key={rowKeys[index]}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 animate-enter"
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
          <Input
            aria-label={m.rules_query_value()}
            value={param.value}
            maxLength={256}
            onChange={(e) => update(index, { value: e.target.value })}
            data-testid="rule-set-query-value"
          />
          <Button
            type="button"
            size="icon-sm"
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
        variant="outline"
        size="sm"
        className="self-start"
        disabled={params.length >= 16 || locked}
        onClick={() => {
          setKeys([...rowKeys, nextDraftKey()]);
          onChange([...params, { name: "", value: "" }]);
        }}
        data-testid="rule-set-query-add"
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {m.rules_query_add()}
      </Button>
    </FieldSet>
  );
}

/**
 * A number shown in other units than stored (seconds for milliseconds, % for basis points);
 * empty is undefined. The text survives while it means the same value.
 */
function OptionalNumber({
  id,
  label,
  value,
  scale,
  min,
  max,
  disabled,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  value: number | undefined;
  /** Stored units per shown unit. */
  scale: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
  testId?: string;
}) {
  const show = (stored: number | undefined) => (stored === undefined ? "" : String(stored / scale));
  const parse = (text: string) => {
    const n = Number(text);
    return text.trim() === "" || !Number.isFinite(n) ? undefined : Math.round(n * scale);
  };
  const [text, setText] = React.useState(() => show(value));
  return (
    <NumberField
      id={id}
      label={label}
      value={parse(text) === value ? text : show(value)}
      min={min}
      max={max}
      step="any"
      placeholder={m.rules_unchanged()}
      disabled={disabled}
      onChange={(next) => {
        setText(next);
        onChange(parse(next));
      }}
      testId={testId}
    />
  );
}

type ConfigAction = ActionOf<"config">;
/** Overrides every config rule may set (also in the phase cache). */
const BASE_SWITCHES = ["cacheBypass", "forceHttps", "gzip"] as const;
/** Overrides only the phase config accepts (rules-v2). */
const V2_SWITCHES = ["brotli", "zstd", "websocket", "underAttack", "ccEnabled"] as const;
type ConfigSwitch = (typeof BASE_SWITCHES)[number] | (typeof V2_SWITCHES)[number];
const switchLabel = (key: ConfigSwitch) =>
  ({
    cacheBypass: m.rules_bypass,
    forceHttps: m.cert_force_https,
    gzip: m.cert_gzip,
    brotli: m.compression_brotli,
    zstd: m.compression_zstd,
    websocket: m.site_pool_websocket,
    underAttack: m.protection_under_attack,
    ccEnabled: m.cc_title,
  })[key]();

/** Site settings a config rule overrides; unset ones stay as the site has them. */
function ConfigFields({
  id,
  phase,
  action: a,
  locked,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: ConfigAction;
  locked: boolean;
  onChange: (action: ConfigAction) => void;
}) {
  const set = (change: Partial<ConfigAction>) => onChange({ ...a, ...change });
  const triState = (key: ConfigSwitch, v2: boolean) => {
    // Turning gzip back on is new with rules-v2 as well.
    const noOn = locked && (v2 || key === "gzip") && a[key] !== true;
    return (
      <FormSelect
        key={key}
        id={`${key}-${id}`}
        label={switchLabel(key)}
        value={a[key] === undefined ? UNCHANGED : String(a[key])}
        options={[
          { value: UNCHANGED, label: m.rules_unchanged() },
          ...(noOn ? [] : [{ value: "true", label: m.rules_on() }]),
          { value: "false", label: m.rules_off() },
        ]}
        disabled={v2 && locked && a[key] === undefined}
        onChange={(value) =>
          onChange({ ...a, [key]: value === UNCHANGED ? undefined : value === "true" })
        }
        testId={`rule-config-${key}`}
      />
    );
  };
  const timeouts = [
    ["originConnectTimeoutMs", m.rules_connect_timeout(), 120],
    ["originSendTimeoutMs", m.rules_send_timeout(), 3600],
    ["originReadTimeoutMs", m.rules_read_timeout(), 3600],
  ] as const;
  return (
    // Spans the row's grid; three overrides per line where there is room.
    <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-3">
      {BASE_SWITCHES.map((key) => triState(key, false))}
      {phase === "config" ? (
        <>
          {V2_SWITCHES.map((key) => triState(key, true))}
          <FormSelect
            id={`cc-level-${id}`}
            label={m.rules_cc_max_level()}
            value={a.ccMaxLevel ?? UNCHANGED}
            options={[
              { value: UNCHANGED, label: m.rules_unchanged() },
              ...challengeTypes.map((type) => ({ value: type, label: challengeLabel(type) })),
            ]}
            disabled={locked && a.ccMaxLevel === undefined}
            onChange={(level) =>
              set({ ccMaxLevel: level === UNCHANGED ? undefined : (level as ChallengeType) })
            }
            testId="rule-config-ccMaxLevel"
          />
          {timeouts.map(([key, label, max]) => (
            <OptionalNumber
              key={key}
              id={`${key}-${id}`}
              label={label}
              value={a[key]}
              scale={1000}
              min={0.1}
              max={max}
              disabled={locked && a[key] === undefined}
              onChange={(value) => onChange({ ...a, [key]: value })}
              testId={`rule-config-${key}`}
            />
          ))}
          <OptionalNumber
            id={`log-sample-${id}`}
            label={m.rules_log_sample_rate()}
            value={a.logSampleRate}
            scale={100}
            min={0}
            max={100}
            disabled={locked && a.logSampleRate === undefined}
            onChange={(logSampleRate) => set({ logSampleRate })}
            testId="rule-config-logSampleRate"
          />
        </>
      ) : null}
    </div>
  );
}

/** Which origin group serves the request, and the Host, SNI and port sent to it. */
function OriginFields({
  id,
  action: a,
  originGroups,
  onChange,
}: {
  id: string;
  action: ActionOf<"origin">;
  originGroups?: string[];
  onChange: (action: ActionOf<"origin">) => void;
}) {
  const set = (change: Partial<ActionOf<"origin">>) => onChange({ ...a, ...change });
  // A group no origin has any more still shows, so the rule can be pointed elsewhere.
  const groups = originGroups && [
    ...new Set([...originGroups, ...(a.originGroup ? [a.originGroup] : [])]),
  ];
  return (
    <>
      {groups ? (
        <FormSelect
          id={`origin-group-${id}`}
          label={m.rules_origin_group()}
          value={a.originGroup || DEFAULT_GROUP}
          options={[
            { value: DEFAULT_GROUP, label: m.site_origin_group_default() },
            ...groups.map((group) => ({ value: group, label: group })),
          ]}
          onChange={(group) => set({ originGroup: group === DEFAULT_GROUP ? "" : group })}
          testId="rule-origin-group"
        />
      ) : null}
      <Field>
        <FieldLabel htmlFor={`origin-host-${id}`}>{m.site_form_host_header()}</FieldLabel>
        <Input
          id={`origin-host-${id}`}
          value={a.hostHeader}
          maxLength={253}
          placeholder={m.rules_unchanged()}
          onChange={(e) => set({ hostHeader: e.target.value })}
          data-testid="rule-origin-host"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`origin-sni-${id}`}>{m.site_origin_sni()}</FieldLabel>
        <Input
          id={`origin-sni-${id}`}
          value={a.sni}
          maxLength={253}
          placeholder={m.rules_unchanged()}
          onChange={(e) => set({ sni: e.target.value })}
          data-testid="rule-origin-sni"
        />
      </Field>
      <OptionalNumber
        id={`origin-port-${id}`}
        label={m.site_form_port()}
        value={a.port || undefined}
        scale={1}
        min={1}
        max={65535}
        onChange={(port) => set({ port: port ?? 0 })}
        testId="rule-origin-port"
      />
    </>
  );
}

/** The codings a response may use, in preference order; none turns compression off. */
function CompressionFields({
  action: a,
  onChange,
}: {
  action: ActionOf<"compression">;
  onChange: (action: ActionOf<"compression">) => void;
}) {
  const list = a.algorithms;
  const set = (algorithms: Coding[]) => onChange({ ...a, algorithms });
  const remaining = compressionCodings.filter((coding) => !list.includes(coding));
  return (
    <FieldSet className="gap-2 sm:col-span-2">
      <FieldLegend variant="label" className="mb-1">
        {m.rules_compression_order()}
      </FieldLegend>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="rule-compression-none">
          {m.rules_compression_none()}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map((coding, index) => {
            const name = codingLabel(coding);
            return (
              <li
                key={coding}
                className="flex min-h-10 items-center gap-1 rounded-xl border py-1 pr-1 pl-3 animate-enter"
                data-testid="rule-compression-algorithm"
                data-coding={coding}
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="flex-1 text-sm">{name}</span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.rules_compression_up({ name })}
                  disabled={index === 0}
                  onClick={() => set(arrayMove(list, index, index - 1))}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.rules_compression_down({ name })}
                  disabled={index === list.length - 1}
                  onClick={() => set(arrayMove(list, index, index + 1))}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.rules_compression_remove({ name })}
                  onClick={() => set(list.filter((c) => c !== coding))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {remaining.length ? (
        <OptionSelect
          value={null}
          options={remaining.map((coding) => ({ value: coding, label: codingLabel(coding) }))}
          onChange={(coding) => set([...list, coding])}
          placeholder={m.rules_compression_add()}
          label={m.rules_compression_add()}
          size="sm"
          className="self-start"
          testId="rule-compression-add"
        />
      ) : null}
    </FieldSet>
  );
}
