import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { m } from "@/lib/i18n";

export interface NavItem {
  title: string;
  to: NonNullable<LinkProps["to"]>;
  icon: React.ReactNode;
  testId: string;
  /** Match the path exactly instead of as a prefix (for area roots). */
  exact?: boolean;
}

export function NavMain({
  items,
  label,
  showNewSite,
}: {
  items: NavItem[];
  label?: string;
  showNewSite?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // Labelled groups sit closer together so the whole sidebar fits a laptop screen.
    <SidebarGroup className={label ? "py-0" : "pb-0"}>
      {label ? <SidebarGroupLabel className="h-6">{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent className="flex flex-col gap-2">
        {showNewSite ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={m.nav_new_site()}
                className="min-w-8 bg-primary text-primary-foreground shadow-md shadow-primary/20 duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                render={<Link to="/sites" search={{ create: true }} />}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                <span>{m.nav_new_site()}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <SidebarMenu>
          {items.map((item) => {
            const to = String(item.to);
            const active = item.exact
              ? pathname === to
              : pathname === to || pathname.startsWith(`${to}/`);
            return (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={active}
                  render={<Link to={item.to} data-testid={item.testId} />}
                >
                  {item.icon}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
