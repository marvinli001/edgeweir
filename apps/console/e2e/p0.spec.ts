import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

const state = JSON.parse(readFileSync(resolve("../../.e2e/p0-state.json"), "utf8")) as {
  clusterId: string;
  siteId: string;
  organizationId: string;
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
      path: `../../.e2e/p0-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/p0-${name}-${scheme}-375.png`,
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

test("P0: an organization owner disables and enables a site", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...OWNER);
  await page.goto(`/sites/${state.siteId}`);
  const status = page.getByTestId("site-status");
  await expect(status).toHaveAttribute("data-state", "active");
  await page.getByTestId("site-toggle-enabled").click();
  await page.getByTestId("confirm-action").click();
  await expect(status).toHaveAttribute("data-state", "disabled");
  await expect(status).toHaveText("已停用");
  await check(page, "site-disabled");
  await page.getByTestId("site-toggle-enabled").click();
  await page.getByTestId("confirm-action").click();
  await expect(status).toHaveAttribute("data-state", "active");
  await page.goto("/sites");
  await expect(page.getByTestId("sites-table").getByTestId("site-status").first()).toHaveText(
    "运行中",
  );
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: the platform suspends a site with a reason; the tenant sees it; the platform resumes it", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/sites");
  const row = page.getByTestId("admin-sites-table").getByRole("row", { name: /p0-site/ });
  await row.getByTestId("site-suspend").click();
  await pick(page, page.getByLabel("原因", { exact: true }), "安全");
  await page.getByTestId("site-suspend-note").fill("ticket 7");
  await page.getByTestId("site-suspend-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(row.getByTestId("site-status")).toHaveAttribute("data-state", "suspended");
  await expect(row).toContainText("安全 · ticket 7");
  await check(page, "admin-sites");
  await logout(page);

  await login(page, ...OWNER);
  await page.goto(`/sites/${state.siteId}`);
  await expect(page.getByTestId("site-suspended-notice")).toHaveText("平台已暂停此网站：安全");
  await expect(page.getByTestId("site-status")).toHaveText("已暂停");
  await expect(page.getByTestId("site-suspended-notice")).not.toContainText("ticket 7");
  await check(page, "site-suspended");
  await logout(page);

  await login(page, ...ADMIN);
  await page.goto("/admin/sites");
  await row.getByTestId("site-resume").click();
  await page.getByTestId("confirm-action").click();
  await expect(row.getByTestId("site-status")).toHaveAttribute("data-state", "active");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: administrators edit organization limits; members see limits and use", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/organizations");
  await page
    .getByTestId("orgs-table")
    .getByRole("row", { name: /P0 Org/ })
    .getByTestId("org-limits")
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("limit-sites")).toHaveValue("3");
  await expect(dialog).toContainText("已用 1");
  await dialog.getByTestId("limit-sites").fill("2");
  await dialog.getByTestId("limit-members").fill("5");
  await check(page, "org-limits-dialog");
  await dialog.getByTestId("org-limits-submit").click();
  await expect(dialog).toBeHidden();
  await logout(page);

  await login(page, ...OWNER);
  await page.goto("/settings");
  const card = page.getByTestId("org-limits-card");
  await expect(card.getByTestId("org-limit-sites")).toContainText("网站数");
  await expect(card.getByTestId("org-limit-sites")).toContainText("1 / 2");
  await expect(card.getByTestId("org-limit-members")).toContainText("1 / 5");
  await expect(card.getByTestId("org-limit-domains")).toHaveCount(0);
  await check(page, "org-limits");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: administrators create a service account, create a key and revoke it", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/service-accounts");
  await expect(page.getByTestId("service-accounts-table")).toContainText("p0-business");
  await page.getByTestId("service-account-new").click();
  await page.getByTestId("service-account-name").fill("p0-ui");
  await page.getByTestId("service-account-scope").filter({ hasText: "usage:read" }).click();
  await page.getByTestId("service-account-scope").filter({ hasText: "sites:read" }).click();
  await page.getByTestId("service-account-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const row = page.getByTestId("service-accounts-table").getByRole("row", { name: /p0-ui/ });
  await expect(row).toContainText("sites:read");
  await expect(row).toContainText("usage:read");
  await row.getByTestId("service-account-keys-open").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("service-account-key-create").click();
  await expect(dialog.getByTestId("service-account-secret")).toHaveText(/^ews_[A-Za-z0-9_-]{43}$/);
  await expect(dialog).toContainText("仅显示一次");
  await check(page, "service-account-key");
  await dialog.getByTestId("service-account-key-revoke").click();
  await page.getByTestId("confirm-action").click();
  await expect(dialog.getByTestId("service-account-keys")).toContainText("已吊销");
  await page.keyboard.press("Escape");
  await page.goto("/admin/audit?action=service_account.key_revoke");
  await expect(page.getByTestId("audit-action").first()).toHaveText("service_account.key_revoke");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: configuration canary status, promote to all and abort", async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/admin/clusters?cluster=${state.clusterId}`);
  // Mark the upgrade canary group as a canary group.
  const groupRow = page
    .getByTestId("node-groups-table")
    .getByRole("row", { name: /upgrade-canary/ });
  await groupRow.getByRole("button", { name: "编辑节点组" }).click();
  await page.getByTestId("node-group-canary").click();
  await page.getByTestId("node-group-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(groupRow.getByTestId("node-group-canary-badge")).toBeVisible();
  // Turn the canary on.
  const card = page.getByTestId("cluster-rollout");
  await card.getByTestId("rollout-enabled").click();
  await card.getByTestId("rollout-window").fill("5");
  await card.getByTestId("rollout-policy-save").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "idle");

  const rename = async (name: string) => {
    await page.goto(`/sites/${state.siteId}`);
    await page.getByTestId("site-name-input").fill(name);
    await page.getByTestId("site-name-save").click();
    await expect(page.getByTestId("site-name-save")).toBeDisabled();
    await page.goto(`/admin/clusters?cluster=${state.clusterId}`);
  };
  await rename("p0-canary-one");
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "canary");
  await expect(card.getByTestId("rollout-candidate")).toBeVisible();
  await expect(card.getByTestId("rollout-canary-node")).toHaveCount(1);
  await check(page, "rollout-canary");
  await card.getByTestId("rollout-promote").click();
  await page.getByTestId("confirm-action").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "promoted");
  await expect(card.getByTestId("rollout-outcome")).toHaveText("管理员推进");

  await rename("p0-canary-two");
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "canary");
  await card.getByTestId("rollout-abort").click();
  await page.getByTestId("confirm-action").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "rolled_back");
  await expect(card.getByTestId("rollout-outcome")).toHaveText("管理员中止");
  await check(page, "rollout-rolled-back");

  // Leave the cluster without a canary for the next steps.
  await card.getByTestId("rollout-enabled").click();
  await card.getByTestId("rollout-policy-save").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "idle");
  await groupRow.getByRole("button", { name: "编辑节点组" }).click();
  await page.getByTestId("node-group-canary").click();
  await page.getByTestId("node-group-submit").click();
  await expect(groupRow.getByTestId("node-group-canary-badge")).toHaveCount(0);
  await page.goto("/admin/audit?action=cluster.rollout_abort");
  await expect(page.getByTestId("audit-action").first()).toHaveText("cluster.rollout_abort");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
