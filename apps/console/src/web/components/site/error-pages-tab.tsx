import {
  ERROR_PAGE_CLASSES,
  ERROR_PAGE_STATUSES,
  ERROR_PAGES_V1_STATUSES,
  type ErrorPageStatus,
  type FeatureAvailability,
  type SiteErrorPages,
  usesRulesV3Placeholders,
  validErrorRedirect,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import {
  TemplateBytes,
  TemplateInput,
  TemplateLabel,
  TemplateVariables,
  templateTooLarge,
} from "@/components/error-page-template";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { MaintenanceCard } from "@/components/site/maintenance-card";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Every page the form edits: the statuses, then the 4xx and 5xx classes. */
const STATUSES: readonly ErrorPageStatus[] = [...ERROR_PAGE_STATUSES, ...ERROR_PAGE_CLASSES];

const statusName: Record<ErrorPageStatus, () => string> = {
  400: m.error_pages_name_400,
  401: m.error_pages_name_401,
  403: m.error_pages_name_403,
  404: m.error_pages_name_404,
  405: m.error_pages_name_405,
  410: m.error_pages_name_410,
  429: m.error_pages_name_429,
  500: m.error_pages_name_500,
  502: m.error_pages_name_502,
  503: m.error_pages_name_503,
  504: m.error_pages_name_504,
  "4xx": m.error_pages_name_4xx,
  "5xx": m.error_pages_name_5xx,
};

/** An example redirect: a local path with a placeholder. */
const REDIRECT_EXAMPLE = "/error?code={{status}}";

/** Pages error-pages-v1 runs; the others need site-content-v1. */
const V1: readonly ErrorPageStatus[] = ERROR_PAGES_V1_STATUSES;

type Mode = "template" | "redirect";
interface PageDraft {
  mode: Mode;
  template: string;
  redirectUrl: string;
  /** The status a template page is sent with; empty keeps the response's. */
  responseStatus: string;
}
type Drafts = Record<ErrorPageStatus, PageDraft>;

const toDrafts = (pages: SiteErrorPages["pages"]): Drafts =>
  Object.fromEntries(
    STATUSES.map((status) => {
      const page = pages.find((p) => p.status === status);
      return [
        status,
        {
          mode: page?.redirectUrl ? "redirect" : "template",
          template: page?.template ?? "",
          redirectUrl: page?.redirectUrl ?? "",
          responseStatus: page?.responseStatus ? String(page.responseStatus) : "",
        },
      ];
    }),
  ) as Drafts;

/** Whether a draft is a page (a blank one means the built-in page). */
const isPage = (d: PageDraft) =>
  d.mode === "redirect" ? d.redirectUrl.trim() !== "" : d.template.trim() !== "";
/** Whether a draft uses a setting of site-content-v1. */
const isV2 = (status: ErrorPageStatus, d: PageDraft) =>
  isPage(d) && (!V1.includes(status) || d.mode === "redirect" || d.responseStatus.trim() !== "");
const statusValid = (value: string) => {
  if (!value.trim()) return true;
  const n = Number(value);
  return Number.isInteger(n) && n >= 200 && n <= 599;
};

/**
 * Error pages tab: maintenance mode, and the site's pages for the responses its nodes
 * generate (empty: the built-in page), optionally also for the origin's; a page is an
 * HTML template or a redirect, the 4xx and 5xx pages stand in for statuses without one.
 */
export function ErrorPagesTab({ siteId }: { siteId: string }) {
  const pages = useQuery(orpc.errorPages.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <div className="flex flex-col gap-4">
      <MaintenanceCard siteId={siteId} />
      <Card
        className="animate-enter"
        style={{ animationDelay: "60ms" }}
        data-testid="error-pages-card"
      >
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
              availabilityContent={available.siteContent}
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function ErrorPagesForm({
  siteId,
  initial,
  availability,
  availabilityV3,
  availabilityContent,
}: {
  siteId: string;
  initial: SiteErrorPages;
  availability: FeatureAvailability;
  /** {{time}} and {{path}} (rules-v3). */
  availabilityV3: FeatureAvailability;
  /** Other statuses, classes, redirects and replacement statuses (site-content-v1). */
  availabilityContent: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.errorPages.update.mutationOptions());
  const saved = React.useMemo(() => toDrafts(initial.pages), [initial.pages]);
  const [drafts, setDrafts] = React.useState(saved);
  const [intercept, setIntercept] = React.useState(initial.interceptOriginErrors);
  const [error, setError] = React.useState<string | null>(null);
  // Pages wait until the cluster's nodes run them.
  const editable = availability.available;
  const tooLarge = STATUSES.some(
    (status) => drafts[status].mode === "template" && templateTooLarge(drafts[status].template),
  );
  const invalid = STATUSES.some((status) => {
    const d = drafts[status];
    return d.mode === "redirect"
      ? d.redirectUrl.trim() !== "" && !validErrorRedirect(d.redirectUrl.trim())
      : !statusValid(d.responseStatus);
  });
  const dirty =
    intercept !== initial.interceptOriginErrors || JSON.stringify(drafts) !== JSON.stringify(saved);
  const set = (status: ErrorPageStatus, change: Partial<PageDraft>) =>
    setDrafts({ ...drafts, [status]: { ...drafts[status], ...change } });
  // A page that is new with site-content-v1 waits like the others (one already saved stays).
  const locked = (status: ErrorPageStatus) =>
    !editable || (!availabilityContent.available && !V1.includes(status) && !isPage(saved[status]));

  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          const result = await mutation.mutateAsync({
            id: siteId,
            // A blank page means the built-in page.
            pages: STATUSES.flatMap((status) => {
              const d = drafts[status];
              if (!isPage(d)) return [];
              return d.mode === "redirect"
                ? [{ status, template: "", redirectUrl: d.redirectUrl.trim(), responseStatus: 0 }]
                : [
                    {
                      status,
                      template: d.template,
                      redirectUrl: "",
                      responseStatus: d.responseStatus.trim() ? Number(d.responseStatus) : 0,
                    },
                  ];
            }),
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
        STATUSES.some(
          (status) =>
            drafts[status].mode === "template" && usesRulesV3Placeholders(drafts[status].template),
        ) ? (
          <SafetyNote className="animate-in fade-in" data-testid="error-pages-v3-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
        {availability.available &&
        !availabilityContent.available &&
        STATUSES.some((status) => isV2(status, drafts[status])) ? (
          <SafetyNote className="animate-in fade-in" data-testid="error-pages-content-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
        {/* One page per row, split by hairlines edge to edge in the card. */}
        <ul className="-mx-(--card-spacing) flex flex-col border-b">
          {STATUSES.map((status, index) => (
            <li
              key={status}
              className="border-t px-(--card-spacing) py-4 animate-enter"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            >
              <PageRow
                status={status}
                draft={drafts[status]}
                disabled={locked(status)}
                // Classic pages stay templates without site-content-v1.
                modes={availabilityContent.available || isV2(status, saved[status])}
                onChange={(change) => set(status, change)}
              />
            </li>
          ))}
        </ul>
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
        dirty={dirty && editable && !tooLarge && !invalid}
        pending={mutation.isPending}
        error={error}
        testId="error-pages-save"
      />
    </form>
  );
}

/**
 * One status's page: an HTML template (optionally sent with another status) or a
 * redirect URL. Without `modes` only the template shows. The template / redirect switch
 * sits on the label's line and stays mounted across modes (it keeps focus).
 */
function PageRow({
  status,
  draft,
  disabled,
  modes,
  onChange,
}: {
  status: ErrorPageStatus;
  draft: PageDraft;
  disabled: boolean;
  modes: boolean;
  onChange: (change: Partial<PageDraft>) => void;
}) {
  const id = `error-page-${status}`;
  const redirect = draft.mode === "redirect";
  const badUrl = draft.redirectUrl.trim() !== "" && !validErrorRedirect(draft.redirectUrl.trim());
  const invalid = redirect ? badUrl : templateTooLarge(draft.template);
  const badStatus = !statusValid(draft.responseStatus);
  return (
    <div className="flex flex-col gap-3">
      <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <TemplateLabel
            id={`${id}-label`}
            htmlFor={redirect ? `${id}-url` : id}
            status={status}
            name={statusName[status]()}
          />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {redirect ? null : <TemplateBytes value={draft.template} testId={id} />}
            {modes ? (
              <Tabs value={draft.mode} onValueChange={(mode) => onChange({ mode: mode as Mode })}>
                <TabsList
                  className="h-7"
                  aria-labelledby={`${id}-label`}
                  data-testid={`${id}-mode`}
                >
                  <TabsTrigger value="template" disabled={disabled} className="text-xs">
                    {m.error_pages_mode_template()}
                  </TabsTrigger>
                  <TabsTrigger
                    value="redirect"
                    disabled={disabled}
                    className="text-xs"
                    data-testid={`${id}-mode-redirect`}
                  >
                    {m.error_pages_mode_redirect()}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
        </div>
        {redirect ? (
          <>
            <Input
              id={`${id}-url`}
              value={draft.redirectUrl}
              disabled={disabled}
              spellCheck={false}
              autoCapitalize="off"
              placeholder={REDIRECT_EXAMPLE}
              aria-invalid={badUrl || undefined}
              aria-describedby={badUrl ? `${id}-url-error` : undefined}
              onChange={(event) => onChange({ redirectUrl: event.target.value })}
              className="font-mono text-sm"
              data-testid={`${id}-url`}
            />
            {badUrl ? (
              <FieldError id={`${id}-url-error`} className="animate-in fade-in">
                {m.common_check_field({ field: m.error_pages_mode_redirect() })}
              </FieldError>
            ) : null}
          </>
        ) : (
          <TemplateInput
            id={id}
            status={status}
            value={draft.template}
            disabled={disabled}
            onChange={(template) => onChange({ template })}
            testId={id}
          />
        )}
      </Field>
      {!redirect && modes ? (
        <Field data-invalid={badStatus || undefined} data-disabled={disabled || undefined}>
          <FieldLabel id={`${id}-status-label`} htmlFor={`${id}-status`}>
            {m.error_pages_response_status()}
          </FieldLabel>
          <Input
            id={`${id}-status`}
            type="number"
            inputMode="numeric"
            min={200}
            max={599}
            value={draft.responseStatus}
            placeholder={typeof status === "number" ? String(status) : status}
            disabled={disabled}
            aria-labelledby={`${id}-label ${id}-status-label`}
            aria-invalid={badStatus || undefined}
            aria-describedby={badStatus ? `${id}-status-error` : undefined}
            onChange={(event) => onChange({ responseStatus: event.target.value })}
            className="max-w-40"
            data-testid={`${id}-status`}
          />
          {badStatus ? (
            <FieldError id={`${id}-status-error`} className="animate-in fade-in">
              {m.common_whole_number_range({ min: "200", max: "599" })}
            </FieldError>
          ) : null}
        </Field>
      ) : null}
    </div>
  );
}
