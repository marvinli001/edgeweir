import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

test("M5: DNS provider controls, tenant ownership, statistics and alert subscriptions", async ({
  page,
}) => {
  const state = JSON.parse(readFileSync(resolve("../../.e2e/m5-state.json"), "utf8")) as {
    siteId: string;
    domain: string;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "admin@e2e.test", "e2e-admin-password-123");
  await page.goto("/admin/dns");
  await expect(page.getByTestId("page-title")).toHaveText("平台 DNS");
  await page.getByTestId("dns-provider-create").click();
  const name = `Browser DNS ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByLabel("DNS 区域").fill("browser.cdn.test");
  await pick(page, dialog.getByLabel("DNS 服务商", { exact: true }), "本地模拟服务");
  await dialog.getByLabel("API Token").fill("e2e-dns-token");
  await page.getByTestId("dns-provider-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const ttl = page.getByLabel("TTL（秒）", { exact: true });
  await ttl.fill((await ttl.inputValue()) === "120" ? "180" : "120");
  await page.getByTestId("dns-policy-save").click();
  await expect(page.getByTestId("dns-policy-save")).toBeDisabled();
  await page.getByTestId("dns-reconcile").click();
  await expect(page.locator("tbody tr").first()).toContainText("已发布", { timeout: 30000 });
  await page.screenshot({
    path: "../../.e2e/m5-dns-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/admin/alerts");
  await expect(page.getByTestId("page-title")).toHaveText("告警渠道");
  await page.getByTestId("alert-channel-create").click();
  const channelName = `Browser webhook ${Date.now()}`;
  await dialog.getByLabel("名称", { exact: true }).fill(channelName);
  await dialog
    .getByLabel("Webhook 地址", { exact: true })
    .fill("http://mock-services:8080/webhook");
  await dialog.getByRole("switch", { name: "允许租户订阅" }).click();
  await page.getByTestId("alert-channel-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(channelName, { exact: true })).toBeVisible();
  await page.goto("/admin/settings");
  await expect(page.getByLabel("SMTP 主机", { exact: true })).toBeVisible();
  await logout(page);
  await login(page, "tenant@m5.test", "m5-tenant-password-123");
  await page.goto(`/sites/${state.siteId}?tab=domains`);
  await expect(page.getByTestId("domain-ownership")).toContainText("已验证");
  await expect(page.getByTestId("cname-target")).toContainText("edge.cdn.m5.test");
  await page.getByTestId("tab-analytics").click();
  await expect(page.getByTestId("top-url")).toContainText("/m5-popular");
  await expect(page.getByTestId("analytics")).toBeVisible();
  await page.getByTestId("nav-alerts").click();
  await page.getByTestId("alert-subscribe").click();
  await dialog.getByLabel("搜索网站", { exact: true }).fill("M5 proof");
  await pick(page, dialog.getByLabel("网站", { exact: true }), "M5 proof");
  await pick(page, dialog.getByLabel("通知渠道", { exact: true }), channelName);
  await page.getByTestId("alert-subscription-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(channelName, { exact: true })).toBeVisible();
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
