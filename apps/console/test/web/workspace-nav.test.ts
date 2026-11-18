import { describe, expect, it } from "vitest";
import { L4_VIEWS, type L4View, l4Href, legacyL4Href } from "../../src/web/lib/l4-views";
import { legacyNodeHref, NODE_VIEWS, type NodeView, nodeHref } from "../../src/web/lib/node-views";
import { legacySiteHref, SITE_TABS, siteDirectory, siteHref } from "../../src/web/lib/site-tabs";
import { listReturnTo, scopeDirection } from "../../src/web/lib/workspace-nav";

describe("workspace navigation", () => {
  it("gives each view one path and lists each site view once", () => {
    const site = siteDirectory("logs", (view) => siteHref("a", view), true);
    const links = site.flatMap((item) => ("children" in item ? item.children : [item]));
    expect(links.map((item) => item.key).sort()).toEqual([...SITE_TABS].sort());
    expect(links.filter((item) => item.current).map((item) => item.key)).toEqual(["logs"]);
    expect(new Set(links.map((item) => item.href)).size).toBe(SITE_TABS.length);
    expect(
      siteDirectory("overview", (view) => siteHref("a", view), false).map((item) => item.key),
    ).not.toContain("extensions");
    for (const [views, root] of [
      [(Object.keys(L4_VIEWS) as L4View[]).map((view) => l4Href("a", view)), "/l4/a"],
      [
        (Object.keys(NODE_VIEWS) as NodeView[]).map((view) => nodeHref("a", view)),
        "/clusters/nodes/a",
      ],
    ] as const) {
      expect(new Set(views).size).toBe(views.length);
      expect(views[0]).toBe(root);
      expect(views.slice(1).every((path) => path.startsWith(`${root}/`))).toBe(true);
    }
  });

  it("canonicalizes old detail links and preserves search and list state", () => {
    expect(legacySiteHref("a", "?tab=logs&range=1h&path=%2Fassets&ip=203.0.113.9")).toBe(
      "/sites/a/logs?range=1h&path=%2Fassets&ip=203.0.113.9",
    );
    expect(legacySiteHref("a", "?tab=overview&range=7d")).toBe("/sites/a?range=7d");
    expect(legacySiteHref("a", "?tab=api-security")).toBe("/sites/a/api-security");
    expect(legacySiteHref("a", "?range=7d")).toBeUndefined();
    expect(legacyL4Href("a", "?tab=stats&range=7d")).toBe("/l4/a/stats?range=7d");
    expect(legacyL4Href("a", "?tab=overview")).toBe("/l4/a");
    const node = legacyNodeHref("?view=regions&cluster=group&sort=-name&node=a&nodeTab=logs");
    const url = new URL(node ?? "", "http://console.test");
    expect(url.pathname).toBe("/clusters/nodes/a/logs");
    expect(url.searchParams.get("returnTo")).toBe(
      "/clusters?view=regions&cluster=group&sort=-name",
    );
    expect(legacyNodeHref("?node=a")).toBe("/clusters/nodes/a");
    expect(legacyNodeHref("?view=regions")).toBeUndefined();
  });

  it("keeps view parameters and only returns to the matching list", () => {
    const search = { range: "1h", returnTo: "/sites?tags=%5B%22a%22%5D&sort=name", path: "/a" };
    const url = new URL(siteHref("id", "logs", search), "http://console.test");
    expect(url.pathname).toBe("/sites/id/logs");
    expect(Object.fromEntries(url.searchParams)).toEqual(search);
    expect(listReturnTo("/sites", search.returnTo)).toBe(search.returnTo);
    expect(listReturnTo("/sites", "/sites/other")).toBe("/sites");
    expect(listReturnTo("/sites", "//example.test/sites")).toBe("/sites");
  });

  it("slides forward into detail, backward to the list, and stays still within a kind", () => {
    expect(scopeDirection(undefined, "site")).toBe(1);
    expect(scopeDirection("site", "l4")).toBe(1);
    expect(scopeDirection("l4", "node")).toBe(1);
    expect(scopeDirection("node", undefined)).toBe(-1);
    for (const kind of [undefined, "site", "l4", "node"])
      expect(scopeDirection(kind, kind)).toBe(0);
  });
});
