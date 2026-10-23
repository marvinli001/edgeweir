import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pick, signedIn, test } from "./helpers";

/**
 * Node logs in the browser, after scripts/e2e-node-logs.mjs (.e2e/node-logs-state.json): the core
 * node's details open on the logs tab from the URL; the Lua warning about the origin that does not
 * resolve is listed with its source and, expanded, its request without the query string; the
 * secret of the run is nowhere on the page; the level filter hides it, a search without matches
 * shows the empty state and clearing the filters brings it back; a debug log pull started from the
 * tab finishes, its viewer lists the warning without the secret, filters by level and downloads
 * JSON lines; the node log retention card is on the system page.
 */
const STATE = resolve("../../.e2e/node-logs-state.json");
const state = existsSync(STATE)
  ? (JSON.parse(readFileSync(STATE, "utf8")) as {
      nodeId: string;
      clusterId: string;
      siteId: string;
      secret: string;
    })
  : undefined;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [width, height, suffix] of [
      [1280, 900, ""],
      [375, 812, "-375"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `../../.e2e/node-logs-${name}-${scheme}${suffix}.png`,
        animations: "disabled",
      });
      expect(
        await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
        `${name} overflows at ${width} px (${scheme})`,
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("the node's logs tab lists the warning without secrets", async ({ page }) => {
  test.skip(!state, "run scripts/e2e-node-logs.mjs first");
  if (!state) return;
  await signedIn(page);
  await page.goto(`/clusters?cluster=${state.clusterId}&node=${state.nodeId}&nodeTab=logs`);
  const sheet = page.getByTestId("node-detail");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("node-detail-tab-logs")).toHaveAttribute("aria-selected", "true");
  const row = sheet
    .getByTestId("node-log-row")
    .filter({ hasText: `of site ${state.siteId} marked down` })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("data-source", "lua");
  await expect(row.getByTestId("node-log-source")).toHaveText("Lua");
  await row.getByTestId("node-log-toggle").click();
  const fields = row.getByTestId("node-log-fields");
  await expect(fields).toContainText("?[redacted] HTTP/1.1");
  expect(await page.content()).not.toContain(state.secret);
  // An agent event reads as its label.
  await expect(
    sheet.getByTestId("node-log-row").filter({ hasText: "配置已应用" }).first(),
  ).toBeVisible();
  await check(page, "tab");

  await pick(page, sheet.getByTestId("node-logs-level"), "错误");
  await expect(row).toBeHidden();
  await pick(page, sheet.getByTestId("node-logs-source"), "Lua");
  await sheet.getByTestId("node-logs-search").fill("no-such-entry-of-this-run");
  await expect(sheet.getByTestId("node-logs-clear")).toBeVisible();
  await check(page, "filtered");
  await sheet.getByTestId("node-logs-clear").click();
  await expect(
    sheet.getByTestId("node-log-row").filter({ hasText: `of site ${state.siteId} marked down` }),
  ).not.toHaveCount(0);

  // The overview tab is one click away and leaves the URL without nodeTab.
  await sheet.getByTestId("node-detail-tab-overview").click();
  await expect(page).not.toHaveURL(/nodeTab=/);
});

test("a debug log pull from the tab can be viewed and downloaded", async ({ page }) => {
  test.skip(!state, "run scripts/e2e-node-logs.mjs first");
  if (!state) return;
  await signedIn(page);
  await page.goto(`/clusters?cluster=${state.clusterId}&node=${state.nodeId}&nodeTab=logs`);
  const sheet = page.getByTestId("node-detail");
  const section = sheet.getByTestId("node-debug-logs");
  await expect(section).toBeVisible();
  const done = section.locator('[data-testid="node-debug-pull-row"][data-state="succeeded"]');
  // The pulls of scripts/e2e-node-logs.mjs.
  await expect(done).not.toHaveCount(0);
  const before = await done.count();
  await section.getByTestId("node-debug-pull").click();
  await pick(page, page.getByTestId("node-debug-source"), "Lua");
  await page.getByTestId("node-debug-pull-submit").click();
  await expect(done).toHaveCount(before + 1, { timeout: 60_000 });
  await expect(section.getByTestId("node-debug-pull")).toBeEnabled();
  await check(page, "debug");

  await done.first().getByTestId("node-debug-view").click();
  const viewer = page.getByTestId("node-debug-viewer");
  await expect(viewer).toBeVisible();
  const warning = viewer
    .getByTestId("node-debug-entry")
    .filter({ hasText: `of site ${state.siteId} marked down` })
    .first();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("?[redacted] HTTP/1.1");
  expect(await page.content()).not.toContain(state.secret);
  await check(page, "debug-viewer");
  await pick(page, viewer.getByTestId("node-debug-level"), "警告及以上");
  for (const level of await viewer
    .getByTestId("node-debug-entry")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-level"))))
    expect(["warn", "error"]).toContain(level);
  const download = page.waitForEvent("download");
  await viewer.getByTestId("node-debug-viewer-download").click();
  expect((await download).suggestedFilename()).toMatch(/-debug-.*\.jsonl$/);
});

test("the system page has the node log retention card", async ({ page }) => {
  await signedIn(page);
  await page.goto("/system");
  const card = page.getByTestId("node-log-retention-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("node-log-retention-days")).toHaveValue("7");
  await expect(card.getByTestId("node-log-retention-per-node")).toHaveValue("10000");
});
