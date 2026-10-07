import type * as React from "react";
import { type PageWidth, SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";

/** The content column, padding included: 72rem (or 56rem) of content, centered in the inset. */
const COLUMN: Record<PageWidth, string> = {
  default: "max-w-[74rem] lg:max-w-[75rem]",
  narrow: "max-w-[58rem] lg:max-w-[59rem]",
};

/**
 * The entrance delay of the `index`th card or row of a list (with `animate-enter`): a short
 * stagger that stops growing after a dozen, so long lists do not keep the last rows waiting.
 */
export function enterDelay(index: number, step = 30): React.CSSProperties {
  return { animationDelay: `${Math.min(index, 12) * step}ms` };
}

/**
 * Standard page frame inside the sidebar inset: the sticky header and a centered content column
 * (24px between sections, 16px / 24px padding) that rises in on mount; its cards and rows
 * stagger after it (`animate-enter` with `enterDelay`). The column is the `main` container that
 * container queries measure.
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
