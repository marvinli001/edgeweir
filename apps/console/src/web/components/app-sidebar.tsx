import {
  Audit01Icon,
  Building03Icon,
  DashboardSquare01Icon,
  DatabaseSync01Icon,
  GlobeIcon,
  Location01Icon,
  SecurityLockIcon,
  ServerStack01Icon,
  Settings05Icon,
  SlidersHorizontalIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { type NavItem, NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { useArea } from "@/lib/area";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const icon = (i: typeof GlobeIcon) => <HugeiconsIcon icon={i} strokeWidth={2} />;

/** Console navigation; "members" only for organization owners/admins (and platform admins). */
export function consoleNav(opts: { manageMembers: boolean }): NavItem[] {
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
      title: m.nav_purge(),
      to: "/purge",
      icon: icon(DatabaseSync01Icon),
      testId: "nav-purge",
    },
    ...(opts.manageMembers
      ? [
          {
            title: m.nav_members(),
            to: "/members" as const,
            icon: icon(UserGroupIcon),
            testId: "nav-members",
          },
        ]
      : []),
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

export function useManageMembers(): boolean {
  const me = useQuery(orpc.account.me.queryOptions());
  const role = me.data?.activeOrganization?.role;
  return role === "owner" || role === "admin";
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
      title: m.nav_regions(),
      to: "/admin/regions",
      icon: icon(Location01Icon),
      testId: "nav-regions",
    },
    {
      title: m.nav_organizations(),
      to: "/admin/organizations",
      icon: icon(Building03Icon),
      testId: "nav-organizations",
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
  const manageMembers = useManageMembers();
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {area === "admin" ? (
          <NavMain key="admin" items={adminNav()} label={m.area_admin()} />
        ) : (
          <NavMain key="console" items={consoleNav({ manageMembers })} showNewSite />
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
