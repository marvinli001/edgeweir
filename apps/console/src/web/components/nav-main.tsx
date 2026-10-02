import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
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
import { orpc } from "@/lib/orpc";

export interface NavItem {
  title: string;
  to: NonNullable<LinkProps["to"]>;
  icon: React.ReactNode;
  testId: string;
  /** Match the path exactly instead of as a prefix (for area roots). */
  exact?: boolean;
  /** Other sections the entry also stands for (prefix match), reached from its page. */
  also?: string[];
}

const PRIMARY =
  "min-w-8 bg-primary text-primary-foreground shadow-md shadow-primary/20 duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground";

/** The sidebar's primary action: a new site, or adding a node while there is none. */
function PrimaryAction() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const addNode = overview.data?.nodes === 0;
  const title = addNode ? m.nav_add_node() : m.nav_new_site();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={title}
          className={PRIMARY}
          render={
            addNode ? (
              <Link
                to="/clusters"
                search={{ enroll: true }}
                data-testid="nav-primary-action"
                data-action="add-node"
              />
            ) : (
              <Link
                to="/sites"
                search={{ create: true }}
                data-testid="nav-primary-action"
                data-action="new-site"
              />
            )
          }
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          <span>{title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function NavMain({
  items,
  label,
  showPrimary,
}: {
  items: NavItem[];
  label?: string;
  showPrimary?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // Labelled groups sit closer together so the whole sidebar fits a laptop screen.
    <SidebarGroup className={label ? "py-0" : "pb-0"}>
      {label ? <SidebarGroupLabel className="h-6">{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent className="flex flex-col gap-2">
        {showPrimary ? <PrimaryAction /> : null}
        <SidebarMenu>
          {items.map((item) => {
            const to = String(item.to);
            const active = item.exact
              ? pathname === to
              : [to, ...(item.also ?? [])].some(
                  (path) => pathname === path || pathname.startsWith(`${path}/`),
                );
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
