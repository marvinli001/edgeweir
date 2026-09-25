import {
  DashboardSquare01Icon,
  GlobeIcon,
  ServerStack01Icon,
  Settings05Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { Logo } from "@/components/logo";
import { type NavItem, NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { m } from "@/lib/i18n";

export function AppSidebar({
  user,
  isAdmin,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string };
  isAdmin: boolean;
}) {
  const items: NavItem[] = [
    {
      title: m.nav_overview(),
      to: "/",
      icon: <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} />,
      testId: "nav-overview",
    },
    ...(isAdmin
      ? [
          {
            title: m.nav_clusters(),
            to: "/clusters" as const,
            icon: <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />,
            testId: "nav-clusters",
          },
        ]
      : []),
    {
      title: m.nav_sites(),
      to: "/sites",
      icon: <HugeiconsIcon icon={GlobeIcon} strokeWidth={2} />,
      testId: "nav-sites",
    },
    {
      title: m.nav_settings(),
      to: "/settings",
      icon: <HugeiconsIcon icon={Settings05Icon} strokeWidth={2} />,
      testId: "nav-settings",
    },
  ];
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/" />}
            >
              <Logo className="size-5!" />
              <span className="text-base font-semibold">{m.app_name()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
