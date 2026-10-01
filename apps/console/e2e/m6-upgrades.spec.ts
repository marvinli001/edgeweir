import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { login, pick } from "./helpers";

test("M6: start signed canary upgrade and explicitly promote healthy nodes", async ({ page }) => {
  test.setTimeout(240000);
  const fixture = JSON.parse(readFileSync(resolve("../../.e2e/m6-upgrade-state.json"), "utf8")) as {
    clusterId: string;
    groupName: string;
    version: string;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "admin@e2e.test", "e2e-admin-password-123");
  await page.goto(`/clusters?cluster=${fixture.clusterId}`);
  await page.getByTestId("upgrade-create").click();
  await page.getByLabel("目标版本", { exact: true }).fill(fixture.version);
  await pick(page, page.getByLabel("先升级的节点组"), `${fixture.groupName}（1 个节点）`);
  await page.getByTestId("upgrade-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const job = page.getByTestId(`upgrade-${fixture.version}`).first();
  await expect(job).toBeVisible();
  await expect(job.getByText("等待试运行组", { exact: true })).toHaveCount(1);
  await expect(job.getByTestId("upgrade-promote")).toBeDisabled();
  await expect(job.getByTestId("upgrade-promote")).toBeEnabled({ timeout: 150000 });
  await page.screenshot({
    path: "../../.e2e/m6-upgrade-canary.png",
    fullPage: true,
    animations: "disabled",
  });
  await job.getByTestId("upgrade-promote").click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(job.getByText("已成功", { exact: true })).toHaveCount(3, { timeout: 90000 });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  await job.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../.e2e/m6-upgrades-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
