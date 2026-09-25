import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Token boundary for appica components that read appica tokens (see appica-bridge.css).
 * Renders `display: contents`, so it never affects layout. Put only appica components inside.
 */
export function AppicaScope({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="appica-scope" className={cn("appica-scope contents", className)} {...props} />
  );
}
