import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowLeftDoubleIcon,
  ArrowRight01Icon,
  ArrowRightDoubleIcon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { SidebarScopeTransition } from "@/components/effects/sidebar-scope-transition";
import { LinkButton } from "@/components/link-button";
import { type NavItem, navGroups } from "@/components/nav-items";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import { workspaceLink } from "@/lib/workspace-link";
import type { ScopeItem, ScopeLink } from "@/lib/workspace-nav";
import { type SidebarScope, useCurrentSidebarScope } from "./sidebar-scope";

const NAV_ROW =
  "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-foreground transition-colors duration-100 focus-ring hover:bg-wash [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:font-medium data-active:[&_svg]:text-sidebar-accent-foreground";

/** Whether the item is the current section (its path, or one of the sections it stands for). */
function isActive(item: NavItem, pathname: string) {
  const to = String(item.to);
  if (item.exact) return pathname === to;
  return [to, ...(item.also ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function useOverview() {
  return useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 30_000,
    meta: { background: true },
  });
}

/** How many things need the operator, beside the entry that lists them; nothing at zero. */
function AttentionBadge({ rail }: { rail: boolean }) {
  const count = useOverview().data?.attention.length ?? 0;
  if (count === 0) return null;
  return (
    <span
      className={cn(
        rail
          ? "absolute top-1.5 right-2 size-2 rounded-full bg-warning text-[0px]"
          : "ml-auto grid h-5 min-w-5 place-items-center rounded-sm bg-tint-warning px-1 text-xs leading-none text-warning-ink tabular-nums",
      )}
      title={m.attention_count({ count })}
      data-testid="nav-attention"
    >
      {count}
    </span>
  );
}

function NavRow({ item, active, rail }: { item: NavItem; active: boolean; rail: boolean }) {
  const row = (
    <Link
      to={item.to}
      data-testid={item.testId}
      data-slot="nav-item"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(NAV_ROW, rail && "justify-center px-0")}
    >
      {item.icon}
      <span className={cn("truncate", rail && "sr-only")}>{item.title}</span>
      {item.attention ? <AttentionBadge rail={rail} /> : null}
    </Link>
  );
  if (!rail) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right">{item.title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The console's primary action at the top of the navigation: a new site, or adding a node while
 * there is none.
 */
function PrimaryAction({ rail }: { rail: boolean }) {
  const addNode = useOverview().data?.nodes === 0;
  const title = addNode ? m.nav_add_node() : m.nav_new_site();
  const button = (
    <LinkButton
      to={addNode ? "/clusters" : "/sites"}
      search={addNode ? { enroll: true } : { create: true }}
      variant="secondary"
      className={cn("w-full", rail ? "icon-button" : "justify-start")}
      aria-label={rail ? title : undefined}
      data-testid="nav-primary-action"
      data-action={addNode ? "add-node" : "new-site"}
    >
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {rail ? null : <span className="truncate">{title}</span>}
    </LinkButton>
  );
  if (!rail) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The grouped navigation: the primary action, then sites, access control, infrastructure and the
 * system under small gray group labels. `rail` shows icons only (with tooltips).
 */
function GlobalNavList({ rail }: { rail: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3", "px-2")}
    >
      <div className="px-1">
        <PrimaryAction rail={rail} />
      </div>
      {navGroups().map((group) => (
        <nav key={group.label} aria-label={group.label} className="flex flex-col gap-0.5">
          {rail ? (
            <div className="mx-3 mb-1 h-px bg-border first:hidden" />
          ) : (
            <div className="px-3 pb-1 text-xs text-muted-foreground">{group.label}</div>
          )}
          {group.items.map((item) => (
            <NavRow
              key={String(item.to)}
              item={item}
              active={isActive(item, pathname)}
              rail={rail}
            />
          ))}
        </nav>
      ))}
    </div>
  );
}

const SCOPE_ROW = cn(NAV_ROW, "pointer-coarse:min-h-11 [&_svg]:size-[18px]");
const expandedGroups = new Map<string, boolean>();

function NavTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function ScopedLink({
  item,
  kind,
  rail = false,
  child = false,
  icon,
}: {
  item: ScopeLink;
  kind: string;
  rail?: boolean;
  child?: boolean;
  icon?: React.ReactNode;
}) {
  const row = (
    <Link
      {...workspaceLink(item.href)}
      activeOptions={{ exact: true }}
      replace
      data-testid={`${kind}-nav-${item.key}`}
      data-slot="nav-item"
      data-active={item.current || undefined}
      aria-current={item.current ? "page" : undefined}
      className={cn(SCOPE_ROW, child && "h-8 pl-[38px] text-[13px]", rail && "justify-center px-0")}
    >
      {icon}
      <span className={rail ? "sr-only" : "truncate"}>{item.label}</span>
    </Link>
  );
  return rail ? <NavTip label={item.label}>{row}</NavTip> : row;
}

function ScopedGroup({
  item,
  kind,
  rail,
}: {
  item: Extract<ScopeItem, { children: readonly ScopeLink[] }>;
  kind: string;
  rail: boolean;
}) {
  const id = React.useId();
  const group = `${kind}:${item.key}`;
  const current = item.children.find((link) => link.current)?.key;
  const [expanded, setExpanded] = React.useState(
    () => !!current || expandedGroups.get(group) === true,
  );
  React.useEffect(() => {
    if (current) {
      expandedGroups.set(group, true);
      setExpanded(true);
    }
  }, [current, group]);
  const testId = `${kind}-nav-${item.key}`;
  const icon = <HugeiconsIcon icon={item.icon} strokeWidth={1.75} aria-hidden />;
  if (rail) {
    return (
      <DropdownMenu>
        <NavTip label={item.label}>
          <DropdownMenuTrigger
            render={<button type="button" />}
            className={cn(SCOPE_ROW, "w-full justify-center px-0")}
            data-testid={testId}
            data-active={!!current || undefined}
            data-current={!!current || undefined}
            aria-label={item.label}
          >
            {icon}
          </DropdownMenuTrigger>
        </NavTip>
        <DropdownMenuContent side="right">
          {item.children.map((link) => (
            <DropdownMenuItem
              key={link.key}
              render={
                <Link {...workspaceLink(link.href)} activeOptions={{ exact: true }} replace />
              }
              data-testid={`${kind}-nav-${link.key}`}
              aria-current={link.current ? "page" : undefined}
            >
              {link.label}
              {link.current ? (
                <HugeiconsIcon icon={CheckmarkCircle02Icon} className="ml-auto" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <>
      <button
        type="button"
        className={cn(SCOPE_ROW, "group w-full text-left")}
        aria-expanded={expanded}
        aria-controls={id}
        data-scope-views={item.children.map((link) => link.key).join(" ")}
        data-testid={testId}
        onClick={() => {
          expandedGroups.set(group, !expanded);
          setExpanded(!expanded);
        }}
      >
        {icon}
        <span className="flex-1 truncate">{item.label}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-3.5! transition-transform duration-120 group-aria-expanded:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
      </button>
      <div
        id={id}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-160 ease-(--ew-ease-standard) motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!expanded || undefined}
        aria-hidden={!expanded || undefined}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="relative grid gap-0.5 before:pointer-events-none before:absolute before:inset-y-1 before:left-5 before:z-1 before:w-px before:bg-border">
            {item.children.map((child) => (
              <li key={child.key}>
                <ScopedLink item={child} kind={kind} child />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function ScopedNavList({
  scope,
  rail,
  drawer,
}: {
  scope: SidebarScope;
  rail: boolean;
  drawer: boolean;
}) {
  const back = (
    <Link
      {...workspaceLink(scope.back.href)}
      activeOptions={{ exact: true }}
      className={cn(SCOPE_ROW, "w-full", rail && "justify-center px-0")}
      aria-label={m.scope_back({ label: scope.back.label })}
      data-testid={`${scope.kind}-nav-back`}
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.75} aria-hidden />
      {!rail ? <span className="truncate">{scope.back.label}</span> : null}
    </Link>
  );
  return (
    <>
      <div
        className={cn("flex h-[52px] shrink-0 items-center px-2", rail && "pointer-coarse:px-1.5")}
      >
        {rail ? <NavTip label={scope.back.label}>{back}</NavTip> : back}
      </div>
      <div className={cn("shrink-0 px-2 pb-3", rail && "pointer-coarse:px-1.5")}>
        {scope.switcher(rail)}
      </div>
      <nav
        aria-label={scope.commandGroup}
        data-slot="scope-directory"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto border-t pb-3 [scrollbar-width:thin]",
          drawer ? "px-0" : "px-2",
          rail && "pointer-coarse:px-1.5",
        )}
      >
        <ul className="grid gap-0.5">
          {scope.items.map((item) => (
            <li key={item.key}>
              {"children" in item ? (
                <ScopedGroup item={item} kind={scope.kind} rail={rail} />
              ) : (
                <ScopedLink
                  item={item}
                  kind={scope.kind}
                  rail={rail}
                  icon={<HugeiconsIcon icon={item.icon} strokeWidth={1.75} aria-hidden />}
                />
              )}
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

export function NavList({ rail = false, drawer = false }: { rail?: boolean; drawer?: boolean }) {
  const scope = useCurrentSidebarScope();
  return (
    <SidebarScopeTransition kind={scope?.kind}>
      {scope ? (
        <ScopedNavList scope={scope} rail={rail} drawer={drawer} />
      ) : (
        <GlobalNavList rail={rail} />
      )}
    </SidebarScopeTransition>
  );
}

/**
 * The left product sidebar (desktop): 208px with labels, or the 56px icon rail; the control at the
 * bottom folds and unfolds it.
 */
export function SideNav({
  rail,
  onRailChange,
}: {
  rail: boolean;
  onRailChange: (rail: boolean) => void;
}) {
  return (
    // The column carries the surface and hairline down the whole page; the sticky panel inside
    // stays in view while the page scrolls.
    <div className="hidden shrink-0 border-r bg-sidebar md:block">
      <aside
        data-slot="sidebar"
        data-rail={rail || undefined}
        className={cn(
          "sticky top-(--header-height) flex h-[calc(100svh-var(--header-height))] flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none",
          rail ? "w-[calc(var(--ew-rail-width)-1px)]" : "w-[calc(var(--ew-sidebar-width)-1px)]",
        )}
      >
        <NavList rail={rail} />
        <div className="border-t p-2">
          <button
            type="button"
            onClick={() => onRailChange(!rail)}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground transition-colors focus-ring hover:bg-wash hover:text-foreground [&_svg]:size-4",
              rail && "justify-center px-0",
            )}
            aria-label={rail ? m.nav_expand() : m.nav_collapse()}
            data-testid="sidebar-collapse"
          >
            <HugeiconsIcon
              icon={rail ? ArrowRightDoubleIcon : ArrowLeftDoubleIcon}
              strokeWidth={2}
            />
            {rail ? null : <span>{m.nav_collapse()}</span>}
          </button>
        </div>
      </aside>
    </div>
  );
}
