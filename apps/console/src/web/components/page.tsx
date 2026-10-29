import type * as React from "react";
import { cn } from "@/lib/utils";

/** The content column of a page: the default one, or a narrower one for short forms. */
export type PageWidth = "default" | "narrow";

const COLUMN: Record<PageWidth, string> = {
  default: "max-w-(--ew-content-max)",
  narrow: "max-w-[60rem]",
};

/**
 * The entrance delay of the `index`th card or row of a list (with `animate-enter`): a short
 * stagger that stops growing after a dozen, so long lists do not keep the last rows waiting.
 */
export function enterDelay(index: number, step = 20): React.CSSProperties {
  return { animationDelay: `${Math.min(index, 12) * step}ms` };
}

/**
 * The page header on the canvas (tokens.md): the title (18px medium) with the page actions at the
 * end, an optional `back` link before it; page tabs follow directly under it as the first child
 * of the page (line tabs). No subtitle. Below `sm` the actions wrap under the title.
 */
function PageHeader({
  title,
  actions,
  back,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  back?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-slot="page-header">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {back}
        {title ? (
          <h1
            className="min-w-0 truncate text-title font-medium text-foreground"
            data-testid="page-title"
          >
            {title}
          </h1>
        ) : null}
      </div>
      {actions ? (
        <div
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
          data-slot="page-actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Standard page frame in the shell: the header on the canvas and the content column (max 1600px,
 * 24px gutters, 16px on phones; 16px between panels). The column is the `main` container that
 * container queries measure.
 */
export function Page({
  title,
  actions,
  back,
  width = "default",
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  back?: React.ReactNode;
  width?: PageWidth;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "@container/main mx-auto flex w-full flex-1 flex-col gap-4 px-(--ew-gutter-phone) pt-5 pb-10 animate-enter md:px-(--ew-gutter) md:pt-6",
        COLUMN[width],
      )}
    >
      <PageHeader title={title} actions={actions} back={back} />
      {children}
    </div>
  );
}
