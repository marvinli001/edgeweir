import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

const state = JSON.parse(readFileSync(resolve("../../.e2e/dns-state.json"), "utf8")) as {
  clusterA: string;
  clusterB: string;
  siteB: string;
  tenantSite: string;
  tenantEmail: string;
  tenantPassword: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/dns-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/dns-${name}-${scheme}-375.png`,
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

test("DNS: an account from the catalog form, zones listed and the connection tested", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/dns");
  await expect(page.getByTestId("page-title")).toHaveText("平台 DNS");
  await expect(page.getByTestId("dns-bindings")).toContainText("dns-b");
  await page.getByTestId("dns-account-create").click();
  const dialog = page.getByRole("dialog");
  const name = `Browser account ${Date.now()}`;
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await pick(page, dialog.getByLabel("DNS 服务商", { exact: true }), "本地模拟服务");
  // Fields come from the catalog: the test provider has one token field.
  await expect(dialog.getByLabel("API Token", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByLabel("API Token", { exact: true }).fill("e2e-dns-token-b");
  await dialog.getByTestId("dns-list-zones").click();
  await expect(dialog.getByTestId("dns-probe-result")).toHaveText("找到 1 个区域");
  await expect(dialog.getByTestId("dns-zone-select")).toHaveText("cdn-b.dns.test");
  await dialog.getByTestId("dns-test-connection").click();
  await expect(dialog.getByTestId("dns-probe-result")).toContainText("连接正常");
  await check(page, "account-dialog");
  // A wrong token is reported without saving anything.
  await dialog.getByLabel("API Token", { exact: true }).fill("wrong-token");
  await dialog.getByTestId("dns-test-connection").click();
  await expect(dialog.getByTestId("dns-probe-result")).toHaveText(
    "DNS 服务商认证失败，请检查凭据与权限",
  );
  await dialog.getByLabel("API Token", { exact: true }).fill("e2e-dns-token-b");
  await page.getByTestId("dns-credential-submit").click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId("dns-accounts").locator("li", { hasText: name });
  await expect(row).toContainText("cdn-b.dns.test");
  await check(page, "accounts");
  await row.getByRole("button", { name: "删除" }).click();
  await page.getByTestId("confirm-action").click();
  await expect(row).toBeHidden();
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("DNS: a cluster's binding, the manual record list and zone file, then automatic", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/admin/clusters?cluster=${state.clusterB}&tab=dns`);
  const tab = page.getByTestId("cluster-dns");
  await expect(tab).toBeVisible();
  // Left in manual mode by scripts/e2e-dns.mjs.
  await expect(page.getByTestId("dns-manual-records").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByTestId("dns-zone-file")).toContainText("$ORIGIN cdn-b.dns.test.");
  await expect(page.getByTestId("dns-zone-file")).toContainText(
    `${state.siteB}.edge 120 IN CNAME all.edge.cdn-b.dns.test.`,
  );
  await check(page, "cluster-manual");
  const download = page.waitForEvent("download");
  await page.getByTestId("dns-download-zone").click();
  expect((await download).suggestedFilename()).toBe("cdn-b.dns.test.zone");
  await pick(page, page.getByLabel("模式", { exact: true }), "自动");
  await page.getByTestId("dns-binding-save").click();
  await expect(page.getByTestId("dns-binding-save")).toBeDisabled();
  await page.getByTestId("dns-reconcile").click();
  await expect(page.getByTestId("dns-binding-status")).toHaveText("已发布", { timeout: 30000 });
  await expect(page.getByTestId("dns-current-records").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByTestId("dns-revisions")).toBeVisible();
  await check(page, "cluster-auto");
  // The overview tab still holds the cluster's nodes.
  await page.getByTestId("cluster-tab-overview").click();
  await expect(page).not.toHaveURL(/tab=dns/);
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("DNS: CNAME targets on the site page, with the tenant's automatic records", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.siteB}?tab=domains`);
  await expect(page.getByTestId("cname-target-value")).toHaveText(
    `${state.siteB}.edge.cdn-b.dns.test`,
  );
  await expect(page.getByTestId("cname-target-status")).toHaveText("已发布", { timeout: 30000 });
  await check(page, "site-target-b");
  await logout(page);
  await login(page, state.tenantEmail, state.tenantPassword);
  await page.goto(`/sites/${state.tenantSite}?tab=domains`);
  await expect(page.getByTestId("cname-target-value")).toHaveText(
    `${state.tenantSite}.edge.cdn.m5.test`,
  );
  const records = page.getByTestId("site-dns-records");
  await expect(records.getByTestId("site-dns-record")).toHaveCount(1);
  await expect(records).toContainText("shop.dns-tenant.test");
  await expect(records.locator("[data-status=written]")).toHaveCount(1);
  await records.getByTestId("site-dns-sync").click();
  await expect(records.locator("[data-status=written]")).toHaveCount(1);
  await check(page, "site-tenant");
  await page.goto("/certificates");
  await expect(page.getByText("Tenant zone", { exact: true })).toBeVisible();
  await check(page, "tenant-credentials");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
