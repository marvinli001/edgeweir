import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g3.mjs: the compression and CRS sites of the
 * default cluster (both turned off, CRS matches in the logs and the top
 * rules) and the cluster g3-legacy whose only node is an old one (no
 * brotli-v1, zstd-v1 or modsecurity-v1) with its site. Every test leaves the
 * sites as it found them.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g3-state.json"), "utf8")) as {
  compressSiteId: string;
  crsSiteId: string;
  /** Rules the CRS test payload matched in detect mode. */
  crsRuleIds: number[];
  /** A path whose request block mode refused (sampled with its rules). */
  crsLoggedPath: string;
  legacySiteId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const BY_NODES = "所在集群有节点不支持，暂时无法开启";

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g3-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g3-${name}-${scheme}-375.png`,
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

async function openTab(page: Page, siteId: string, tab: "cache" | "security" | "logs") {
  await page.goto(`/sites/${siteId}?tab=${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

test("G3: the cache tab turns Zstandard and Brotli on with their levels and keeps gzip", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.compressSiteId, "cache");
  const zstd = page.getByTestId("https-zstd");
  const brotli = page.getByTestId("https-brotli");
  const gzip = page.getByTestId("https-gzip");
  const save = page.getByTestId("compression-save");
  await expect(zstd).toHaveAttribute("aria-checked", "false");
  await expect(brotli).toHaveAttribute("aria-checked", "false");
  await expect(gzip).toHaveAttribute("aria-checked", "true");
  for (const algorithm of ["zstd", "brotli", "gzip"])
    await expect(page.getByTestId(`https-${algorithm}-unavailable`)).toHaveCount(0);
  await expect(zstd).toBeEnabled();
  await expect(brotli).toBeEnabled();
  await expect(page.getByTestId("https-zstd-level")).toHaveValue("3");
  await expect(page.getByTestId("https-brotli-level")).toHaveValue("6");
  await expect(page.getByTestId("https-gzip-level")).toHaveCount(0);
  await expect(page.getByTestId("https-brotli-types")).toHaveValue(/text\/plain/);
  await expect(save).toBeDisabled();

  await zstd.click();
  await page.getByTestId("https-zstd-level").fill("7");
  await brotli.click();
  await page.getByTestId("https-brotli-level").fill("9");
  await page.getByTestId("https-brotli-min").fill("512");
  // Typed key by key: a separator stays while typing.
  const zstdTypes = page.getByTestId("https-zstd-types");
  await zstdTypes.clear();
  await zstdTypes.pressSequentially("text/html, text/plain, application/json");
  await expect(zstdTypes).toHaveValue("text/html, text/plain, application/json");
  await check(page, "https-compression");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(zstd).toHaveAttribute("aria-checked", "true");
  await expect(brotli).toHaveAttribute("aria-checked", "true");
  await expect(gzip).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("https-zstd-level")).toHaveValue("7");
  await expect(page.getByTestId("https-brotli-level")).toHaveValue("9");
  await expect(page.getByTestId("https-brotli-min")).toHaveValue("512");
  await expect(page.getByTestId("https-zstd-types")).toHaveValue(
    "text/html, text/plain, application/json",
  );

  // Back to the defaults the script left.
  await zstd.click();
  await page.getByTestId("https-zstd-level").fill("3");
  await page
    .getByTestId("https-zstd-types")
    .fill(
      "text/html, text/plain, text/css, application/javascript, application/json, image/svg+xml",
    );
  await brotli.click();
  await page.getByTestId("https-brotli-level").fill("6");
  await page.getByTestId("https-brotli-min").fill("256");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(zstd).toHaveAttribute("aria-checked", "false");
  await expect(brotli).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("https-zstd-level")).toHaveValue("3");
  await expect(page.getByTestId("https-brotli-min")).toHaveValue("256");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G3: the security tab edits the site's OWASP CRS and lists the most-matched rules", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.crsSiteId, "security");
  const card = page.getByTestId("waf-card");
  await expect(card).toBeVisible();
  const mode = page.getByTestId("waf-mode");
  const paranoia = page.getByTestId("waf-paranoia");
  const threshold = page.getByTestId("waf-threshold");
  const bodyLimit = page.getByTestId("waf-body-limit");
  const input = page.getByTestId("waf-exclusion-input");
  const add = page.getByTestId("waf-exclusion-add");
  const exclusions = page.getByTestId("waf-exclusion");
  const save = page.getByTestId("waf-save");
  const badge = page.getByTestId("waf-mode-badge");
  const preset = page.getByTestId("waf-preset");
  await expect(mode).toHaveText("关闭");
  await expect(mode).toBeEnabled();
  await expect(badge).toHaveCount(0);
  await expect(preset).toHaveText("标准");
  await expect(threshold).toHaveCount(0);
  await expect(exclusions).toHaveCount(0);
  await expect(page.getByTestId("waf-unavailable")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // The script's detect run: its detection rules are the most-matched ones; the blocking
  // evaluation (949110) matched every request too but does not rank.
  const top = page.getByTestId("waf-top-rules");
  const detection = state.crsRuleIds.filter(
    (id) => ![901, 949, 959, 980].includes(Math.floor(id / 1000)),
  );
  for (const rule of detection) await expect(top).toContainText(String(rule));
  await expect(top).not.toContainText("949110");
  await pick(page, page.getByTestId("waf-top-range"), "过去 1 小时");
  await expect(page.getByTestId("waf-top-range")).toHaveText("过去 1 小时");
  for (const rule of detection) await expect(top).toContainText(String(rule));

  await pick(page, mode, "拦截");
  await pick(page, preset, "自定义");
  await expect(paranoia).toHaveText("1 级");
  await expect(threshold).toHaveValue("5");
  await expect(bodyLimit).toHaveValue("131072");
  await pick(page, paranoia, "2 级");
  await threshold.fill("10");
  await bodyLimit.fill("65536");
  await input.fill("94110");
  await add.click();
  await expect(page.getByTestId("waf-exclusion-error")).toBeVisible();
  await expect(exclusions).toHaveCount(0);
  await input.fill("942100, 941100 942100");
  await expect(page.getByTestId("waf-exclusion-error")).toHaveCount(0);
  await add.click();
  await expect(exclusions).toHaveCount(2);
  await expect(exclusions.first()).toHaveAttribute("data-rule-id", "941100");
  await expect(exclusions.nth(1)).toHaveAttribute("data-rule-id", "942100");
  await expect(input).toHaveValue("");
  await exclusions.nth(1).getByTestId("waf-exclusion-remove").click();
  await expect(exclusions).toHaveCount(1);
  await check(page, "waf-card");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(badge).toHaveText("拦截");
  await page.reload();
  await expect(mode).toHaveText("拦截");
  await expect(badge).toHaveText("拦截");
  await expect(preset).toHaveText("自定义");
  await expect(paranoia).toHaveText("2 级");
  await expect(threshold).toHaveValue("10");
  await expect(bodyLimit).toHaveValue("65536");
  await expect(exclusions).toHaveCount(1);
  await expect(exclusions.first()).toHaveAttribute("data-rule-id", "941100");

  // Off again, with the defaults.
  await pick(page, mode, "仅检测");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(badge).toHaveText("仅检测");
  await pick(page, mode, "关闭");
  await pick(page, preset, "标准");
  await expect(threshold).toHaveCount(0);
  await exclusions.first().getByTestId("waf-exclusion-remove").click();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(badge).toHaveCount(0);
  await page.reload();
  await expect(mode).toHaveText("关闭");
  await expect(preset).toHaveText("标准");
  await expect(exclusions).toHaveCount(0);
  await page.goto("/audit?action=site.waf_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("site.waf_update");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G3: the logs tab shows the CRS rules of sampled requests and which were blocked", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.crsSiteId, "logs");
  await expect(page.getByTestId("logs-table")).toBeVisible();
  await expect(page.getByTestId("log-waf").first()).toBeVisible();
  await page.locator("#log-path").fill(state.crsLoggedPath);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  const rows = page.getByTestId("logs-table").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(state.crsLoggedPath);
  await expect(rows.first()).toContainText("403");
  await expect(rows.first().getByTestId("log-waf-blocked")).toHaveText("已拦截");
  await expect(rows.first().getByTestId("log-waf-rule").filter({ hasText: "949110" })).toHaveCount(
    1,
  );
  for (const rule of state.crsRuleIds.filter((id) => id !== 949110))
    await expect(rows.first().getByTestId("log-waf")).toContainText(String(rule));
  await check(page, "logs");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G3: a cluster with an old node cannot turn Brotli, Zstandard or CRS on", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.legacySiteId, "cache");
  for (const algorithm of ["zstd", "brotli"]) {
    await expect(page.getByTestId(`https-${algorithm}`)).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId(`https-${algorithm}`)).toBeDisabled();
    await expect(page.getByTestId(`https-${algorithm}-unavailable`)).toHaveText(BY_NODES);
  }
  await expect(page.getByTestId("https-gzip")).toBeEnabled();
  await expect(page.getByTestId("https-gzip-unavailable")).toHaveCount(0);
  await check(page, "compression-old-node");

  await openTab(page, state.legacySiteId, "security");
  const unavailable = page.getByTestId("waf-unavailable");
  await expect(unavailable).toHaveAttribute("data-reason", "nodes");
  await expect(unavailable).toHaveText(BY_NODES);
  await expect(page.getByTestId("waf-mode")).toHaveText("关闭");
  await expect(page.getByTestId("waf-mode")).toBeDisabled();
  await check(page, "waf-old-node");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
