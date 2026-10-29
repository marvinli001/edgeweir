import {
  ComputerIcon,
  LanguageSkillIcon,
  Logout01Icon,
  Menu01Icon,
  Moon02Icon,
  Notification03Icon,
  Search01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { openCommandMenu } from "@/components/command-menu";
import { Logo } from "@/components/logo";
import { accountNav } from "@/components/nav-items";
import { useTheme } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAction } from "@/hooks/use-action";
import { authClient } from "@/lib/auth-client";
import { getLocale, type Locale, localeLabels, locales, m, setLocale } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export interface ShellUser {
  name: string;
  email: string;
  demo?: boolean;
}

/** The ⌘K entry: a search field look-alike that opens the command palette. */
function SearchTrigger() {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <>
      <button
        type="button"
        onClick={openCommandMenu}
        className="hidden h-8 w-full max-w-90 items-center gap-2 rounded-md border border-input bg-well px-3 text-sm text-placeholder transition-colors focus-ring hover:border-input-hover md:flex"
        data-testid="command-trigger"
      >
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
        <span className="flex-1 truncate text-left">{m.command_placeholder()}</span>
        <kbd className="rounded-sm border bg-card px-1.5 font-sans text-xs text-muted-foreground">
          {mac ? "⌘ K" : m.command_shortcut_ctrl()}
        </kbd>
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="icon-button md:hidden"
        onClick={openCommandMenu}
        aria-label={m.command_label()}
      >
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
      </Button>
    </>
  );
}

/** Alerts, with a dot while something needs the operator. */
function AlertsLink() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const count = overview.data?.attention.length ?? 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/alerts"
            className="relative grid size-8 place-items-center rounded-md text-muted-foreground transition-colors focus-ring hover:bg-wash hover:text-foreground"
            aria-label={count ? m.attention_count({ count }) : m.alert_title()}
          />
        }
      >
        <HugeiconsIcon icon={Notification03Icon} strokeWidth={2} className="size-4.5" />
        {count ? (
          <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive ring-2 ring-card" />
        ) : null}
      </TooltipTrigger>
      <TooltipContent>{m.alert_title()}</TooltipContent>
    </Tooltip>
  );
}

/** The account menu: account pages, language, theme and sign out. */
function UserMenu({ user }: { user: ShellUser }) {
  const subtitle = user.demo ? m.user_menu_demo() : user.email;
  const { theme, resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useAction();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-md px-1.5 text-sm transition-colors focus-ring hover:bg-wash aria-expanded:bg-wash"
            data-testid="user-menu"
            aria-label={user.name}
          />
        }
      >
        <Avatar name={user.name} className="size-7" aria-hidden="true" />
        <span className="hidden max-w-40 truncate lg:inline">{user.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56" align="end" sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex flex-col px-1 py-1.5 text-left text-sm leading-tight">
              <span className="truncate font-medium text-foreground">{user.name}</span>
              <span
                className="truncate text-xs text-muted-foreground"
                data-testid={user.demo ? "demo-account" : undefined}
              >
                {subtitle}
              </span>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {accountNav().map((item) => (
            <DropdownMenuItem
              key={String(item.to)}
              data-testid={item.testId}
              onClick={() => void navigate({ to: item.to })}
            >
              {item.icon}
              {item.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="language-menu">
            <HugeiconsIcon icon={LanguageSkillIcon} strokeWidth={2} />
            {m.user_menu_language()}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={getLocale()}
              onValueChange={(value) => setLocale(value as Locale)}
            >
              {locales.map((locale) => (
                <DropdownMenuRadioItem key={locale} value={locale} data-testid={`locale-${locale}`}>
                  {localeLabels[locale]()}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <HugeiconsIcon
              icon={resolvedTheme === "dark" ? Moon02Icon : Sun03Icon}
              strokeWidth={2}
            />
            {m.user_menu_theme()}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as "light" | "dark" | "system")}
            >
              <DropdownMenuRadioItem value="light">
                <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />
                {m.theme_light()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
                {m.theme_dark()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
                {m.theme_system()}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="logout"
          disabled={signOut.pending}
          onClick={() =>
            signOut.run(async () => {
              await authClient.signOut();
              // Nothing of this account may leak into the next sign-in.
              queryClient.clear();
              await navigate({ to: "/login" });
            })
          }
        >
          <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
          {m.user_menu_logout()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The 56px top bar (white, bottom hairline): the logo and product name, the ⌘K search, alerts,
 * the theme and the account menu; on phones a menu button opens the navigation drawer.
 */
export function TopBar({ user, onMenu }: { user?: ShellUser; onMenu?: () => void }) {
  return (
    <header
      data-slot="top-bar"
      className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center gap-3 border-b bg-card px-3 md:px-4"
    >
      {onMenu ? (
        <Button
          variant="ghost"
          size="sm"
          className="icon-button md:hidden"
          onClick={onMenu}
          aria-label={m.nav_open_menu()}
          data-testid="nav-menu"
        >
          <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} />
        </Button>
      ) : null}
      <Link
        to="/overview"
        className="flex shrink-0 items-center gap-2 rounded-md pr-2 focus-ring md:w-[calc(var(--ew-sidebar-width)-1rem)]"
      >
        <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
          <Logo className="size-4.5 text-primary-foreground" />
        </span>
        <span className="text-section font-medium">{m.app_name()}</span>
      </Link>
      <div className="flex min-w-0 flex-1 justify-end md:justify-start">
        {user ? <SearchTrigger /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {user ? <AlertsLink /> : null}
        <ThemeToggle />
        {user ? <UserMenu user={user} /> : null}
      </div>
    </header>
  );
}
