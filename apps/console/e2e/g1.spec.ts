import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/** Written by scripts/e2e-g1.mjs, which lifts every ban before this spec runs. */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g1-state.json"), "utf8")) as {
  /** The P0 site. */
  siteId: string;
  siteName: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g1-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g1-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
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

/** Opens the ban dialog; with `site`, searches and picks the site. */
async function openBanDialog(page: Page, site?: string) {
  await page.getByTestId("ban-create").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (site) {
    await dialog.locator("#ban-site-search").fill(site);
    await pick(page, dialog.locator("#ban-site"), site);
  }
  return dialog;
}

const banRow = (page: Page, cidr: string) =>
  page
    .getByTestId("bans-table")
    .getByRole("row")
    .filter({ has: page.getByTestId("ban-cidr-cell").getByText(cidr, { exact: true }) });

async function unban(page: Page, cidr: string) {
  const row = banRow(page, cidr);
  await row.getByTestId("ban-unban").click();
  await expect(page.getByRole("dialog")).toContainText(`解封 ${cidr}？`);
  await page.getByTestId("confirm-action").click();
  await expect(row).toHaveCount(0);
}

test("G1: the operator bans an address on a site and lifts it", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.getByTestId("nav-ip-lists").click();
  await page.getByTestId("access-tab-bans").click();
  await expect(page).toHaveURL(/\/bans$/);
  await expect(page.getByTestId("page-title")).toHaveText("封禁");
  await expect(page.getByText("暂无封禁", { exact: true })).toBeVisible();

  let dialog = await openBanDialog(page, state.siteName);
  await dialog.getByTestId("ban-cidr").fill("203.0.113.7");
  await pick(page, dialog.locator("#ban-reason"), "扫描");
  await pick(page, dialog.locator("#ban-duration"), "6 小时");
  await check(page, "ban-dialog");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog).toBeHidden();

  const row = banRow(page, "203.0.113.7/32");
  await expect(row).toContainText(state.siteName);
  await expect(row).toContainText("扫描");
  await expect(row.getByTestId("ban-source")).toHaveText("手动");
  await expect(row).toContainText("E2E Admin");
  await expect(row).toContainText(/剩 [56] 小时/);
  await expect(row.getByTestId("ban-unapplied")).toHaveCount(0);
  await check(page, "bans");

  // Filters: no automatic bans, the site has the manual one.
  await pick(page, page.getByTestId("ban-filter-source"), "自动");
  await expect(page.getByText("没有符合条件的封禁", { exact: true })).toBeVisible();
  await pick(page, page.getByTestId("ban-filter-source"), "全部来源");
  await pick(page, page.getByTestId("ban-filter-site"), state.siteName);
  await expect(row).toBeVisible();
  await pick(page, page.getByTestId("ban-filter-site"), "全部网站");

  // Prefixes shorter than /16 are refused in the dialog.
  dialog = await openBanDialog(page, state.siteName);
  await dialog.getByTestId("ban-cidr").fill("10.0.0.0/8");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog.getByTestId("form-error")).toHaveText("前缀太短，最短为 /16");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await unban(page, "203.0.113.7/32");
  await expect(page.getByText("暂无封禁", { exact: true })).toBeVisible();
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G1: the operator bans a range on every site and an address on one site", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.getByTestId("nav-ip-lists").click();
  await page.getByTestId("access-tab-bans").click();
  await expect(page.getByTestId("page-title")).toHaveText("封禁");

  let dialog = await openBanDialog(page);
  await expect(dialog.locator("#ban-scope")).toHaveText("网站");
  await pick(page, dialog.locator("#ban-scope"), "全局");
  await dialog.getByTestId("ban-cidr").fill("198.51.100.0/24");
  await pick(page, dialog.locator("#ban-reason"), "攻击");
  await pick(page, dialog.locator("#ban-duration"), "1 小时");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog).toBeHidden();
  const platformRow = banRow(page, "198.51.100.0/24");
  await expect(platformRow).toContainText("全局");
  await expect(platformRow).toContainText("攻击");
  await expect(platformRow.getByTestId("ban-source")).toHaveText("手动");
  await expect(platformRow).toContainText("E2E Admin");
  await expect(platformRow).toContainText(/剩 (59|60) 分钟|剩 1 小时/);

  dialog = await openBanDialog(page, state.siteName);
  await dialog.getByTestId("ban-cidr").fill("203.0.113.9");
  await check(page, "ban-dialog-site");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog).toBeHidden();
  const siteRow = banRow(page, "203.0.113.9/32");
  await expect(siteRow).toContainText(state.siteName);
  // The console clock may run a few seconds ahead of the browser: a new 1-day ban shows 23 hours or 1 day.
  await expect(siteRow).toContainText(/剩 (2[34] 小时|1 天)/);

  await pick(page, page.getByTestId("ban-filter-scope"), "全局");
  await expect(platformRow).toBeVisible();
  await expect(siteRow).toHaveCount(0);
  await pick(page, page.getByTestId("ban-filter-scope"), "网站");
  await expect(siteRow).toBeVisible();
  await expect(platformRow).toHaveCount(0);
  await pick(page, page.getByTestId("ban-filter-scope"), "全部范围");
  await expect(platformRow).toBeVisible();
  await check(page, "bans-scopes");

  await unban(page, "198.51.100.0/24");
  await unban(page, "203.0.113.9/32");
  await expect(page.getByText("暂无封禁", { exact: true })).toBeVisible();
  await page.goto("/audit?action=ban.delete");
  await expect(page.getByTestId("audit-action").first()).toHaveText("ban.delete");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G1: the operator edits the ban settings", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/protection");
  const maxTotal = page.getByTestId("bans-max-total");
  const share = page.getByRole("switch", { name: "集群内共享自动封禁", exact: true });
  const save = page.getByTestId("ban-settings-save");
  await expect(maxTotal).toHaveValue("10000");
  await expect(share).toHaveAttribute("aria-checked", "true");
  await expect(save).toBeDisabled();

  await maxTotal.fill("5000");
  await share.click();
  await expect(share).toHaveAttribute("aria-checked", "false");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(maxTotal).toHaveValue("5000");
  await expect(share).toHaveAttribute("aria-checked", "false");
  await check(page, "ban-settings");
  await page.goto("/audit?action=system.bans_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("system.bans_update");

  // Back to the defaults for the next steps.
  await page.goto("/protection");
  await maxTotal.fill("10000");
  await share.click();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(maxTotal).toHaveValue("10000");
  await expect(share).toHaveAttribute("aria-checked", "true");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
