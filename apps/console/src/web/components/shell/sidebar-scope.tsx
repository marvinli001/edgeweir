import type { IconSvgElement } from "@hugeicons/react";
import * as React from "react";
import type { ScopeItem } from "@/lib/workspace-nav";

export interface SidebarScope {
  kind: string;
  back: { href: string; label: string };
  switcher: (rail: boolean) => React.ReactNode;
  items: readonly ScopeItem[];
  commandGroup: string;
}

const ScopeContext = React.createContext<SidebarScope | undefined>(undefined);
const RegisterContext = React.createContext<React.Dispatch<
  React.SetStateAction<SidebarScope | undefined>
> | null>(null);

export function SidebarScopeProvider({ children }: { children: React.ReactNode }) {
  const [scope, register] = React.useState<SidebarScope>();
  return (
    <RegisterContext.Provider value={register}>
      <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
    </RegisterContext.Provider>
  );
}

export function useCurrentSidebarScope() {
  return React.useContext(ScopeContext);
}

export function useSidebarScope(scope: SidebarScope) {
  const register = React.useContext(RegisterContext);
  React.useLayoutEffect(() => {
    register?.(scope);
    return () => register?.((current) => (current === scope ? undefined : current));
  }, [register, scope]);
}

export function useWorkspaceTitle(label: string, name: string | undefined) {
  React.useEffect(() => {
    if (!name) return;
    const previous = document.title;
    document.title = `${label} · ${name}`;
    return () => {
      document.title = previous;
    };
  }, [label, name]);
}

export function flatScopeItems<View extends string>(
  views: Record<View, { icon: IconSvgElement; label: () => string }>,
  current: View,
  href: (view: View) => string,
  available: (view: View) => boolean = () => true,
): ScopeItem[] {
  return (Object.keys(views) as View[]).filter(available).map((key) => ({
    key,
    icon: views[key].icon,
    label: views[key].label(),
    current: key === current,
    href: href(key),
  }));
}
