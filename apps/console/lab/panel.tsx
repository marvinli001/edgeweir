/**
 * Lab-only switches in a corner: theme, language, Latin typeface, and shortcuts to the pages
 * under review. Styled inline with the console's tokens so it adds no classes to the app's CSS.
 * Hidden with `localStorage["edgeweir-lab:panel"] = "hidden"` (screenshots) or the × button.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { getLocale, type Locale, setLocale } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { sites } from "./fixtures/world";

const FONT_KEY = "edgeweir-lab:font";
const PANEL_KEY = "edgeweir-lab:panel";

type LabFont = "geist" | "mona";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the switch lasts until reload.
  }
}

const storedFont = (): LabFont => (read(FONT_KEY) === "mona" ? "mona" : "geist");

/** Applies the stored typeface before the first paint (`html[data-font]`). */
export function applyLabFont(font: LabFont = storedFont()) {
  document.documentElement.dataset.font = font;
}

const SHOP = sites.find((s) => s.name === "shop.example.com")?.id ?? "";

const PAGES: { label: string; to: string; params?: Record<string, string>; search?: object }[] = [
  { label: "login", to: "/login" },
  { label: "setup", to: "/setup" },
  { label: "overview", to: "/overview" },
  { label: "sites", to: "/sites" },
  { label: "site", to: "/sites/$id", params: { id: SHOP } },
  { label: "origins", to: "/sites/$id", params: { id: SHOP }, search: { tab: "origins" } },
  { label: "clusters", to: "/clusters" },
];

const panel: React.CSSProperties = {
  position: "fixed",
  right: 12,
  bottom: 12,
  zIndex: 2147483000,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 8,
  borderRadius: 12,
  font: "500 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--popover-foreground)",
  background: "color-mix(in oklch, var(--popover) 88%, transparent)",
  backdropFilter: "blur(10px)",
  boxShadow:
    "0 0 0 1px color-mix(in oklch, var(--foreground) 12%, transparent), 0 8px 24px -8px color-mix(in oklch, var(--foreground) 30%, transparent)",
};

const row: React.CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  flexWrap: "wrap",
};

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 7px",
        borderRadius: 7,
        border: 0,
        cursor: "pointer",
        font: "inherit",
        color: active ? "var(--primary-foreground)" : "inherit",
        background: active
          ? "var(--primary)"
          : "color-mix(in oklch, var(--foreground) 7%, transparent)",
      }}
    >
      {children}
    </button>
  );
}

export function LabPanel({ router, queryClient }: { router: AnyRouter; queryClient: QueryClient }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [font, setFont] = React.useState<LabFont>(storedFont);
  const [hidden, setHidden] = React.useState(() => read(PANEL_KEY) === "hidden");
  const locale = getLocale();

  if (hidden) return null;

  const chooseFont = (next: LabFont) => {
    write(FONT_KEY, next);
    applyLabFont(next);
    setFont(next);
  };
  const chooseLocale = (next: Locale) => {
    if (next !== locale) void setLocale(next);
  };
  const go = (page: (typeof PAGES)[number]) => {
    // The cached status decides between /setup and /login.
    queryClient.removeQueries({ queryKey: orpc.system.status.queryKey() });
    void router.navigate({ to: page.to, params: page.params, search: page.search ?? {} });
  };

  return (
    <div style={panel} data-lab-panel="">
      <div style={row}>
        <Chip active={resolvedTheme === "light"} onClick={() => setTheme("light")}>
          light
        </Chip>
        <Chip active={resolvedTheme === "dark"} onClick={() => setTheme("dark")}>
          dark
        </Chip>
        <span style={{ width: 6 }} />
        <Chip active={locale === "zh-CN"} onClick={() => chooseLocale("zh-CN")}>
          zh-CN
        </Chip>
        <Chip active={locale === "en"} onClick={() => chooseLocale("en")}>
          en
        </Chip>
        <span style={{ width: 6 }} />
        <Chip active={font === "geist"} onClick={() => chooseFont("geist")}>
          Geist
        </Chip>
        <Chip active={font === "mona"} onClick={() => chooseFont("mona")}>
          Mona Sans
        </Chip>
        <Chip
          onClick={() => {
            write(PANEL_KEY, "hidden");
            setHidden(true);
          }}
        >
          ×
        </Chip>
      </div>
      <div style={row}>
        {PAGES.map((page) => (
          <Chip key={page.label} onClick={() => go(page)}>
            {page.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}
