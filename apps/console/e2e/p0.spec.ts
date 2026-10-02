import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout } from "./helpers";

const state = JSON.parse(readFileSync(resolve("../../.e2e/p0-state.json"), "utf8")) as {
  clusterId: string;
  siteId: string;
  /** The node group of the upgrade canary node (named by earlier milestones). */
  canaryGroupName: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

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

test("P0: the operator disables and enables a site", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.siteId}`);
  const status = page.getByTestId("site-status");
  // Live: every online node of the cluster runs the site's latest version.
  await expect(status).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await page.getByTestId("site-toggle-enabled").click();
  await page.getByTestId("confirm-action").click();
  await expect(status).toHaveAttribute("data-state", "disabled");
  await expect(status).toHaveText("已停用");
  await check(page, "site-disabled");
  await page.getByTestId("site-toggle-enabled").click();
  await page.getByTestId("confirm-action").click();
  // Re-enabled, the site rolls out to the nodes again (polled every 5 s) before it is live.
  await expect(status).toHaveAttribute("data-state", /^(pending|partial|active)$/);
  await expect(status).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await page.goto("/sites");
  const row = page
    .getByTestId("sites-table")
    .getByRole("row")
    .filter({ has: page.locator(`a[href="/sites/${state.siteId}"]`) });
  await expect(row.getByTestId("site-status")).toHaveText("运行中");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: the operator creates a service account, creates a key and revokes it", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/service-accounts");
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
  await page.goto("/audit?action=service_account.key_revoke");
  await expect(page.getByTestId("audit-action").first()).toHaveText("service_account.key_revoke");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("P0: configuration canary status, promote to all and abort", async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}`);
  // Mark the upgrade canary node's group as a canary group.
  const groupRow = page
    .getByTestId("node-groups-table")
    .getByRole("row")
    .filter({ has: page.getByText(state.canaryGroupName, { exact: true }) });
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
    await page.goto(`/clusters?cluster=${state.clusterId}`);
  };
  await rename("p0-canary-one");
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "canary");
  await expect(card.getByTestId("rollout-candidate")).toBeVisible();
  await expect(card.getByTestId("rollout-canary-node")).toHaveCount(1);
  await check(page, "rollout-canary");
  await card.getByTestId("rollout-promote").click();
  await page.getByTestId("confirm-action").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "promoted");
  await expect(card.getByTestId("rollout-outcome")).toHaveText("手动推进");

  await rename("p0-canary-two");
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "canary");
  await card.getByTestId("rollout-abort").click();
  await page.getByTestId("confirm-action").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "rolled_back");
  await expect(card.getByTestId("rollout-outcome")).toHaveText("手动中止");
  await check(page, "rollout-rolled-back");

  // Leave the cluster without a canary for the next steps.
  await card.getByTestId("rollout-enabled").click();
  await card.getByTestId("rollout-policy-save").click();
  await expect(card.getByTestId("rollout-state")).toHaveAttribute("data-state", "idle");
  await groupRow.getByRole("button", { name: "编辑节点组" }).click();
  await page.getByTestId("node-group-canary").click();
  await page.getByTestId("node-group-submit").click();
  await expect(groupRow.getByTestId("node-group-canary-badge")).toHaveCount(0);
  await page.goto("/audit?action=cluster.rollout_abort");
  await expect(page.getByTestId("audit-action").first()).toHaveText("cluster.rollout_abort");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
