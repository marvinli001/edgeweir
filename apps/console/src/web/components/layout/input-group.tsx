import type * as React from "react";
import { Input } from "@/components/arc/input/input";
import { cn } from "@/lib/utils";

/*
 * An input with leading or trailing addons (an icon, a unit, a button) inside one frame: the frame
 * takes the Arc input's border, hover, focus and error states.
 */

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "group/input-group relative flex h-(--arc-control-height-md) w-full min-w-0 items-center rounded-md border border-input bg-card transition-[border-color,box-shadow] duration-150 hover:border-input-hover has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20 has-[[data-slot][aria-invalid=true]]:border-destructive has-[>textarea]:h-auto",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupAddon({
  className,
  align = "inline-start",
  onClick,
  ...props
}: React.ComponentProps<"div"> & { align?: "inline-start" | "inline-end" }) {
  return (
    // A click on the addon's icon focuses the input; the input itself is the keyboard target.
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer convenience only
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer convenience only
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex h-auto cursor-text items-center justify-center gap-2 text-sm text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-4",
        align === "inline-start"
          ? "order-first pl-2.5 has-[>button]:pl-1"
          : "order-last pr-2.5 has-[>button]:pr-1",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if ((event.target as HTMLElement).closest("button")) return;
        event.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input data-slot="input-group-control" className={cn("flex-1 px-2.5", className)} {...props} />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput };
