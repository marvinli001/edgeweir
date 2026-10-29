import type { SiteUpdateInput } from "@edgeweir/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { FieldError } from "@/components/layout/form";
import { PanelFooter } from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Saves part of a site; the toast follows the change onto the nodes (followSiteDelivery). */
export function useSaveSite(siteId: string) {
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.sites.update.mutationOptions(),
    meta: { invalidates: [orpc.sites.key()] },
  });
  const [error, setError] = React.useState<string | null>(null);
  /** Resolves true once saved; a failure is shown in `error`. */
  const save = async (patch: Omit<SiteUpdateInput, "id">): Promise<boolean> => {
    setError(null);
    try {
      const result = await update.mutateAsync({ id: siteId, ...patch });
      queryClient.setQueryData(orpc.sites.get.queryKey({ input: { id: siteId } }), result.site);
      followSiteDelivery(queryClient, siteId, m.common_saved(), result.site.delivery);
      // New domains the site's ACME certificate is reissued for.
      if (result.certificateReissue)
        toast.info(m.site_certificate_reissue({ name: result.certificateReissue.name }), {
          id: "site-certificate-reissue",
        });
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };
  return { save, error, pending: update.isPending };
}

/**
 * A form panel's save bar: the button on the left, lined up with the fields (tokens.md "Forms"),
 * and the last error beside it.
 */
export function SaveBar({
  dirty,
  pending,
  error,
  indent = false,
  sticky = false,
  testId,
  errorTestId = "site-save-error",
  className,
}: {
  dirty: boolean;
  pending: boolean;
  error: string | null;
  /** Lines the button up with the controls of a label-left form (index.css [data-form]). */
  indent?: boolean;
  /** Keeps the bar at the bottom of the viewport while a long form scrolls. */
  sticky?: boolean;
  testId: string;
  errorTestId?: string;
  className?: string;
}) {
  useUnsavedChanges(dirty);
  return (
    <PanelFooter
      sticky={sticky}
      className={cn("@container/save-bar flex-wrap gap-x-4 gap-y-2 border-t", className)}
    >
      <Button
        type="submit"
        disabled={!dirty || pending}
        className={
          indent ? "@min-[42.5rem]/save-bar:ml-[calc(var(--ew-form-label)+1.5rem)]" : undefined
        }
        data-testid={testId}
      >
        {pending ? <Spinner /> : null}
        {m.common_save()}
      </Button>
      {error ? (
        <FieldError className="animate-in fade-in" data-testid={errorTestId}>
          {error}
        </FieldError>
      ) : null}
    </PanelFooter>
  );
}

let draftKeys = 0;

/** Stable React keys (and drag ids) for rows that do not have a server id yet. */
export const nextDraftKey = () => ++draftKeys;

/** JSON of draft rows without their React keys, to tell whether a form differs from the server. */
export const serializeDrafts = <T extends { key: number }>(rows: T[]) =>
  JSON.stringify(rows.map(({ key: _key, ...rest }) => rest));
