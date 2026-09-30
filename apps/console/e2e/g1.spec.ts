import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/** Written by scripts/e2e-g1.mjs, which lifts every ban before this spec runs. */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g1-state.json"), "utf8")) as {
  /** The P0 site of the organization below. */
  siteId: string;
  siteName: string;
  organizationId: string;
  organizationName: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const OWNER = ["owner@p0.test", "p0-owner-password-123"] as const;

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

test("G1: an organization owner bans an address on a site and lifts it", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...OWNER);
  await page.getByTestId("nav-bans").click();
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
  await expect(row).toContainText("P0 Owner");
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

test("G1: administrators set an organization's bans limit; the owner sees it and reaches it", async ({
  page,
}) => {
  const pageErrors = errors(page);
  const openLimits = async () => {
    await page.goto("/admin/organizations");
    await page
      .getByTestId("orgs-table")
      .getByRole("row")
      .filter({ hasText: state.organizationName })
      .getByTestId("org-limits")
      .click();
    return page.getByRole("dialog");
  };
  await login(page, ...ADMIN);
  let dialog = await openLimits();
  const limit = dialog.getByTestId("limit-bans");
  await expect(dialog.getByLabel("封禁数", { exact: true })).toBeVisible();
  await expect(limit).toHaveValue("");
  await limit.fill("1");
  await check(page, "org-limits-dialog");
  await dialog.getByTestId("org-limits-submit").click();
  await expect(dialog).toBeHidden();
  await logout(page);

  await login(page, ...OWNER);
  await page.goto("/settings");
  const card = page.getByTestId("org-limits-card").getByTestId("org-limit-bans");
  await expect(card).toContainText("封禁数");
  await expect(card).toContainText("0 / 1");
  await page.goto("/bans");
  const first = await openBanDialog(page, state.siteName);
  await first.getByTestId("ban-cidr").fill("203.0.113.20");
  await first.getByTestId("ban-submit").click();
  await expect(first).toBeHidden();
  await expect(banRow(page, "203.0.113.20/32")).toBeVisible();
  const second = await openBanDialog(page, state.siteName);
  await second.getByTestId("ban-cidr").fill("203.0.113.21");
  await second.getByTestId("ban-submit").click();
  await expect(second.getByTestId("form-error")).toHaveText("组织的封禁数已达上限：1 / 1");
  await page.keyboard.press("Escape");
  await expect(second).toBeHidden();
  await page.goto("/settings");
  await expect(card).toContainText("1 / 1");
  await check(page, "org-limits");
  await page.goto("/bans");
  await unban(page, "203.0.113.20/32");
  await logout(page);

  // Leave the organization without a bans limit.
  await login(page, ...ADMIN);
  dialog = await openLimits();
  await expect(dialog.getByTestId("limit-bans")).toHaveValue("1");
  await dialog.getByTestId("limit-bans").fill("");
  await dialog.getByTestId("org-limits-submit").click();
  await expect(dialog).toBeHidden();
  dialog = await openLimits();
  await expect(dialog.getByTestId("limit-bans")).toHaveValue("");
  await page.keyboard.press("Escape");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G1: a platform administrator bans a range on every site and an address on a tenant's site", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/bans");
  await expect(page.getByTestId("nav-admin-bans")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("封禁");

  let dialog = await openBanDialog(page);
  await expect(dialog.locator("#ban-scope")).toHaveText("平台");
  await dialog.getByTestId("ban-cidr").fill("198.51.100.0/24");
  await pick(page, dialog.locator("#ban-reason"), "攻击");
  await pick(page, dialog.locator("#ban-duration"), "1 小时");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog).toBeHidden();
  const platformRow = banRow(page, "198.51.100.0/24");
  await expect(platformRow).toContainText("平台");
  await expect(platformRow).toContainText("攻击");
  await expect(platformRow.getByTestId("ban-source")).toHaveText("手动");
  await expect(platformRow).toContainText("E2E Admin");
  await expect(platformRow).toContainText(/剩 (59|60) 分钟|剩 1 小时/);

  dialog = await openBanDialog(page);
  await pick(page, dialog.locator("#ban-scope"), "网站");
  await dialog.locator("#ban-site-search").fill(state.siteName);
  await pick(page, dialog.locator("#ban-site"), state.siteName);
  await dialog.getByTestId("ban-cidr").fill("203.0.113.9");
  await check(page, "admin-ban-dialog");
  await dialog.getByTestId("ban-submit").click();
  await expect(dialog).toBeHidden();
  const siteRow = banRow(page, "203.0.113.9/32");
  await expect(siteRow).toContainText(state.siteName);
  await expect(siteRow).toContainText(state.organizationName);
  // The console clock may run a few seconds ahead of the browser: a new 1-day ban shows 23 hours or 1 day.
  await expect(siteRow).toContainText(/剩 (2[34] 小时|1 天)/);

  await pick(page, page.getByTestId("ban-filter-scope"), "平台");
  await expect(platformRow).toBeVisible();
  await expect(siteRow).toHaveCount(0);
  await pick(page, page.getByTestId("ban-filter-scope"), "网站");
  await expect(siteRow).toBeVisible();
  await expect(platformRow).toHaveCount(0);
  await pick(page, page.getByTestId("ban-filter-scope"), "全部范围");
  await expect(platformRow).toBeVisible();
  await check(page, "admin-bans");

  await unban(page, "198.51.100.0/24");
  await unban(page, "203.0.113.9/32");
  await expect(page.getByText("暂无封禁", { exact: true })).toBeVisible();
  await page.goto("/admin/audit?action=ban.delete");
  await expect(page.getByTestId("audit-action").first()).toHaveText("ban.delete");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G1: administrators edit the ban settings", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/settings");
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
  await page.goto("/admin/audit?action=system.bans_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("system.bans_update");

  // Back to the defaults for the next steps.
  await page.goto("/admin/settings");
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
