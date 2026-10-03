import type * as React from "react";
import { type PageWidth, SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";

/** The content column, padding included: 72rem (or 56rem) of content, centered in the inset. */
const COLUMN: Record<PageWidth, string> = {
  default: "max-w-[74rem] lg:max-w-[75rem]",
  narrow: "max-w-[58rem] lg:max-w-[59rem]",
};

/**
 * Standard page frame inside the sidebar inset: header + a centered content column that fades in
 * on mount. The column is the `main` container that container queries measure.
 */
export function Page({
  title,
  actions,
  width = "default",
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  width?: PageWidth;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader title={title} actions={actions} width={width} />
      <div
        className={cn(
          "@container/main mx-auto flex w-full flex-1 flex-col gap-6 p-4 animate-enter lg:p-6",
          COLUMN[width],
        )}
      >
        {children}
      </div>
    </>
  );
}
