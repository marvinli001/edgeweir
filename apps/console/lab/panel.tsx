/**
 * Lab-only switches in a corner: theme, language, data state (state.ts) and every page
 * (pages.ts). Styled inline with the console's tokens so it adds no classes to the app's CSS.
 * Hidden with `localStorage["edgeweir-lab:panel"] = "hidden"` (screenshots) or the × button.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { getLocale, type Locale, setLocale } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { type LabPage, PAGES } from "./pages";
import { LAB_STATES, type LabState, labState, setLabState } from "./state";

const PANEL_KEY = "edgeweir-lab:panel";

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

const GROUPS = [...new Set(PAGES.map((page) => page.group))];

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

const quiet = "color-mix(in oklch, var(--foreground) 7%, transparent)";

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 7px",
        borderRadius: 7,
        border: 0,
        cursor: "pointer",
        font: "inherit",
        color: active ? "var(--primary-foreground)" : "inherit",
        background: active ? "var(--primary)" : quiet,
      }}
    >
      {children}
    </button>
  );
}

/** The page whose path matches the current location best (longest match wins). */
function pageAt(href: string): LabPage | undefined {
  const exact = PAGES.find((page) => page.path === href);
  if (exact) return exact;
  const pathname = href.split("?")[0];
  return PAGES.find((page) => page.path === pathname);
}

export function LabPanel({ router, queryClient }: { router: AnyRouter; queryClient: QueryClient }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [hidden, setHidden] = React.useState(() => read(PANEL_KEY) === "hidden");
  const [state, setState] = React.useState<LabState>(labState);
  const href = useRouterState({ router, select: (s) => s.location.href });
  const locale = getLocale();

  if (hidden) return null;

  const current = pageAt(href);
  const chooseLocale = (next: Locale) => {
    if (next !== locale) void setLocale(next);
  };
  const chooseState = (next: LabState) => {
    setLabState(next);
    setState(next);
    // Pending and failed queries start over in the new state.
    void queryClient.resetQueries();
  };
  const go = (page: LabPage) => {
    // The cached status decides between /setup and /login.
    queryClient.removeQueries({ queryKey: orpc.system.status.queryKey() });
    void router.navigate({ href: page.path });
  };
  const step = (by: number) => {
    const index = current ? PAGES.indexOf(current) : -1;
    const next = PAGES[(index + by + PAGES.length) % PAGES.length];
    if (next) go(next);
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
        <span style={{ flex: 1 }} />
        <Chip
          title="hide (localStorage edgeweir-lab:panel)"
          onClick={() => {
            write(PANEL_KEY, "hidden");
            setHidden(true);
          }}
        >
          ×
        </Chip>
      </div>
      <div style={row}>
        {LAB_STATES.map((value) => (
          <Chip key={value} active={state === value} onClick={() => chooseState(value)}>
            {value}
          </Chip>
        ))}
      </div>
      <div style={row}>
        <Chip title="previous page" onClick={() => step(-1)}>
          ‹
        </Chip>
        <select
          aria-label="page"
          value={current?.name ?? ""}
          onChange={(event) => {
            const page = PAGES.find((candidate) => candidate.name === event.target.value);
            if (page) go(page);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "3px 4px",
            borderRadius: 7,
            border: 0,
            font: "inherit",
            color: "inherit",
            background: quiet,
          }}
        >
          {current ? null : <option value="">—</option>}
          {GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {PAGES.filter((page) => page.group === group).map((page) => (
                <option key={page.name} value={page.name}>
                  {page.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <Chip title="next page" onClick={() => step(1)}>
          ›
        </Chip>
      </div>
    </div>
  );
}
