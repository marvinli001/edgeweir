import {
  PLATFORM_ERROR_PAGE_STATUSES,
  type PlatformErrorPages,
  usesRulesV3Placeholders,
} from "@edgeweir/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TemplateField,
  TemplateVariables,
  templateTooLarge,
} from "@/components/error-page-template";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

type PageKey = keyof PlatformErrorPages;

/** The platform's pages in display order, with their field and test ids. */
const PAGES: { key: PageKey; id: string; name: () => string }[] = [
  { key: "unknownHost", id: "platform-page-unknown-host", name: m.platform_pages_unknown_host },
  { key: "siteDisabled", id: "platform-page-disabled", name: m.platform_pages_disabled },
];

/**
 * System settings card: the pages nodes answer with for hosts no site serves (404) and for
 * disabled sites (503); empty means the built-in page. Saving publishes every cluster.
 */
export function PlatformErrorPagesCard() {
  const query = useQuery(orpc.settings.errorPages.queryOptions());
  return (
    <Panel
      className="animate-enter"
      style={{ animationDelay: "220ms" }}
      data-testid="platform-error-pages-card"
    >
      <PanelHeader>
        <PanelTitle>{m.platform_pages_title()}</PanelTitle>
      </PanelHeader>
      <QueryView query={query} frame={PanelContent}>
        {(pages) => <PlatformErrorPagesForm initial={pages} />}
      </QueryView>
    </Panel>
  );
}

function PlatformErrorPagesForm({ initial }: { initial: PlatformErrorPages }) {
  const queryClient = useQueryClient();
  const form = useSettingsForm({
    value: initial,
    toDraft: (pages) => pages,
    // A blank template means the built-in page.
    toInput: (pages) => ({
      unknownHost: pages.unknownHost.trim() ? pages.unknownHost : "",
      siteDisabled: pages.siteDisabled.trim() ? pages.siteDisabled : "",
    }),
    mutation: orpc.settings.setErrorPages.mutationOptions(),
    onSaved: (saved) => queryClient.setQueryData(orpc.settings.errorPages.queryKey(), saved),
  });
  const pages = form.draft;
  const tooLarge = PAGES.some(({ key }) => templateTooLarge(pages[key]));
  return (
    <form className="flex flex-col gap-(--panel-pad)" onSubmit={form.submit}>
      <PanelContent form className="flex flex-col gap-5">
        {PAGES.map(({ key, id, name }) => (
          <TemplateField
            key={key}
            id={id}
            status={PLATFORM_ERROR_PAGE_STATUSES[key]}
            name={name()}
            value={pages[key]}
            onChange={(template) => form.set({ [key]: template })}
            testId={id}
          />
        ))}
        <TemplateVariables />
        {PAGES.some(({ key }) => usesRulesV3Placeholders(pages[key])) ? (
          <SafetyNote className="animate-in fade-in" data-testid="platform-pages-v3-note">
            {m.error_pages_v3_note({ time: "{{time}}", path: "{{path}}" })}
          </SafetyNote>
        ) : null}
      </PanelContent>
      <SaveBar
        indent
        dirty={form.dirty && !tooLarge}
        pending={form.pending}
        error={form.error}
        testId="platform-pages-save"
      />
    </form>
  );
}
