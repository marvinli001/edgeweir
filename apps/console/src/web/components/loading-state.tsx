import { Spinner } from "@/components/layout/spinner";
import { m } from "@/lib/i18n";
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
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-5 text-primary-ink" />
        {m.common_loading()}
      </span>
    </div>
  );
}
