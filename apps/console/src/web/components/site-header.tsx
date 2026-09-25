import { useRouteContext } from "@tanstack/react-router";
import type * as React from "react";
import { AreaSwitch } from "@/components/area-switch";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function SiteHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  const { isAdmin } = useRouteContext({ from: "/_app" });
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 rounded-t-[inherit] border-b bg-background/80 backdrop-blur-md transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <h1 className="text-base font-medium" data-testid="page-title">
          {title}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {isAdmin ? <AreaSwitch /> : null}
        </div>
      </div>
    </header>
  );
}
