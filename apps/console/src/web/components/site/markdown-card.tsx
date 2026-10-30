import {
  type AnalyticsRange,
  type FeatureAvailability,
  type MarkdownSettings,
  markdownSettings,
  type Site,
} from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Textarea } from "@/components/arc/textarea/textarea";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { ANALYTICS_RANGES, rangeLabel } from "@/lib/analytics";
import { formatNumber, m } from "@/lib/i18n";
import { checkFieldText, splitList } from "@/lib/lists";
import { orpc } from "@/lib/orpc";

const FIELD_LABELS: Record<string, () => string> = {
  includePrefixes: m.markdown_include,
  excludePrefixes: m.markdown_exclude,
};

interface Draft {
  enabled: boolean;
  includePrefixes: string;
  excludePrefixes: string;
}

/** Markdown for Agents: HTML converted to Markdown for requests that ask for it. */
export function MarkdownCard({ site }: { site: Site }) {
  const settings = useQuery(orpc.markdown.get.queryOptions({ input: { id: site.id } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  return (
    <QueryView query={combineQueries(settings, features)}>
      {([saved, { markdown }]) => (
        <MarkdownEditor siteId={site.id} server={saved} availability={markdown} />
      )}
    </QueryView>
  );
}

function MarkdownEditor({
  siteId,
  server,
  availability,
}: {
  siteId: string;
  server: MarkdownSettings;
  availability: FeatureAvailability;
}) {
  const { draft, set, dirty, error, pending, submit } = useSettingsForm({
    value: server,
    toDraft: (value): Draft => ({
      enabled: value.enabled,
      includePrefixes: value.includePrefixes.join("\n"),
      excludePrefixes: value.excludePrefixes.join("\n"),
    }),
    toInput: (value: Draft) => ({
      id: siteId,
      enabled: value.enabled,
      includePrefixes: splitList(value.includePrefixes),
      excludePrefixes: splitList(value.excludePrefixes),
    }),
    check: ({ id: _id, ...value }) => {
      const parsed = markdownSettings.safeParse(value);
      return parsed.success ? null : checkFieldText(parsed.error.issues[0]?.path[0], FIELD_LABELS);
    },
    mutation: {
      ...orpc.markdown.update.mutationOptions(),
      meta: { invalidates: [orpc.markdown.key(), orpc.sites.key()] },
    },
  });
  // Nodes that lack the feature: it cannot be turned on (it can be turned off).
  const blocked = !availability.available && !server.enabled;
  return (
    <Panel className="animate-enter" style={{ animationDelay: "240ms" }} data-testid="markdown-card">
      <form className="flex flex-col gap-(--panel-pad)" onSubmit={submit}>
        <PanelHeader>
          <PanelTitle>{m.markdown_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <SwitchField
              id="markdown-enabled"
              label={m.compression_enabled()}
              checked={draft.enabled}
              disabled={blocked}
              className="self-start"
              testId="markdown-enabled"
              onCheckedChange={(enabled) => set({ enabled })}
            />
            <SafetyNote>{m.markdown_note()}</SafetyNote>
            {availability.available ? null : (
              <SafetyNote data-testid="markdown-unavailable">
                {m.feature_unavailable_nodes()}
              </SafetyNote>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="markdown-include">{m.markdown_include()}</FieldLabel>
              <Textarea
                id="markdown-include"
                rows={3}
                value={draft.includePrefixes}
                placeholder="/docs/"
                spellCheck={false}
                className="font-mono text-sm"
                onChange={(e) => set({ includePrefixes: e.target.value })}
                data-testid="markdown-include"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="markdown-exclude">{m.markdown_exclude()}</FieldLabel>
              <Textarea
                id="markdown-exclude"
                rows={3}
                value={draft.excludePrefixes}
                spellCheck={false}
                className="font-mono text-sm"
                onChange={(e) => set({ excludePrefixes: e.target.value })}
                data-testid="markdown-exclude"
              />
            </Field>
          </div>
        </PanelContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="markdown-save" />
      </form>
    </Panel>
  );
}

/** Responses the site served as Markdown over a range. */
export function MarkdownStatsCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const stats = useQuery({
    ...orpc.markdown.stats.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Panel
      className="animate-enter"
      style={{ animationDelay: "280ms" }}
      data-testid="markdown-stats-card"
    >
      <PanelHeader className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>{m.markdown_responses_title()}</PanelTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="markdown-stats-range"
            label={m.security_hours()}
            value={range}
            testId="markdown-stats-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => setRange(value as AnalyticsRange)}
          />
        </div>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-4">
        <QueryView query={stats}>
          {({ responses, unsupportedNodes }) => (
            <>
              <p
                className="font-heading text-3xl font-medium tabular-nums"
                data-testid="markdown-responses"
              >
                {formatNumber(responses)}
              </p>
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="markdown-stats-partial">
                  {m.markdown_responses_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </PanelContent>
    </Panel>
  );
}
