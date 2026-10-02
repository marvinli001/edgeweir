import {
  ArrowDataTransferHorizontalIcon,
  Audit01Icon,
  Certificate01Icon,
  DashboardSquare01Icon,
  DatabaseSync01Icon,
  GlobeIcon,
  Key01Icon,
  ListViewIcon,
  Location01Icon,
  Notification03Icon,
  Route01Icon,
  SecurityLockIcon,
  ServerStack01Icon,
  Settings05Icon,
  Shield01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { NavItem } from "@/components/nav-main";
import { m } from "@/lib/i18n";

const icon = (i: typeof GlobeIcon) => <HugeiconsIcon icon={i} strokeWidth={2} />;

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** The sidebar: sites first, then access control, infrastructure and the system. */
export function navGroups(): NavGroup[] {
  return [
    {
      items: [
        {
          title: m.nav_overview(),
          to: "/overview",
          icon: icon(DashboardSquare01Icon),
          testId: "nav-overview",
          exact: true,
          attention: true,
        },
        {
          title: m.nav_sites(),
          to: "/sites",
          icon: icon(GlobeIcon),
          testId: "nav-sites",
          // Layer-4 applications are a tab of the sites section.
          also: ["/l4"],
        },
        {
          title: m.cert_title(),
          to: "/certificates",
          icon: icon(Certificate01Icon),
          testId: "nav-certificates",
        },
        {
          title: m.nav_purge(),
          to: "/purge",
          icon: icon(DatabaseSync01Icon),
          testId: "nav-purge",
        },
      ],
    },
    {
      label: m.nav_group_access(),
      items: [
        {
          title: m.rules_platform(),
          to: "/rules",
          icon: icon(Shield01Icon),
          testId: "nav-rules",
        },
        {
          title: m.nav_ip_lists_bans(),
          to: "/ip-lists",
          icon: icon(ListViewIcon),
          testId: "nav-ip-lists",
          // Bans are a tab of the same section.
          also: ["/bans"],
        },
        {
          title: m.protection_page_title(),
          to: "/protection",
          icon: icon(SecurityLockIcon),
          testId: "nav-protection",
        },
      ],
    },
    {
      label: m.nav_group_infrastructure(),
      items: [
        {
          title: m.nav_clusters(),
          to: "/clusters",
          icon: icon(ServerStack01Icon),
          testId: "nav-clusters",
        },
        {
          title: m.nav_regions(),
          to: "/regions",
          icon: icon(Location01Icon),
          testId: "nav-regions",
        },
        { title: m.dns_title(), to: "/dns", icon: icon(Route01Icon), testId: "nav-dns" },
      ],
    },
    {
      label: m.nav_group_system(),
      items: [
        {
          title: m.alert_title(),
          to: "/alerts",
          icon: icon(Notification03Icon),
          testId: "nav-alerts",
        },
        {
          title: m.nav_service_accounts(),
          to: "/service-accounts",
          icon: icon(Key01Icon),
          testId: "nav-service-accounts",
        },
        { title: m.nav_audit(), to: "/audit", icon: icon(Audit01Icon), testId: "nav-audit" },
        {
          title: m.nav_system(),
          to: "/system",
          icon: icon(SlidersHorizontalIcon),
          testId: "nav-system",
        },
      ],
    },
  ];
}

/** Pages without a sidebar entry of their own, for the command menu. */
export function moreNav(): NavItem[] {
  return [
    {
      title: m.l4_title(),
      to: "/l4",
      icon: icon(ArrowDataTransferHorizontalIcon),
      testId: "nav-l4",
    },
  ];
}

/** Pages of the signed-in account, in the user menu. */
export function accountNav(): NavItem[] {
  return [
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
