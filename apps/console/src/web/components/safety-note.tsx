import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The one line a screen may add beside labels and values: a safety note such as "shown once", or
 * what a confirmation is about to change (ADR-0003 decision 7). Never an explanation; those go to
 * docs/. Description slots (CardDescription, DialogDescription, FieldDescription…) are not used.
 */
export function SafetyNote({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="safety-note"
      className={cn("text-left text-sm leading-normal text-muted-foreground", className)}
      {...props}
    />
  );
}
