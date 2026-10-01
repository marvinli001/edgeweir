import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * MVP M2 console acceptance (dev-docs/specs/mvp.md §2): the platform admin submits a URL purge on
 * 刷新预热 and sees the e2e node report it done, submits a directory purge and sees it listed,
 * then checks the demo site's origin health and the origin pool and cache settings cards.
 */
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const nodeName = process.env.E2E_NODE_NAME ?? "edge-e2e-1";

test("M2: purge tasks, origin health, origin and cache settings", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await login(page, adminEmail, adminPassword);

  await test.step("a URL purge reaches the node, which reports the result", async () => {
    await page.getByTestId("nav-purge").click();
    await expect(page.getByTestId("page-title")).toHaveText("刷新预热");
    await expect(page.getByTestId("purge-type-url")).toHaveAttribute("aria-selected", "true");

    const url = `http://demo.test/e2e-m2/${Date.now()}.txt`;
    await page.getByTestId("purge-urls-url").fill(url);
    await page.getByTestId("purge-submit").click();
    await expect(page.getByText("已提交")).toBeVisible();
    await expect(page.getByTestId("purge-urls-url")).toHaveValue("");

    // The new task is at the top of the list and follows the node until it reports.
    const task = page.getByTestId("cache-task").first();
    await expect(task.getByTestId("cache-task-target")).toHaveText(url);
    await expect(task.getByTestId("cache-task-type")).toHaveText("URL 刷新");
    await expect(task).toHaveAttribute("data-state", "succeeded", { timeout: 60_000 });
    await expect(task.getByTestId("cache-task-state")).toHaveText("成功");
    await expect(task.getByTestId("cache-task-progress")).toHaveText(/^(\d+)\/\1 个节点$/);

    // New tasks open with their per-node results.
    const toggle = task.getByTestId("cache-task-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const node = task.getByTestId("cache-task-node").filter({ hasText: nodeName });
    await expect(node).toBeVisible();
    await expect(node).toHaveAttribute("data-state", "succeeded");
    await expect(node.getByTestId("cache-task-node-name")).toHaveText(nodeName);
    await expect(node.getByTestId("cache-task-node-state")).toHaveText("成功");
    await expect(node.getByTestId("cache-task-node-counts")).toContainText("失败 0");
  });

  await test.step("a directory purge is listed", async () => {
    await page.getByTestId("purge-type-prefix").click();
    // The type lives in the URL: the tab (and its field) switch once the navigation lands, so a
    // fill right after the click could still reach the URL tab's field.
    await expect(page.getByTestId("purge-type-prefix")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("目录", { exact: true })).toBeVisible();
    await page.getByTestId("purge-urls-prefix").fill("http://demo.test/static/");
    await expect(page.getByLabel("目录", { exact: true })).toHaveValue("http://demo.test/static/");
    await page.getByTestId("purge-submit").click();
    const task = page.getByTestId("cache-task").first();
    await expect(task).toHaveAttribute("data-type", "prefix");
    await expect(task.getByTestId("cache-task-type")).toHaveText("目录刷新");
    await expect(task.getByTestId("cache-task-target")).toHaveText("http://demo.test/static/");
    await expect(task).toHaveAttribute("data-state", "succeeded", { timeout: 60_000 });
    // The URL purge from the previous step is still listed below it.
    await expect(page.getByTestId("cache-task").nth(1)).toHaveAttribute("data-type", "url");
  });

  await test.step("the demo site shows origin health and the origin pool settings", async () => {
    await page.getByTestId("nav-sites").click();
    await page.getByTestId("sites-search").fill("demo.test");
    await page
      .getByTestId("site-link")
      .filter({ hasText: /^demo$/ })
      .click();
    await expect(page.getByTestId("page-title")).toHaveText("demo");

    await page.getByTestId("tab-origins").click();
    const origin = page.getByTestId("origin-row").first();
    await expect(origin.getByTestId("origin-address")).not.toHaveValue("");
    // Health comes from the nodes' passive checks; the e2e node is online, so it is known.
    await expect(origin.getByTestId("origin-health")).toHaveText(/^(正常|\d+\/\d+ 个节点不可用)$/);

    const pool = page.getByTestId("pool-settings");
    await expect(pool).toBeVisible();
    await expect(pool.getByTestId("pool-policy")).toBeVisible();
    await expect(pool.getByTestId("pool-tls-verify")).toBeVisible();
    await expect(pool.getByTestId("pool-connect-timeout")).not.toHaveValue("");
    await expect(pool.getByTestId("pool-keepalive")).toBeVisible();
    await expect(pool.getByTestId("pool-websocket")).toBeVisible();
    // Nothing edited yet: both cards have nothing to save.
    await expect(page.getByTestId("origins-save")).toBeDisabled();
    await expect(page.getByTestId("pool-save")).toBeDisabled();
  });

  await test.step("the cache tab lists sortable rules and the cache key settings", async () => {
    await page.getByTestId("tab-cache").click();
    const rules = page.getByTestId("cache-rules-card");
    await expect(rules).toBeVisible();
    await expect(rules.getByTestId("cache-rule-row").first()).toBeVisible();
    const before = await rules.getByTestId("cache-rule-row").count();

    // Reorder with the keyboard (drag handle: space, arrow up, space); nothing is saved. Each
    // step waits for the screen reader announcement, i.e. for the move to have landed.
    await rules.getByTestId("cache-rule-add").click();
    await rules.getByTestId("cache-rule-prefixes").last().fill("/e2e-sort/");
    await expect(rules.getByTestId("cache-rule-row")).toHaveCount(before + 1);
    const announcement = page.locator('[role="status"][aria-live="assertive"]');
    const added = before + 1;
    // Let the new row's entrance animation end before picking it up.
    for (const row of await rules.getByTestId("cache-rule-row").all()) {
      await row.evaluate((el) =>
        Promise.all(
          el
            .getAnimations({ subtree: true })
            .map((a: { finished: Promise<unknown> }) => a.finished),
        ),
      );
    }
    await rules.getByTestId("cache-rule-handle").last().focus();
    await page.keyboard.press("Space");
    await expect(announcement).toHaveText(
      new RegExp(`^(已拿起规则 ${added}|规则 ${added} 移到第 ${added} 位)$`),
    );
    // dnd-kit's KeyboardSensor attaches its keydown listener in a timeout after the pickup, so a
    // key pressed within milliseconds can be lost (no person types that fast).
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowUp");
    await expect(announcement).toHaveText(`规则 ${added} 移到第 ${before} 位`);
    await page.keyboard.press("Space");
    await expect(announcement).toHaveText(`规则 ${added} 放在第 ${before} 位`);
    await expect(rules.getByTestId("cache-rule-prefixes").nth(before - 1)).toHaveValue(
      "/e2e-sort/",
    );
    await expect(page.getByTestId("cache-save")).toBeEnabled();

    const cacheKey = page.getByTestId("cache-key-card");
    await expect(cacheKey).toBeVisible();
    await expect(cacheKey.getByTestId("cache-key-query")).toBeVisible();
    await expect(cacheKey.getByTestId("cache-key-host")).toBeVisible();
    await expect(cacheKey.getByTestId("cache-range-slice")).toBeVisible();
    await expect(page.getByTestId("cache-key-save")).toBeDisabled();

    // Leave the unsaved reorder behind.
    await page.reload();
    await expect(page.getByTestId("cache-rule-row")).toHaveCount(before);
  });

  expect(pageErrors).toEqual([]);
});
