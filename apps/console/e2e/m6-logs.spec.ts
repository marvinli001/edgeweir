import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { login, pick } from "./helpers";

test("M6: log filters, CSV export and scoped AccessKey revocation", async ({ page }) => {
  const state = JSON.parse(readFileSync(resolve("../../.e2e/m6-logs-state.json"), "utf8")) as {
    siteId: string;
    path: string;
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "admin@e2e.test", "e2e-admin-password-123");
  await page.goto(`/sites/${state.siteId}?tab=logs`);
  await expect(page.getByLabel("访问日志采样率")).toBeVisible();
  await page.getByLabel("状态码", { exact: true }).fill("200");
  await page.getByLabel("路径前缀").fill(state.path);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByRole("table").getByText(state.path, { exact: false }).first(),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page.getByLabel("状态码", { exact: true }).fill("404");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("没有匹配的日志")).toBeVisible();
  await page.getByLabel("状态码", { exact: true }).fill("200");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.screenshot({
    path: "../../.e2e/m6-logs-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "../../.e2e/m6-logs-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  await page.goto("/settings");
  const name = `browser-readonly-${Date.now()}`;
  await page.getByLabel("名称", { exact: true }).fill(name);
  await pick(page, page.getByLabel("权限范围"), "只读");
  await page.getByTestId("access-key-create").click();
  await expect(page.getByTestId("new-api-key")).toBeVisible();
  const row = page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  await expect(row.getByText("只读", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "吊销密钥" }).click();
  await page.getByTestId("confirm-action").click();
  await expect(row.getByText("已吊销", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "../../.e2e/m6-keys-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
