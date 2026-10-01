import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g4.mjs on the default cluster (two G4 nodes): the
 * tag site g4-tag (tag.g4.test, tag2.g4.test; Cache-Tag not forwarded), the
 * prefetch site g4-prefetch (pre.g4.test, cache key separating devices; its
 * origin serves /sitemap.xml listing /page/1 to /page/7), the pool site
 * g4-pool (two origins and the backup "hidden", which both nodes' active
 * checks report down with address_forbidden; active checks on: /health, GET,
 * 200-299, every 5 s, 2 s timeout, thresholds 2/2; affinity off), the error
 * page site g4-errors (all five templates, origin errors not replaced, one
 * sampled request with its request id) and empty platform pages. Every test
 * leaves them as it found them.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g4-state.json"), "utf8")) as {
  tagSiteId: string;
  preSiteId: string;
  poolSiteId: string;
  /** The backup origin the nodes' active checks report down. */
  poolHiddenOriginId: string;
  errSiteId: string;
  /** Request id and path of the sampled request of g4-errors. */
  loggedRequestId: string;
  loggedPath: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const BOTH_VARIANTS = "桌面端 / 移动端";

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g4-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g4-${name}-${scheme}-375.png`,
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

async function openTab(page: Page, siteId: string, tab: "cache" | "origins" | "errors" | "logs") {
  await page.goto(`/sites/${siteId}?tab=${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

/** Switches the purge form to a type; the type lives in the URL, so wait for the tab to land. */
async function purgeType(page: Page, type: "host" | "tag" | "prefetch" | "sitemap") {
  await page.getByTestId(`purge-type-${type}`).click();
  await expect(page.getByTestId(`purge-type-${type}`)).toHaveAttribute("aria-selected", "true");
}

/**
 * Submits the purge form and returns the new task (listed first, opened with its nodes) once
 * every node that ran it reported success. A submitted task clears its field.
 */
async function submitTask(page: Page, type: string, field: Locator): Promise<Locator> {
  await page.getByTestId("purge-submit").click();
  await expect(field).toHaveValue("");
  await expect(page.getByTestId("purge-error")).toHaveCount(0);
  const task = page.getByTestId("cache-task").first();
  await expect(task).toHaveAttribute("data-type", type);
  await expect(task).toHaveAttribute("data-state", "succeeded", { timeout: 60_000 });
  await expect(task.getByTestId("cache-task-state")).toHaveText("成功");
  await expect(task.getByTestId("cache-task-progress")).toHaveText(/^(\d+)\/\1 个节点$/);
  const toggle = task.getByTestId("cache-task-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const ran = task.locator('[data-testid="cache-task-node"]:not([data-state="skipped"])');
  await expect(ran.first()).toBeVisible();
  for (const node of await ran.all()) {
    await expect(node.getByTestId("cache-task-node-state")).toHaveText("成功");
    await expect(node.getByTestId("cache-task-node-counts")).toContainText("失败 0");
  }
  return task;
}

/**
 * Clicks a save button and waits for its RPC to answer: the button turns
 * disabled while the mutation is still pending, so a reload right after the
 * click could read the old value.
 */
async function saved(page: Page, save: Locator, procedure: string) {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/rpc/${procedure}`) && response.request().method() === "POST",
  );
  await save.click();
  expect((await answered).ok()).toBe(true);
}

test("G4: purges by host and Cache-Tag, device variant prefetches and a sitemap reach every node", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/purge");
  await expect(page.getByTestId("page-title")).toHaveText("刷新预热");

  await test.step("a host purge", async () => {
    await purgeType(page, "host");
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible();
    await page.getByTestId("purge-hosts").fill("tag.g4.test");
    await expect(page.getByTestId("purge-count")).toHaveText("1 / 500");
    const task = await submitTask(page, "host", page.getByTestId("purge-hosts"));
    await expect(task.getByTestId("cache-task-type")).toHaveText("Host 刷新");
    await expect(task.getByTestId("cache-task-target")).toHaveText("tag.g4.test");
  });

  await test.step("a Cache-Tag purge on one site, tags shown as nodes compare them", async () => {
    await purgeType(page, "tag");
    const site = page.getByTestId("purge-tag-site");
    await expect(site).toHaveText("选择网站");
    // Searchable once there are many sites; g4-tag may be beyond the first page. The options
    // follow the search once its (debounced) query answered.
    const search = page.getByTestId("purge-tag-site-search");
    if (await search.isVisible()) {
      const searched = page.waitForResponse(
        (response) =>
          response.url().includes("/rpc/sites/list") &&
          `${response.url()} ${response.request().postData() ?? ""}`.includes("g4-tag"),
      );
      await search.fill("g4-tag");
      await searched;
    }
    await pick(page, site, "g4-tag");
    await expect(site).toHaveText("g4-tag");
    await expect(page.getByTestId("purge-tag-unavailable")).toHaveCount(0);
    await page.getByTestId("purge-tags").fill("g4-ui-tag\nG4-UI-Upper");
    await expect(page.getByTestId("purge-count")).toHaveText("2 / 500");
    const task = await submitTask(page, "tag", page.getByTestId("purge-tags"));
    // The site stays chosen for the next tag purge.
    await expect(site).toHaveText("g4-tag");
    await expect(task.getByTestId("cache-task-type")).toHaveText("标签刷新");
    await expect(task.getByTestId("cache-task-target")).toHaveText("g4-ui-tag");
    await expect(task.getByTestId("cache-task-sites")).toHaveText("g4-tag");
    await expect(task.getByTestId("cache-task-targets").locator("li")).toHaveText([
      "g4-ui-tag",
      "g4-ui-upper",
    ]);
    await expect(task.getByTestId("cache-task-variants")).toHaveCount(0);
  });

  await test.step("a prefetch in the desktop and mobile variants", async () => {
    await purgeType(page, "prefetch");
    const desktop = page.getByTestId("purge-variant-desktop");
    const mobile = page.getByTestId("purge-variant-mobile");
    await expect(desktop).toHaveAttribute("aria-checked", "true");
    await expect(mobile).toHaveAttribute("aria-checked", "false");
    // At least one variant.
    await desktop.click();
    await expect(desktop).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("purge-urls-prefetch").fill("http://pre.g4.test/page/ui");
    await expect(page.getByTestId("purge-submit")).toBeDisabled();
    await desktop.click();
    await mobile.click();
    await expect(mobile).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("purge-submit")).toBeEnabled();
    const task = await submitTask(page, "prefetch", page.getByTestId("purge-urls-prefetch"));
    await expect(task.getByTestId("cache-task-type")).toHaveText("URL 预热");
    await expect(task.getByTestId("cache-task-target")).toHaveText("http://pre.g4.test/page/ui");
    await expect(task.getByTestId("cache-task-variants")).toHaveText(BOTH_VARIANTS);
    await expect(task.getByTestId("cache-task-max-urls")).toHaveCount(0);
  });

  await test.step("a sitemap prefetch of three URLs in both variants", async () => {
    await purgeType(page, "sitemap");
    // The variants carry over from the prefetch.
    await expect(page.getByTestId("purge-variant-desktop")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("purge-variant-mobile")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("purge-sitemap-max")).toHaveValue("1000");
    await page.getByTestId("purge-sitemap-url").fill("http://pre.g4.test/sitemap.xml");
    await page.getByTestId("purge-sitemap-max").fill("3");
    const task = await submitTask(page, "sitemap", page.getByTestId("purge-sitemap-url"));
    await expect(task.getByTestId("cache-task-type")).toHaveText("站点地图预热");
    await expect(task.getByTestId("cache-task-target")).toHaveText(
      "http://pre.g4.test/sitemap.xml",
    );
    await expect(task.getByTestId("cache-task-variants")).toHaveText(BOTH_VARIANTS);
    await expect(task.getByTestId("cache-task-max-urls")).toHaveText("最多 3 个 URL");
    // Three of the seven pages, each in both variants, on every node.
    const ran = task.locator('[data-testid="cache-task-node"]:not([data-state="skipped"])');
    for (const node of await ran.all())
      await expect(node.getByTestId("cache-task-node-counts")).toHaveText("成功 6 · 失败 0");
  });

  await check(page, "purge");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G4: the cache tab forwards Cache-Tag to clients and back", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.tagSiteId, "cache");
  const keep = page.getByTestId("cache-keep-cache-tag");
  const save = page.getByTestId("cache-tag-save");
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await expect(save).toBeDisabled();
  await keep.click();
  await expect(save).toBeEnabled();
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  // The cache key card has nothing to save: it kept its settings.
  await expect(page.getByTestId("cache-key-save")).toBeDisabled();
  await check(page, "cache-tag");

  await keep.click();
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G4: the origins tab edits active health checks and session affinity and shows the checks' verdicts", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.poolSiteId, "origins");
  const health = page.getByTestId("origins-active-health");
  const path = page.getByTestId("origins-health-path");
  const method = page.getByTestId("origins-health-method");
  const statusMin = page.getByTestId("origins-health-status-min");
  const statusMax = page.getByTestId("origins-health-status-max");
  const host = page.getByTestId("origins-health-host");
  const interval = page.getByTestId("origins-health-interval");
  const timeout = page.getByTestId("origins-health-timeout");
  const healthy = page.getByTestId("origins-health-healthy");
  const unhealthy = page.getByTestId("origins-health-unhealthy");
  const affinity = page.getByTestId("origins-affinity");
  const ttl = page.getByTestId("origins-affinity-ttl");
  const save = page.getByTestId("pool-save");

  // The script's check.
  await expect(health).toHaveAttribute("aria-checked", "true");
  await expect(path).toHaveValue("/health");
  await expect(method).toHaveText("GET");
  await expect(statusMin).toHaveValue("200");
  await expect(statusMax).toHaveValue("299");
  await expect(host).toHaveValue("");
  await expect(interval).toHaveValue("5");
  await expect(timeout).toHaveValue("2");
  await expect(healthy).toHaveValue("2");
  await expect(unhealthy).toHaveValue("2");
  await expect(affinity).toHaveAttribute("aria-checked", "false");
  await expect(affinity).toBeEnabled();
  await expect(ttl).toHaveValue("3600");
  await expect(page.getByTestId("origins-active-health-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("origins-affinity-unavailable")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // Both nodes' probes find the hidden backup on a forbidden address.
  const hidden = page.locator(
    `[data-testid="origin-row"][data-origin-id="${state.poolHiddenOriginId}"]`,
  );
  const badge = hidden.getByTestId("origin-health");
  await expect(badge).toHaveAttribute("data-state", "down", { timeout: 60_000 });
  await expect(hidden.getByTestId("origin-health-error")).toHaveAttribute(
    "data-code",
    "address_forbidden",
  );
  await badge.hover();
  await expect(page.getByTestId("origin-health-source-active").first()).toHaveText("主动");
  await expect(
    page.locator('[data-testid="origin-health-node"][data-source="active"]'),
  ).not.toHaveCount(0);
  await check(page, "origins");

  await interval.fill("10");
  await affinity.click();
  await ttl.fill("600");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(interval).toHaveValue("10");
  await expect(affinity).toHaveAttribute("aria-checked", "true");
  await expect(ttl).toHaveValue("600");
  // Untouched settings stay as they were.
  await expect(health).toHaveAttribute("aria-checked", "true");
  await expect(path).toHaveValue("/health");
  await expect(timeout).toHaveValue("2");

  // Back to the script's settings.
  await interval.fill("5");
  await affinity.click();
  await ttl.fill("3600");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(interval).toHaveValue("5");
  await expect(affinity).toHaveAttribute("aria-checked", "false");
  await expect(ttl).toHaveValue("3600");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G4: the error pages tab edits a site's templates and refuses one over 64 KiB", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.errSiteId, "errors");
  const field = (status: number) => page.getByTestId(`error-page-${status}`);
  const intercept = page.getByTestId("error-pages-intercept");
  const save = page.getByTestId("error-pages-save");
  for (const status of [403, 429, 502, 503, 504]) await expect(field(status)).not.toHaveValue("");
  await expect(intercept).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("error-pages-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("error-page-variables")).toContainText("{{request_id}}");
  await expect(save).toBeDisabled();

  const original = await field(503).inputValue();
  const edited = "<h1>{{status}}</h1><p>G4 {{request_id}} {{client_ip}} {{host}}</p>";
  await field(503).fill(edited);
  await intercept.click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(field(503)).toHaveValue(edited);
  await expect(intercept).toHaveAttribute("aria-checked", "true");
  await check(page, "errors");

  await field(503).fill(original);
  await intercept.click();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(field(503)).toHaveValue(original);
  await expect(intercept).toHaveAttribute("aria-checked", "false");
  for (const status of [403, 429, 502, 504]) await expect(field(status)).not.toHaveValue("");

  // The limit counts UTF-8 bytes: 21,846 CJK characters are 65,538 bytes.
  const before = await field(429).inputValue();
  await field(429).fill("错".repeat(21_846));
  await expect(page.getByTestId("error-page-429-bytes")).toHaveText("65,538 / 65,536 字节");
  await expect(page.getByTestId("error-page-429-too-large")).toHaveText(
    "429 错误页超过 65,536 字节",
  );
  await expect(save).toBeDisabled();
  await check(page, "errors-too-large");
  await field(429).fill(before);
  await expect(page.getByTestId("error-page-429-too-large")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G4: the operator sets and clears the platform error pages", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/system");
  const card = page.getByTestId("platform-error-pages-card");
  const pages = {
    "platform-page-unknown-host": "<h1>{{host}}</h1><p>G4 unknown host</p>",
    "platform-page-disabled": "<h1>{{status}}</h1><p>G4 disabled {{request_id}}</p>",
  };
  const save = card.getByTestId("platform-pages-save");
  for (const id of Object.keys(pages)) await expect(card.getByTestId(id)).toHaveValue("");
  await expect(save).toBeDisabled();
  for (const [id, template] of Object.entries(pages)) await card.getByTestId(id).fill(template);
  await saved(page, save, "settings/setErrorPages");
  await expect(save).toBeDisabled();
  await page.reload();
  for (const [id, template] of Object.entries(pages))
    await expect(card.getByTestId(id)).toHaveValue(template);
  await check(page, "platform-pages");

  for (const id of Object.keys(pages)) await card.getByTestId(id).fill("");
  await saved(page, save, "settings/setErrorPages");
  await expect(save).toBeDisabled();
  await page.reload();
  for (const id of Object.keys(pages)) await expect(card.getByTestId(id)).toHaveValue("");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G4: the logs tab finds a sampled request by its request id", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.errSiteId, "logs");
  await page.getByTestId("logs-request-id").fill(state.loggedRequestId);
  await page.getByTestId("logs-search").click();
  const rows = page.getByTestId("logs-table").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(state.loggedPath);
  await expect(rows.first().getByTestId("log-request-id")).toHaveText(state.loggedRequestId);
  await check(page, "logs-request-id");

  // An id nobody answered with matches nothing.
  await page.getByTestId("logs-request-id").fill(`${state.loggedRequestId}-none`);
  await page.getByTestId("logs-search").click();
  await expect(page.getByText("没有匹配的日志")).toBeVisible();
  await logout(page);
  expect(pageErrors).toEqual([]);
});
