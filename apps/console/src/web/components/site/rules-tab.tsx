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
  type Site,
  siteRuleInput,
  staticRedirectTarget,
} from "@edgeweir/contract";
import {
  type ChallengeType,
  challengeTypes,
  compressionCodings,
  crsOverrides,
  MAX_HOST_HEADER_LENGTH,
  type Phase,
  phases,
  QUERY_NAME_RE,
  RULE_BAN,
  rateLimitKeys,
  respondContentTypes,
  respondStatus,
  validHostHeader,
  validRespondBody,
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
import { durationLabel } from "@/components/ban-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { PresetSelect, usePreset } from "@/components/preset-select";
import { SafetyNote } from "@/components/safety-note";
import { ExpressionEditor, expressionFailure } from "@/components/site/expression-editor";
import { ListInput, NumberField, SwitchField } from "@/components/site/fields";
import { RulesBodyLimitCard } from "@/components/site/rules-body-limit-card";
import { nextDraftKey, SaveBar } from "@/components/site/save-site";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { expressionErrorText, expressionReason } from "@/lib/expressions";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { challengeLabel, wafModeLabel } from "@/lib/protection";
import {
  type Action,
  type ActionOf,
  defaultAction,
  type Kind,
  RULE_BAN_DURATIONS,
  type SkipTarget,
  toggleSkip,
  WAF_V2_KINDS,
  withAccessLog,
  withRateLimitBan,
  withRespondStatus,
} from "@/lib/rule-actions";
import { cn } from "@/lib/utils";
import { randomUuid } from "@/lib/uuid";

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
  "waf-custom": ["block", "log", "allow", "challenge", "ban", "respond", "close", "skip"],
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
    ban: m.rules_ban,
    respond: m.rules_respond,
    close: m.rules_close,
    skip: m.rules_skip,
  })[kind]();
const codingLabel = (coding: Coding) =>
  ({ zstd: m.compression_zstd, br: m.compression_brotli, gzip: m.cert_gzip })[coding]();
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
  // A header's value expression (rules-v3) is its value.
  expression: m.rules_value,
  append: m.rules_append_header,
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
  requestBodyLimit: m.rules_request_body_limit,
  banScope: m.rules_ban_scope,
  banPrefixV4: m.rules_ban_prefix_v4,
  banPrefixV6: m.rules_ban_prefix_v6,
  contentType: m.rules_respond_type,
  body: m.rules_respond_body,
  errorPage: m.rules_respond_error_page,
  skip: m.rules_skip_targets,
  crs: m.rules_config_crs,
};

/** Whether the site's cluster lacks site-content-v1 (config rules' body limit). */
const ContentLock = React.createContext(false);
/**
 * What the site's cluster lacks of G14 (waf-v2 actions and settings, rules-body-v1 body fields,
 * challenge-v2 crawler fields), and whether these are platform rules (only they ban everywhere).
 */
interface Locks {
  wafV2: boolean;
  body: boolean;
  bot: boolean;
  platform: boolean;
}
const LocksContext = React.createContext<Locks>({
  wafV2: false,
  body: false,
  bot: false,
  platform: false,
});
/** The label of the field an issue of `row` points at. */
function issueField(row: RuleDto, path: readonly PropertyKey[]): string {
  const [head, field] = path;
  if (head === "name") return m.rules_name();
  if (head === "expression") return m.rules_expression();
  if (head !== "action" || typeof field !== "string") return m.rules_action();
  // A ban's duration, or a rate limit's ban over the limit.
  if (field === "banSeconds")
    return row.action.kind === "rate_limit" ? m.rules_rate_ban() : m.rules_ban_seconds();
  // Redirects and rewrites label their static value as the target.
  if (field === "value")
    return row.action.kind === "redirect" || row.action.kind === "rewrite"
      ? m.rules_target()
      : m.rules_value();
  return (actionFieldLabels[field] ?? m.rules_action)();
}
/** Why a rule cannot be saved: the field, and where and why an expression fails. */
/** A Host header nodes refuse (they drop the rule); empty keeps the origin's. */
const invalidHostHeader = (value: string) => {
  const host = value.trim();
  return host !== "" && !validHostHeader(host);
};

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
 * groups; the rule engine extensions (rules-v2), additions (rules-v3), the WAF actions (waf-v2),
 * the request body fields (rules-body-v1) and the crawler fields (challenge-v2) stay locked while
 * the cluster's nodes lack them. With `site`, the tab also sets how much body the rules read.
 */
