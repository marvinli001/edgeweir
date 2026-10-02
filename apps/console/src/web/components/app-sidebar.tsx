import { Link, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { Logo } from "@/components/logo";
import { navGroups } from "@/components/nav-items";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { m } from "@/lib/i18n";

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string };
}) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a drawer over the page: any navigation from it closes it.
  React.useEffect(
    () =>
      router.subscribe("onBeforeNavigate", (event) => {
        if (event.hrefChanged) setOpenMobile(false);
      }),
    [router, setOpenMobile],
  );
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/overview" />}
            >
              <Logo className="size-5!" />
              <span className="text-base font-semibold">{m.app_name()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1">
        {navGroups().map((group, index) => (
          <NavMain
            key={group.label ?? "main"}
            items={group.items}
            label={group.label}
            showNewSite={index === 0}
          />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
