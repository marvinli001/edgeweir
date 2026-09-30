import type { Site, SiteSuspendReason } from "@edgeweir/contract";
import { GlobeIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SearchBox } from "@/components/search-box";
import { SiteStatus, SUSPEND_REASONS, suspendReasonLabel } from "@/components/site-status";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const PAGE_SIZE = 20;

export const Route = createFileRoute("/_app/admin/sites")({
  validateSearch: z.object({
    q: z.string().optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: AdminSitesPage,
});

function SuspendDialog({
  site,
  onOpenChange,
}: {
  site: Site | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const suspend = useMutation(orpc.admin.sites.suspend.mutationOptions());
  const [reason, setReason] = React.useState<SiteSuspendReason>("billing");
  React.useEffect(() => {
    if (site) setReason(site.suspendReason ?? "billing");
  }, [site]);
  return (
    <FormDialog
      open={site !== null}
      onOpenChange={onOpenChange}
      title={m.site_suspend_title({ name: site?.name ?? "" })}
      submitLabel={m.site_suspend()}
      submitTestId="site-suspend-submit"
      onSubmit={async (data) => {
        if (!site) return;
        await suspend.mutateAsync({
          id: site.id,
          reason,
          note: String(data.get("note") ?? "").trim(),
          expectedUpdatedAt: site.updatedAt,
        });
        await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
        toast.success(m.site_suspended_toast());
        onOpenChange(false);
      }}
    >
      <FormSelect
        id="suspend-reason"
        label={m.site_suspend_reason_label()}
        value={reason}
        options={SUSPEND_REASONS.map((value) => ({ value, label: suspendReasonLabel(value) }))}
        onChange={(value) => setReason(value as SiteSuspendReason)}
      />
      <Field>
        <FieldLabel htmlFor="suspend-note">{m.site_suspend_note_label()}</FieldLabel>
        <Textarea
          id="suspend-note"
          name="note"
          maxLength={256}
          defaultValue={site?.suspendNote}
          data-testid="site-suspend-note"
        />
      </Field>
    </FormDialog>
  );
}

/**
 * Resume with confirmation. A component of its own so that the table's cell
 * renderers keep their identity: a new renderer per render would remount the
 * cell and close an open dialog whenever the page re-renders.
 */
function ResumeAction({ site }: { site: Site }) {
  const queryClient = useQueryClient();
  const resume = useMutation(orpc.admin.sites.resume.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline" data-testid="site-resume">
          {m.site_resume()}
        </Button>
      }
      title={m.site_resume_confirm({ name: site.name })}
      confirmLabel={m.site_resume()}
      onConfirm={async () => {
        try {
          await resume.mutateAsync({ id: site.id, expectedUpdatedAt: site.updatedAt });
          await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
          toast.success(m.site_resumed_toast());
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    />
  );
}

function AdminSitesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = search.page ?? 1;
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({
      input: { search: search.q || undefined, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
  });
  const [suspending, setSuspending] = React.useState<Site | null>(null);
  const columns = React.useMemo<Columns<Site>>(
    () => [
      {
        id: "name",
        header: () => m.sites_col_name(),
        cell: ({ row }) => (
          <Link
            to="/sites/$id"
            params={{ id: row.original.id }}
            className="font-medium underline-offset-4 hover:underline"
            data-testid="admin-site-link"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "status",
        header: () => m.sites_col_status(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <SiteStatus site={row.original} />
            {row.original.suspended ? (
              <span className="text-xs text-muted-foreground">
                {suspendReasonLabel(row.original.suspendReason)}
                {row.original.suspendNote ? ` · ${row.original.suspendNote}` : ""}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "organization",
        header: () => m.sites_col_organization(),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{row.original.organizationName}</span>
        ),
      },
      {
        id: "domains",
        header: () => m.sites_col_domains(),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.domains.map((d) => (
              <Badge key={d} variant="outline" className="font-mono">
                {d}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.suspended ? (
            <ResumeAction site={row.original} />
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSuspending(row.original)}
              data-testid="site-suspend"
            >
              {m.site_suspend()}
            </Button>
          ),
      },
    ],
    [],
  );

  return (
    <Page title={m.nav_admin_sites()}>
      <SearchBox
        value={search.q ?? ""}
        onChange={(q) =>
          navigate({
            search: (prev) => ({ ...prev, q: q || undefined, page: undefined }),
            replace: true,
          })
        }
      />
      {sites.isPending ? (
        <LoadingState />
      ) : sites.isError ? (
        <ErrorState error={sites.error} onRetry={() => sites.refetch()} />
      ) : sites.data.total === 0 ? (
        search.q ? (
          <EmptyState icon={Search01Icon} title={m.sites_no_match()} />
        ) : (
          <EmptyState icon={GlobeIcon} title={m.admin_sites_empty()} />
        )
      ) : (
        <>
          <DataTable
            data={sites.data.items}
            columns={columns}
            getRowId={(s) => s.id}
            testId="admin-sites-table"
          />
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            total={sites.data.total}
            onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
          />
        </>
      )}
      <SuspendDialog site={suspending} onOpenChange={(open) => !open && setSuspending(null)} />
    </Page>
  );
}
