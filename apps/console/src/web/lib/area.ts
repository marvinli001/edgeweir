import { useRouterState } from "@tanstack/react-router";

export type Area = "console" | "admin";

/** The admin area lives under /admin; everything else is the console every user sees. */
export function areaOf(pathname: string): Area {
  return pathname === "/admin" || pathname.startsWith("/admin/") ? "admin" : "console";
}

export function useArea(): Area {
  return useRouterState({ select: (s) => areaOf(s.location.pathname) });
}
