import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** The caller's starred sites and a toggle that keeps every list in step. */
export function useSiteStars() {
  const starred = useQuery(orpc.sites.starred.queryOptions());
  const setStarred = useMutation({
    ...orpc.sites.setStarred.mutationOptions(),
    meta: { invalidates: [orpc.sites.starred.key()], toastError: true },
  });
  const ids = React.useMemo(() => new Set(starred.data?.map((s) => s.id)), [starred.data]);
  const { mutateAsync } = setStarred;
  const toggle = React.useCallback(
    async (id: string) => {
      await mutateAsync({ id, starred: !ids.has(id) }).catch(() => undefined);
    },
    [ids, mutateAsync],
  );
  return {
    starred,
    ids,
    toggle,
    pendingId: setStarred.isPending ? setStarred.variables?.id : undefined,
  };
}

/** The filled star that marks a starred site. */
export function StarMark({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      icon={StarIcon}
      strokeWidth={2}
      className={cn("size-4 text-star [&_path]:fill-current", className)}
    />
  );
}

export function StarButton({
  starred,
  pending,
  onToggle,
  className,
}: {
  starred: boolean;
  pending?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={starred}
      aria-label={starred ? m.site_unstar() : m.site_star()}
      title={starred ? m.site_unstar() : m.site_star()}
      disabled={pending}
      onClick={onToggle}
      className={cn("icon-button", className)}
      data-testid="site-star"
    >
      {starred ? (
        <StarMark />
      ) : (
        <HugeiconsIcon icon={StarIcon} strokeWidth={2} className="text-muted-foreground" />
      )}
    </Button>
  );
}
