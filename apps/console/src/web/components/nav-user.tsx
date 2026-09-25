import {
  ComputerIcon,
  LanguageSkillIcon,
  Logout01Icon,
  Moon02Icon,
  MoreVerticalCircle01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { getLocale, type Locale, localeLabels, locales, m, setLocale } from "@/lib/i18n";

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function NavUser({ user }: { user: { name: string; email: string } }) {
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="aria-expanded:bg-muted"
                data-testid="user-menu"
              />
            }
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-foreground/70">{user.email}</span>
            </div>
            <HugeiconsIcon
              icon={MoreVerticalCircle01Icon}
              strokeWidth={2}
              className="ml-auto size-4"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex flex-col px-1 py-1.5 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                </div>
              </DropdownMenuLabel>
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
                    <DropdownMenuRadioItem
                      key={locale}
                      value={locale}
                      data-testid={`locale-${locale}`}
                    >
                      {localeLabels[locale]()}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <HugeiconsIcon icon={theme === "dark" ? Moon02Icon : Sun03Icon} strokeWidth={2} />
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
              onClick={async () => {
                await authClient.signOut();
                // Nothing of this account may leak into the next sign-in.
                queryClient.clear();
                await navigate({ to: "/login" });
              }}
            >
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              {m.user_menu_logout()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
