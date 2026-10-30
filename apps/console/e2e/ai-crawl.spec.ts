import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { errors, shots, signedIn, test } from "./helpers";

/**
 * AI crawl control in the browser, on the site scripts/e2e-ai-crawl.mjs leaves before its
 * cleanup (.e2e/ai-crawl-state.json): the overview shows GPTBot's requests as impersonated and
 * refused, ClaudeBot as unverifiable, the top paths; the settings card shows the site's actions,
 * the managed robots.txt preview and pay per crawl; the global card on /protection.
 */
const STATE = JSON.parse(readFileSync(resolve("../../.e2e/ai-crawl-state.json"), "utf8")) as {
  siteId: string;
};

test("AI crawlers: the overview counts the crawlers' requests", async ({ page }) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(`/sites/${STATE.siteId}?tab=crawlers`);
  const overview = page.getByTestId("ai-crawl-overview");
  await expect(overview).toBeVisible();
  await expect(page.getByTestId("ai-crawl-partial")).toHaveCount(0);
  const gpt = overview.locator('[data-testid="ai-crawl-crawler-row"][data-crawler="gptbot"]');
  await expect(gpt).toBeVisible();
  await expect(gpt.getByTestId("ai-crawl-crawler-requests")).not.toHaveText("0");
  await expect(gpt.getByTestId("ai-crawl-verification-failed")).toBeVisible();
  await expect(gpt.getByTestId("ai-crawl-verification-verified")).toHaveCount(0);
  const claude = overview.locator('[data-testid="ai-crawl-crawler-row"][data-crawler="claudebot"]');
  await expect(claude.getByTestId("ai-crawl-verification-unverifiable")).toBeVisible();
  await expect(page.getByTestId("ai-crawl-paths")).toContainText("/robots.txt");
  await expect(page.getByTestId("ai-crawl-summary")).toBeVisible();
  await shots(page, "ai-crawl", "overview");
  expect(pageErrors).toEqual([]);
});

test("AI crawlers: the settings card and the managed robots.txt preview", async ({ page }) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(`/sites/${STATE.siteId}?tab=crawlers`);
  const card = page.getByTestId("ai-crawl-settings-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("ai-crawl-unavailable")).toHaveCount(0);
  const preview = page.getByTestId("ai-crawl-robots-preview");
  await expect(preview).toContainText("# BEGIN Edgeweir managed content");
  await expect(preview).toContainText("User-agent: GPTBot");
  await expect(preview).toContainText("Content-Signal: ai-train=no");
  await expect(page.getByTestId("ai-crawl-price")).toHaveValue("0.01");
  await card.scrollIntoViewIfNeeded();
  await shots(page, "ai-crawl", "settings");
  expect(pageErrors).toEqual([]);
});

test("AI crawlers: the global card on the protection page", async ({ page }) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto("/protection");
  const card = page.getByTestId("ai-crawl-global-card");
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shots(page, "ai-crawl", "global");
  expect(pageErrors).toEqual([]);
});
