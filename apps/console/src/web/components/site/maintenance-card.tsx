import {
  type FeatureAvailability,
  type SiteMaintenance,
  siteMaintenanceInput,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { TemplateField, templateTooLarge } from "@/components/error-page-template";
import { SafetyNote } from "@/components/safety-note";
import { ListInput, NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/**
 * Maintenance mode: 503 with the page (empty: the nodes' built-in one) for everyone but
 * the allowed addresses and paths. The settings are kept while it is off.
 */
export function MaintenanceCard({ siteId }: { siteId: string }) {
  const maintenance = useQuery(orpc.maintenance.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card className="animate-enter" data-testid="maintenance-card">
      <CardHeader>
        <CardTitle>{m.site_maintenance_title()}</CardTitle>
      </CardHeader>
      <QueryView query={combineQueries(maintenance, features)} frame={CardContent}>
        {([saved, available]) => (
          <MaintenanceForm
            key={saved.updatedAt ?? "default"}
            siteId={siteId}
            initial={saved}
            availability={available.siteContent}
          />
        )}
      </QueryView>
    </Card>
  );
}

function MaintenanceForm({
  siteId,
  initial,
  availability,
}: {
  siteId: string;
  initial: SiteMaintenance;
  availability: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.maintenance.update.mutationOptions());
  const saved = React.useMemo(
    () => ({
      enabled: initial.enabled,
      template: initial.template,
      retryAfter: initial.retryAfterSeconds ? String(initial.retryAfterSeconds) : "",
      allowedCidrs: initial.allowedCidrs,
      allowedPathPrefixes: initial.allowedPathPrefixes,
    }),
    [initial],
  );
  const [draft, setDraft] = React.useState(saved);
  const [error, setError] = React.useState<string | null>(null);
  const set = (change: Partial<typeof draft>) => setDraft({ ...draft, ...change });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  // Turning it on waits for the cluster's nodes; turning it off never does.
  const blocked = !availability.available && !initial.enabled;
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const input = siteMaintenanceInput.safeParse({
          id: siteId,
          enabled: draft.enabled,
          template: draft.template,
          retryAfterSeconds: draft.retryAfter.trim() ? Number(draft.retryAfter) : 0,
          allowedCidrs: draft.allowedCidrs,
          allowedPathPrefixes: draft.allowedPathPrefixes,
          ...(initial.updatedAt ? { expectedUpdatedAt: initial.updatedAt } : {}),
        });
        if (!input.success) {
          setError(localizeError(input.error));
          return;
        }
        try {
          const result = await mutation.mutateAsync(input.data);
          queryClient.setQueryData(
            orpc.maintenance.get.queryKey({ input: { id: siteId } }),
            result,
          );
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-5">
        {blocked ? (
          <SafetyNote className="animate-in fade-in" data-testid="maintenance-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
        <SwitchField
          id="maintenance-enabled"
          label={m.site_maintenance_enabled()}
          checked={draft.enabled}
          disabled={blocked}
          onCheckedChange={(enabled) => set({ enabled })}
          className="self-start"
          testId="maintenance-enabled"
        />
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
          <NumberField
            id="maintenance-retry-after"
            label={m.site_maintenance_retry_after()}
            value={draft.retryAfter}
            min={0}
            max={86_400}
            step={1}
            placeholder="0"
            disabled={blocked}
            onChange={(retryAfter) => set({ retryAfter })}
            testId="maintenance-retry-after"
          />
          <Field data-disabled={blocked || undefined}>
            <FieldLabel htmlFor="maintenance-cidrs">{m.site_maintenance_allow_cidrs()}</FieldLabel>
            <ListInput
              id="maintenance-cidrs"
              value={draft.allowedCidrs}
              placeholder="203.0.113.0/24"
              disabled={blocked}
              onChange={(allowedCidrs) => set({ allowedCidrs })}
              testId="maintenance-cidrs"
            />
          </Field>
          <Field data-disabled={blocked || undefined}>
            <FieldLabel htmlFor="maintenance-paths">{m.site_maintenance_allow_paths()}</FieldLabel>
            <ListInput
              id="maintenance-paths"
              value={draft.allowedPathPrefixes}
              placeholder="/health"
              disabled={blocked}
              onChange={(allowedPathPrefixes) => set({ allowedPathPrefixes })}
              testId="maintenance-paths"
            />
          </Field>
        </div>
        <TemplateField
          id="maintenance-page"
          status={503}
          name={m.site_maintenance_page()}
          value={draft.template}
          disabled={blocked}
          onChange={(template) => set({ template })}
          testId="maintenance-page"
        />
      </CardContent>
      <SaveBar
        dirty={dirty && !templateTooLarge(draft.template)}
        pending={mutation.isPending}
        error={error}
        testId="maintenance-save"
      />
    </form>
  );
}
