import type * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A list cell that stays one line high: the first item, then "+N" for the rest, which lists every
 * item on hover and keyboard focus. Dense tables (sites: domains, origins) keep 48px rows this way.
 */
export function MoreList<T>({
  items,
  render,
  getKey,
  testId,
  className,
}: {
  items: readonly T[];
  render: (item: T) => React.ReactNode;
  getKey: (item: T) => string;
  testId?: string;
  className?: string;
}) {
  const [first, ...rest] = items;
  if (first === undefined) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span className="min-w-0 truncate">{render(first)}</span>
      {rest.length ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="shrink-0 cursor-default rounded-sm bg-well px-1 font-sans text-xs leading-5 text-muted-foreground tabular-nums focus-ring"
                aria-label={m.more_list_label({ count: rest.length })}
                data-testid={testId}
                data-row-ignore
              />
            }
          >
            +{rest.length}
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <span className="flex flex-col gap-0.5 font-mono text-xs">
              {items.map((item) => (
                <span key={getKey(item)} className="break-all">
                  {render(item)}
                </span>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
