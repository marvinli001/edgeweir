import {
  Add01Icon,
  DashboardSquare01Icon,
  GlobeIcon,
  LanguageSkillIcon,
  Moon02Icon,
  ServerStack01Icon,
  Settings05Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { getLocale, m, setLocale } from "@/lib/i18n";

/** ⌘K / Ctrl+K command palette (shadcn command block). */
export function CommandMenu({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={m.command_placeholder()} />
      <CommandList>
        <CommandEmpty>{m.command_empty()}</CommandEmpty>
        <CommandGroup heading={m.command_group_navigation()}>
          <CommandItem onSelect={run(() => navigate({ to: "/" }))}>
            <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} />
            {m.nav_overview()}
          </CommandItem>
          {isAdmin ? (
            <CommandItem onSelect={run(() => navigate({ to: "/clusters" }))}>
              <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
              {m.nav_clusters()}
            </CommandItem>
          ) : null}
          <CommandItem onSelect={run(() => navigate({ to: "/sites" }))}>
            <HugeiconsIcon icon={GlobeIcon} strokeWidth={2} />
            {m.nav_sites()}
          </CommandItem>
          <CommandItem onSelect={run(() => navigate({ to: "/settings" }))}>
            <HugeiconsIcon icon={Settings05Icon} strokeWidth={2} />
            {m.nav_settings()}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={m.command_group_actions()}>
          <CommandItem onSelect={run(() => navigate({ to: "/sites", search: { create: true } }))}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_new_site()}
          </CommandItem>
          {isAdmin ? (
            <CommandItem
              onSelect={run(() => navigate({ to: "/clusters", search: { enroll: true } }))}
            >
              <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </CommandItem>
          ) : null}
          <CommandItem onSelect={run(() => setLocale(getLocale() === "zh-CN" ? "en" : "zh-CN"))}>
            <HugeiconsIcon icon={LanguageSkillIcon} strokeWidth={2} />
            {m.command_toggle_language()}
          </CommandItem>
          <CommandItem onSelect={run(() => setTheme(theme === "dark" ? "light" : "dark"))}>
            <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
            {m.command_toggle_theme()}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
