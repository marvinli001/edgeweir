import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * Written by scripts/e2e-g10.mjs: g10-suffix (.multi.g10.test) with the CNAME prefix
 * g10-custom and two replaced prefixes still resolving, g10-idn (bücher.g10.test) and
 * g10-default (default.g10.test, with a certificate) in the default cluster, whose unknown
 * host handling is back to the defaults. The site g10-ui created here is removed by
 * `node scripts/e2e-g10.mjs --cleanup`.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g10-state.json"), "utf8")) as {
  clusterId: string;
  clusterName: string;
  suffixSiteId: string;
  idnSiteId: string;
  defaultSiteId: string;
  /** The cluster's DNS binding domain: targets are `<prefix>.<domain>`. */
  domain: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g10-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g10-${name}-${scheme}-375.png`,
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

test("G10: Unicode and suffix, wildcard and pattern domains", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/sites");
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill("g10-ui");
  const clusterSelect = page.getByTestId("site-cluster");
  if (await clusterSelect.isVisible()) await pick(page, clusterSelect, state.clusterName);
  await page
    .getByLabel("域名", { exact: true })
    .fill("Bücher-UI.g10.test\n.ui.g10.test\n~ui[0-9]+\\.g10\\.test");
  await page.getByLabel("源站地址", { exact: true }).fill("whoami");
  await page.getByTestId("create-site-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText("g10-ui");

  await page.getByTestId("tab-domains").click();
  const list = page.getByTestId("domain-list");
  // Stored as Punycode, shown in Unicode with the stored form on hover.
  const unicode = list.getByTestId("domain-unicode");
  await expect(unicode).toHaveText("bücher-ui.g10.test");
  await unicode.hover();
  await expect(page.getByTestId("domain-punycode")).toHaveText("xn--bcher-ui-65a.g10.test");
  await expect(list.getByTestId("domain-kind-suffix")).toHaveText("全部子域名");
  await expect(list.getByTestId("domain-kind-regex")).toHaveText("正则");
  await expect(list).toContainText(".ui.g10.test");
  await expect(list).toContainText("~ui[0-9]+\\.g10\\.test");

  // A pattern outside the shared subset is refused before saving.
  const input = page.getByTestId("domain-input");
  await input.fill("~(?=a)b\\.g10\\.test");
  await page.getByTestId("domain-add").click();
  await expect(page.getByText("域名无效：~(?=a)b\\.g10\\.test")).toBeVisible();
  await input.fill("*.w.ui.g10.test");
  await page.getByTestId("domain-add").click();
  await saved(page, page.getByTestId("domains-save"), "sites/update");
  await expect(list.getByTestId("domain-kind-wildcard")).toBeVisible();
  // Suffix and pattern domains have nothing to check in DNS.
  await expect(page.getByTestId("domain-pointing")).toContainText("无法检查");
  await check(page, "domains");

  // The list shows Unicode and finds the site by either form.
  for (const search of ["bücher-ui", "xn--bcher-ui"]) {
    await page.goto(`/sites?q=${encodeURIComponent(search)}`);
    await expect(page.getByTestId("sites-table")).toContainText("bücher-ui.g10.test");
  }
  await check(page, "sites");
  expect(pageErrors).toEqual([]);
});

test("G10: the cluster's unknown host handling", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=network`);
  const card = page.getByTestId("unknown-hosts");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("unknown-hosts-unknown")).toHaveText("未知域名页（404）");
  await expect(card.getByTestId("unknown-hosts-ip")).toHaveText("未知域名页（404）");
  const save = card.getByTestId("unknown-hosts-save");
  await expect(save).toBeDisabled();

  await pick(page, card.getByTestId("unknown-hosts-unknown"), "交给默认网站");
  await expect(card.getByTestId("unknown-hosts-site")).toBeVisible();
  // Handing requests over needs the site, found by name or domain.
  await expect(save).toBeDisabled();
  await card.getByTestId("unknown-hosts-site-search").fill("default.g10");
  await pick(page, card.getByTestId("unknown-hosts-site"), "g10-default");
  await pick(page, card.getByTestId("unknown-hosts-ip"), "关闭连接（444）");
  await card.getByTestId("unknown-hosts-certificate").click();
  await card.getByTestId("unknown-hosts-scan").click();
  await expect(card.getByTestId("unknown-hosts-threshold")).toHaveValue("100");
  await expect(card.getByTestId("unknown-hosts-ban")).toHaveValue("3600");
  await card.getByTestId("unknown-hosts-threshold").fill("5");
  await expect(card.getByTestId("unknown-hosts-scan-invalid")).toBeVisible();
  await expect(save).toBeDisabled();
  await card.getByTestId("unknown-hosts-threshold").fill("50");
  await expect(card.getByTestId("unknown-hosts-scan-invalid")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await check(page, "unknown-hosts");
  await saved(page, save, "clusters/setUnknownHosts");

  await page.reload();
  await expect(card.getByTestId("unknown-hosts-unknown")).toHaveText("交给默认网站");
  await expect(card.getByTestId("unknown-hosts-site")).toHaveText("g10-default");
  await expect(card.getByTestId("unknown-hosts-ip")).toHaveText("关闭连接（444）");
  await expect(card.getByTestId("unknown-hosts-certificate")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(card.getByTestId("unknown-hosts-threshold")).toHaveValue("50");
  await check(page, "unknown-hosts-saved");

  // Back to the defaults for the steps after G10.
  await pick(page, card.getByTestId("unknown-hosts-unknown"), "未知域名页（404）");
  await pick(page, card.getByTestId("unknown-hosts-ip"), "未知域名页（404）");
  await card.getByTestId("unknown-hosts-scan").click();
  await expect(card.getByTestId("unknown-hosts-site")).toHaveCount(0);
  await saved(page, save, "clusters/setUnknownHosts");
  await page.reload();
  await expect(card.getByTestId("unknown-hosts-unknown")).toHaveText("未知域名页（404）");
  await expect(card.getByTestId("unknown-hosts-scan")).toHaveAttribute("aria-checked", "false");
  expect(pageErrors).toEqual([]);
});

