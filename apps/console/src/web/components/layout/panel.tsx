import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Panel: the white content surface on the gray canvas (tokens.md): 1px hairline, 8px radius, no
 * shadow, 20px padding (16px in `size="sm"`). Header = title (16px medium) with actions at the
 * end; content; an optional footer (a top hairline when it holds the save actions).
 */

function Panel({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"section"> & { size?: "default" | "sm" }) {
  return (
    <section
      data-slot="panel"
      data-size={size}
      className={cn(
        "group/panel flex min-w-0 flex-col gap-(--panel-gap) rounded-lg border border-border bg-card py-(--panel-pad) text-sm text-card-foreground [--panel-gap:--spacing(4)] [--panel-pad:--spacing(5)] data-[size=sm]:[--panel-pad:--spacing(4)] max-sm:[--panel-pad:--spacing(4)]",
        className,
      )}
      {...props}
    />
  );
}

function PanelHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex min-h-7 flex-wrap items-center gap-x-4 gap-y-2 px-(--panel-pad) [.border-b]:pb-(--panel-pad)",
        className,
      )}
      {...props}
    />
  );
}

function PanelTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="panel-title"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 text-section font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Actions at the end of the header: buttons, a switch, a link. */
function PanelAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-action"
      className={cn("ml-auto flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
}

function PanelContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-content"
      className={cn("@container/panel min-w-0 px-(--panel-pad)", className)}
      {...props}
    />
  );
}

/**
 * The panel's footer. With `sticky`, the save bar of a long settings form: it stays at the bottom
 * of the viewport while the form scrolls, on the panel color with a top hairline.
 */
function PanelFooter({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"div"> & { sticky?: boolean }) {
  return (
    <div
      data-slot="panel-footer"
      data-sticky={sticky || undefined}
      className={cn(
        "flex items-center gap-3 px-(--panel-pad) [.border-t]:pt-(--panel-pad) data-sticky:sticky data-sticky:bottom-0 data-sticky:z-10 data-sticky:-mb-(--panel-pad) data-sticky:rounded-b-lg data-sticky:border-t data-sticky:bg-card data-sticky:py-3",
        className,
      )}
      {...props}
    />
  );
}

export { Panel, PanelAction, PanelContent, PanelFooter, PanelHeader, PanelTitle };
