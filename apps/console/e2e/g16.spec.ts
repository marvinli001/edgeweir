import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * G16 in the browser. A site of its own, g16-ui-<run> (created here through the UI in the cluster
 * of .e2e/m6-upgrade-state.json), gets the access log options; g16-logs and g16-block, which
 * scripts/e2e-g16.mjs leaves with log lines and statistics before its cleanup, show the new
 * filters, the line details, the statistics dimension cards and the security tab's block reasons
 * and challenge pass rate; the overview lists their country (the GeoIP fixture puts the e2e
 * network in New Zealand); the system page's retention card saves and is set back. The site is
 * removed at the end (scripts/e2e-g16.mjs --cleanup also removes g16-ui-* sites a failed run
 * leaves and resets the retention).
 */
const ADMIN = [
  process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
] as const;
const RUN = Date.now().toString(36);
const SITE = `g16-ui-${RUN}`;
const DOMAIN = `${SITE}.test`;
const LOGS_SITE = "g16-logs";
const BLOCK_SITE = "g16-block";
const UPGRADE_STATE = resolve("../../.e2e/m6-upgrade-state.json");
const CLUSTER_ID = existsSync(UPGRADE_STATE)
  ? (JSON.parse(readFileSync(UPGRADE_STATE, "utf8")) as { clusterId?: string }).clusterId
  : undefined;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g16-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 1280 px (${scheme})`,
    ).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g16-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"], [data-testid="log-row"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)`,
      ),
      `${name}: a card, dialog or log row wider than the page at 375 px (${scheme})`,
    ).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

function errors(page: Page) {
  const list: string[] = [];
  page.on("pageerror", (error) => list.push(error.message));
  return list;
}

/** The id of a site found by its exact name in the sites list. */
async function siteNamed(page: Page, name: string) {
  await page.goto(`/sites?q=${name}`);
  const link = page.getByTestId("site-link").filter({ hasText: new RegExp(`^${name}$`) });
  await expect(link, `${name} (left by scripts/e2e-g16.mjs)`).toHaveCount(1);
  await link.click();
  await expect(page.getByTestId("page-title")).toHaveText(name);
  const id = /\/sites\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  expect(id, `${name}'s id in the address`).not.toBe("");
  return id;
}

let siteId = "";

