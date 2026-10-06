import type * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** The content column of a page (Page): the default one, or a narrower one for short forms. */
export type PageWidth = "default" | "narrow";

/*
 * Where the header row turns into three columns: the inset is wide enough for the content column
 * plus the sidebar trigger and the theme toggle beside it (72rem / 56rem + 2 × 3.5rem + padding).
 */
const ROW: Record<PageWidth, string> = {
  default:
    "@min-[82rem]/header:grid @min-[82rem]/header:grid-cols-[minmax(0,1fr)_minmax(0,72rem)_minmax(0,1fr)]",
  narrow:
    "@min-[66rem]/header:grid @min-[66rem]/header:grid-cols-[minmax(0,1fr)_minmax(0,56rem)_minmax(0,1fr)]",
};
const SEPARATOR: Record<PageWidth, string> = {
  default: "@min-[82rem]/header:hidden",
  narrow: "@min-[66rem]/header:hidden",
};
const TITLE_ROW: Record<PageWidth, string> = {
  default: "@min-[82rem]/header:flex",
  narrow: "@min-[66rem]/header:flex",
};

/**
 * Page header. On a wide inset the title and the page actions sit over the content column, with
 * the sidebar trigger at the left edge and the theme toggle at the right; narrower it is one row,
 * and below `sm` the page actions wrap onto a second row so the title keeps its room on phones.
 * Without a title (status pages) only the trigger and the toggle show.
 */
export function SiteHeader({
  title,
  actions,
  width = "default",
}: {
  title?: string;
  actions?: React.ReactNode;
  width?: PageWidth;
}) {
  return (
    <header className="@container/header sticky top-0 z-20 flex min-h-(--header-height) shrink-0 items-center gap-2 rounded-t-[inherit] border-b border-edge glass transition-[width,height] ease-linear">
      <div
        className={cn(
          "flex w-full flex-wrap items-center gap-x-1 gap-y-2 px-4 py-2 lg:gap-x-2 lg:px-6",
          ROW[width],
        )}
      >
        <div className="flex items-center">
          <SidebarTrigger className="-ml-1" />
          {title || actions ? (
            <Separator
              orientation="vertical"
              className={cn("mx-2 h-4 data-vertical:self-auto", SEPARATOR[width])}
            />
          ) : null}
        </div>
        <div className={cn("contents min-w-0 items-center gap-2", TITLE_ROW[width])}>
          {title ? (
            <h1 className="min-w-0 flex-1 truncate text-base font-medium" data-testid="page-title">
              {title}
            </h1>
          ) : (
            <div className="flex-1" />
          )}
          {actions ? (
            <div className="order-last flex w-full flex-wrap items-center gap-2 sm:order-none sm:w-auto">
              {actions}
            </div>
          ) : null}
        </div>
        <ThemeToggle className="shrink-0 justify-self-end" />
      </div>
    </header>
  );
}