test("G10: the CNAME card regenerates and customizes the prefix", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.suffixSiteId}?tab=domains`);
  const card = page.getByTestId("cname-target");
  const value = card.getByTestId("cname-target-value");
  await expect(value).toHaveText(`g10-custom.${state.domain}`);
  // The two prefixes scripts/e2e-g10.mjs replaced keep resolving for 24 hours.
  await expect(card.getByTestId("cname-retired").locator("li")).toHaveCount(2);
  await expect(card.getByTestId("cname-retired-until").first()).toContainText("解析至");

  await card.getByTestId("cname-prefix-regenerate").click();
  await expect(page.getByText("旧名称继续解析 24 小时")).toBeVisible();
  await page.getByTestId("confirm-action").click();
  await expect(value).toHaveText(
    new RegExp(`^[a-z][a-z0-9]{7}\\.${state.domain.replaceAll(".", "\\.")}$`),
  );
  await expect(card.getByTestId("cname-retired").locator("li")).toHaveCount(3);
  await expect(card.getByTestId("cname-retired")).toContainText(`g10-custom.${state.domain}`);

  await card.getByTestId("cname-prefix-customize").click();
  const input = card.getByTestId("cname-prefix-input");
  const save = card.getByTestId("cname-prefix-save");
  await expect(input).toHaveValue(/^[a-z][a-z0-9]{7}$/);
  await input.fill("-bad");
  await expect(card.getByText("1–30 位小写字母、数字或 -，不以 - 开头或结尾")).toBeVisible();
  await expect(save).toBeDisabled();
  // A name of the DNS plan is taken.
  await input.fill("all");
  await save.click();
  await expect(card.getByTestId("cname-prefix-error")).toHaveText("CNAME 前缀 all 已被使用或保留");
  await input.fill("g10-ui-custom");
  await save.click();
  await expect(value).toHaveText(`g10-ui-custom.${state.domain}`);
  await expect(input).toHaveCount(0);
  // A replaced name still resolving is taken back.
  const retired = card
    .getByTestId("cname-retired")
    .locator("li", { hasText: `g10-custom.${state.domain}` });
  await retired.getByTestId("cname-retired-restore").click();
  await expect(value).toHaveText(`g10-custom.${state.domain}`);
  await check(page, "cname");
  expect(pageErrors).toEqual([]);
});
