import { CSS } from "@dnd-kit/utilities";
import type { RuleDto } from "@edgeweir/contract";
import type { ChallengeType, Phase } from "@edgeweir/rule-engine";
import { Delete02Icon, DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { FormSelect } from "@/components/form-select";
import { ExpressionEditor } from "@/components/site/expression-editor";
import { SwitchField } from "@/components/site/fields";
import { StatusSelect } from "@/components/site/rules/fields/common";
import {
  CompressionFields,
  ConfigFields,
  OriginFields,
} from "@/components/site/rules/fields/config";
import {
  BanFields,
  LogFields,
  RateLimitFields,
  RespondFields,
  SkipFields,
} from "@/components/site/rules/fields/protection";
import { HeaderFields, TargetFields } from "@/components/site/rules/fields/transform";
import { RuleHistoryButton } from "@/components/site/rules/history";
import { actionLabel, kinds, LocksContext, v2Kinds } from "@/components/site/rules/labels";
import { useSortableRow } from "@/components/sortable-list";
import { m } from "@/lib/i18n";
import { challengeKindOptions } from "@/lib/protection";
import {
  type Action,
  CHALLENGE_V3_KINDS,
  defaultAction,
  type Kind,
  WAF_V2_KINDS,
} from "@/lib/rule-actions";
import { cn } from "@/lib/utils";

export function RuleRow({
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
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortableRow(row.id);
  const locks = React.useContext(LocksContext);
  const a = row.action;
  const kindOptions = kinds[row.phase]
    .filter(
      (kind) =>
        kind === a.kind ||
        !(
          (locked && v2Kinds.has(kind)) ||
          (locks.wafV2 && WAF_V2_KINDS.has(kind)) ||
          (locks.managed && CHALLENGE_V3_KINDS.has(kind))
        ),
    )
    .map((kind) => ({ value: kind, label: actionLabel(kind) }));
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "grid gap-4 border-t px-5 pt-4 pb-5 last:rounded-b-2xl",
        // Lifted only while it is carried.
        isDragging && "relative z-10 rounded-lg bg-card shadow-elev-2",
      )}
      data-testid="rule-row"
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          ref={setActivatorNodeRef}
          className="icon-button cursor-grab touch-none active:cursor-grabbing"
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
        <RuleHistoryButton ruleId={row.id} />
        <Button
          className="icon-button"
          type="button"
          size="sm"
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
          options={challengeKindOptions(false)}
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
