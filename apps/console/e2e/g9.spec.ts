import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, pick } from "./helpers";

/**
 * Written by scripts/e2e-g9.mjs: the default cluster listens on 8081, 8082 (HTTP) and 9443
 * (HTTPS) besides 80 and 443; ports.g9.test is bound to 8081 and 9443 with a 308 to 9443 that
 * leaves keep.g9.test alone; layer-4 applications g9-range (25000-25001) and g9-tls (TLS);
 * cluster g9-proxy takes client addresses from the PROXY protocol. Nothing here is saved.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g9-state.json"), "utf8")) as {
  clusterId: string;
  proxyClusterId: string;
  portsSiteId: string;
  rangeAppId: string;
  tlsAppId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g9-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g9-${name}-${scheme}-375.png`,
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

const row = (table: Locator, id: string) => table.locator(`[data-row-id="${id}"]`);

test("G9: listener ports and the client address of a cluster", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=network`);
  await expect(page.getByTestId("cluster-tab-network")).toHaveAttribute("aria-selected", "true");
  const ports = page.getByTestId("listen-ports");
  await expect(ports.getByTestId("listen-ports-http")).toHaveValue("8081, 8082");
  await expect(ports.getByTestId("listen-ports-https")).toHaveValue("9443");
  await expect(ports.getByTestId("listen-ports-unavailable")).toHaveCount(0);
  const save = ports.getByTestId("listen-ports-save");
  await expect(save).toBeDisabled();
  // 80 is always listened on: the list refuses it.
  await ports.getByTestId("listen-ports-http").fill("8081, 80");
  await expect(ports.getByTestId("listen-ports-invalid")).toBeVisible();
  await expect(save).toBeDisabled();
  await ports.getByTestId("listen-ports-http").fill("8081, 8082");
  await expect(save).toBeDisabled();

  const clientIp = page.getByTestId("client-ip");
  await expect(clientIp.getByTestId("client-ip-mode")).toHaveText("直连");
  await expect(clientIp.getByTestId("client-ip-drop")).toHaveAttribute("aria-checked", "false");
  await pick(page, clientIp.getByTestId("client-ip-mode"), "可信代理报头");
  await expect(clientIp.getByTestId("client-ip-cidrs")).toBeVisible();
  await expect(clientIp.getByTestId("client-ip-cidrs-invalid")).toBeVisible();
  await clientIp.getByTestId("client-ip-cidrs").fill("10.0.0.0/8\n192.0.2.7");
  await expect(clientIp.getByTestId("client-ip-cidrs-invalid")).toHaveCount(0);
  await pick(page, clientIp.getByTestId("client-ip-header"), "自定义");
  await clientIp.getByTestId("client-ip-header-name").fill("x-client-ip");
  await expect(clientIp.getByTestId("client-ip-save")).toBeEnabled();
  await check(page, "network");

  // The PROXY protocol cluster says what that means for its ports.
  await page.goto(`/clusters?cluster=${state.proxyClusterId}&tab=network`);
  await expect(page.getByTestId("client-ip").getByTestId("client-ip-mode")).toHaveText(
    "PROXY protocol",
  );
  await expect(page.getByTestId("client-ip-proxy-note")).toBeVisible();
  await check(page, "network-proxy");
  expect(pageErrors).toEqual([]);
});

test("G9: a site's ports and its HTTPS redirect", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.portsSiteId}?tab=domains`);
  const card = page.getByTestId("site-ports");
  for (const [port, checked] of [
    ["80", false],
    ["8081", true],
    ["8082", false],
  ] as const)
    await expect(card.getByTestId(`site-ports-http-${port}`)).toHaveAttribute(
      "aria-checked",
      String(checked),
    );
  for (const [port, checked] of [
    ["443", false],
    ["9443", true],
  ] as const)
    await expect(card.getByTestId(`site-ports-https-${port}`)).toHaveAttribute(
      "aria-checked",
      String(checked),
    );
  await expect(card.getByTestId("site-ports-https-note")).toHaveCount(0);
  const save = card.getByTestId("site-ports-save");
  await expect(save).toBeDisabled();
  await card.getByTestId("site-ports-http-80").click();
  await expect(save).toBeEnabled();
  await card.getByTestId("site-ports-http-80").click();
  await expect(save).toBeDisabled();
  await check(page, "site-ports");

  await page.goto(`/sites/${state.portsSiteId}?tab=https`);
  const redirect = page.getByTestId("https-redirect");
  await expect(redirect).toBeVisible();
  await expect(redirect.locator("#redirectStatus")).toHaveText("308");
  await expect(redirect.locator("#redirectPort")).toHaveText("9443");
  await expect(redirect.getByTestId("https-redirect-excluded-keep.g9.test")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(redirect.getByTestId("https-redirect-excluded-ports.g9.test")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("https-redirect-unavailable")).toHaveCount(0);
  await check(page, "https");
  expect(pageErrors).toEqual([]);
});

test("G9: layer-4 port ranges, origins on the arriving port and TLS", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/l4?cluster=${state.clusterId}`);
  const table = page.getByTestId("l4-apps-table");
  await expect(row(table, state.rangeAppId).getByTestId("l4-app-port")).toHaveText("25000-25001");
  await row(table, state.rangeAppId).getByTestId("l4-app-actions").click();
  await page.getByTestId("l4-app-edit").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("l4-app-port-end")).toHaveValue("25001");
  await expect(dialog.getByTestId("l4-app-origin-port-mode")).toHaveText("固定");
  await pick(page, dialog.getByTestId("l4-app-origin-port-mode"), "同号");
  await expect(dialog.getByTestId("l4-origin-port")).toBeDisabled();
  await dialog.getByTestId("l4-app-port-end").fill("26100");
  await expect(dialog.getByTestId("l4-app-port-end-invalid")).toBeVisible();
  await expect(dialog.getByTestId("l4-app-v2-unavailable")).toHaveCount(0);
  await check(page, "l4-dialog");
  await page.keyboard.press("Escape");

  await page.goto(`/l4/${state.tlsAppId}`);
  await expect(page.getByTestId("l4-app-tls")).toContainText("g9-ports");
  await check(page, "l4-tls");

  // Kernel bans match the TCP peer: behind the balancer that is not the client.
  await page.goto("/bans");
  await expect(page.getByTestId("bans-kernel-peer-note")).toContainText("g9-proxy");
  await check(page, "bans");
  expect(pageErrors).toEqual([]);
});
