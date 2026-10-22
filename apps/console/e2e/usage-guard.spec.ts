import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { errors, pick, saved, signedIn, test } from "./helpers";

/**
 * Usage protection in the browser. A site of its own, ug-ui-<run> (created here through the UI in
 * the cluster of .e2e/m6-upgrade-state.json), starts without protection, gets it through the
 * overview card's dialog (refused without a limit), shows its period's usage, is edited and
 * removed; of the sites scripts/e2e-usage-guard.mjs leaves before its cleanup, A shows a guard
 * paused by a manual restore and D one that holds maintenance, restored here.
 */
const RUN = Date.now().toString(36);
const SITE = `ug-ui-${RUN}`;
const DOMAIN = `${SITE}.test`;
const UPGRADE_STATE = resolve("../../.e2e/m6-upgrade-state.json");
const CLUSTER_ID = existsSync(UPGRADE_STATE)
  ? (JSON.parse(readFileSync(UPGRADE_STATE, "utf8")) as { clusterId?: string }).clusterId
  : undefined;
const STATE = resolve("../../.e2e/usage-guard-state.json");

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/usage-guard-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 1280 px (${scheme})`,
    ).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/usage-guard-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)`,
      ),
      `${name}: a card or dialog wider than the page at 375 px (${scheme})`,
    ).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

let siteId = "";

test("usage protection: set up from the empty card, edited and removed", async ({ page }) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(CLUSTER_ID ? `/sites?cluster=${CLUSTER_ID}` : "/sites");
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill(SITE);
  await page.getByLabel("域名", { exact: true }).fill(DOMAIN);
  await page.getByLabel("源站地址", { exact: true }).fill("whoami");
  await page.getByTestId("create-site-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  siteId = /\/sites\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  expect(siteId).not.toBe("");

  const card = page.getByTestId("usage-guard-card");
  await expect(card.getByText("未设置用量保护")).toBeVisible();
  await check(page, "empty");

  await page.getByTestId("usage-guard-setup").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("至少设置一个上限")).toBeVisible();
  await expect(page.getByTestId("usage-guard-save")).toBeDisabled();
  await pick(page, page.getByTestId("usage-guard-period-select"), "每天");
  await page.getByTestId("usage-guard-requests-input").fill("1000");
  await page.getByTestId("usage-guard-bytes-input").fill("0.5");
  await pick(page, page.getByTestId("usage-guard-action-select"), "停用网站");
  await check(page, "dialog");
  await saved(page, page.getByTestId("usage-guard-save"), "usageGuard/update");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("usage-guard-requests")).toContainText("0 / 1000");
  await expect(page.getByTestId("usage-guard-bytes")).toContainText("500");
  await expect(page.getByTestId("usage-guard-bandwidth")).toHaveCount(0);
  await expect(page.getByTestId("usage-guard-period")).toContainText("本日至");
  await expect(page.getByTestId("usage-guard-period")).toContainText("停用网站");
  await check(page, "set");

  await page.getByTestId("usage-guard-edit").click();
  await expect(page.getByTestId("usage-guard-requests-input")).toHaveValue("1000");
  await page.getByTestId("usage-guard-bandwidth-input").fill("100");
  await saved(page, page.getByTestId("usage-guard-save"), "usageGuard/update");
  await expect(page.getByTestId("usage-guard-bandwidth")).toContainText("100 Mbps");

  await page.getByTestId("usage-guard-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(card.getByText("未设置用量保护")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("usage protection: a guard paused by a manual restore", async ({ page }) => {
  const pageErrors = errors(page);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as { a: string };
  await signedIn(page);
  await page.goto(`/sites/${state.a}`);
  await expect(page.getByTestId("usage-guard-paused")).toBeVisible();
  await expect(page.getByTestId("usage-guard-held")).toHaveCount(0);
  await expect(page.getByTestId("usage-guard-requests")).toContainText("/ 20");
  await check(page, "paused");
  expect(pageErrors).toEqual([]);
});

test("usage protection: maintenance the guard holds, restored", async ({ page }) => {
  const pageErrors = errors(page);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as { d: string };
  await signedIn(page);
  await page.goto(`/sites/${state.d}`);
  const held = page.getByTestId("usage-guard-held");
  await expect(held).toHaveAttribute("data-action", "maintenance");
  await expect(held).toContainText("请求数达到上限，已开启维护模式");
  await expect(page.getByTestId("site-usage-guard")).toHaveText("用量超限");
  await check(page, "held");
  // The list shows 20 sites a page, oldest first: after a full run D is not on the first one.
  await page.goto(CLUSTER_ID ? `/sites?cluster=${CLUSTER_ID}&q=ug-` : "/sites?q=ug-");
  await expect(page.getByTestId("site-usage-guard")).toHaveCount(1);
  await page.goto(`/sites/${state.d}`);
  await page.getByTestId("usage-guard-restore").click();
  await page.getByTestId("confirm-action").click();
  await expect(held).toHaveCount(0);
  await expect(page.getByTestId("usage-guard-paused")).toBeVisible();
  await expect(page.getByTestId("site-usage-guard")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("usage protection: the site goes", async ({ page }) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  await page.getByTestId("site-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(page).toHaveURL(/\/sites$/);
  expect(pageErrors).toEqual([]);
});
