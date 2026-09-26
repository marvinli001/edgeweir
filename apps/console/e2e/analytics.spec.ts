import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const nodeName = process.env.E2E_NODE_NAME ?? "edge-e2e-1";

/** Opens a card's breakdown: its header is the stretched button's uncovered part (the chart sits on top). */
async function openCard(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click({ position: { x: 24, y: 12 } });
}

/** Runs after scripts/e2e.sh has seen the node's stats for demo.test arrive. */
test("home lists and charts, stars, site and platform analytics with breakdowns", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, email, password);

  await test.step("the home shows the sites, recents and traffic charts", async () => {
    await expect(page.getByTestId("home-sites").getByTestId("home-site").first()).toBeVisible();
    await expect(page.getByTestId("home-recents")).toBeVisible();
    const requests = page.getByTestId("metric-requests");
    await expect(requests.locator("[data-slot=metric-value]")).toHaveText(/[1-9]/);
    await expect(requests.locator(".recharts-area")).toBeVisible();
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
    await page.getByTestId("tab-analytics").click();
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
    // One site: no per-site view; administrators get nodes first.
    await expect(dialog.getByTestId("detail-view-site")).toHaveCount(0);
    await expect(dialog.getByTestId("detail-chart").locator(".recharts-line")).toBeVisible();
    await expect(dialog.getByTestId("detail-list")).toContainText(nodeName);
    await dialog.getByTestId("detail-view-status").click();
    await expect(dialog.getByTestId("detail-chart").locator(".recharts-bar")).toBeVisible();
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
    await page.getByTestId("nav-overview").click();
    await expect(page.getByTestId("home-recents")).toContainText("demo");
  });

  await test.step("the platform overview ranks nodes and sites", async () => {
    await page.getByTestId("area-admin").click();
    await expect(page.getByTestId("page-title")).toHaveText("平台概览");
    await expect(page.getByTestId("stat-nodes")).toContainText(nodeName);
    await expect(page.getByTestId("admin-revisions").getByRole("link").first()).toBeVisible();
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
