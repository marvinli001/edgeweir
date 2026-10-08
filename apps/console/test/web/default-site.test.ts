import { describe, expect, it } from "vitest";
import {
  defaultSiteChoices,
  loadedSites,
  nextSitePage,
  SITE_PAGE_SIZE,
} from "../../src/web/lib/default-site";

const site = (n: number, enabled = true) => ({ id: `s${n}`, name: `site-${n}`, enabled });
const none = { siteId: "", chosen: null, savedId: null };

describe("default-site picker", () => {
  it("lists the enabled sites and the saved default", () => {
    const page = { items: [site(1), site(2, false), site(3, false)], total: 3 };
    expect(defaultSiteChoices(page, { ...none, savedId: "s3" }).options).toEqual([
      { value: "s1", label: "site-1" },
      { value: "s3", label: "site-3" },
    ]);
  });

  it("keeps the picked site while a search hides it", () => {
    const chosen = { value: "s9", label: "site-9" };
    const page = { items: [site(1)], total: 1 };
    expect(defaultSiteChoices(page, { siteId: "s9", chosen, savedId: null }).options).toEqual([
      chosen,
      { value: "s1", label: "site-1" },
    ]);
    expect(defaultSiteChoices(undefined, { siteId: "s9", chosen, savedId: null }).options).toEqual([
      chosen,
    ]);
  });

  it("says when more sites match than one page holds", () => {
    const items = Array.from({ length: 100 }, (_, i) => site(i));
    expect(defaultSiteChoices({ items, total: 121 }, none).more).toBe(true);
    expect(defaultSiteChoices({ items, total: 100 }, none).more).toBe(false);
    expect(defaultSiteChoices({ items: [], total: 0 }, none)).toEqual({ options: [], more: false });
    expect(defaultSiteChoices(undefined, none).more).toBe(false);
  });

  it("loads the next page until every matching site is listed", () => {
    // 120 sites a1…a120.example.com, then example.com: every search for it matches 121 sites,
    // and it comes last (oldest first).
    const all = [
      ...Array.from({ length: 120 }, (_, i) => site(i + 1)),
      { id: "s-last", name: "example.com", enabled: true },
    ];
    const pageOf = (n: number) => ({
      items: all.slice((n - 1) * SITE_PAGE_SIZE, n * SITE_PAGE_SIZE),
      total: all.length,
    });
    const first = [pageOf(1)];
    expect(nextSitePage(pageOf(1), first)).toBe(2);
    const once = loadedSites(first);
    expect(defaultSiteChoices(once, none).more).toBe(true);
    expect(defaultSiteChoices(once, none).options.map((o) => o.label)).not.toContain("example.com");
    const both = [pageOf(1), pageOf(2)];
    expect(nextSitePage(pageOf(2), both)).toBeUndefined();
    const twice = defaultSiteChoices(loadedSites(both), none);
    expect(twice.more).toBe(false);
    expect(twice.options).toHaveLength(121);
    expect(twice.options.at(-1)).toEqual({ value: "s-last", label: "example.com" });
  });

  it("stops at an empty page and lists a site once when pages overlap", () => {
    const empty = { items: [], total: 150 };
    expect(nextSitePage(empty, [{ items: [site(1)] }, empty])).toBeUndefined();
    expect(nextSitePage({ items: [], total: 0 }, [{ items: [] }])).toBeUndefined();
    // A site that starts matching between two pages moves the last one of page 1 to page 2.
    const merged = loadedSites([
      { items: [site(1), site(2)], total: 3 },
      { items: [site(2), site(3)], total: 4 },
    ]);
    expect(merged).toEqual({ items: [site(1), site(2), site(3)], total: 4 });
    expect(loadedSites(undefined)).toBeUndefined();
    expect(loadedSites([])).toBeUndefined();
  });
});
