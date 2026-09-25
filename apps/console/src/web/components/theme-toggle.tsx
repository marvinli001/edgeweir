import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";

/** Light / dark / follow-system picker; the icon shows the scheme currently on screen. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            aria-label={m.user_menu_theme()}
            data-testid="theme-toggle"
          />
        }
      >
        <HugeiconsIcon icon={resolvedTheme === "dark" ? Moon02Icon : Sun03Icon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as "light" | "dark" | "system")}
        >
          <DropdownMenuRadioItem value="light" closeOnClick data-testid="theme-light">
            <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />
            {m.theme_light()}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" closeOnClick data-testid="theme-dark">
            <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
            {m.theme_dark()}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" closeOnClick data-testid="theme-system">
            <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
            {m.theme_system()}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
