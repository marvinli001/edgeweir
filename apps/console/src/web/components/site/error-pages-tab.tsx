import {
  ERROR_PAGE_STATUSES,
  type ErrorPageStatus,
  type FeatureAvailability,
  type SiteErrorPages,
  usesRulesV3Placeholders,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import {
  TemplateField,
  TemplateVariables,
  templateTooLarge,
} from "@/components/error-page-template";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const statusName: Record<ErrorPageStatus, () => string> = {
  403: m.error_pages_name_403,
  429: m.error_pages_name_429,
  502: m.error_pages_name_502,
  503: m.error_pages_name_503,
  504: m.error_pages_name_504,
};

type Templates = Record<ErrorPageStatus, string>;

const toTemplates = (pages: SiteErrorPages["pages"]): Templates =>
  Object.fromEntries(
    ERROR_PAGE_STATUSES.map((status) => [
      status,
      pages.find((page) => page.status === status)?.template ?? "",
    ]),
  ) as Templates;

/**
 * Error pages tab: the site's pages for the 403, 429, 502, 503 and 504 responses its nodes
 * generate (empty: the built-in page) and whether they also replace the origin's.
 */
export function ErrorPagesTab({ siteId }: { siteId: string }) {
  const pages = useQuery(orpc.errorPages.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card className="animate-enter" data-testid="error-pages-card">
      <CardHeader>
        <CardTitle>{m.error_pages_title()}</CardTitle>
      </CardHeader>
      <QueryView query={combineQueries(pages, features)} frame={CardContent}>
        {([saved, available]) => (
          <ErrorPagesForm
            key={saved.updatedAt ?? "default"}
            siteId={siteId}
            initial={saved}
            availability={available.errorPages}
            availabilityV3={available.rulesV3}
          />
        )}
      </QueryView>
    </Card>
  );
}

function ErrorPagesForm({
  siteId,
  initial,
  availability,
  availabilityV3,
}: {
  siteId: string;
  initial: SiteErrorPages;
  availability: FeatureAvailability;
  /** {{time}} and {{path}} (rules-v3). */
  availabilityV3: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.errorPages.update.mutationOptions());
  const saved = React.useMemo(() => toTemplates(initial.pages), [initial.pages]);
  const [templates, setTemplates] = React.useState(saved);
  const [intercept, setIntercept] = React.useState(initial.interceptOriginErrors);
  const [error, setError] = React.useState<string | null>(null);
  // Pages wait until the cluster's nodes run them.
  const editable = availability.available;
  const tooLarge = ERROR_PAGE_STATUSES.some((status) => templateTooLarge(templates[status]));
  const dirty =
    intercept !== initial.interceptOriginErrors ||
    ERROR_PAGE_STATUSES.some((status) => templates[status] !== saved[status]);

  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          const result = await mutation.mutateAsync({
            id: siteId,
            // A blank template means the built-in page.
            pages: ERROR_PAGE_STATUSES.flatMap((status) =>
              templates[status].trim() ? [{ status, template: templates[status] }] : [],
            ),
            interceptOriginErrors: intercept,
            ...(initial.updatedAt ? { expectedUpdatedAt: initial.updatedAt } : {}),
          });
          queryClient.setQueryData(orpc.errorPages.get.queryKey({ input: { id: siteId } }), result);
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-5">
        {availability.available ? null : (
          <SafetyNote className="animate-in fade-in" data-testid="error-pages-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        )}
        {availability.available &&
        !availabilityV3.available &&
        ERROR_PAGE_STATUSES.some((status) => usesRulesV3Placeholders(templates[status])) ? (
          <SafetyNote className="animate-in fade-in" data-testid="error-pages-v3-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
        {ERROR_PAGE_STATUSES.map((status, index) => (
          <div
            key={status}
            className="animate-enter"
            style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
          >
            <TemplateField
              id={`error-page-${status}`}
              status={status}
              name={statusName[status]()}
              value={templates[status]}
              disabled={!editable}
              onChange={(template) => setTemplates({ ...templates, [status]: template })}
              testId={`error-page-${status}`}
            />
          </div>
        ))}
        <SwitchField
          id="error-pages-intercept"
          label={m.error_pages_intercept()}
          checked={intercept}
          disabled={!editable}
          onCheckedChange={setIntercept}
          className="self-start"
          testId="error-pages-intercept"
        />
        <TemplateVariables hideRulesV3={!availabilityV3.available} />
      </CardContent>
      <SaveBar
        dirty={dirty && editable && !tooLarge}
        pending={mutation.isPending}
        error={error}
        testId="error-pages-save"
      />
    </form>
  );
}
