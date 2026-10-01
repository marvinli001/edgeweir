import {
  ERROR_PAGE_STATUSES,
  type ErrorPageStatus,
  type FeatureAvailability,
  type SiteErrorPages,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
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
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { unavailableReason } from "@/lib/protection";

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
 * generate (empty: the built-in page) and whether they also replace the origin's. Members read
 * them; owners and admins change them.
 */
export function ErrorPagesTab({
  siteId,
  organizationRole,
}: {
  siteId: string;
  organizationRole?: string;
}) {
  const { isAdmin } = useRouteContext({ from: "/_app" });
  const canEdit = isAdmin || organizationRole === "owner" || organizationRole === "admin";
  const pages = useQuery(orpc.errorPages.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card className="animate-enter" data-testid="error-pages-card">
      <CardHeader>
        <CardTitle>{m.error_pages_title()}</CardTitle>
      </CardHeader>
      {pages.isPending || features.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : pages.isError ? (
        <CardContent>
          <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
        </CardContent>
      ) : features.isError ? (
        <CardContent>
          <ErrorState error={features.error} onRetry={() => void features.refetch()} />
        </CardContent>
      ) : (
        <ErrorPagesForm
          key={pages.data.updatedAt ?? "default"}
          siteId={siteId}
          initial={pages.data}
          availability={features.data.errorPages}
          canEdit={canEdit}
          isAdmin={isAdmin}
        />
      )}
    </Card>
  );
}

function ErrorPagesForm({
  siteId,
  initial,
  availability,
  canEdit,
  isAdmin,
}: {
  siteId: string;
  initial: SiteErrorPages;
  availability: FeatureAvailability;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.errorPages.update.mutationOptions());
  const saved = React.useMemo(() => toTemplates(initial.pages), [initial.pages]);
  const [templates, setTemplates] = React.useState(saved);
  const [intercept, setIntercept] = React.useState(initial.interceptOriginErrors);
  const [error, setError] = React.useState<string | null>(null);
  // Tenants cannot use pages before the cluster's nodes run them; administrators may require them.
  const editable = canEdit && (isAdmin || availability.available);
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
          <SafetyNote
            className="animate-in fade-in"
            data-testid="error-pages-unavailable"
            data-reason={availability.reason ?? undefined}
          >
            {unavailableReason(availability)}
          </SafetyNote>
        )}
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
        <TemplateVariables />
      </CardContent>
      {canEdit ? (
        <SaveBar
          dirty={dirty && editable && !tooLarge}
          pending={mutation.isPending}
          error={error}
          testId="error-pages-save"
        />
      ) : null}
    </form>
  );
}
