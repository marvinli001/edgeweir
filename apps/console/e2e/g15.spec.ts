import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick } from "./helpers";

/**
 * Written by scripts/e2e-g15.mjs: content.g15.test on the default cluster (two nodes with
 * site-content-v1 and cache-zone-v1) with a Set-Cookie cache rule, utm_* left out of the cache
 * key, the PURGE method, charset gbk, a 1024-byte body limit, gzip level 9 and error pages by
 * class and redirect; maint.g15.test whose maintenance mode was on and is off again;
 * s3.g15.test reading MinIO. Nothing here is saved.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g15-state.json"), "utf8")) as {
  contentSiteId: string;
  maintSiteId: string;
  s3SiteId: string;
  clusterId: string;
  nodeId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g15-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g15-${name}-${scheme}-375.png`,
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

async function openTab(page: Page, siteId: string, tab: "cache" | "origins" | "errors") {
  await page.goto(`/sites/${siteId}?tab=${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

test("G15: cache tab with excluded parameters, Set-Cookie caching, PURGE, X-Cache, gzip level and charset", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.contentSiteId, "cache");

  await test.step("the cache key leaves utm_* out", async () => {
    await expect(page.getByTestId("cache-key-query")).toHaveText("排除指定参数");
    await expect(page.getByTestId("cache-key-params")).toHaveValue("utm_*");
    // A wildcard in the middle is refused.
    await page.getByTestId("cache-key-params").fill("utm_*_x");
    await page.getByTestId("cache-key-save").click();
    await expect(page.getByTestId("cache-key-card").getByTestId("site-save-error")).toBeVisible();
  });

  await test.step("the /account/ rule caches Set-Cookie responses", async () => {
    const rule = page.getByTestId("cache-rule-row").first();
    await expect(rule.getByTestId("cache-rule-prefixes")).toHaveValue("/account/");
    await rule.getByTestId("cache-rule-more").click();
    await expect(rule.getByTestId("cache-rule-set-cookie")).toHaveAttribute("aria-checked", "true");
  });

  await test.step("PURGE: the saved key stays hidden, a generated one is shown once", async () => {
    const card = page.getByTestId("purge-method-card");
    await expect(card.getByTestId("purge-method-enabled")).toHaveAttribute("aria-checked", "true");
    const key = card.getByTestId("purge-method-key");
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("placeholder", "已保存，留空不修改");
    await expect(card.getByTestId("purge-method-save")).toBeDisabled();
    await card.getByTestId("purge-method-generate").click();
    await expect(key).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    await expect(card.getByTestId("purge-method-generated")).toBeVisible();
    await expect(card.getByTestId("purge-method-save")).toBeEnabled();
    await key.fill("short");
    await card.getByTestId("purge-method-save").click();
    await expect(card.getByTestId("site-save-error")).toBeVisible();
  });

  await test.step("X-Cache, gzip level and the largest compressed length, charset", async () => {
    await expect(page.getByTestId("x-cache-send")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("https-gzip-level")).toHaveValue("9");
    await expect(page.getByTestId("compression-max-length")).toHaveValue("2000");
    await expect(page.getByTestId("charset-name")).toHaveText("gbk");
    await expect(page.getByTestId("charset-force")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("charset-uppercase")).toHaveAttribute("aria-checked", "true");
    await pick(page, page.getByTestId("charset-name"), "关闭");
    await expect(page.getByTestId("charset-force")).toBeDisabled();
    await expect(page.getByTestId("charset-save")).toBeEnabled();
  });
  await check(page, "cache");
  await page.reload();
  await expect(page.getByTestId("charset-name")).toHaveText("gbk");
  expect(pageErrors).toEqual([]);
});

test("G15: origins tab with tries, status retries, body limit and the S3 presets", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.contentSiteId, "origins");

  await test.step("tries and status retries keep their defaults", async () => {
    await expect(page.getByTestId("pool-tries")).toHaveValue("3");
    await expect(page.getByTestId("pool-status-retry")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("pool-retries-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("pool-save")).toBeDisabled();
    await page.getByTestId("pool-tries").fill("2");
    await expect(page.getByTestId("pool-save")).toBeEnabled();
  });

  await test.step("the body limit shows 1024 bytes in MiB, not 0", async () => {
    const limit = page.getByTestId("body-limit");
    await expect(limit).toHaveValue("0.000977");
    await expect(page.getByTestId("body-limit-save")).toBeDisabled();
    await limit.fill("20000");
    await expect(page.getByTestId("body-limit-save")).toBeDisabled();
  });
  await check(page, "origins");

  await openTab(page, state.s3SiteId, "origins");
  await test.step("the MinIO origin and a preset that fills endpoint and region", async () => {
    const row = page.getByTestId("origin-row").first();
    await expect(row.getByTestId("origin-s3")).toHaveAttribute("aria-checked", "true");
    await expect(row.getByTestId("origin-s3-region")).toHaveValue("us-east-1");
    await expect(row.getByTestId("origin-s3-bucket")).toHaveValue("g15");
    await expect(row.getByTestId("origin-s3-access-key")).toHaveValue("e2e-minio-access");
    await pick(page, row.getByTestId("origin-s3-preset"), "阿里云 OSS");
    await expect(row.getByTestId("origin-address")).toHaveValue(
      "<bucket>.s3.oss-<region>.aliyuncs.com",
    );
    await expect(row.getByTestId("origin-s3-region")).toHaveValue("cn-hangzhou");
    await expect(row.getByTestId("origin-s3-bucket")).toHaveValue("");
    await pick(page, row.getByTestId("origin-s3-preset"), "MinIO");
    await expect(row.getByTestId("origin-s3-region")).toHaveValue("us-east-1");
  });
  await check(page, "s3");
  await page.reload();
  await expect(page.getByTestId("origin-row").first().getByTestId("origin-address")).toHaveValue(
    "minio",
  );
  expect(pageErrors).toEqual([]);
});

test("G15: error pages by class and redirect, maintenance mode", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.contentSiteId, "errors");
  await expect(page.getByTestId("error-pages-content-unavailable")).toHaveCount(0);

  await test.step("4xx and 5xx classes, a 404 redirect, a replaced status", async () => {
    await expect(page.getByTestId("error-page-4xx")).toHaveValue("<p>c4 {{status}}</p>");
    await expect(page.getByTestId("error-page-5xx")).toHaveValue("<p>c5 {{status}}</p>");
    await expect(page.getByTestId("error-page-5xx-status")).toHaveValue("200");
    await expect(page.getByTestId("error-page-405")).toHaveValue("<p>m405 {{status}}</p>");
    await expect(page.getByTestId("error-page-404-url")).toHaveValue(
      "/nf?s={{status}}&id={{request_id}}",
    );
    // An invalid redirect and an out-of-range status are flagged before saving.
    await page.getByTestId("error-page-404-url").fill("javascript:alert(1)");
    await expect(
      page.getByTestId("error-pages-card").getByText("检查「跳转到 URL」"),
    ).toBeVisible();
    await page.getByTestId("error-page-5xx-status").fill("700");
    await expect(page.getByTestId("error-page-5xx-status")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("error-pages-save")).toBeDisabled();
  });
  await check(page, "errors");

  await openTab(page, state.maintSiteId, "errors");
  await test.step("maintenance keeps its settings while off", async () => {
    const card = page.getByTestId("maintenance-card");
    await expect(card.getByTestId("maintenance-enabled")).toHaveAttribute("aria-checked", "false");
    await expect(card.getByTestId("maintenance-retry-after")).toHaveValue("30");
    await expect(card.getByTestId("maintenance-paths")).toHaveValue("/open");
    await expect(card.getByTestId("maintenance-cidrs")).toHaveValue(/\/32$/);
    await expect(card.getByTestId("maintenance-page")).toHaveValue("<p>maint {{status}}</p>");
    await expect(card.getByTestId("maintenance-unavailable")).toHaveCount(0);
    await card.getByTestId("maintenance-enabled").click();
    await expect(card.getByTestId("maintenance-save")).toBeEnabled();
  });
  await check(page, "maintenance");
  await page.reload();
  await expect(page.getByTestId("maintenance-enabled")).toHaveAttribute("aria-checked", "false");
  expect(pageErrors).toEqual([]);
});

test("G15: the cluster's cache zone and a node's own size and usage", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}`);
  const card = page.getByTestId("cluster-cache");
  await expect(card.getByTestId("cluster-cache-size")).toHaveValue("10");
  await expect(card.getByTestId("cluster-cache-days")).toHaveValue("7");
  await card.getByTestId("cluster-cache-size").fill("0");
  await expect(card.getByTestId("cluster-cache-save")).toBeDisabled();
  await card.getByTestId("cluster-cache-size").fill("20");
  await expect(card.getByTestId("cluster-cache-save")).toBeEnabled();
  await check(page, "cluster-cache");

  await page.goto(`/clusters?cluster=${state.clusterId}&node=${state.nodeId}`);
  const dialog = page.getByTestId("node-detail");
  const cache = dialog.getByTestId("node-cache");
  await expect(cache.getByTestId("node-cache-usage")).toContainText("/", { timeout: 60_000 });
  await expect(cache.getByTestId("node-cache-size")).toHaveValue("");
  await expect(cache.getByTestId("node-cache-size")).toHaveAttribute("placeholder", /10/);
  await expect(cache.getByTestId("node-cache-unavailable")).toHaveCount(0);
  await cache.getByTestId("node-cache-size").fill("2");
  await expect(cache.getByTestId("node-cache-save")).toBeEnabled();
  await check(page, "node-cache");
  expect(pageErrors).toEqual([]);
});
