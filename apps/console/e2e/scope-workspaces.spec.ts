import type { Node } from "@edgeweir/contract";
import { expect } from "@playwright/test";
import { errors, shots, signedIn, test } from "./helpers";

test("the site scope works in the rail, command menu and phone drawer", async ({ page }) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto("/sites?sort=name");
  const site = page.getByTestId("site-link").first();
  await expect(site).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(`(() => {
    const samples = [];
    const measure = () => {
      for (const layer of document.querySelectorAll('[data-slot="sidebar-scope-layer"]')) {
        if (layer.getBoundingClientRect().width) samples.push(getComputedStyle(layer).transform);
      }
      if (samples.length < 180) requestAnimationFrame(measure);
    };
    requestAnimationFrame(measure);
    Object.assign(window, { scopeSamples: samples });
  })()`);
  await site.click();
  await expect(page.getByTestId("site-nav-overview")).toHaveAttribute("aria-current", "page");
  const sampled = await page.evaluate<string[]>("window.scopeSamples");
  expect(sampled.length).toBeGreaterThan(2);
  expect([...new Set(sampled)]).toEqual(["none"]);

  await page.keyboard.press("Control+k");
  const command = page.getByTestId("command-menu");
  await expect(command.getByText(/^当前站点 · /)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByTestId("sidebar-collapse").click();
  const rail = page.locator('[data-slot="sidebar"][data-rail]');
  await expect(rail).toBeVisible();
  const group = rail.getByTestId("site-nav-observability");
  await group.press("Enter");
  const logs = page.getByRole("menuitem", { name: "访问日志", exact: true });
  await expect(logs).toBeVisible();
  await logs.press("Enter");
  await expect(page).toHaveURL(/\/logs\?/);
  await group.press("Enter");
  await expect(logs).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(group).toBeFocused();
  await page.getByTestId("sidebar-collapse").click();
  await page.getByTestId("site-nav-overview").click();
  await shots(page, "scope", "site");

  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByTestId("nav-menu").click();
      const drawer = page.locator('[data-slot="drawer-content"]');
      await expect(drawer.getByTestId("site-nav-overview")).toHaveAttribute("aria-current", "page");
      await expect(drawer.getByTestId("site-nav-switcher")).toBeVisible();
      expect(await page.evaluate("document.documentElement.scrollWidth")).toBe(width);
      await page.screenshot({
        path: `../../.e2e/scope-site-directory-${scheme}-${width}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId("site-nav-back").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sites\?sort=name$/);
  await expect(page.getByTestId("nav-sites")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-sites")).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("node detail links preserve the list and show online, offline and retiring states", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await signedIn(page);
  const response = await page.request.post("/rpc/nodes/list", {
    headers: { "x-csrf-token": "orpc" },
    data: { json: {} },
  });
  expect(response.ok()).toBe(true);
  const { json: nodes } = (await response.json()) as { json: Node[] };
  const online = nodes.find((node) => node.online);
  expect(online).toBeDefined();
  if (!online) throw new Error("Expected an enrolled online node");
  const source = `/clusters?cluster=${online.clusterId}&sort=name`;
  await page.goto(source);
  await page.getByTestId("node-open").filter({ hasText: online.name }).click();
  await expect(page.getByTestId("page-title")).toHaveText(online.name);
  await expect(page.getByTestId("node-nav-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("node-detail-state")).toHaveText("在线");
  await shots(page, "scope", "node");
  const old = `/clusters?node=${online.id}&nodeTab=logs&view=regions&sort=name`;
  await page.goto(old);
  await expect(page).toHaveURL(new RegExp(`/clusters/nodes/${online.id}/logs\\?`));
  await expect(page.getByTestId("node-nav-logs")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("node-nav-back").click();
  await expect(page).toHaveURL(/\/clusters\?view=regions&sort=name$/);

  const offline: Node = {
    ...online,
    id: "00000000-0000-4000-8000-000000000201",
    name: "scope-offline",
    online: false,
    metrics: null,
  };
  const retiring: Node = {
    ...online,
    id: "00000000-0000-4000-8000-000000000202",
    name: "scope-retiring",
    decommissionRequestedAt: new Date().toISOString(),
  };
  await page.route("**/rpc/nodes/get**", (route) => {
    const input = route.request().postDataJSON() as { json: { id: string } } | null;
    const node = [offline, retiring].find((node) => node.id === input?.json.id);
    return node ? route.fulfill({ json: { json: node } }) : route.continue();
  });
  await page.goto(`/clusters/nodes/${offline.id}`);
  await expect(page.getByTestId("node-detail-state")).toHaveText("离线");
  await expect(page.getByTestId("node-metrics-none")).toBeVisible();
  await page.goto(`/clusters/nodes/${retiring.id}`);
  await expect(page.getByTestId("node-detail-state")).toHaveText("退役中");
  await expect(page.getByTestId("node-decommission-waiting")).toBeVisible();
  await page.getByTestId("node-detail-actions").click();
  await expect(page.getByTestId("node-decommission-cancel")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
