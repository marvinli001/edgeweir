import { Add01Icon, ArrowLeftDoubleIcon, ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { LinkButton } from "@/components/link-button";
import { type NavItem, navGroups } from "@/components/nav-items";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

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
      className={cn(
        "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-foreground transition-colors duration-100 focus-ring hover:bg-wash [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        "data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:font-medium data-active:[&_svg]:text-sidebar-accent-foreground",
        rail && "justify-center px-0",
      )}
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
export function NavList({ rail = false }: { rail?: boolean }) {
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
          rail ? "w-(--ew-rail-width)" : "w-(--ew-sidebar-width)",
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
