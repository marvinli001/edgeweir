import { Alert02Icon, InboxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { Loader } from "@/components/appica/loader";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/**
 * First-load placeholder: a centered loader, faded in after a short delay so fast responses
 * never flash it. Refreshes of loaded data keep the old content and only run the top progress bar.
 */
export function LoadingState({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-40 flex-1 items-center justify-center animate-in fade-in fill-mode-both delay-200 duration-300",
        className,
      )}
    >
      <Loader label={m.common_loading()} />
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
  icon = InboxIcon,
  children,
}: {
  title: string;
  icon?: typeof InboxIcon;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="border border-dashed bg-linear-to-b from-muted/40 to-transparent animate-enter">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
