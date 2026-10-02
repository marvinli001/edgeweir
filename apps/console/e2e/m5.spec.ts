import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { login, pick } from "./helpers";

test("M5: DNS provider controls, statistics and alert subscriptions", async ({ page }) => {
  const state = JSON.parse(readFileSync(resolve("../../.e2e/m5-state.json"), "utf8")) as {
    siteId: string;
    clusterId: string;
    domain: string;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "admin@e2e.test", "e2e-admin-password-123");
  await page.getByTestId("nav-dns").click();
  await expect(page.getByTestId("page-title")).toHaveText("DNS 调度");
  await page.getByTestId("dns-account-create").click();
  const name = `Browser DNS ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await pick(page, dialog.getByLabel("DNS 服务商", { exact: true }), "本地模拟服务");
  await dialog.getByLabel("API Token", { exact: true }).fill("e2e-dns-token");
  await dialog.getByTestId("dns-zone-input").fill("browser.cdn.test");
  await page.getByTestId("dns-credential-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  // The binding of the M5 cluster lives on its DNS tab.
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=dns`);
  const ttl = page.getByLabel("TTL（秒）", { exact: true });
  await ttl.fill((await ttl.inputValue()) === "120" ? "180" : "120");
  await page.getByTestId("dns-binding-save").click();
  await expect(page.getByTestId("dns-binding-save")).toBeDisabled();
  await page.getByTestId("dns-reconcile").click();
  await expect(page.getByTestId("dns-binding-status")).toHaveText("已发布", { timeout: 30000 });
  await page.screenshot({
    path: "../../.e2e/m5-dns-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByTestId("nav-alerts").click();
  await expect(page.getByTestId("page-title")).toHaveText("告警");
  await page.getByTestId("alert-channel-create").click();
  const channelName = `Browser webhook ${Date.now()}`;
  await dialog.getByLabel("名称", { exact: true }).fill(channelName);
  await dialog
    .getByLabel("Webhook 地址", { exact: true })
    .fill("http://mock-services:8080/webhook");
  await page.getByTestId("alert-channel-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("alert-channel").filter({ hasText: channelName })).toBeVisible();
  await page.getByTestId("nav-system").click();
  await expect(page.getByLabel("SMTP 主机", { exact: true })).toBeVisible();
  await page.goto(`/sites/${state.siteId}?tab=domains`);
  await expect(page.getByTestId("cname-target")).toContainText("edge.cdn.m5.test");
  await page.getByTestId("tab-analytics").click();
  await expect(page.getByTestId("top-url")).toContainText("/m5-popular");
  await expect(page.getByTestId("analytics")).toBeVisible();
  await page.getByTestId("nav-alerts").click();
  await page.getByTestId("alert-subscribe").click();
  await pick(page, dialog.getByLabel("通知渠道", { exact: true }), channelName);
  await dialog.getByLabel("搜索网站", { exact: true }).fill("M5 site");
  await dialog.getByTestId("site-option").filter({ hasText: "M5 site" }).click();
  await expect(dialog.getByTestId("alert-sites-selected")).toHaveText("已选 1 个");
  await page.getByTestId("alert-subscription-submit").click();
  await expect(dialog).toBeHidden();
  const subscription = page.getByTestId("alert-subscription").filter({ hasText: channelName });
  await expect(subscription.getByTestId("alert-subscription-sites")).toHaveText("M5 site");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "../../.e2e/m5-alerts-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
