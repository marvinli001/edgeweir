import type * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Page header. Below the `sm` breakpoint the page actions wrap onto a second row so the title
 * keeps its room on phones.
 */
export function SiteHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex min-h-(--header-height) shrink-0 items-center gap-2 rounded-t-[inherit] border-b bg-background/80 backdrop-blur-md transition-[width,height] ease-linear">
      <div className="flex w-full flex-wrap items-center gap-x-1 gap-y-2 px-4 py-2 lg:gap-x-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <h1 className="min-w-0 flex-1 truncate text-base font-medium" data-testid="page-title">
          {title}
        </h1>
        {actions ? (
          <div className="order-last flex w-full flex-wrap items-center gap-2 sm:order-none sm:w-auto">
            {actions}
          </div>
        ) : null}
        <ThemeToggle className="shrink-0" />
      </div>
    </header>
  );
}
