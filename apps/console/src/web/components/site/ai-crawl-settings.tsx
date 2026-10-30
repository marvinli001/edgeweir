import {
  AI_CRAWL_BLOCK_STATUSES,
  AI_CRAWL_IMPERSONATOR_ACTIONS,
  type AiCrawlAction,
  type AiCrawlCatalogue,
  type AiCrawlGlobalSettings,
  type AiCrawlRobots,
  type AiCrawlSite,
  aiCrawler,
  aiCrawlSiteSettings,
  CHALLENGE_TYPES,
  type ChallengeType,
  CONTENT_SIGNAL_VALUES,
  effectiveAiCrawlActions,
  type FeatureAvailability,
  managedRobotsTxt,
  resolveAiCrawlAction,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { AiCrawlActionList } from "@/components/ai-crawl-actions";
import { Textarea } from "@/components/arc/textarea/textarea";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/layout/input-group";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { contentSignalLabel, impersonatorActionLabel } from "@/lib/ai-crawl";
import { m } from "@/lib/i18n";
import { checkFieldText } from "@/lib/lists";
import { orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";

const INHERIT = "inherit";

const FIELD_LABELS: Record<string, () => string> = {
  blockBody: m.ai_crawl_block_body,
  crawlers: m.ai_crawl_actions,
  operators: m.ai_crawl_actions,
  payPerCrawl: m.ai_crawl_price,
};

/** "Default · <the global value>", the option that keeps a setting on the global one. */
const inheritOption = (label: string) => ({
  value: INHERIT,
  label: m.ai_crawl_inherit({ action: label }),
});

/**
 * A site's AI crawl control: actions per operator and crawler over the global ones, what
 * impersonators get, the challenge and block answer, the managed robots.txt with its content
 * signals, and pay per crawl.
 */
export function AiCrawlSettingsCard({ siteId }: { siteId: string }) {
  const settings = useQuery(orpc.aiCrawl.get.queryOptions({ input: { id: siteId } }));
  const global = useQuery(orpc.aiCrawl.settings.queryOptions());
  const catalogue = useQuery(orpc.aiCrawl.catalogue.queryOptions());
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Panel className="animate-enter" data-testid="ai-crawl-settings-card">
      <PanelHeader>
        <PanelTitle>{m.ai_crawl_settings_title()}</PanelTitle>
      </PanelHeader>
      <QueryView query={combineQueries(settings, global, catalogue, features)} frame={PanelContent}>
        {([saved, defaults, list, { aiCrawl }]) => (
          <AiCrawlSettingsForm
            siteId={siteId}
            server={saved}
            global={defaults}
            catalogue={list}
            availability={aiCrawl}
          />
        )}
      </QueryView>
    </Panel>
  );
}

function AiCrawlSettingsForm({
  siteId,
  server,
  global,
  catalogue,
  availability,
}: {
  siteId: string;
  server: AiCrawlSite;
  global: AiCrawlGlobalSettings;
  catalogue: AiCrawlCatalogue;
  availability: FeatureAvailability;
}) {
  const { draft, set, dirty, error, pending, submit } = useSettingsForm({
    value: server,
    toDraft: ({ updatedAt: _updatedAt, ...value }) => value,
    toInput: (value, saved) => ({
      id: siteId,
      ...value,
      ...(saved.updatedAt ? { expectedUpdatedAt: saved.updatedAt } : {}),
    }),
    check: ({ id: _id, expectedUpdatedAt: _at, ...value }) => {
      const parsed = aiCrawlSiteSettings.safeParse(value);
      if (parsed.success) return null;
      const field = parsed.error.issues[0]?.path[0];
      return field === "payPerCrawl"
        ? m.ai_crawl_price_invalid()
        : checkFieldText(field, FIELD_LABELS);
    },
    mutation: {
      ...orpc.aiCrawl.update.mutationOptions(),
      meta: { invalidates: [orpc.aiCrawl.key(), orpc.sites.key()] },
    },
  });
  const ppc = draft.payPerCrawl;
  const robots = draft.robots;
  // What the edge prepends to the origin's robots.txt; a charge without pay per crawl blocks.
  const actions = new Map(
    [...effectiveAiCrawlActions(draft, global)].map(([id, action]): [string, AiCrawlAction] => [
      id,
      action === "charge" && !ppc.enabled ? "block" : action,
    ]),
  );
  const preview = managedRobotsTxt(robots, actions);
  // Nodes that lack the feature: nothing can be turned on (it can be turned off).
  const blocked = !availability.available;
  return (
    <form className="flex flex-col gap-(--panel-pad)" onSubmit={submit}>
      <PanelContent className="flex flex-col divide-y divide-border [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {blocked ? (
          <div>
            <SafetyNote data-testid="ai-crawl-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          </div>
        ) : null}
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="text-muted-foreground">
            {m.ai_crawl_actions()}
          </FieldLegend>
          <AiCrawlActionList
            catalogue={catalogue}
            value={{ crawlers: draft.crawlers, operators: draft.operators }}
            onChange={(next) => set(next)}
            inherited={({ kind, id }) => {
              if (kind === "operator") return global.operators[id] ?? null;
              const crawler = aiCrawler(id);
              if (!crawler) return null;
              const { [id]: _own, ...others } = draft.crawlers;
              return resolveAiCrawlAction(
                crawler,
                { crawlers: others, operators: draft.operators },
                global,
              ).action;
            }}
            charge={ppc.enabled}
            idPrefix="ai-crawl"
          />
        </FieldSet>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormSelect
              id="ai-crawl-impersonators"
              label={m.ai_crawl_impersonators()}
              value={draft.impersonators ?? INHERIT}
              testId="ai-crawl-impersonators"
              options={[
                inheritOption(impersonatorActionLabel(global.impersonators)),
                ...AI_CRAWL_IMPERSONATOR_ACTIONS.map((value) => ({
                  value,
                  label: impersonatorActionLabel(value),
                })),
              ]}
              onChange={(value) =>
                set({
                  impersonators: value === INHERIT ? null : (value as AiCrawlSite["impersonators"]),
                })
              }
            />
            <FormSelect
              id="ai-crawl-challenge"
              label={m.rules_challenge_type()}
              value={draft.challenge ?? INHERIT}
              testId="ai-crawl-challenge"
              options={[
                inheritOption(challengeLabel(global.challenge)),
                ...CHALLENGE_TYPES.map((type) => ({ value: type, label: challengeLabel(type) })),
              ]}
              onChange={(value) =>
                set({ challenge: value === INHERIT ? null : (value as ChallengeType) })
              }
            />
            <FormSelect
              id="ai-crawl-block-status"
              label={m.ai_crawl_block_status()}
              value={draft.blockStatus === null ? INHERIT : String(draft.blockStatus)}
              testId="ai-crawl-block-status"
              options={[
                inheritOption(String(global.blockStatus)),
                ...AI_CRAWL_BLOCK_STATUSES.map((status) => ({
                  value: String(status),
                  label: String(status),
                })),
              ]}
              onChange={(value) =>
                set({ blockStatus: value === INHERIT ? null : (Number(value) as 403 | 402) })
              }
            />
          </div>
          <Field>
            <FieldLabel htmlFor="ai-crawl-block-body">{m.ai_crawl_block_body()}</FieldLabel>
            {/* Empty keeps the global body. */}
            <Textarea
              id="ai-crawl-block-body"
              rows={3}
              className="font-mono"
              value={draft.blockBody ?? ""}
              placeholder={global.blockBody}
              onChange={(event) => set({ blockBody: event.target.value || null })}
              data-testid="ai-crawl-block-body"
            />
          </Field>
        </div>
        <FieldSet className="gap-3" data-testid="ai-crawl-robots">
          <FieldLegend variant="label" className="text-muted-foreground">
            {m.ai_crawl_robots()}
          </FieldLegend>
          <SwitchField
            id="ai-crawl-robots-managed"
            label={m.ai_crawl_robots_managed()}
            checked={robots.managed}
            disabled={blocked && !robots.managed}
            className="self-start"
            testId="ai-crawl-robots-managed"
            onCheckedChange={(managed) => set({ robots: { ...robots, managed } })}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["search", m.ai_crawl_signal_search()],
                ["aiInput", m.ai_crawl_signal_ai_input()],
                ["aiTrain", m.ai_crawl_signal_ai_train()],
              ] as const
            ).map(([key, label]) => (
              <FormSelect
                key={key}
                id={`ai-crawl-signal-${key}`}
                label={label}
                value={robots[key]}
                disabled={!robots.managed}
                testId={`ai-crawl-signal-${key}`}
                options={CONTENT_SIGNAL_VALUES.map((value) => ({
                  value,
                  label: contentSignalLabel(value),
                }))}
                onChange={(value) => {
                  const next: AiCrawlRobots = { ...robots };
                  next[key] = value;
                  set({ robots: next });
                }}
              />
            ))}
          </div>
          {robots.managed ? (
            preview ? (
              <pre
                className="max-h-64 overflow-auto rounded-lg faint-well px-3 py-2 font-mono text-xs whitespace-pre-wrap"
                title={m.ai_crawl_robots_preview()}
                data-testid="ai-crawl-robots-preview"
              >
                {preview}
              </pre>
            ) : (
              <SafetyNote data-testid="ai-crawl-robots-empty">
                {m.ai_crawl_robots_nothing()}
              </SafetyNote>
            )
          ) : null}
        </FieldSet>
        <FieldSet className="gap-3" data-testid="ai-crawl-ppc">
          <FieldLegend variant="label" className="text-muted-foreground">
            {m.ai_crawl_ppc()}
          </FieldLegend>
          <SwitchField
            id="ai-crawl-ppc-enabled"
            label={m.ai_crawl_ppc_enabled()}
            checked={ppc.enabled}
            disabled={blocked && !ppc.enabled}
            className="self-start"
            testId="ai-crawl-ppc-enabled"
            onCheckedChange={(enabled) => set({ payPerCrawl: { ...ppc, enabled } })}
          />
          <div className="grid gap-4 sm:grid-cols-[12rem_auto] sm:items-end">
            <Field>
              <FieldLabel htmlFor="ai-crawl-price">{m.ai_crawl_price()}</FieldLabel>
              <InputGroup>
                <InputGroupAddon>USD</InputGroupAddon>
                <InputGroupInput
                  id="ai-crawl-price"
                  inputMode="decimal"
                  className="font-mono"
                  value={ppc.price}
                  disabled={!ppc.enabled}
                  onChange={(event) =>
                    set({ payPerCrawl: { ...ppc, price: event.target.value.trim() } })
                  }
                  data-testid="ai-crawl-price"
                />
              </InputGroup>
            </Field>
            <SwitchField
              id="ai-crawl-dynamic-pricing"
              label={m.ai_crawl_dynamic_pricing()}
              checked={ppc.dynamicPricing}
              disabled={!ppc.enabled}
              testId="ai-crawl-dynamic-pricing"
              onCheckedChange={(dynamicPricing) => set({ payPerCrawl: { ...ppc, dynamicPricing } })}
            />
          </div>
          <SafetyNote>{m.ai_crawl_ppc_note()}</SafetyNote>
        </FieldSet>
      </PanelContent>
      <SaveBar sticky dirty={dirty} pending={pending} error={error} testId="ai-crawl-save" />
    </form>
  );
}
