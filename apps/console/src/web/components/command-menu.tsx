import {
  Add01Icon,
  LanguageSkillIcon,
  Moon02Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { accountNav, moreNav, navGroups } from "@/components/nav-items";
import { useTheme } from "@/components/theme-provider";
import {
  Command,
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
export function CommandMenu() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

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
      {/* cmdk items need their Command root inside the dialog. */}
      <Command>
        <CommandInput placeholder={m.command_placeholder()} />
        <CommandList>
          <CommandEmpty>{m.command_empty()}</CommandEmpty>
          <CommandGroup heading={m.command_group_navigation()}>
            {[...navGroups().flatMap((group) => group.items), ...moreNav(), ...accountNav()].map(
              (item) => (
                <CommandItem key={String(item.to)} onSelect={run(() => navigate({ to: item.to }))}>
                  {item.icon}
                  {item.title}
                </CommandItem>
              ),
            )}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={m.command_group_actions()}>
            <CommandItem onSelect={run(() => navigate({ to: "/sites", search: { create: true } }))}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.nav_new_site()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => navigate({ to: "/clusters", search: { enroll: true } }))}
            >
              <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </CommandItem>
            <CommandItem onSelect={run(() => setLocale(getLocale() === "zh-CN" ? "en" : "zh-CN"))}>
              <HugeiconsIcon icon={LanguageSkillIcon} strokeWidth={2} />
              {m.command_toggle_language()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}
            >
              <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
              {m.command_toggle_theme()}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
