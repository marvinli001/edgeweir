import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type RuleDto, type RuleInput, ruleInput, siteRuleInput } from "@edgeweir/contract";
import { phases } from "@edgeweir/rule-engine";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { SafetyNote } from "@/components/safety-note";
import { DeletedRules, RuleHistoryContext } from "@/components/site/rules/history";
import {
  kinds,
  phaseLabel,
  ruleIssueText,
  type SiteFeatures,
  v2Kinds,
} from "@/components/site/rules/labels";
import { RuleRow } from "@/components/site/rules/rule-row";
import { SaveBar } from "@/components/site/save-site";
import { SortableList } from "@/components/sortable-list";
import { EmptyState } from "@/components/states";
import { m } from "@/lib/i18n";
import { invalidHostHeader } from "@/lib/lists";
import { client, errorMessage } from "@/lib/orpc";
import { defaultAction } from "@/lib/rule-actions";
import { randomUuid } from "@/lib/uuid";

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
export function RulesEditor({
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
  const save = useMutation({
    mutationFn: async (rules: RuleInput[]) => {
      if (siteId) await client.rules.save({ id: siteId, rules });
      else await client.platformRules.save({ rules });
    },
    // Rules reach revisions, the sites' delivery and the platform's views.
    meta: { invalidates: "all", success: m.common_saved },
  });
  const dirty = JSON.stringify(initial) !== JSON.stringify(rows);
  const history = React.useMemo(
    () => ({ siteId, saved: new Map(initial.map((rule) => [rule.id, rule])), dirty }),
    [siteId, initial, dirty],
  );
  const position = (id: unknown) => rows.findIndex((r) => r.id === id) + 1;
  const patch = (id: string, update: Partial<RuleDto>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...update } : row)));
  return (
    <RuleHistoryContext.Provider value={history}>
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
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <UnavailableNote features={features} />
        <DeletedRules />
        {rows.length === 0 ? <EmptyState title={m.rules_empty()} /> : null}
        <SortableList
          position={position}
          activationDistance={8}
          onMove={(active, over) => {
            const from = position(active) - 1,
              to = position(over) - 1;
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
                className="flex flex-col rounded-lg border bg-card animate-enter"
                data-testid={`rules-phase-${phase}`}
              >
                <div className="flex min-h-14 items-center justify-between gap-3 px-5 py-3">
                  <h3 className="font-heading text-base font-medium">{phaseLabel(phase)}</h3>
                  <Button
                    type="button"
                    variant="secondary"
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
        </SortableList>
        <SaveBar dirty={dirty} pending={save.isPending} error={error} testId="rules-save" />
      </form>
    </RuleHistoryContext.Provider>
  );
}