export function RulesTab({
  siteId,
  originGroups,
  site,
}: {
  siteId?: string;
  originGroups?: string[];
  site?: Site;
}) {
  const query = useQuery(
    siteId
      ? orpc.rules.get.queryOptions({ input: { id: siteId } })
      : orpc.platformRules.get.queryOptions(),
  );
  const features = useQuery({
    ...orpc.sites.features.queryOptions({ input: { id: siteId ?? "" } }),
    enabled: !!siteId,
  });
  const editor = (rules: RuleDto[], available?: SiteFeatures) => (
    <ContentLock.Provider value={available?.siteContent.available === false}>
      <LocksContext.Provider
        value={{
          wafV2: available?.wafV2.available === false,
          body: available?.rulesBody.available === false,
          bot: available?.challengeV2.available === false,
          platform: !siteId,
        }}
      >
        <RulesEditor
          key={JSON.stringify(rules)}
          initial={rules}
          siteId={siteId}
          originGroups={siteId ? (originGroups ?? []) : undefined}
          features={available}
          locked={available?.rulesV2.available === false}
          lockedV3={available?.rulesV3.available === false}
        />
      </LocksContext.Provider>
    </ContentLock.Provider>
  );
  // Platform rules have no site features to wait for.
  return (
    <div className="flex flex-col gap-5">
      <QueryView query={query}>
        {(rules) =>
          siteId ? (
            <QueryView query={features}>{(available) => editor(rules, available)}</QueryView>
          ) : (
            editor(rules)
          )
        }
      </QueryView>
      {site ? <RulesBodyLimitCard site={site} /> : null}
    </div>
  );
}

type SiteFeatures = Record<
  "rulesV2" | "rulesV3" | "siteContent" | "wafV2" | "rulesBody" | "challengeV2",
  FeatureAvailability
>;

/**
 * The one line on what the cluster's nodes cannot run yet: the rule engine extensions, or else
 * the first of the later additions they lack (test id names it).
 */
function UnavailableNote({ features }: { features?: SiteFeatures }) {
  if (!features) return null;
  if (!features.rulesV2.available)
    return (
      <SafetyNote
        className="animate-in fade-in"
        data-testid="rules-v2-unavailable"
        data-reason={features.rulesV2.reason ?? undefined}
      >
        {m.rules_v2_unavailable()}
      </SafetyNote>
    );
  const missing = (
    [
      ["rules-v3", features.rulesV3],
      ["rules-waf-v2", features.wafV2],
      ["rules-body", features.rulesBody],
      ["rules-challenge-v2", features.challengeV2],
    ] as const
  ).find(([, availability]) => !availability.available);
  return missing ? (
    <SafetyNote
      className="animate-in fade-in"
      data-testid={`${missing[0]}-unavailable`}
      data-reason={missing[1].reason ?? undefined}
    >
      {m.feature_unavailable_nodes()}
    </SafetyNote>
  ) : null;
}
function RulesEditor({
  initial,
  siteId,
  originGroups,
  features,
  locked,
  lockedV3,
}: {
  initial: RuleDto[];
  siteId?: string;
  originGroups?: string[];
  features?: SiteFeatures;
  locked: boolean;
  /** The rules-v3 additions wait until the cluster's nodes run them. */
  lockedV3: boolean;
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
        // A site's rules ban on the request's site only.
        const schema = siteId ? siteRuleInput : ruleInput;
        for (const row of rows) {
          const parsed = schema.safeParse(row);
          if (!parsed.success) {
            setError(ruleIssueText(row, parsed.error.issues[0]));
            return;
          }
          const { action } = parsed.data;
          if (action.kind === "origin" && invalidHostHeader(action.hostHeader)) {
            setError(m.rules_check_rule({ name: row.name, field: m.site_form_host_header() }));
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
      <UnavailableNote features={features} />
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
            // A card per phase; its rules are flat rows split by hairlines.
            <section
              key={phase}
              className="flex flex-col rounded-2xl bg-card shadow-elev-1 edge-lit animate-enter"
              data-testid={`rules-phase-${phase}`}
            >
              <div className="flex min-h-14 items-center justify-between gap-3 px-5 py-3">
                <h3 className="font-heading text-base font-medium">{phaseLabel(phase)}</h3>
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
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
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
                    lockedV3={lockedV3}
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
  lockedV3,
  patch,
  remove,
}: {
  row: RuleDto;
  /** The site's origin groups besides the default one; undefined for platform rules. */
  originGroups?: string[];
  locked: boolean;
  lockedV3: boolean;
  patch: (update: Partial<RuleDto>) => void;
  remove: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.id,
    attributes: { roleDescription: m.site_rule_role() },
    transition: reducedMotion ? null : undefined,
  });
  const locks = React.useContext(LocksContext);
  const a = row.action;
  const kindOptions = kinds[row.phase]
    .filter(
      (kind) =>
        kind === a.kind ||
        !((locked && v2Kinds.has(kind)) || (locks.wafV2 && WAF_V2_KINDS.has(kind))),
    )
    .map((kind) => ({ value: kind, label: actionLabel(kind) }));
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "grid gap-4 border-t px-5 pt-4 pb-5 last:rounded-b-2xl",
        // Lifted only while it is carried.
        isDragging && "relative z-10 rounded-2xl bg-card shadow-elev-2",
      )}
      data-testid="rule-row"
    >
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
        hideRulesV3={lockedV3}
        hideRulesBody={locks.body}
        hideBotFields={locks.bot}
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
            if (action.kind === "origin" && originGroups?.[0]) action.originGroup = originGroups[0];
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
          lockedV3={lockedV3}
          onChange={(action) => patch({ action })}
        />
      </div>
    </div>
  );
}

