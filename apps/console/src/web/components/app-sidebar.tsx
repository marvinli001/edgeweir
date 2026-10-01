import {
  Audit01Icon,
  BlockedIcon,
  DashboardSquare01Icon,
  DatabaseSync01Icon,
  GlobeIcon,
  Key01Icon,
  Location01Icon,
  SecurityLockIcon,
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
      to: "/overview",
      icon: icon(DashboardSquare01Icon),
      testId: "nav-overview",
      exact: true,
    },
    {
      title: m.cert_title(),
      to: "/certificates",
      icon: icon(SecurityLockIcon),
      testId: "nav-certificates",
    },
    { title: m.nav_sites(), to: "/sites", icon: icon(GlobeIcon), testId: "nav-sites" },
    {
      title: m.alert_title(),
      to: "/alerts",
      icon: icon(Audit01Icon),
      testId: "nav-alerts",
    },
    {
      title: m.ip_lists_title(),
      to: "/ip-lists",
      icon: icon(SecurityLockIcon),
      testId: "nav-ip-lists",
    },
    { title: m.bans_title(), to: "/bans", icon: icon(BlockedIcon), testId: "nav-bans" },
    {
      title: m.nav_purge(),
      to: "/purge",
      icon: icon(DatabaseSync01Icon),
      testId: "nav-purge",
    },
    {
      title: m.nav_security(),
      to: "/security",
      icon: icon(SecurityLockIcon),
      testId: "nav-security",
    },
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
    {
      title: m.alert_admin_title(),
      to: "/admin/alerts",
      icon: icon(Audit01Icon),
      testId: "nav-alert-channels",
    },
    {
      title: m.dns_title(),
      to: "/admin/dns",
      icon: icon(GlobeIcon),
      testId: "nav-dns",
    },
    {
      title: m.rules_platform(),
      to: "/admin/rules",
      icon: icon(SecurityLockIcon),
      testId: "nav-platform-rules",
    },
    {
      title: m.nav_regions(),
      to: "/admin/regions",
      icon: icon(Location01Icon),
      testId: "nav-regions",
    },
    {
      title: m.nav_service_accounts(),
      to: "/admin/service-accounts",
      icon: icon(Key01Icon),
      testId: "nav-service-accounts",
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
              render={<Link to={area === "admin" ? "/admin" : "/overview"} />}
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
