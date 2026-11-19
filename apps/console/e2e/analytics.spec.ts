import type { Traffic } from "@edgeweir/contract";
import { expect, type Page } from "@playwright/test";
import { signedIn, siteTab, test } from "./helpers";

const nodeName = process.env.E2E_NODE_NAME ?? "edge-e2e-1";

/** Opens a card's breakdown: its header is the stretched button's uncovered part (the chart sits on top). */
async function openCard(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click({ position: { x: 24, y: 12 } });
}

/** Runs after scripts/e2e.sh has seen the node's stats for demo.test arrive. */
test("overview lists and charts, stars, site analytics with breakdowns", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signedIn(page);

  await test.step("the home shows the sites, recents and traffic charts", async () => {
    await expect(page.getByTestId("home-sites").getByTestId("home-site").first()).toBeVisible();
    await expect(page.getByTestId("home-recents")).toBeVisible();
    const requests = page.getByTestId("metric-requests");
    await expect(requests.locator("[data-slot=metric-value]")).toHaveText(/[1-9]/);
    await expect(requests.locator("[data-slot=chart-area]")).toBeVisible();
    await expect(page.getByTestId("status-codes")).toBeVisible();
    await expect(page.getByTestId("top-sites").getByTestId("top-item-name").first()).toBeVisible();
  });

  await test.step("a starred site leads the home site list", async () => {
    await page.getByTestId("nav-sites").click();
    const row = page.getByTestId("sites-table").getByRole("row").filter({ hasText: "demo.test" });
    const star = row.getByTestId("site-star");
    // Restore the fixture on retries; the previous attempt may have starred it.
    await expect(star).toBeVisible();
    if ((await star.getAttribute("aria-pressed")) === "true") await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("nav-overview").click();
    await expect(page.getByTestId("home-site").first()).toContainText("demo");
  });

  await test.step("the site's analytics tab shows its traffic and follows the range", async () => {
    await page.getByTestId("home-site").first().click();
    await expect(page.getByTestId("page-title")).toHaveText("demo");
    await expect(page.getByTestId("site-star")).toHaveAttribute("aria-pressed", "true");
    await siteTab(page, "analytics");
    await expect(
      page.getByTestId("metric-requests").locator("[data-slot=metric-value]"),
    ).toHaveText(/[1-9]/);
    await expect(page.getByTestId("status-2xx").first()).toHaveText(/[1-9]/);
    await page.getByTestId("analytics-range").click();
    await page.getByTestId("range-1h").click();
    await expect(page).toHaveURL(/range=1h/);
    await expect(page.getByTestId("analytics-range")).toHaveText("过去 1 小时");
    await expect(
      page.getByTestId("metric-requests").locator("[data-slot=metric-value]"),
    ).toHaveText(/[1-9]/);
  });

  await test.step("a metric card opens its breakdown by node and status code", async () => {
    await openCard(page, "请求总数详情");
    const dialog = page.getByTestId("metric-detail");
    await expect(dialog.getByRole("heading", { name: "请求总数", exact: true })).toBeVisible();
    // One site: no per-site view; nodes come first.
    await expect(dialog.getByTestId("detail-view-site")).toHaveCount(0);
    await expect(
      dialog.getByTestId("detail-chart").locator("[data-slot=chart-line]").first(),
    ).toBeVisible();
    await expect(dialog.getByTestId("detail-list")).toContainText(nodeName);
    await dialog.getByTestId("detail-view-status").click();
    await expect(
      dialog.getByTestId("detail-chart").locator("[data-slot=chart-bar]").first(),
    ).toBeVisible();
    await expect(dialog.getByTestId("detail-list").getByTestId("ranked-item").first()).toHaveText(
      /^\d{3}/,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await openCard(page, "缓存命中率详情");
    await expect(dialog.getByTestId("detail-list")).toContainText("命中");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  await test.step("recents remember the visited site", async () => {
    await page.getByTestId("site-nav-back").click();
    await page.getByTestId("nav-overview").click();
    await expect(page.getByTestId("home-recents")).toContainText("demo");
  });

  await test.step("the overview lists nodes and revisions and ranks nodes and sites", async () => {
    await expect(page.getByTestId("page-title")).toHaveText("概览");
    await expect(page.getByTestId("home-nodes")).toContainText(nodeName);
    await expect(page.getByTestId("home-revisions").getByRole("link").first()).toBeVisible();
    await expect(page.getByTestId("top-nodes")).toContainText(nodeName);
    await expect(page.getByTestId("top-sites")).toContainText("demo");
    await openCard(page, "数据传输详情");
    const dialog = page.getByTestId("metric-detail");
    await expect(dialog.getByTestId("detail-list")).toContainText("demo");
    await dialog.getByTestId("detail-view-node").click();
    await expect(dialog.getByTestId("detail-list")).toContainText(nodeName);
  });

  expect(pageErrors).toEqual([]);
});

test.describe("right now on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });

  test("cache misses, unsampled minutes and complete bandwidth ticks", async ({ page }) => {
    let sampled = false;
    await page.route("**/rpc/analytics/traffic", async (route) => {
      const response = await route.fetch();
      const body: { json: Traffic } = await response.json();
      const { points, bucketSeconds } = body.json;
      for (const [index, point] of points.entries()) {
        point.requests = 60 * bucketSeconds;
        point.bytesSent = (index === points.length - 1 ? 900_000 : 100_000) * bucketSeconds;
        // The open minute has hits. Only two isolated completed minutes have cache observations.
        point.cacheHits = index === points.length - 1 ? 20 : 0;
        point.cacheMisses = sampled && (index === 0 || index === points.length - 2) ? 10 : 0;
      }
      await route.fulfill({ json: body });
    });
    await page.goto("/overview?range=1h");
    const hit = page.getByTestId("live-hit-ratio");
    const value = hit.locator("[data-slot=metric-value]");
    await expect(value).toHaveText("—");
    await expect(hit.getByRole("slider")).toHaveCount(0);

    const egress = page.getByTestId("live-egress");
    await expect(egress.locator("[data-slot=metric-value]")).toHaveText("800 Kbps");
    const tick = egress.locator("[data-slot=chart-tick]").filter({ hasText: /^800\sKbps$/ });
    await expect(tick).toBeVisible();
    expect(
      await tick.evaluate((el) => {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        return (
          range.getBoundingClientRect().right <=
          (el.closest("section")?.getBoundingClientRect().right ?? 0)
        );
      }),
    ).toBe(true);

    sampled = true;
    await page.getByTestId("analytics-refresh").click();
    await expect(value).toHaveText("0%");
    const plot = hit.getByRole("slider");
    await plot.tap();
    await expect(hit.locator("[data-scrubbing]")).toBeVisible();
    await plot.press("End");
    await expect(plot).toHaveAttribute("aria-valuetext", /0%$/);
    await plot.press("ArrowLeft");
    await expect(plot).toHaveAttribute("aria-valuetext", /—$/);
    await expect(hit.locator("[data-slot=chart-line]")).toHaveAttribute("d", /h0M.*h0/);
  });
});