/** The fields of a rule's action, as cells of the row's two-column grid. */
function ActionFields({
  id,
  phase,
  action: a,
  originGroups,
  locked,
  lockedV3,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: Action;
  originGroups?: string[];
  locked: boolean;
  lockedV3: boolean;
  onChange: (action: Action) => void;
}) {
  switch (a.kind) {
    case "redirect":
    case "rewrite":
      return (
        <TargetFields
          id={id}
          phase={phase}
          action={a}
          locked={locked}
          lockedV3={lockedV3}
          onChange={onChange}
        />
      );
    case "request_header":
    case "response_header":
      return (
        <HeaderFields id={id} phase={phase} action={a} lockedV3={lockedV3} onChange={onChange} />
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
    case "log":
      return <LogFields id={id} action={a} onChange={onChange} />;
    case "ban":
      return <BanFields id={id} action={a} onChange={onChange} />;
    case "respond":
      return <RespondFields id={id} action={a} onChange={onChange} />;
    case "skip":
      return <SkipFields id={id} action={a} onChange={onChange} />;
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
  const locks = React.useContext(LocksContext);
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
      <IntegerField
        id={`rate-ban-${id}`}
        label={m.rules_rate_ban()}
        value={a.banSeconds ?? 0}
        min={0}
        max={RULE_BAN.rateLimitSeconds.max}
        invalid={(n) => n !== 0 && (n < RULE_BAN.rateLimitSeconds.min || !Number.isInteger(n))}
        disabled={locks.wafV2 && !a.banSeconds}
        onChange={(seconds) => onChange(withRateLimitBan(a, seconds))}
        testId="rule-rate-ban"
      />
    </>
  );
}

/**
 * A whole number kept as text while it is edited (empty reads as 0), so a field can be cleared
 * and typed into without jumping; `invalid` marks values the contract refuses.
 */
function IntegerField({
  id,
  label,
  value,
  min,
  max,
  invalid,
  disabled,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  invalid?: (value: number) => boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
  testId?: string;
}) {
  const parse = (text: string) => (text.trim() === "" ? 0 : Number(text));
  const [text, setText] = React.useState(() => String(value));
  const shown = parse(text) === value ? text : String(value);
  return (
    <NumberField
      id={id}
      label={label}
      value={shown}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      invalid={
        Number.isNaN(parse(shown)) ||
        parse(shown) < min ||
        parse(shown) > max ||
        (invalid?.(parse(shown)) ?? false)
      }
      onChange={(next) => {
        setText(next);
        onChange(parse(next));
      }}
      testId={testId}
    />
  );
}

/** A log rule's access log line, written whatever the sample rate (waf-v2). */
function LogFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"log">;
  onChange: (action: Action) => void;
}) {
  const locks = React.useContext(LocksContext);
  return (
    <SwitchField
      id={`access-log-${id}`}
      label={m.rules_log_access_log()}
      checked={a.accessLog === true}
      disabled={locks.wafV2 && a.accessLog !== true}
      onCheckedChange={(on) => onChange(withAccessLog(a, on))}
      testId="rule-log-access-log"
    />
  );
}

