import { Alert02Icon, InboxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

/** Loading placeholder shaped like a card/table. */
export function LoadingState({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label ?? m.common_loading()}</span>
      <Skeleton className="h-8 w-1/3" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>{m.common_error_title()}</AlertTitle>
      <AlertDescription>{errorMessage(error, m.common_unknown_error())}</AlertDescription>
      {onRetry ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {m.common_retry()}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

export function EmptyState({
  title,
  description,
  icon = InboxIcon,
  children,
}: {
  title: string;
  description?: string;
  icon?: typeof InboxIcon;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
