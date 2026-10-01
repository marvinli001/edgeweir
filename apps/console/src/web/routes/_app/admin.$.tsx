import { createFileRoute, redirect } from "@tanstack/react-router";

/** Pages that lived under /admin: bookmarks open the same page of the one console. */
const MOVED = {
  clusters: "/clusters",
  regions: "/regions",
  dns: "/dns",
  rules: "/rules",
  "service-accounts": "/service-accounts",
  audit: "/audit",
  settings: "/system",
  alerts: "/alerts",
  bans: "/bans",
  "ip-lists": "/ip-lists",
  sites: "/sites",
} as const;

export const Route = createFileRoute("/_app/admin/$")({
  beforeLoad: ({ params, location }) => {
    const page = params._splat ?? "";
    const to = Object.hasOwn(MOVED, page) ? MOVED[page as keyof typeof MOVED] : "/overview";
    throw redirect({ href: `${to}${location.searchStr}`, replace: true });
  },
});