/** Select value of a ban duration entered in seconds. */
const CUSTOM = "custom";

/**
 * A ban: how long (a named duration or seconds), where (platform rules: every site), and how
 * much of the address (IPv4 and IPv6 prefix lengths).
 */
function BanFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"ban">;
  onChange: (action: Action) => void;
}) {
  const locks = React.useContext(LocksContext);
  const [custom, setCustom] = React.useState(() => !RULE_BAN_DURATIONS.includes(a.banSeconds));
  const set = (change: Partial<ActionOf<"ban">>) => onChange({ ...a, ...change });
  const prefixes = (range: { min: number; max: number }) =>
    Array.from({ length: range.max - range.min + 1 }, (_, i) => String(range.max - i)).map(
      (bits) => ({ value: bits, label: `/${bits}` }),
    );
  return (
    <>
      <FormSelect
        id={`ban-duration-${id}`}
        label={m.rules_ban_duration()}
        value={custom ? CUSTOM : String(a.banSeconds)}
        options={[
          ...RULE_BAN_DURATIONS.map((seconds) => ({
            value: String(seconds),
            label: durationLabel(seconds),
          })),
          { value: CUSTOM, label: m.preset_custom() },
        ]}
        onChange={(choice) => {
          setCustom(choice === CUSTOM);
          if (choice !== CUSTOM) set({ banSeconds: Number(choice) });
        }}
        testId="rule-ban-duration"
      />
      {custom ? (
        <IntegerField
          id={`ban-seconds-${id}`}
          label={m.rules_ban_seconds()}
          value={a.banSeconds}
          min={RULE_BAN.seconds.min}
          max={RULE_BAN.seconds.max}
          onChange={(banSeconds) => set({ banSeconds })}
          testId="rule-ban-seconds"
        />
      ) : null}
      {locks.platform ? (
        <FormSelect
          id={`ban-scope-${id}`}
          label={m.rules_ban_scope()}
          value={a.banScope}
          options={[
            { value: "site", label: m.rules_ban_scope_site() },
            { value: "platform", label: m.rules_ban_scope_platform() },
          ]}
          onChange={(scope) => set({ banScope: scope as ActionOf<"ban">["banScope"] })}
          testId="rule-ban-scope"
        />
      ) : null}
      <FormSelect
        id={`ban-v4-${id}`}
        label={m.rules_ban_prefix_v4()}
        value={String(a.banPrefixV4)}
        options={prefixes(RULE_BAN.prefixV4)}
        onChange={(bits) => set({ banPrefixV4: Number(bits) })}
        testId="rule-ban-prefix-v4"
      />
      <FormSelect
        id={`ban-v6-${id}`}
        label={m.rules_ban_prefix_v6()}
        value={String(a.banPrefixV6)}
        options={prefixes(RULE_BAN.prefixV6)}
        onChange={(bits) => set({ banPrefixV6: Number(bits) })}
        testId="rule-ban-prefix-v6"
      />
    </>
  );
}

/**
 * A custom response: the status and either a static body of a content type or the site's error
 * page of the status (4xx and 5xx); 204 has no body.
 */
function RespondFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"respond">;
  onChange: (action: Action) => void;
}) {
  const set = (change: Partial<ActionOf<"respond">>) => onChange({ ...a, ...change });
  const errorPages = a.statusCode >= 400;
  return (
    <>
      <IntegerField
        id={`respond-status-${id}`}
        label={m.rules_status()}
        value={a.statusCode}
        min={200}
        max={599}
        invalid={(status) => !respondStatus(status)}
        onChange={(status) => onChange(withRespondStatus(a, status))}
        testId="rule-respond-status"
      />
      {errorPages ? (
        <SwitchField
          id={`respond-error-page-${id}`}
          label={m.rules_respond_error_page()}
          checked={a.errorPage}
          // An error page has no body of its own.
          onCheckedChange={(errorPage) => set(errorPage ? { errorPage, body: "" } : { errorPage })}
          testId="rule-respond-error-page"
        />
      ) : null}
      {a.errorPage ? null : (
        <>
          <FormSelect
            id={`respond-type-${id}`}
            label={m.rules_respond_type()}
            value={a.contentType}
            options={respondContentTypes.map((type) => ({ value: type, label: type }))}
            onChange={(type) => set({ contentType: type as ActionOf<"respond">["contentType"] })}
            testId="rule-respond-type"
          />
          {a.statusCode === 204 ? null : (
            <Field
              className="min-w-0 sm:col-span-2"
              data-invalid={!validRespondBody(a.body) || undefined}
            >
              <FieldLabel htmlFor={`respond-body-${id}`}>{m.rules_respond_body()}</FieldLabel>
              <Textarea
                id={`respond-body-${id}`}
                value={a.body}
                rows={3}
                spellCheck={false}
                aria-invalid={!validRespondBody(a.body) || undefined}
                onChange={(e) => set({ body: e.target.value })}
                className="max-h-64 font-mono"
                data-testid="rule-respond-body"
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}

/** What a skip rule skips, in the order a request meets them. */
const SKIP_CHOICES: readonly [SkipTarget, () => string][] = [
  ["rules", m.rules_skip_rules],
  ["rate_limits", m.rules_skip_rate_limits],
  ["crs", m.rules_skip_crs],
  ["challenges", m.rules_skip_challenges],
];

/** The checks a skip rule skips for the request (at least one). */
function SkipFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"skip">;
  onChange: (action: Action) => void;
}) {
  return (
    <FieldSet className="gap-2 sm:col-span-2" data-invalid={a.skip.length === 0 || undefined}>
      <FieldLegend variant="label" className="mb-1">
        {m.rules_skip_targets()}
      </FieldLegend>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {SKIP_CHOICES.map(([target, label]) => (
          <Field key={target} orientation="horizontal" className="w-auto">
            <Checkbox
              id={`skip-${target}-${id}`}
              checked={a.skip.includes(target)}
              aria-invalid={a.skip.length === 0 || undefined}
              onCheckedChange={(on) => onChange({ ...a, skip: toggleSkip(a.skip, target, on) })}
              data-testid={`rule-skip-${target}`}
            />
            <FieldLabel htmlFor={`skip-${target}-${id}`} className="font-normal">
              {label()}
            </FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
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
function HeaderFields({
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
  // The body limit waits until the cluster's nodes run site-content-v1, the CRS override waf-v2.
  const contentLocked = React.useContext(ContentLock);
  const wafV2Locked = React.useContext(LocksContext).wafV2;
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
          <OptionalNumber
            id={`body-limit-${id}`}
            label={m.rules_request_body_limit()}
            value={a.requestBodyLimit}
            scale={1024 * 1024}
            min={0}
            max={10240}
            disabled={contentLocked && a.requestBodyLimit === undefined}
            onChange={(requestBodyLimit) => set({ requestBodyLimit })}
            testId="rule-config-requestBodyLimit"
          />
          <FormSelect
            id={`crs-${id}`}
            label={m.rules_config_crs()}
            value={a.crs ?? UNCHANGED}
            options={[
              { value: UNCHANGED, label: m.rules_unchanged() },
              ...crsOverrides.map((mode) => ({ value: mode, label: wafModeLabel(mode) })),
            ]}
            disabled={wafV2Locked && a.crs === undefined}
            onChange={(mode) =>
              set({ crs: mode === UNCHANGED ? undefined : (mode as (typeof crsOverrides)[number]) })
            }
            testId="rule-config-crs"
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
  const hostInvalid = invalidHostHeader(a.hostHeader);
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
      <Field data-invalid={hostInvalid || undefined}>
        <FieldLabel htmlFor={`origin-host-${id}`}>{m.site_form_host_header()}</FieldLabel>
        <Input
          id={`origin-host-${id}`}
          value={a.hostHeader}
          maxLength={MAX_HOST_HEADER_LENGTH}
          placeholder={m.rules_unchanged()}
          onChange={(e) => set({ hostHeader: e.target.value })}
          aria-invalid={hostInvalid || undefined}
          data-testid="rule-origin-host"
        />
        {hostInvalid ? (
          <FieldError className="animate-in fade-in" data-testid="rule-origin-host-invalid">
            {m.site_form_host_header_invalid()}
          </FieldError>
        ) : null}
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
                className="flex min-h-10 items-center gap-1 rounded-xl sunk-well py-1 pr-1 pl-3 animate-enter"
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
