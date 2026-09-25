import {
  Audit01Icon,
  DashboardSquare01Icon,
  GlobeIcon,
  ServerStack01Icon,
  Settings05Icon,
  SlidersHorizontalIcon,
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
import { useArea } from "@/lib/area";
import { m } from "@/lib/i18n";

const icon = (i: typeof GlobeIcon) => <HugeiconsIcon icon={i} strokeWidth={2} />;

export function consoleNav(): NavItem[] {
  return [
    {
      title: m.nav_overview(),
      to: "/",
      icon: icon(DashboardSquare01Icon),
      testId: "nav-overview",
      exact: true,
    },
    { title: m.nav_sites(), to: "/sites", icon: icon(GlobeIcon), testId: "nav-sites" },
    {
      title: m.nav_settings(),
      to: "/settings",
      icon: icon(Settings05Icon),
      testId: "nav-settings",
    },
  ];
}

export function adminNav(): NavItem[] {
  return [
    {
      title: m.nav_admin_overview(),
      to: "/admin",
      icon: icon(DashboardSquare01Icon),
      testId: "nav-admin-overview",
      exact: true,
    },
    {
      title: m.nav_clusters(),
      to: "/admin/clusters",
      icon: icon(ServerStack01Icon),
      testId: "nav-clusters",
    },
    { title: m.nav_audit(), to: "/admin/audit", icon: icon(Audit01Icon), testId: "nav-audit" },
    {
      title: m.nav_system(),
      to: "/admin/settings",
      icon: icon(SlidersHorizontalIcon),
      testId: "nav-system",
    },
  ];
}

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string };
}) {
  const area = useArea();
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to={area === "admin" ? "/admin" : "/"} />}
            >
              <Logo className="size-5!" />
              <span className="text-base font-semibold">{m.app_name()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {area === "admin" ? (
          <NavMain key="admin" items={adminNav()} label={m.area_admin()} />
        ) : (
          <NavMain key="console" items={consoleNav()} showNewSite />
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
