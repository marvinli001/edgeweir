import * as React from "react";
import { createPortal } from "react-dom";
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

const TabsSlot = React.createContext<HTMLElement | null>(null);

/**
 * A page's tab bar: put the page's line TabsList in it and it shows in the header band, under the
 * title, while the Tabs root (and its panels) stay in the page body. The band's hairline is the
 * tab bar's line.
 */
export function PageTabs({ children }: { children: React.ReactNode }) {
  const slot = React.useContext(TabsSlot);
  return slot ? createPortal(children, slot) : null;
}

/**
 * The page header band (tokens.md, shell): a white strip across the content area with a bottom
 * hairline; the title (18px medium) with an optional `back` link before it and the page actions at
 * the end, in a 56px row; the page's tab bar (PageTabs) directly under it. No subtitle. Below
 * `sm` the actions wrap under the title.
 */
function PageHeader({
  title,
  actions,
  back,
  column,
  onTabsSlot,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  back?: React.ReactNode;
  column: string;
  onTabsSlot: (slot: HTMLDivElement | null) => void;
}) {
  return (
    <div className="border-b bg-card" data-slot="page-header">
      <div className={cn("mx-auto w-full px-(--ew-gutter-phone) md:px-(--ew-gutter)", column)}>
        <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
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
        <div ref={onTabsSlot} className="-mt-1.5 empty:hidden" data-slot="page-tabs" />
      </div>
    </div>
  );
}

/**
 * Standard page frame in the shell: the header band, then the content column on the canvas (max
 * 1600px, 24px gutters, 16px on phones; 20px under the band, 16px between panels). The column is
 * the `main` container that container queries measure.
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
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  return (
    <div className="flex w-full flex-1 flex-col">
      <PageHeader
        title={title}
        actions={actions}
        back={back}
        column={COLUMN[width]}
        onTabsSlot={setSlot}
      />
      <TabsSlot.Provider value={slot}>
        <div
          className={cn(
            "@container/main mx-auto flex w-full flex-1 flex-col gap-4 px-(--ew-gutter-phone) pt-5 pb-10 animate-enter md:px-(--ew-gutter)",
            COLUMN[width],
          )}
        >
          {children}
        </div>
      </TabsSlot.Provider>
    </div>
  );
}
