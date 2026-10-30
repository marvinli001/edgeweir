import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pick, shots, signedIn, test } from "./helpers";

/**
 * Written by scripts/e2e-probe-sources.mjs: the generic webhook source (stale,
 * then healthy again after the story's last signed delivery) and the
 * UptimeRobot source (failing: the simulator answers 503).
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/probe-sources-state.json"), "utf8")) as {
  hookId: string;
  pullId: string;
};

const check = (page: Page, name: string) => shots(page, "probe-sources", name);

test("external probe sources: states, results, mappings, a new webhook source and modes", async ({
  page,
}) => {
  expect(state.hookId).toBeTruthy();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signedIn(page);
  await page.goto("/system?tab=probes");
  const panel = page.getByTestId("probe-sources");
  await expect(panel).toBeVisible();
  const row = (name: string) => panel.locator("tr").filter({ hasText: name });
  await expect(
    row("ps-e2e webhook").locator(
      '[data-testid="probe-source-healthy"], [data-testid="probe-source-stale"]',
    ),
  ).toBeVisible();
  await expect(row("ps-e2e robot").getByTestId("probe-source-failing")).toBeVisible();
  await expect(row("ps-e2e robot").getByTestId("probe-source-error")).toBeVisible();
  await check(page, "list");

  // Results of the webhook source: monitor ps-a from fra and sin, its URL, no secret.
  await row("ps-e2e webhook").getByTestId("probe-source-name").click();
  const results = page.getByTestId("probe-source-result");
  await expect(results.filter({ hasText: "fra" })).toHaveCount(1);
  await expect(results.filter({ hasText: "sin" })).toHaveCount(1);
  await expect(page.getByTestId("probe-source-results-webhook-url")).toContainText(
    `/api/hooks/probe-sources/${state.hookId}`,
  );
  await check(page, "results");
  await page.keyboard.press("Escape");

  // Mappings of the UptimeRobot source: its one row, node ps-b.
  await row("ps-e2e robot").getByTestId("probe-source-actions").click();
  await page.getByTestId("probe-source-mappings").click();
  await expect(page.getByTestId("probe-source-mapping-row")).toHaveCount(1);
  await check(page, "mappings");
  await page.keyboard.press("Escape");

  // A new generic webhook source: URL and secret shown once, then listed as waiting.
  await page.getByTestId("probe-source-add").click();
  await page.getByTestId("probe-source-name-input").fill("ps-e2e ui");
  await pick(page, page.getByTestId("probe-source-provider"), "通用 Webhook");
  const created = page.waitForResponse((r) => r.url().includes("/rpc/probeSources/create"));
  await page.getByTestId("probe-source-submit").click();
  expect((await created).ok()).toBe(true);
  await expect(page.getByTestId("probe-source-webhook-secret")).toContainText("ewh_");
  await check(page, "created");
  await page.getByTestId("probe-source-close").click();
  await expect(row("ps-e2e ui").getByTestId("probe-source-waiting")).toBeVisible();
  // The secret is not shown again anywhere on the page.
  await expect(page.getByText(/ewh_[A-Za-z0-9_-]{20,}/)).toHaveCount(0);
  await row("ps-e2e ui").getByTestId("probe-source-actions").click();
  await page.getByTestId("probe-source-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(row("ps-e2e ui")).toHaveCount(0);

  // Modes: the cluster's own mode is external.
  const modes = page.getByTestId("probe-modes");
  await expect(modes.getByTestId("probe-mode-clusters")).toContainText("ps-e2e");
  await check(page, "modes");
  expect(pageErrors).toEqual([]);
});
