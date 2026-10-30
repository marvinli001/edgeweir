import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { errors, saved, shots, signedIn, test } from "./helpers";

/**
 * Development mode in the browser, on dev-mode.test that the dev-mode section of scripts/e2e.sh
 * leaves off (.e2e/dev-mode-state.json): the cache tab's card turns it on, shows the time left
 * and the site header its badge (the overview and the sites list too); turning it off removes them.
 */
const STATE = resolve("../../.e2e/dev-mode-state.json");

test("development mode: the card turns it on with the time left and a badge, and off again", async ({
  page,
}) => {
  const pageErrors = errors(page);
  const { siteId } = JSON.parse(readFileSync(STATE, "utf8")) as { siteId: string };
  await signedIn(page);
  await page.goto(`/sites/${siteId}?tab=cache`);
  const toggle = page.getByTestId("dev-mode-switch");
  await expect(page.getByTestId("dev-mode-card")).toBeVisible();
  await expect(page.getByTestId("dev-mode-unavailable")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("site-header-dev-mode")).toHaveCount(0);

  await saved(page, toggle, "developmentMode/set");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("dev-mode-left")).toBeVisible();
  await expect(page.getByTestId("dev-mode-note")).toBeVisible();
  await expect(page.getByTestId("site-header-dev-mode")).toHaveText("开发模式");
  await shots(page, "dev-mode", "on");
  // The overview's status row and the sites list carry the badge too.
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByTestId("site-dev-mode")).toBeVisible();
  await page.goto("/sites?q=dev-mode.test");
  await expect(page.getByTestId("site-dev-mode")).toBeVisible();

  await page.goto(`/sites/${siteId}?tab=cache`);
  await expect(page.getByTestId("site-header-dev-mode")).toBeVisible();
  await saved(page, page.getByTestId("dev-mode-switch"), "developmentMode/set");
  await expect(page.getByTestId("dev-mode-switch")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("dev-mode-left")).toHaveCount(0);
  await expect(page.getByTestId("site-header-dev-mode")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
