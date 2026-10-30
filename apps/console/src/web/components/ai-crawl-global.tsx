import {
  AI_CRAWL_BLOCK_STATUSES,
  AI_CRAWL_IMPERSONATOR_ACTIONS,
  type AiCrawlCatalogue,
  type AiCrawlGlobalSettings,
  aiCrawlGlobalSettings,
  CHALLENGE_TYPES,
  type ChallengeType,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { AiCrawlActionList } from "@/components/ai-crawl-actions";
import { Textarea } from "@/components/arc/textarea/textarea";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { impersonatorActionLabel } from "@/lib/ai-crawl";
import { m } from "@/lib/i18n";
import { checkFieldText } from "@/lib/lists";
import { orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";

const FIELD_LABELS: Record<string, () => string> = {
  blockBody: m.ai_crawl_block_body,
  crawlers: m.ai_crawl_actions,
  operators: m.ai_crawl_actions,
};

/**
 * AI crawl control every site starts from (the /protection page): crawler detection, the
 * actions per operator and crawler, what impersonators get, the challenge and the block answer.
 */
export function AiCrawlGlobalCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const settings = useQuery(orpc.aiCrawl.settings.queryOptions());
  const catalogue = useQuery(orpc.aiCrawl.catalogue.queryOptions());
  return (
    <Panel className={className} style={style} data-testid="ai-crawl-global-card">
      <PanelHeader>
        <PanelTitle>{m.ai_crawl_global_title()}</PanelTitle>
      </PanelHeader>
      <QueryView query={combineQueries(settings, catalogue)} frame={PanelContent}>
        {([saved, list]) => <AiCrawlGlobalForm server={saved} catalogue={list} />}
      </QueryView>
    </Panel>
  );
}

function AiCrawlGlobalForm({
  server,
  catalogue,
}: {
  server: AiCrawlGlobalSettings;
  catalogue: AiCrawlCatalogue;
}) {
  const { draft, set, dirty, error, pending, submit } = useSettingsForm({
    value: server,
    toDraft: (value) => value,
    toInput: (value) => value,
    check: (input) => {
      const parsed = aiCrawlGlobalSettings.safeParse(input);
      return parsed.success ? null : checkFieldText(parsed.error.issues[0]?.path[0], FIELD_LABELS);
    },
    mutation: {
      ...orpc.aiCrawl.setSettings.mutationOptions(),
      meta: { invalidates: [orpc.aiCrawl.key()] },
    },
  });
  const operatorOf = (crawler: string) =>
    catalogue.crawlers.find((c) => c.id === crawler)?.operator;
  return (
    <form className="flex flex-col gap-(--panel-pad)" onSubmit={submit}>
      <PanelContent className="flex flex-col divide-y divide-border [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <div>
          <SwitchField
            id="ai-crawl-detection"
            label={m.ai_crawl_detection()}
            checked={draft.detection}
            className="self-start"
            testId="ai-crawl-detection"
            onCheckedChange={(detection) => set({ detection })}
          />
        </div>
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="text-muted-foreground">
            {m.ai_crawl_actions()}
          </FieldLegend>
          <AiCrawlActionList
            catalogue={catalogue}
            value={{ crawlers: draft.crawlers, operators: draft.operators }}
            onChange={(actions) => set(actions)}
            // A crawler falls back to its operator's action; an operator to none (tagged only).
            inherited={({ kind, id }) => {
              if (kind === "operator") return null;
              const operator = operatorOf(id);
              return (operator && draft.operators[operator]) || null;
            }}
            // Pay per crawl is set per site; globally a charge applies to sites that enable it.
            charge
            idPrefix="ai-crawl-global"
          />
        </FieldSet>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormSelect
            id="ai-crawl-global-impersonators"
            label={m.ai_crawl_impersonators()}
            value={draft.impersonators}
            testId="ai-crawl-global-impersonators"
            options={AI_CRAWL_IMPERSONATOR_ACTIONS.map((value) => ({
              value,
              label: impersonatorActionLabel(value),
            }))}
            onChange={(impersonators) => set({ impersonators })}
          />
          <FormSelect
            id="ai-crawl-global-challenge"
            label={m.rules_challenge_type()}
            value={draft.challenge}
            testId="ai-crawl-global-challenge"
            options={CHALLENGE_TYPES.map((type) => ({ value: type, label: challengeLabel(type) }))}
            onChange={(challenge) => set({ challenge: challenge as ChallengeType })}
          />
          <FormSelect
            id="ai-crawl-global-block-status"
            label={m.ai_crawl_block_status()}
            value={String(draft.blockStatus)}
            testId="ai-crawl-global-block-status"
            options={AI_CRAWL_BLOCK_STATUSES.map((status) => ({
              value: String(status),
              label: String(status),
            }))}
            onChange={(status) => set({ blockStatus: Number(status) as 403 | 402 })}
          />
        </div>
        <Field>
          <FieldLabel htmlFor="ai-crawl-global-block-body">{m.ai_crawl_block_body()}</FieldLabel>
          <Textarea
            id="ai-crawl-global-block-body"
            rows={3}
            className="font-mono"
            value={draft.blockBody}
            onChange={(event) => set({ blockBody: event.target.value })}
            data-testid="ai-crawl-global-block-body"
          />
        </Field>
      </PanelContent>
      <SaveBar dirty={dirty} pending={pending} error={error} testId="ai-crawl-global-save" />
    </form>
  );
}
