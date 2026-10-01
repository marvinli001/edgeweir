import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g7.mjs on the upgrade cluster (both nodes report l4-v1, its DNS is on):
 * the port pools it saved (TCP and UDP 20000-20020) and the L4 apps it keeps, among them `tcp`
 * (with connections, refused connections and bytes in its statistics) and `udp`; `proxy` (or
 * `v1`) sends PROXY protocol v1 to its origin. Every test leaves them as it found them; an app
 * left behind by a failed run is named "g7-…", which the script's cleanup deletes.
 */
type AppRef = { id: string; name: string; port: number };
type Pool = { protocol: "tcp" | "udp" | "both"; from: number; to: number };
const state = JSON.parse(readFileSync(resolve("../../.e2e/g7-state.json"), "utf8")) as {
  clusterId: string;
  pools: Pool[];
  apps: { tcp: AppRef; udp: AppRef; proxy?: AppRef; v1?: AppRef } & Record<string, AppRef>;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const UI_APP = "g7-ui-app";
/** Outside every pool of the cluster, then a free port inside the TCP pool. */
const OUTSIDE_PORT = 30000;
const FREE_PORT = 20010;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g7-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g7-${name}-${scheme}-375.png`,
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

/** Waits for the answer of one RPC that `act` triggers; a reload before it could read old data. */
async function answered(page: Page, procedure: string, act: () => Promise<void>) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes(`/rpc/${procedure}`),
  );
  await act();
  return response;
}

/** Clicks a save button and waits for its RPC to succeed. */
async function saved(page: Page, save: Locator, procedure: string) {
  expect((await answered(page, procedure, () => save.click())).ok()).toBe(true);
}

/** Clicks a save button and waits for its RPC to be refused. */
async function refused(page: Page, save: Locator, procedure: string) {
  expect((await answered(page, procedure, () => save.click())).ok()).toBe(false);
}

const row = (table: Locator, id: string) => table.locator(`[data-row-id="${id}"]`);
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("G7: port pools are edited on the cluster page and an overlapping pool is refused inline", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=ports`);
  await expect(page.getByTestId("cluster-tab-ports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("cluster-tab-ports")).toHaveText("端口池");
  const card = page.getByTestId("port-pools");
  const rows = card.getByTestId("port-pool-row");
  const save = card.getByTestId("port-pools-save");

  await test.step("the saved pools and the reserved listener ports", async () => {
    await expect(rows).toHaveCount(state.pools.length);
    for (const [index, pool] of state.pools.entries()) {
      await expect(rows.nth(index).getByTestId("port-pool-from")).toHaveValue(String(pool.from));
      await expect(rows.nth(index).getByTestId("port-pool-to")).toHaveValue(String(pool.to));
    }
    await expect(card.getByTestId("port-pools-reserved").locator('[data-port="80"]')).toHaveText(
      "80",
    );
    await expect(page.getByTestId("l4-nodes-without-l4")).toHaveCount(0);
    await expect(save).toBeDisabled();
  });
  await check(page, "port-pools");

  await test.step("a pool overlapping the TCP pool is refused and marked", async () => {
    await card.getByTestId("port-pool-add").click();
    await expect(rows).toHaveCount(state.pools.length + 1);
    const added = rows.last();
    await pick(page, added.getByTestId("port-pool-protocol"), "TCP + UDP");
    await added.getByTestId("port-pool-from").fill("20015");
    await added.getByTestId("port-pool-to").fill("20030");
    await expect(save).toBeEnabled();
    await refused(page, save, "clusters/setPortPools");
    await expect(card.getByTestId("port-pools-error")).toContainText("端口池重叠");
    await expect(added).toHaveAttribute("data-invalid", "true");
    await check(page, "port-pools-refused");
  });

  await test.step("a separate TCP pool is saved, then removed again", async () => {
    const added = rows.last();
    await pick(page, added.getByTestId("port-pool-protocol"), "TCP");
    await added.getByTestId("port-pool-from").fill("21000");
    await added.getByTestId("port-pool-to").fill("21010");
    await expect(card.getByTestId("port-pools-error")).toHaveCount(0);
    await saved(page, save, "clusters/setPortPools");
    await page.reload();
    // Sorted by first port: the new pool comes last.
    await expect(rows).toHaveCount(state.pools.length + 1);
    await expect(rows.last().getByTestId("port-pool-from")).toHaveValue("21000");
    await expect(rows.last().getByTestId("port-pool-to")).toHaveValue("21010");
    await expect(rows.last().getByTestId("port-pool-protocol")).toHaveText("TCP");
    await rows.last().getByTestId("port-pool-remove").click();
    await saved(page, save, "clusters/setPortPools");
    await page.reload();
    await expect(rows).toHaveCount(state.pools.length);
    await expect(save).toBeDisabled();
  });
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G7: the L4 apps list shows the e2e apps with their ports and DNS targets", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  await test.step("the sites section leads to the L4 apps; the sidebar fits 800 px", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId("nav-sites").click();
    await expect(page.getByTestId("page-title")).toHaveText("网站");
    await page.getByTestId("sites-tab-l4").click();
    await expect(page).toHaveURL(/\/l4$/);
    await expect(page.getByTestId("page-title")).toHaveText("四层转发");
    await expect(page.getByTestId("sites-tab-l4")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("nav-sites")).toHaveAttribute("data-active");
    const sidebar = page.locator("[data-slot=sidebar-content]");
    await expect(sidebar).toBeVisible();
    const overflow = await sidebar.evaluate(
      (element: { scrollHeight: number; clientHeight: number }) =>
        element.scrollHeight - element.clientHeight,
    );
    expect(overflow, "the sidebar scrolls at 800 px").toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await page.goto(`/l4?cluster=${state.clusterId}`);
  const table = page.getByTestId("l4-apps-table");

  await test.step("TCP and UDP apps with protocol, port, origins and DNS target", async () => {
    for (const [key, protocol] of [
      ["tcp", "TCP"],
      ["udp", "UDP"],
    ] as const) {
      const app = state.apps[key];
      const line = row(table, app.id);
      await expect(line.getByTestId("l4-app-link")).toHaveText(app.name);
      await expect(line.getByTestId("l4-app-protocol")).toHaveText(protocol);
      await expect(line.getByTestId("l4-app-port")).toHaveText(String(app.port));
      await expect(line.getByTestId("l4-app-origins")).toHaveAttribute("data-count", /^[1-9]\d*$/);
      // `<app id>.<the cluster's DNS domain>`.
      await expect(line.getByTestId("l4-app-dns")).toHaveText(
        new RegExp(`^${literal(app.id)}\\.\\S+$`),
      );
      await expect(line.getByTestId("l4-app-enabled")).toHaveAttribute("aria-checked", "true");
    }
  });
  await check(page, "l4-list");

  await test.step("switching an app off asks first; cancelled, it stays on", async () => {
    const toggle = row(table, state.apps.udp.id).getByTestId("l4-app-enabled");
    await toggle.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(`停用 L4 应用 ${state.apps.udp.name}？`);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  await test.step("a UDP app's editor offers no PROXY protocol", async () => {
    await row(table, state.apps.udp.id).getByTestId("l4-app-actions").click();
    await page.getByTestId("l4-app-edit").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("编辑 L4 应用");
    await expect(dialog.getByTestId("l4-app-name")).toHaveValue(state.apps.udp.name);
    await expect(dialog.getByTestId("l4-app-port")).toHaveValue(String(state.apps.udp.port));
    await expect(dialog.getByTestId("l4-app-proxy-udp")).toHaveText("UDP 不支持 PROXY protocol");
    await expect(dialog.getByTestId("l4-app-proxy-send")).toBeDisabled();
    await expect(dialog.getByTestId("l4-app-proxy-accept")).toBeDisabled();
    await expect(dialog.getByTestId("l4-app-pools-hint")).toContainText("20000–20020");
    await check(page, "l4-edit");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G7: an L4 app is created in the UI, a port outside the pools refused, and deleted", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/l4?cluster=${state.clusterId}`);
  const table = page.getByTestId("l4-apps-table");
  await expect(row(table, state.apps.tcp.id)).toBeVisible();
  const added = table.getByRole("row").filter({
    has: page.getByTestId("l4-app-link").filter({ hasText: new RegExp(`^${UI_APP}$`) }),
  });

  const remove = async () => {
    await added.getByTestId("l4-app-actions").click();
    await page.getByTestId("l4-app-delete").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(`删除 L4 应用 ${UI_APP}？`);
    await saved(page, dialog.getByTestId("confirm-action"), "l4Apps/delete");
    await expect(added).toHaveCount(0);
  };
  // Left behind by a failed run, it would hold the port.
  if (await added.count()) await remove();

  await test.step("the form shows the pools; a port outside them is refused next to the port", async () => {
    await page.getByTestId("l4-create").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("新建 L4 应用");
    await dialog.getByTestId("l4-app-name").fill(UI_APP);
    await expect(dialog.getByTestId("l4-app-protocol-select")).toHaveText("TCP");
    await dialog.getByTestId("l4-app-port").fill(String(OUTSIDE_PORT));
    await expect(dialog.getByTestId("l4-app-pools-hint")).toHaveAttribute("data-outside", "true");
    await dialog.getByTestId("l4-origin-address").first().fill("l4-origin-a");
    await dialog.getByTestId("l4-origin-port").first().fill("7000");
    await expect(dialog.getByTestId("l4-app-idle-timeout")).toHaveValue("600");

    // UDP takes no PROXY protocol and a shorter idle timeout; back to TCP.
    await pick(page, dialog.getByTestId("l4-app-protocol-select"), "UDP");
    await expect(dialog.getByTestId("l4-app-proxy-udp")).toBeVisible();
    await expect(dialog.getByTestId("l4-app-idle-timeout")).toHaveValue("30");
    await pick(page, dialog.getByTestId("l4-app-protocol-select"), "TCP");
    await expect(dialog.getByTestId("l4-app-proxy-udp")).toHaveCount(0);
    await expect(dialog.getByTestId("l4-app-idle-timeout")).toHaveValue("600");
    await check(page, "l4-create");

    await refused(page, dialog.getByTestId("l4-app-submit"), "l4Apps/create");
    await expect(dialog.getByTestId("l4-app-port-error")).toHaveText(
      `端口 ${OUTSIDE_PORT} 不在集群此协议的端口池内`,
    );
    await check(page, "l4-create-refused");
  });

  await test.step("a free port inside the pool is accepted", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("l4-app-port").fill(String(FREE_PORT));
    await expect(dialog.getByTestId("l4-app-port-error")).toHaveCount(0);
    await expect(dialog.getByTestId("l4-app-pools-hint")).not.toHaveAttribute("data-outside");
    await saved(page, dialog.getByTestId("l4-app-submit"), "l4Apps/create");
    await expect(dialog).toBeHidden();
    await expect(added.getByTestId("l4-app-protocol")).toHaveText("TCP");
    await expect(added.getByTestId("l4-app-port")).toHaveText(String(FREE_PORT));
    await expect(added.getByTestId("l4-app-origins")).toHaveAttribute("data-count", "1");
    await expect(added.getByTestId("l4-app-enabled")).toHaveAttribute("aria-checked", "true");
    await expect(added.getByTestId("l4-app-dns")).toHaveText(/^[0-9a-f-]{36}\.\S+$/);
  });

  await test.step("deleted with confirmation", remove);
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G7: an L4 app's statistics show its connections, traffic and nodes", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  const app = state.apps.tcp;
  await page.goto(`/l4/${app.id}`);
  await expect(page.getByTestId("page-title")).toHaveText(app.name);
  const overview = page.getByTestId("l4-app-overview");

  await test.step("the overview names the listener, the DNS target and the origins", async () => {
    await expect(page.getByTestId("l4-tab-overview")).toHaveAttribute("aria-selected", "true");
    const listen = overview.getByTestId("l4-app-listen");
    await expect(listen.getByTestId("l4-app-protocol")).toHaveText("TCP");
    await expect(listen).toContainText(String(app.port));
    await expect(overview.getByTestId("l4-app-dns")).toHaveText(
      new RegExp(`^${literal(app.id)}\\.\\S+$`),
    );
    await expect(overview.getByTestId("l4-app-origin").first()).toBeVisible();
    await expect(overview.getByTestId("l4-app-state")).toContainText("已启用");
  });
  await check(page, "l4-app");

  await test.step("connections, refused connections and bytes over 6 hours, per node", async () => {
    await page.getByTestId("l4-tab-stats").click();
    await expect(page).toHaveURL(/tab=stats/);
    // The minute statistics are kept 7 days: no 30-day range.
    await page.getByTestId("analytics-range").click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(4);
    await expect(page.getByTestId("range-30d")).toHaveCount(0);
    await page.getByTestId("range-6h").click();
    await expect(page).toHaveURL(/range=6h/);
    const value = (counter: string) =>
      page.getByTestId(`l4-stat-${counter}`).locator("[data-slot=metric-value]");
    for (const counter of ["connections", "refused", "bytesReceived", "bytesSent"])
      await expect(value(counter)).toHaveAttribute("data-value", /^[1-9]\d*$/, {
        timeout: 60_000,
      });
    await expect(page.getByTestId("l4-stats-connections-chart")).toBeVisible();
    await expect(page.getByTestId("l4-stats-traffic-chart")).toBeVisible();
    const nodes = page.getByTestId("l4-stats-nodes");
    await expect(nodes.getByTestId("l4-stats-node-name").first()).toBeVisible();
    await expect(nodes.getByTestId("l4-stats-node-connections").first()).toHaveText(/[1-9]/);
  });
  await check(page, "l4-stats");

  const proxy = state.apps.proxy ?? state.apps.v1;
  if (proxy) {
    await test.step("an app with PROXY protocol says how it uses it", async () => {
      await page.goto(`/l4/${proxy.id}`);
      await expect(overview.getByTestId("l4-app-proxy")).toHaveText(/^(接受|发送 v[12])/);
    });
  }
  await logout(page);
  expect(pageErrors).toEqual([]);
});
