import type { SiteUpdateInput } from "@edgeweir/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Saves part of a site; the toast follows the change onto the nodes (followSiteDelivery). */
export function useSaveSite(siteId: string) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.sites.update.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  /** Resolves true once saved; a failure is shown in `error`. */
  const save = async (patch: Omit<SiteUpdateInput, "id">): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const result = await update.mutateAsync({ id: siteId, ...patch });
      queryClient.setQueryData(orpc.sites.get.queryKey({ input: { id: siteId } }), result.site);
      await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
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
    } finally {
      setPending(false);
    }
  };
  return { save, error, pending };
}

export function SaveBar({
  dirty,
  pending,
  error,
  testId,
  errorTestId = "site-save-error",
}: {
  dirty: boolean;
  pending: boolean;
  error: string | null;
  testId: string;
  errorTestId?: string;
}) {
  useUnsavedChanges(dirty);
  return (
    <CardFooter className="flex-wrap justify-end gap-3 border-t">
      {error ? (
        <FieldError className="mr-auto animate-in fade-in" data-testid={errorTestId}>
          {error}
        </FieldError>
      ) : null}
      <Button type="submit" disabled={!dirty || pending} data-testid={testId}>
        {pending ? <Spinner /> : null}
        {m.common_save()}
      </Button>
    </CardFooter>
  );
}

/** "a, b c" → ["a", "b", "c"]. */
export const splitList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

let draftKeys = 0;

/** Stable React keys (and drag ids) for rows that do not have a server id yet. */
export const nextDraftKey = () => ++draftKeys;

/** JSON of draft rows without their React keys, to tell whether a form differs from the server. */
export const serializeDrafts = <T extends { key: number }>(rows: T[]) =>
  JSON.stringify(rows.map(({ key: _key, ...rest }) => rest));
