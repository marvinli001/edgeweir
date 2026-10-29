import type * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { cn } from "@/lib/utils";

/**
 * Why a control is disabled, in a tooltip over it. A disabled button takes no pointer events, so
 * the tooltip sits on a wrapper around it. Without a `reason` the control renders on its own.
 */
export function DisabledHint({
  reason,
  className,
  children,
}: {
  reason: string | false | null | undefined;
  /** The control's place in its row (e.g. `ml-auto`), for the wrapper. */
  className?: string;
  children: React.ReactElement;
}) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("inline-flex cursor-not-allowed", className)}
            data-slot="disabled-hint"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