test("G16: a site's access log options save and stay", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(CLUSTER_ID ? `/sites?cluster=${CLUSTER_ID}` : "/sites");
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill(SITE);
  await page.getByLabel("域名", { exact: true }).fill(DOMAIN);
  await page.getByLabel("源站地址", { exact: true }).fill("whoami");
  await page.getByTestId("create-site-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  siteId = /\/sites\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  expect(siteId).not.toBe("");

  await page.goto(`/sites/${siteId}?tab=logs`);
  await expect(page.getByTestId("log-options")).toBeVisible();
  // The cluster's nodes run access-logs-v2: nothing is locked.
  await expect(page.getByTestId("log-options-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("logs-privacy")).toContainText("7");
  // A forbidden header is refused before saving.
  await page.getByTestId("log-headers").fill("cookie");
  await expect(page.getByTestId("log-headers-error")).toBeVisible();
  await page.getByTestId("log-headers").fill("X-Trace-Id, accept-language");
  await expect(page.getByTestId("log-headers-error")).toHaveCount(0);
  await page.getByTestId("log-blocked").click();
  await page.getByTestId("log-query").click();
  await saved(page, page.getByTestId("log-options-save"), "logs/configure");
  await page.reload();
  await expect(page.getByTestId("log-blocked")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("log-query")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("log-peer")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("log-headers")).toHaveValue("x-trace-id, accept-language");
  await check(page, "log-options");
  expect(pageErrors).toEqual([]);
});

test("G16: the new filters and the line details of the access log", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  const blockId = await siteNamed(page, BLOCK_SITE);
  await page.goto(`/sites/${blockId}?tab=logs`);
  await expect(page.getByTestId("logs-search")).toBeVisible();
  await page.getByTestId("logs-more-filters").click();
  await expect(page.getByTestId("logs-more-filters-panel")).toBeVisible();
  await pick(page, page.getByTestId("log-filter-block-reason"), "自定义规则");
  await page.getByTestId("log-filter-country").fill("nz");
  await page.getByTestId("logs-search").click();
  const reasons = page.getByTestId("log-block-reason");
  await expect(reasons.first()).toBeVisible();
  for (const reason of await reasons.all())
    await expect(reason).toHaveAttribute("data-reason", "rule");
  // The rule behind it, by name.
  await expect(page.getByTestId("log-block-rule").first()).toContainText("g16 block");
  // An invalid network opens nothing and says why.
  await page.getByTestId("log-filter-cidr").fill("10.0.0.0/33");
  await page.getByTestId("logs-search").click();
  await expect(page.getByText("网段格式无效")).toBeVisible();
  await page.getByTestId("log-filter-cidr").fill("");
  await check(page, "log-filters");

  const logsId = await siteNamed(page, LOGS_SITE);
  await page.goto(`/sites/${logsId}?tab=logs`);
  await page.getByTestId("logs-more-filters").click();
  await page.getByTestId("log-filter-ua").fill("chrome/129");
  await pick(page, page.getByTestId("log-filter-cache-status"), "MISS");
  await page.getByTestId("logs-search").click();
  const row = page.getByTestId("log-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("log-details-toggle").click();
  const details = page.getByTestId("log-details").first();
  await expect(details).toBeVisible();
  await expect(details.getByTestId("log-user-agent")).toContainText("Chrome/129");
  await expect(details.getByTestId("log-referer")).toContainText("https://ref.g16.example/from");
  await expect(details.getByTestId("log-referer")).not.toContainText("secret");
  await expect(details.getByTestId("log-country")).toContainText("NZ");
  await expect(details.getByTestId("log-asn")).toContainText("AS64513");
  await expect(details.getByTestId("log-upstream")).toContainText("200");
  await expect(details.getByTestId("log-query-string")).toContainText("x=1");
  await expect(details.getByTestId("log-request-headers")).toContainText("x-trace-id");
  await check(page, "log-details");
  expect(pageErrors).toEqual([]);
});

test("G16: the statistics dimension cards and the overview's countries", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  const logsId = await siteNamed(page, LOGS_SITE);
  await page.goto(`/sites/${logsId}?tab=analytics`);
  const dims = page.getByTestId("stats-dimensions");
  await expect(dims).toBeVisible();
  await expect(page.getByTestId("stats-dims-partial")).toHaveCount(0);
  await expect(
    page.getByTestId("stats-countries").locator('[data-testid="stats-item"][data-key="NZ"]'),
  ).toContainText("新西兰");
  await expect(
    page.getByTestId("stats-asns").locator('[data-testid="stats-item"][data-key="64513"]'),
  ).toContainText("Synthetic AS64513");
  await expect(
    page
      .getByTestId("stats-referers")
      .locator('[data-testid="stats-item"][data-key="ref.g16.example"]'),
  ).toBeVisible();
  await expect(
    page.getByTestId("stats-browsers").locator('[data-key="chrome"]').first(),
  ).toBeVisible();
  await expect(
    page.getByTestId("stats-http-versions").locator('[data-key="1.1"]').first(),
  ).toBeVisible();
  await check(page, "stats");

  await page.goto("/overview");
  await expect(page.getByTestId("top-countries")).toContainText("新西兰");
  await check(page, "overview");
  expect(pageErrors).toEqual([]);
});

test("G16: block reasons and the challenge pass rate on the security tab", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  const blockId = await siteNamed(page, BLOCK_SITE);
  await page.goto(`/sites/${blockId}?tab=security`);
  const reasons = page.getByTestId("block-reasons");
  await expect(reasons).toContainText("自定义规则");
  await expect(reasons).toContainText("限速");
  await expect(page.getByTestId("block-reasons-partial")).toHaveCount(0);
  // g16-block sends no challenges.
  await expect(page.getByTestId("challenges-card")).toBeVisible();
  await expect(page.getByTestId("challenges-empty")).toBeVisible();
  await check(page, "security");
  expect(pageErrors).toEqual([]);
});

test("G16: the access log retention card saves and is set back", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/system");
  const days = page.getByTestId("log-retention-days");
  await expect(days).toHaveValue("7");
  // PostgreSQL keeps at most 30 days: the field refuses 31.
  await days.fill("31");
  await expect(days).toHaveAttribute("max", "30");
  expect(
    await days.evaluate(
      (el: { validity: { rangeOverflow: boolean } }) => el.validity.rangeOverflow,
    ),
  ).toBe(true);
  await days.fill("9");
  await saved(page, page.getByTestId("log-retention-save"), "settings/setLogRetention");
  await page.reload();
  await expect(page.getByTestId("log-retention-days")).toHaveValue("9");
  await check(page, "retention");
  await page.getByTestId("log-retention-days").fill("7");
  await saved(page, page.getByTestId("log-retention-save"), "settings/setLogRetention");
  expect(pageErrors).toEqual([]);
});

test("G16: the site goes", async ({ page }) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  await page.getByTestId("site-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(page).toHaveURL(/\/sites$/);
  await page.goto(`/sites?q=${SITE}`);
  await expect(page.getByText("没有匹配的网站")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
