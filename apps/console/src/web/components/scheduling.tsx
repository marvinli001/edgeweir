import type {
  SchedulingAction,
  SchedulingCondition,
  SchedulingMetric,
  SchedulingPreview,
  SchedulingRule,
  SchedulingRuleUpdateInput,
} from "@edgeweir/contract";
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  FlowConnectionIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { NumberField, SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { EmptyState, QueryView } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import {
  actionLabel,
  aggregateLabel,
  comparatorSign,
  conditionSubject,
  conditionText,
  formatMetric,
  isProbeMetric,
  matchLabel,
  metricLabel,
  metricUnit,
  SCHEDULING_ACTIONS,
  SCHEDULING_AGGREGATES,
  SCHEDULING_COMPARATORS,
  SCHEDULING_METRICS,
  stateLabel,
} from "@/lib/scheduling";
import { cn } from "@/lib/utils";

const MAX_CONDITIONS = 8;
const ALL_LINES = "__all__";
const ALL_REGIONS = "__all__";

/** Region names by id, for conditions limited to one region's probes. */
function useRegionName() {
  const regions = useQuery(orpc.regions.list.queryOptions());
  return React.useCallback(
    (id: string) => regions.data?.find((r) => r.id === id)?.name,
    [regions.data],
  );
}

/** The scheduling tab of a cluster: its rules and what they would do now. */
export function ClusterScheduling({ clusterId }: { clusterId: string }) {
  const rules = useQuery(
    orpc.scheduling.list.queryOptions({
      input: { clusterId },
      refetchInterval: 10_000,
      meta: { background: true },
    }),
  );
  const edit = useDialogState<SchedulingRule | "new">();
  const columns = React.useMemo<Columns<SchedulingRule>>(
    () => [
      {
        id: "name",
        header: () => m.scheduling_rule_name(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium" data-testid="scheduling-rule-name">
              {row.original.name}
            </span>
            <span className="text-xs text-muted-foreground" data-testid="scheduling-rule-line">
              {row.original.lineName ?? m.scheduling_line_all()}
            </span>
          </div>
        ),
      },
      {
        id: "conditions",
        header: () => m.scheduling_conditions(),
        cell: ({ row }) => <ConditionSummary rule={row.original} />,
      },
      {
        id: "action",
        header: () => m.scheduling_action(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="whitespace-nowrap" data-testid="scheduling-rule-action">
              {actionLabel(row.original.action)}
            </span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {m.scheduling_hold_recover({
                hold: row.original.holdSeconds,
                recover: row.original.recoverSeconds,
              })}
            </span>
          </div>
        ),
      },
      {
        id: "active",
        header: () => m.scheduling_active_nodes(),
        cell: ({ row }) =>
          row.original.activeNodes.length ? (
            <div className="flex flex-wrap gap-1" data-testid="scheduling-rule-active">
              {row.original.activeNodes.map((n) => (
                <Badge key={n.nodeId} variant="destructive" title={formatDateTime(n.since)}>
                  {n.nodeName}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "enabled",
        header: () => m.scheduling_enabled(),
        cell: ({ row }) => <RuleEnabledSwitch rule={row.original} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.scheduling_rule_edit()}
              onClick={() => edit.show(row.original)}
              data-testid="scheduling-rule-edit"
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            <DeleteRuleAction rule={row.original} />
          </div>
        ),
      },
    ],
    [edit.show],
  );

  return (
    <div className="flex flex-col gap-6" data-testid="cluster-scheduling">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-medium">{m.scheduling_rules()}</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => edit.show("new")}
            data-testid="scheduling-rule-create"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.scheduling_rule_create()}
          </Button>
        </div>
        <QueryView
          query={rules}
          empty={
            <EmptyState icon={FlowConnectionIcon} title={m.scheduling_rules_empty()}>
              <Button onClick={() => edit.show("new")}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.scheduling_rule_create()}
              </Button>
            </EmptyState>
          }
        >
          {(list) => (
            <DataTable
              data={list}
              columns={columns}
              getRowId={(r) => r.id}
              testId="scheduling-rules-table"
            />
          )}
        </QueryView>
      </section>
      {rules.data?.length ? <SchedulingPreviewSection clusterId={clusterId} /> : null}
      {edit.value ? (
        <RuleDialog
          key={edit.key}
          clusterId={clusterId}
          rule={edit.value === "new" ? undefined : edit.value}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
        />
      ) : null}
    </div>
  );
}

function ConditionSummary({ rule }: { rule: SchedulingRule }) {
  const regionName = useRegionName();
  return (
    <div className="flex flex-col gap-1 text-xs">
      {rule.conditions.length > 1 ? (
        <span className="text-muted-foreground">{matchLabel(rule.match)}</span>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {rule.conditions.map((c, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions are identified by their order
            key={index}
            className="whitespace-nowrap"
            data-testid="scheduling-rule-condition"
          >
            {conditionText(c, regionName)}
            {c.durationSeconds > 0 ? (
              <span className="text-muted-foreground">
                {" · "}
                {m.scheduling_for_seconds({ seconds: c.durationSeconds })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A component of its own: column templates are plain functions (DataTable) and hold no hooks. */
function RuleEnabledSwitch({ rule }: { rule: SchedulingRule }) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.scheduling.update.mutationOptions());
  return (
    <Switch
      checked={rule.enabled}
      disabled={update.isPending}
      aria-label={m.scheduling_enabled()}
      data-testid="scheduling-rule-enabled"
      onCheckedChange={async (enabled) => {
        try {
          await update.mutateAsync({ id: rule.id, enabled });
          await queryClient.invalidateQueries({ queryKey: orpc.scheduling.key() });
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    />
  );
}

function DeleteRuleAction({ rule }: { rule: SchedulingRule }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.scheduling.delete.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={m.common_delete()}
          data-testid="scheduling-rule-delete"
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.scheduling_rule_delete_confirm({ name: rule.name })}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        await remove.mutateAsync({ id: rule.id });
        await queryClient.invalidateQueries({ queryKey: orpc.scheduling.key() });
        toast.success(m.common_deleted());
      }}
    />
  );
}

type ConditionDraft = {
  key: number;
  metric: SchedulingMetric;
  aggregate: SchedulingCondition["aggregate"];
  comparator: SchedulingCondition["comparator"];
  threshold: string;
  durationSeconds: string;
  regionId: string | null;
};
type RuleDraft = {
  name: string;
  lineName: string | null;
  enabled: boolean;
  match: "all" | "any";
  action: SchedulingAction;
  holdSeconds: string;
  recoverSeconds: string;
  conditions: ConditionDraft[];
};

const newCondition = (): ConditionDraft => ({
  key: nextDraftKey(),
  metric: "cpu_percent",
  aggregate: "avg",
  comparator: "gt",
  threshold: "90",
  durationSeconds: "60",
  regionId: null,
});

const toDraft = (rule?: SchedulingRule): RuleDraft =>
  rule
    ? {
        name: rule.name,
        lineName: rule.lineName,
        enabled: rule.enabled,
        match: rule.match,
        action: rule.action,
        holdSeconds: String(rule.holdSeconds),
        recoverSeconds: String(rule.recoverSeconds),
        conditions: rule.conditions.map((c) => ({
          key: nextDraftKey(),
          metric: c.metric,
          aggregate: c.aggregate,
          comparator: c.comparator,
          threshold: String(c.threshold),
          durationSeconds: String(c.durationSeconds),
          regionId: c.regionId,
        })),
      }
    : {
        name: "",
        lineName: null,
        enabled: true,
        match: "all",
        action: "remove_node",
        holdSeconds: "300",
        recoverSeconds: "300",
        conditions: [newCondition()],
      };

const conditionsKey = (conditions: SchedulingCondition[]) =>
  JSON.stringify(
    conditions.map((c) => [
      c.metric,
      c.aggregate,
      c.comparator,
      c.threshold,
      c.durationSeconds,
      c.regionId,
    ]),
  );

/** Creates a rule, or edits one (sending only what changed, so an action in effect keeps going). */
function RuleDialog({
  clusterId,
  rule,
  open,
  onOpenChange,
}: {
  clusterId: string;
  rule?: SchedulingRule;
} & DialogProps) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.scheduling.create.mutationOptions());
  const update = useMutation(orpc.scheduling.update.mutationOptions());
  const binding = useQuery({
    ...orpc.dns.binding.queryOptions({ input: { clusterId } }),
    enabled: open,
  });
  const regions = useQuery({ ...orpc.regions.list.queryOptions(), enabled: open });
  const [draft, setDraft] = React.useState(() => toDraft(rule));
  const lines = [
    ...new Set([
      ...(binding.data?.binding.lines.map((l) => l.name) ?? []),
      ...(draft.lineName ? [draft.lineName] : []),
    ]),
  ];
  const patchCondition = (key: number, change: Partial<ConditionDraft>) =>
    setDraft({
      ...draft,
      conditions: draft.conditions.map((c) => (c.key === key ? { ...c, ...change } : c)),
    });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? m.scheduling_rule_edit() : m.scheduling_rule_create()}
      submitLabel={rule ? m.common_save() : m.common_create()}
      submitTestId="scheduling-rule-submit"
      className="sm:max-w-3xl"
      onSubmit={async () => {
        const input = {
          lineName: draft.lineName,
          name: draft.name.trim(),
          enabled: draft.enabled,
          match: draft.match,
          action: draft.action,
          holdSeconds: Number(draft.holdSeconds),
          recoverSeconds: Number(draft.recoverSeconds),
          conditions: draft.conditions.map((c) => ({
            metric: c.metric,
            aggregate: c.aggregate,
            comparator: c.comparator,
            threshold: Number(c.threshold),
            durationSeconds: Number(c.durationSeconds),
            regionId: isProbeMetric(c.metric) ? c.regionId : null,
          })),
        };
        if (input.action === "backup_group" && !input.lineName)
          throw new Error(m.error_scheduling_rule_invalid());
        if (rule) {
          const patch: SchedulingRuleUpdateInput = { id: rule.id };
          if (input.name !== rule.name) patch.name = input.name;
          if (input.lineName !== rule.lineName) patch.lineName = input.lineName;
          if (input.enabled !== rule.enabled) patch.enabled = input.enabled;
          if (input.match !== rule.match) patch.match = input.match;
          if (input.action !== rule.action) patch.action = input.action;
          if (input.holdSeconds !== rule.holdSeconds) patch.holdSeconds = input.holdSeconds;
          if (input.recoverSeconds !== rule.recoverSeconds)
            patch.recoverSeconds = input.recoverSeconds;
          if (conditionsKey(input.conditions) !== conditionsKey(rule.conditions))
            patch.conditions = input.conditions;
          if (Object.keys(patch).length > 1) await update.mutateAsync(patch);
        } else {
          await create.mutateAsync({ clusterId, ...input });
        }
        await queryClient.invalidateQueries({ queryKey: orpc.scheduling.key() });
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="scheduling-rule-name">{m.scheduling_rule_name()}</FieldLabel>
          <Input
            id="scheduling-rule-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            maxLength={100}
            data-testid="scheduling-rule-name-input"
          />
        </Field>
        <FormSelect
          id="scheduling-rule-line"
          label={m.scheduling_line()}
          value={draft.lineName ?? ALL_LINES}
          options={[
            { value: ALL_LINES, label: m.scheduling_line_all() },
            ...lines.map((line) => ({ value: line, label: line })),
          ]}
          onChange={(value) => setDraft({ ...draft, lineName: value === ALL_LINES ? null : value })}
          testId="scheduling-rule-line-select"
        />
        <FormSelect
          id="scheduling-rule-action"
          label={m.scheduling_action()}
          value={draft.action}
          options={SCHEDULING_ACTIONS.map((action) => ({
            value: action,
            label: actionLabel(action),
          }))}
          onChange={(action) => setDraft({ ...draft, action: action as SchedulingAction })}
          testId="scheduling-rule-action-select"
        />
        <FormSelect
          id="scheduling-rule-match"
          label={m.scheduling_match()}
          value={draft.match}
          options={(["all", "any"] as const).map((match) => ({
            value: match,
            label: matchLabel(match),
          }))}
          onChange={(match) => setDraft({ ...draft, match: match as "all" | "any" })}
          testId="scheduling-rule-match-select"
        />
        <NumberField
          id="scheduling-rule-hold"
          label={m.scheduling_hold()}
          value={draft.holdSeconds}
          onChange={(holdSeconds) => setDraft({ ...draft, holdSeconds })}
          min={0}
          max={86400}
          step={1}
          required
          testId="scheduling-rule-hold"
        />
        <NumberField
          id="scheduling-rule-recover"
          label={m.scheduling_recover()}
          value={draft.recoverSeconds}
          onChange={(recoverSeconds) => setDraft({ ...draft, recoverSeconds })}
          min={0}
          max={86400}
          step={1}
          required
          testId="scheduling-rule-recover"
        />
      </div>
      <SwitchField
        id="scheduling-rule-enabled"
        label={m.scheduling_enabled()}
        checked={draft.enabled}
        onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
        className="self-start"
        testId="scheduling-rule-enabled-input"
      />
      <FieldSet className="gap-3">
        <FieldLegend variant="label">{m.scheduling_conditions()}</FieldLegend>
        <ol className="flex flex-col gap-3">
          {draft.conditions.map((c, index) => (
            <ConditionEditor
              key={c.key}
              index={index}
              condition={c}
              regions={regions.data ?? []}
              removable={draft.conditions.length > 1}
              onChange={(change) => patchCondition(c.key, change)}
              onRemove={() =>
                setDraft({
                  ...draft,
                  conditions: draft.conditions.filter((other) => other.key !== c.key),
                })
              }
            />
          ))}
        </ol>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={draft.conditions.length >= MAX_CONDITIONS}
          onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, newCondition()] })}
          data-testid="scheduling-condition-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.scheduling_condition_add()}
        </Button>
      </FieldSet>
    </FormDialog>
  );
}

function ConditionEditor({
  index,
  condition: c,
  regions,
  removable,
  onChange,
  onRemove,
}: {
  index: number;
  condition: ConditionDraft;
  regions: { id: string; name: string; code: string }[];
  removable: boolean;
  onChange: (change: Partial<ConditionDraft>) => void;
  onRemove: () => void;
}) {
  const probe = isProbeMetric(c.metric);
  const unit = metricUnit(c.metric);
  const id = (field: string) => `scheduling-condition-${c.key}-${field}`;
  return (
    <li
      className="grid gap-3 rounded-xl border p-3 animate-enter"
      style={{ animationDelay: `${index * 40}ms` }}
      data-testid="scheduling-condition"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{index + 1}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!removable}
          aria-label={m.scheduling_condition_remove({ index: index + 1 })}
          onClick={onRemove}
          data-testid="scheduling-condition-remove"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <FormSelect
            id={id("metric")}
            label={m.scheduling_metric()}
            value={c.metric}
            options={SCHEDULING_METRICS.map((metric) => ({
              value: metric,
              label: metricLabel(metric),
            }))}
            onChange={(value) => {
              const metric = value as SchedulingMetric;
              onChange({ metric, regionId: isProbeMetric(metric) ? c.regionId : null });
            }}
            testId="scheduling-condition-metric"
          />
        </div>
        <FormSelect
          id={id("comparator")}
          label={m.scheduling_comparator()}
          value={c.comparator}
          options={SCHEDULING_COMPARATORS.map((comparator) => ({
            value: comparator,
            label: comparatorSign(comparator),
          }))}
          onChange={(value) => onChange({ comparator: value as ConditionDraft["comparator"] })}
          testId="scheduling-condition-comparator"
        />
        <NumberField
          id={id("threshold")}
          label={unit ? m.scheduling_threshold_unit({ unit }) : m.scheduling_threshold()}
          value={c.threshold}
          onChange={(threshold) => onChange({ threshold })}
          min={0}
          step="any"
          required
          testId="scheduling-condition-threshold"
        />
        <NumberField
          id={id("duration")}
          label={m.scheduling_duration()}
          value={c.durationSeconds}
          onChange={(durationSeconds) => onChange({ durationSeconds })}
          min={0}
          max={3600}
          step={1}
          required
          testId="scheduling-condition-duration"
        />
        {probe ? (
          <>
            <FormSelect
              id={id("aggregate")}
              label={m.scheduling_aggregate()}
              value={c.aggregate}
              options={SCHEDULING_AGGREGATES.map((aggregate) => ({
                value: aggregate,
                label: aggregateLabel(aggregate),
              }))}
              onChange={(value) => onChange({ aggregate: value as ConditionDraft["aggregate"] })}
              testId="scheduling-condition-aggregate"
            />
            <div className="col-span-2 sm:col-span-1">
              <FormSelect
                id={id("region")}
                label={m.node_groups_region()}
                value={c.regionId ?? ALL_REGIONS}
                options={[
                  { value: ALL_REGIONS, label: m.scheduling_region_all() },
                  ...regions.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` })),
                ]}
                onChange={(value) => onChange({ regionId: value === ALL_REGIONS ? null : value })}
                testId="scheduling-condition-region"
              />
            </div>
          </>
        ) : null}
      </div>
    </li>
  );
}

type PreviewRule = SchedulingPreview["rules"][number];
type PreviewNode = PreviewRule["nodes"][number];
type PreviewCondition = PreviewNode["conditions"][number];

/** Every rule against every node under the current metrics (refreshed with the rules). */
function SchedulingPreviewSection({ clusterId }: { clusterId: string }) {
  const preview = useQuery(
    orpc.scheduling.preview.queryOptions({
      input: { clusterId },
      refetchInterval: 10_000,
      meta: { background: true },
    }),
  );
  return (
    <section className="flex flex-col gap-3" data-testid="scheduling-preview">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{m.scheduling_preview()}</h2>
        {preview.data ? (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(preview.data.evaluatedAt)}
          >
            {timeAgo(preview.data.evaluatedAt)}
          </span>
        ) : null}
      </div>
      <QueryView query={preview}>
        {(data) =>
          data.rules.map((rule, index) => (
            <PreviewRuleBlock key={rule.ruleId} rule={rule} index={index} />
          ))
        }
      </QueryView>
    </section>
  );
}

const stateVariant = (state: PreviewNode["state"]) =>
  (
    ({
      idle: "outline",
      pending: "secondary",
      active: "destructive",
      recovering: "secondary",
    }) as const
  )[state];

function PreviewRuleBlock({ rule, index }: { rule: PreviewRule; index: number }) {
  const regionName = useRegionName();
  return (
    <div
      className="overflow-hidden rounded-2xl border bg-card shadow-xs animate-enter"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      data-testid="scheduling-preview-rule"
      data-rule-id={rule.ruleId}
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/60 px-4 py-2.5">
        <span className="mr-auto font-medium">{rule.ruleName}</span>
        {rule.enabled ? null : <Badge variant="outline">{m.nodes_disabled()}</Badge>}
        <Badge variant="outline">{rule.lineName ?? m.scheduling_line_all()}</Badge>
        <Badge variant="secondary">{actionLabel(rule.action)}</Badge>
      </div>
      {rule.nodes.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{m.nodes_empty_title()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.nodes_col_name()}</TableHead>
              <TableHead>{m.nodes_col_status()}</TableHead>
              <TableHead>{m.scheduling_conditions()}</TableHead>
              <TableHead>{m.scheduling_outcome()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rule.nodes.map((node) => (
              <TableRow
                key={node.nodeId}
                data-testid="scheduling-preview-node"
                data-node-id={node.nodeId}
                data-state={node.state}
              >
                <TableCell className="align-top font-medium">{node.nodeName}</TableCell>
                <TableCell className="align-top">
                  <Badge variant={stateVariant(node.state)} data-testid="scheduling-preview-state">
                    {stateLabel(node.state)}
                  </Badge>
                </TableCell>
                <TableCell className="align-top">
                  <ul className="flex flex-col gap-1">
                    {node.conditions.map((c, i) => (
                      <PreviewConditionItem
                        // biome-ignore lint/suspicious/noArrayIndexKey: conditions are identified by their order
                        key={i}
                        condition={c}
                        regionName={regionName}
                      />
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="align-top text-xs">
                  <Outcome node={node} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function PreviewConditionItem({
  condition: c,
  regionName,
}: {
  condition: PreviewCondition;
  regionName: (id: string) => string | undefined;
}) {
  const tone: StatusTone =
    c.value === null ? "idle" : c.satisfied ? "bad" : c.holds ? "warn" : "good";
  return (
    <li
      className="flex items-center gap-1.5 text-xs whitespace-nowrap"
      data-testid="scheduling-preview-condition"
      data-holds={c.holds}
      data-satisfied={c.satisfied}
    >
      <Dot tone={tone} small />
      <span>{conditionSubject(c, regionName)}</span>
      <span className="font-medium tabular-nums" data-testid="scheduling-preview-value">
        {c.value === null ? m.scheduling_no_data() : formatMetric(c.metric, c.value)}
      </span>
      <span className="text-muted-foreground">
        {comparatorSign(c.comparator)} {formatMetric(c.metric, c.threshold)}
      </span>
      {c.durationSeconds > 0 ? (
        <span className={cn("tabular-nums", c.satisfied ? "" : "text-muted-foreground")}>
          {m.scheduling_held({
            held: Math.min(c.heldSeconds, c.durationSeconds),
            duration: c.durationSeconds,
          })}
        </span>
      ) : null}
    </li>
  );
}

function Outcome({ node }: { node: PreviewNode }) {
  if (node.wouldActivate)
    return (
      <span className="text-destructive" data-testid="scheduling-preview-outcome">
        {m.scheduling_outcome_activate()}
      </span>
    );
  if (node.wouldRecover)
    return <span data-testid="scheduling-preview-outcome">{m.scheduling_outcome_recover()}</span>;
  if (node.inEffect)
    return (
      <span data-testid="scheduling-preview-outcome">
        {node.recoversAt
          ? m.scheduling_outcome_in_effect({ time: formatDateTime(node.recoversAt) })
          : m.scheduling_outcome_active()}
      </span>
    );
  return (
    <span className="text-muted-foreground" data-testid="scheduling-preview-outcome">
      {m.scheduling_outcome_none()}
    </span>
  );
}
