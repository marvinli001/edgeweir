import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, saved } from "./helpers";

/**
 * G18 in the browser. A site of its own, g18-ui-<run> (created here through the UI in the cluster
 * of .e2e/m6-upgrade-state.json), turns on WebP / AVIF conversion in the cache tab, is refused
 * settings outside the bounds before saving and keeps what it saved; img.g18.test, which
 * scripts/e2e-g18.mjs leaves converting with saved bytes before its cleanup, shows them in the
 * savings card. The site is removed at the end.
 */
const ADMIN = [
  process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
] as const;
const RUN = Date.now().toString(36);
const SITE = `g18-ui-${RUN}`;
const DOMAIN = `${SITE}.test`;
const UPGRADE_STATE = resolve("../../.e2e/m6-upgrade-state.json");
const CLUSTER_ID = existsSync(UPGRADE_STATE)
  ? (JSON.parse(readFileSync(UPGRADE_STATE, "utf8")) as { clusterId?: string }).clusterId
  : undefined;
const G18_STATE = resolve("../../.e2e/g18-state.json");

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g18-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 1280 px (${scheme})`,
    ).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g18-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)`,
      ),
      `${name}: a card or dialog wider than the page at 375 px (${scheme})`,
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

let siteId = "";

test("G18: conversion turns on in the cache tab, refuses bad settings and keeps what it saved", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(CLUSTER_ID ? `/sites?cluster=${CLUSTER_ID}` : "/sites");
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill(SITE);
  await page.getByLabel("域名", { exact: true }).fill(DOMAIN);
  await page.getByLabel("源站地址", { exact: true }).fill("g18-origin");
  await page.getByTestId("create-site-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  siteId = /\/sites\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  expect(siteId).not.toBe("");

  await page.goto(`/sites/${siteId}?tab=cache`);
  const card = page.getByTestId("image-convert-card");
  await expect(card).toBeVisible();
  // The cluster's nodes run image-convert-v1: nothing is locked.
  await expect(page.getByTestId("image-convert-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("image-convert-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("image-convert-webp-on")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("image-convert-avif-on")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("image-convert-webp-quality")).toHaveValue("80");
  await expect(page.getByTestId("image-convert-avif-quality")).toHaveValue("50");
  await check(page, "card-defaults");

  // No format: refused before saving, nothing sent.
  await page.getByTestId("image-convert-enabled").click();
  await page.getByTestId("image-convert-webp-on").click();
  await page.getByTestId("image-convert-save").click();
  await expect(card.getByText("至少选择一种格式")).toBeVisible();
  // A lower bound above the upper bound.
  await page.getByTestId("image-convert-webp-on").click();
  await page.getByTestId("image-convert-min-size").fill("2000");
  await page.getByTestId("image-convert-max-size").fill("1000");
  await page.getByTestId("image-convert-save").click();
  await expect(card.getByText("最小原图不能大于最大原图")).toBeVisible();
  await page.getByTestId("image-convert-max-size").fill("5000000");

  await page.getByTestId("image-convert-avif-on").click();
  await page.getByTestId("image-convert-avif-quality").fill("45");
  await page.getByTestId("image-convert-png").click();
  await page.getByTestId("image-convert-max-pixels").fill("8000000");
  await saved(page, page.getByTestId("image-convert-save"), "imageConvert/update");
  await page.reload();
  await expect(page.getByTestId("image-convert-enabled")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("image-convert-avif-on")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("image-convert-avif-quality")).toHaveValue("45");
  await expect(page.getByTestId("image-convert-png")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("image-convert-min-size")).toHaveValue("2000");
  await expect(page.getByTestId("image-convert-max-size")).toHaveValue("5000000");
  await expect(page.getByTestId("image-convert-max-pixels")).toHaveValue("8000000");
  await expect(page.getByTestId("image-savings-bytes")).toBeVisible();
  await check(page, "card-saved");
  expect(pageErrors).toEqual([]);
});

test("G18: the savings card shows what the nodes saved", async ({ page }) => {
  const pageErrors = errors(page);
  const state = JSON.parse(readFileSync(G18_STATE, "utf8")) as { siteId: string };
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.siteId}?tab=cache`);
  await expect(page.getByTestId("image-convert-enabled")).toHaveAttribute("aria-checked", "true");
  const bytes = page.getByTestId("image-savings-bytes");
  await expect(bytes).toBeVisible();
  await expect(bytes).not.toHaveText(/^0\s*B$/);
  await expect(page.getByTestId("image-savings-partial")).toHaveCount(0);
  await check(page, "savings");
  expect(pageErrors).toEqual([]);
});

test("G18: the site goes", async ({ page }) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  await page.getByTestId("site-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(page).toHaveURL(/\/sites$/);
  await page.goto(`/sites?q=${SITE}`);
  await expect(page.getByText("没有匹配的网站")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
