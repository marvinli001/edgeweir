import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { type IconPlayer, useIconPlay } from "@/components/effects/animated-icons";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
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
  /** Shows how many things need the operator (the overview lists them). */
  attention?: boolean;
  /** The same glyph, animated: it plays when the row is hovered or focused. */
  animated?: React.ForwardRefExoticComponent<
    { className?: string } & React.RefAttributes<IconPlayer>
  >;
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const { ref, trigger } = useIconPlay();
  const Animated = item.animated;
  // The animated glyph plays once when its entry becomes the current page (not on first render).
  const wasActive = React.useRef(active);
  React.useEffect(() => {
    if (active && !wasActive.current) ref.current?.play();
    wasActive.current = active;
  }, [active, ref]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.title}
        isActive={active}
        render={<Link to={item.to} data-testid={item.testId} />}
        {...(Animated ? trigger : {})}
      >
        {Animated ? <Animated ref={ref} /> : item.icon}
        <span>{item.title}</span>
      </SidebarMenuButton>
      {item.attention ? <AttentionBadge /> : null}
    </SidebarMenuItem>
  );
}

/** How many things need the operator, beside the entry that lists them; nothing at zero. */
function AttentionBadge() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const count = overview.data?.attention.length ?? 0;
  if (count === 0) return null;
  return (
    <SidebarMenuBadge
      className="bg-state-warn/15"
      title={m.attention_count({ count })}
      data-testid="nav-attention"
    >
      {count}
    </SidebarMenuBadge>
  );
}

/**
 * The sidebar's primary action: a new site, or adding a node while there is none. A primary
 * Button (the lit face, btn-lit) spanning the sidebar, not a menu row.
 */
function PrimaryAction() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const addNode = overview.data?.nodes === 0;
  const title = addNode ? m.nav_add_node() : m.nav_new_site();
  return (
    <Button
      className="w-full justify-start"
      nativeButton={false}
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
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
      <span className="truncate">{title}</span>
    </Button>
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
            return <NavRow key={to} item={item} active={active} />;
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
