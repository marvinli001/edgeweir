import { PLATFORM_ERROR_PAGE_STATUSES, type PlatformErrorPages } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import {
  TemplateField,
  TemplateVariables,
  templateTooLarge,
} from "@/components/error-page-template";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

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
    <Card
      className="animate-enter"
      style={{ animationDelay: "220ms" }}
      data-testid="platform-error-pages-card"
    >
      <CardHeader>
        <CardTitle>{m.platform_pages_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : query.isError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </CardContent>
      ) : (
        <PlatformErrorPagesForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function PlatformErrorPagesForm({ initial }: { initial: PlatformErrorPages }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setErrorPages.mutationOptions());
  const [pages, setPages] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = PAGES.some(({ key }) => pages[key] !== initial[key]);
  const tooLarge = PAGES.some(({ key }) => templateTooLarge(pages[key]));
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          // A blank template means the built-in page.
          const saved = await save.mutateAsync({
            unknownHost: pages.unknownHost.trim() ? pages.unknownHost : "",
            siteDisabled: pages.siteDisabled.trim() ? pages.siteDisabled : "",
          });
          queryClient.setQueryData(orpc.settings.errorPages.queryKey(), saved);
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-5">
        {PAGES.map(({ key, id, name }) => (
          <TemplateField
            key={key}
            id={id}
            status={PLATFORM_ERROR_PAGE_STATUSES[key]}
            name={name()}
            value={pages[key]}
            onChange={(template) => setPages({ ...pages, [key]: template })}
            testId={id}
          />
        ))}
        <TemplateVariables />
      </CardContent>
      <SaveBar
        dirty={dirty && !tooLarge}
        pending={save.isPending}
        error={error}
        testId="platform-pages-save"
      />
    </form>
  );
}
