import type { OrganizationLimits, OrgLimitResource } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/form-dialog";
import { NumberField } from "@/components/site/fields";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber, m } from "@/lib/i18n";
import { ORG_LIMIT_RESOURCES, orgLimitLabel } from "@/lib/org-limits";
import { orpc } from "@/lib/orpc";

type Draft = Record<OrgLimitResource, string>;

const toDraft = (limits: OrganizationLimits["limits"]): Draft =>
  Object.fromEntries(
    ORG_LIMIT_RESOURCES.map((r) => [r, limits[r] === null ? "" : String(limits[r])]),
  ) as Draft;

/** Platform administrators edit an organization's limits; empty means no limit. */
export function OrgLimitsDialog({
  organization,
  onClose,
}: {
  organization: { id: string; name: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const current = useQuery(
    orpc.admin.organizations.getLimits.queryOptions({ input: { id: organization.id } }),
  );
  const save = useMutation(orpc.admin.organizations.setLimits.mutationOptions());
  const [draft, setDraft] = React.useState<Draft | null>(null);
  React.useEffect(() => {
    if (current.data && !draft) setDraft(toDraft(current.data.limits));
  }, [current.data, draft]);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.org_limits_edit_title({ name: organization.name })}
      submitLabel={m.common_save()}
      submitTestId="org-limits-submit"
      onSubmit={async () => {
        if (!draft || !current.data) return;
        const limits = Object.fromEntries(
          ORG_LIMIT_RESOURCES.map((r) => [r, draft[r].trim() === "" ? null : Number(draft[r])]),
        ) as OrganizationLimits["limits"];
        await save.mutateAsync({
          id: organization.id,
          limits,
          expectedUpdatedAt: current.data.updatedAt ?? undefined,
        });
        await queryClient.invalidateQueries({ queryKey: orpc.admin.organizations.key() });
        toast.success(m.org_limits_saved());
        onClose();
      }}
    >
      {current.isError ? (
        <ErrorState error={current.error} onRetry={() => current.refetch()} />
      ) : !current.data || !draft ? (
        <LoadingState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {ORG_LIMIT_RESOURCES.map((resource) => (
            <div key={resource} className="flex flex-col gap-1">
              <NumberField
                id={`limit-${resource}`}
                label={orgLimitLabel(resource)}
                value={draft[resource]}
                min={0}
                max={1_000_000_000}
                step={1}
                placeholder={m.org_limits_unlimited()}
                onChange={(value) => setDraft({ ...draft, [resource]: value })}
                testId={`limit-${resource}`}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {m.org_limits_usage({ current: formatNumber(current.data.usage[resource]) })}
              </span>
            </div>
          ))}
        </div>
      )}
    </FormDialog>
  );
}

/** The active organization's limits that are set, with current use. */
export function OrgLimitsCard() {
  const limits = useQuery(orpc.organization.limits.queryOptions());
  if (limits.isPending) return null;
  if (limits.isError) return <ErrorState error={limits.error} onRetry={() => limits.refetch()} />;
  const set = ORG_LIMIT_RESOURCES.filter((r) => limits.data.limits[r] !== null);
  if (set.length === 0) return null;
  return (
    <Card data-testid="org-limits-card">
      <CardHeader>
        <CardTitle>{m.org_limits_title()}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {set.map((resource, index) => {
          const limit = limits.data.limits[resource] ?? 0;
          const used = limits.data.usage[resource];
          return (
            <div
              key={resource}
              className="flex flex-col gap-2 animate-enter"
              style={{ animationDelay: `${index * 40}ms` }}
              data-testid={`org-limit-${resource}`}
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{orgLimitLabel(resource)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatNumber(used)} / {formatNumber(limit)}
                </span>
              </div>
              <Progress
                value={limit === 0 ? 100 : Math.min(100, (used / limit) * 100)}
                aria-label={orgLimitLabel(resource)}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
