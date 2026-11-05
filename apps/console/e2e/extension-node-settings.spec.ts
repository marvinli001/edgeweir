import { createHash } from "node:crypto";
import {
  EXTENSION_SECRET_MASK,
  type ExtensionDetail,
  type ExtensionNodeSettings,
  extensionManifest,
  type Site,
  type SiteExtensionView,
} from "@edgeweir/contract";
import { expect, type Locator, type Page } from "@playwright/test";
import { clusters, nodes } from "../lab/fixtures/world";
import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh-CN.json" with { type: "json" };
import { readArchive } from "../src/server/lib/extension-package";
import { PACKAGE, ustar } from "../test/server/extension-fixtures";
import { nodeExtensionManifest } from "../test/server/extension-node-fixtures";
import { errors, pick, signedIn, test } from "./helpers";

// UI-only RPC stand-ins do not establish real package delivery or Node listener support.
const nodeManifest = extensionManifest.parse(nodeExtensionManifest("node-status"));
const oldManifest = extensionManifest.parse(
  JSON.parse(
    Buffer.from(
      readArchive(PACKAGE).find((file) => file.path === "manifest.json")?.data ?? [],
    ).toString(),
  ),
);
const detail = (manifest: typeof nodeManifest, bytes: Buffer = PACKAGE): ExtensionDetail => ({
  id: manifest.id,
  scope: manifest.scope,
  name: manifest.name,
  version: manifest.version,
  publisher: manifest.publisher,
  enabled: false,
  failureMode: "open",
  sites: 0,
  nodesLoaded: 0,
  nodesFailing: 0,
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  manifest,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  config: {},
  versions: [],
  siteList: [],
  nodes: [],
  ruleReferences: 0,
  secretVersion: 0,
});

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function nextTarget(page: Page, current: string, next: string) {
  await page.getByTestId("extension-node-targets").click();
  const selected = page.getByRole("option", { name: current, exact: true });
  await expect(selected).toBeVisible();
  await expect(selected).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: next, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extension-node-targets")).toHaveText(next);
}

for (const locale of ["zh-CN", "en"] as const) {
  test(`node settings UI stand-in: drafts, keyboard, targets, failures and Saved on mobile (${locale})`, async ({
    page,
  }) => {
    const copy = locale === "en" ? en : zh;
    const discard = page.getByRole("dialog", { name: copy.unsaved_leave_title, exact: true });
    const pageErrors = errors(page);
    await signedIn(page);
    await page.evaluate((locale) => {
      localStorage.setItem("PARAGLIDE_LOCALE", locale);
      localStorage.removeItem("theme");
    }, locale);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const nodeDetail = detail(
      nodeManifest,
      ustar({
        "manifest.json": JSON.stringify(nodeExtensionManifest("node-status")),
        "lua/main.lua": "return {init=function(ew) end, listen=function(ew) end}",
      }),
    );
    const siteDetail = detail(oldManifest);
    let settings: ExtensionNodeSettings = { listeners: {}, clusterIds: null };
    let failRead = true;
    let failCheck = true;
    let failSave = true;
    let checks = 0;
    const saves: ExtensionNodeSettings[] = [];
    const readGate = Promise.withResolvers<void>();
    const cluster = clusters[0] as (typeof clusters)[number];
    const view = (value = settings) => ({
      id: nodeManifest.id,
      settings: value,
      targetClusterIds: value.clusterIds ?? clusters.map((cluster) => cluster.id),
    });
    await page.route("**/rpc/extensions/list**", (route) =>
      route.fulfill({ json: { json: [nodeDetail, siteDetail] } }),
    );
    await page.route("**/rpc/extensions/get**", (route) => {
      const input = route.request().postDataJSON().json as { id: string };
      return route.fulfill({
        json: { json: input.id === oldManifest.id ? siteDetail : nodeDetail },
      });
    });
    await page.route("**/rpc/clusters/list**", (route) =>
      route.fulfill({ json: { json: clusters } }),
    );
    const targetNodes = nodes.slice(0, 4).map((node, index) => ({
      ...node,
      name: ["api2-only", "unknown-node", "failed-node", "feature-node"][index],
      clusterId: cluster.id,
      status: "active",
      online: index !== 1,
      lastSeenAt: index === 1 ? null : new Date().toISOString(),
      supportedFeatures:
        index === 0
          ? ["extensions-v1", "extensions-v2"]
          : ["extensions-v1", "extensions-v2", "extensions-node-v1"],
      applyState: index === 2 ? "failed" : null,
      applyMessage: index === 2 ? "fixture apply failure" : "",
      appliedContentHash: index === 3 ? "a".repeat(64) : "",
    }));
    await page.route("**/rpc/nodes/list**", (route) =>
      route.fulfill({ json: { json: targetNodes } }),
    );
    await page.route("**/rpc/extensions/nodeSettings**", async (route) => {
      await readGate.promise;
      return failRead
        ? route.fulfill({ status: 503, body: "unavailable" })
        : route.fulfill({ json: { json: view() } });
    });
    await page.route("**/rpc/extensions/checkNodeSettings**", (route) => {
      checks++;
      const input = route.request().postDataJSON().json as { settings: ExtensionNodeSettings };
      return failCheck
        ? route.fulfill({ status: 503, body: "unavailable" })
        : route.fulfill({ json: { json: view(input.settings) } });
    });
    await page.route("**/rpc/extensions/updateNodeSettings**", (route) => {
      const input = route.request().postDataJSON().json as { settings: ExtensionNodeSettings };
      saves.push(input.settings);
      if (failSave) return route.fulfill({ status: 503, body: "unavailable" });
      settings = input.settings;
      return route.fulfill({ json: { json: view() } });
    });
    await page.goto("/system?tab=extensions");
    const row = page.getByTestId("extensions-table").locator('[data-row-id="node-status"]');
    await expect(row).toContainText(copy.extensions_scope_node);
    await expect(
      page.getByTestId("extensions-table").locator('[data-row-id="hello-header"]'),
    ).toContainText(copy.extensions_scope_site);
    await row.getByTestId("extension-open").click();
    const sheet = page.getByTestId("extension-detail");
    await expect(sheet.getByText(copy.common_loading, { exact: true })).toBeVisible();
    readGate.resolve();
    await expect(sheet.getByRole("button", { name: copy.common_retry, exact: true })).toBeVisible();
    failRead = false;
    await sheet.getByRole("button", { name: copy.common_retry, exact: true }).click();
    const listener = sheet.getByTestId("extension-listener-status");
    const enabled = listener.getByTestId("extension-listener-status-enabled");
    const port = listener.getByLabel(copy.extensions_node_port, { exact: true });
    const binding = listener.getByTestId("extension-listener-status-binding");
    const summary = binding.locator("summary");
    const bind = listener.getByLabel(copy.extensions_node_bind, { exact: true });
    const allow = listener.getByLabel(copy.extensions_node_allow, { exact: true });
    const save = sheet.getByTestId("extension-node-save");
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await expect(port).toBeHidden();
    await expect(port).toHaveValue("");
    await expect(listener).toContainText("9145");
    await expect(listener.locator("dl")).toContainText("GET");
    await expect(listener.locator("dl")).toContainText("0");
    await expect(save).toBeDisabled();
    const targets = sheet.getByTestId("extension-target-node");
    await expect(targets.filter({ hasText: "api2-only" })).toContainText(
      copy.extensions_node_unsupported,
    );
    await expect(targets.filter({ hasText: "api2-only" })).toContainText("extensions-node-v1");
    await expect(targets.filter({ hasText: "unknown-node" })).toContainText(
      copy.extensions_node_unknown,
    );
    await expect(targets.filter({ hasText: "failed-node" })).toContainText(
      copy.extensions_node_failed,
    );
    await expect(targets.filter({ hasText: "feature-node" })).toContainText(
      copy.extensions_node_features_reported,
    );
    await expect(targets.filter({ hasText: "feature-node" })).toContainText("a".repeat(64));

    await tabTo(page, enabled);
    await page.keyboard.press("Space");
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Tab");
    await expect(port).toBeFocused();
    await port.fill("9146");
    await page.keyboard.press("Tab");
    await expect(summary).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(bind).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(allow).toBeFocused();
    await allow.fill("not-an-ip");
    const original = await allow.elementHandle();
    await summary.click();
    await sheet.getByTestId("extension-node-check").click();
    await expect(binding).toHaveAttribute("open", "");
    await expect(allow).toBeFocused();
    expect(checks).toBe(0);
    const longAllow = Array.from({ length: 64 }, (_, index) => `10.0.0.${index}/32`).join("\n");
    await allow.fill(longAllow);
    await expect
      .poll(() => allow.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await sheet.getByTestId("extension-node-check").click();
    await expect(sheet.getByTestId("extension-node-error")).toBeVisible();
    await expect(allow).toHaveValue(longAllow);
    expect(await allow.evaluate((element, previous) => element === previous, original)).toBe(true);
    failCheck = false;
    await sheet.getByTestId("extension-node-check").click();
    await expect(sheet).toContainText(copy.extensions_node_checked);
    await save.click();
    await expect(sheet.getByTestId("extension-node-error")).toBeVisible();
    await expect(port).toHaveValue("9146");
    await expect(allow).toHaveValue(longAllow);
    expect(await allow.evaluate((element, previous) => element === previous, original)).toBe(true);
    failSave = false;
    await save.click();
    await expect(save).toBeDisabled();
    expect(await allow.evaluate((element, previous) => element === previous, original)).toBe(true);
    expect(settings.clusterIds).toBeNull();
    expect(settings.listeners.status?.port).toBe(9146);
    const notice = page.locator('[data-type="success"]').filter({ hasText: copy.common_saved });
    await expect(notice).toBeVisible();
    await expect(sheet.getByTestId("extension-target-nodes")).toBeVisible();
    await expect(notice).toHaveCount(0, { timeout: 15_000 });

    await nextTarget(page, copy.extensions_node_targets_all, copy.extensions_node_targets_selected);
    await save.click();
    await expect(sheet.getByTestId("extension-node-error")).toHaveText(
      copy.extensions_node_select_cluster,
    );
    expect(saves).toHaveLength(2);
    await nextTarget(
      page,
      copy.extensions_node_targets_selected,
      copy.extensions_node_targets_none,
    );
    await save.click();
    await expect(save).toBeDisabled();
    expect(settings.clusterIds).toEqual([]);
    await expect(sheet.getByTestId("extension-target-nodes")).toContainText(copy.nodes_empty_title);
    await pick(
      page,
      page.getByTestId("extension-node-targets"),
      copy.extensions_node_targets_selected,
    );
    await listener.getByTestId("extension-listener-status-enabled").click();
    await sheet.getByRole("checkbox", { name: cluster.name }).click();
    await save.click();
    await expect(save).toBeDisabled();
    expect(settings.clusterIds).toEqual([cluster.id]);
    expect(settings.listeners.status).toBeNull();
    await enabled.click();
    await expect(port).toHaveValue("9146");
    await expect(allow).toHaveValue(longAllow);
    await summary.click();
    await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(port).toHaveValue("9146");
    await targets.filter({ hasText: "feature-node" }).getByRole("link").click();
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(port).toHaveValue("9146");
    await expect(page).toHaveURL(/system\?tab=extensions/);

    await expect(page.locator('[data-type="success"]')).toHaveCount(0, { timeout: 15_000 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect
        .poll(() =>
          page.evaluate(
            'document.querySelector(\'[data-testid="extension-detail"]\').getAnimations({ subtree: true }).filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity).length',
          ),
        )
        .toBe(0);
      await save.scrollIntoViewIfNeeded();
      await save.click({ trial: true });
      expect(
        await save.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [0.2, 0.5, 0.8].every((fraction) =>
            element.contains(
              element.ownerDocument.elementFromPoint(
                bounds.x + bounds.width * fraction,
                bounds.y + bounds.height / 2,
              ),
            ),
          );
        }),
      ).toBe(true);
      expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
        true,
      );
      await page.screenshot({
        path: `../../.e2e/extension-node-settings-${locale}-${colorScheme}-375.png`,
      });
    }
    await page.mouse.move(0, 0);
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCount(0, { timeout: 15_000 });
    await expect(save).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page
      .getByTestId("extensions-table")
      .locator('[data-row-id="hello-header"]')
      .getByTestId("extension-open")
      .click();
    await expect(sheet.getByTestId("extension-node-settings")).toHaveCount(0);
    const greeting = sheet.getByTestId("extension-config-greeting");
    await expect(greeting).toHaveValue("hello");
    await greeting.fill("still a site draft");
    await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(greeting).toHaveValue("still a site draft");
    await page.keyboard.press("Escape");
    await discard.getByTestId("confirm-action").click();
    await expect(sheet).toBeHidden();
    await page.getByTestId("system-tab-general").click();
    await expect(page).not.toHaveURL(/tab=extensions/);
    expect(pageErrors).toEqual([]);
  });

  test(`site extension UI stand-in: global and site secrets keep failed drafts and remask after saving (${locale})`, async ({
    page,
  }) => {
    const pageErrors = errors(page);
    await signedIn(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate((locale) => localStorage.setItem("PARAGLIDE_LOCALE", locale), locale);
    const secretSchema = {
      type: "object",
      properties: { credential: { type: "string", "x-secret": true } },
    };
    const manifest = extensionManifest.parse({
      ...oldManifest,
      config: { global: secretSchema, site: secretSchema },
    });
    let globalDetail = {
      ...detail(
        manifest,
        ustar({ "manifest.json": JSON.stringify(manifest), "lua/main.lua": "return {}" }),
      ),
      config: { credential: EXTENSION_SECRET_MASK },
    };
    let siteView: SiteExtensionView = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      installedEnabled: true,
      enabled: true,
      config: { credential: EXTENSION_SECRET_MASK },
      schema: manifest.config.site ?? null,
      capabilities: manifest.capabilities,
      updatedAt: null,
      dataLimits: null,
    };
    let failSave = true;
    const writes: Record<string, unknown>[] = [];
    await page.route("**/rpc/extensions/list**", (route) =>
      route.fulfill({ json: { json: [globalDetail] } }),
    );
    await page.route("**/rpc/extensions/get**", (route) =>
      route.fulfill({ json: { json: globalDetail } }),
    );
    await page.route("**/rpc/extensions/forSite**", (route) =>
      route.fulfill({ json: { json: [siteView] } }),
    );
    await page.route(/\/rpc\/extensions\/(update|updateSite)(?:\?|$)/, (route) => {
      writes.push(route.request().postDataJSON().json.config);
      if (failSave) return route.fulfill({ status: 503, body: "unavailable" });
      if (route.request().url().includes("updateSite")) {
        siteView = { ...siteView, updatedAt: new Date().toISOString() };
        return route.fulfill({ json: { json: siteView } });
      }
      globalDetail = { ...globalDetail, config: { credential: EXTENSION_SECRET_MASK } };
      return route.fulfill({ json: { json: globalDetail } });
    });
    await page.goto("/system?tab=extensions");
    await page.getByTestId("extension-open").click();
    const sheet = page.getByTestId("extension-detail");
    const globalForm = sheet.getByTestId("extension-global-config");
    const credential = globalForm.getByTestId("extension-config-credential");
    await expect(credential).toHaveAttribute("type", "password");
    await expect(credential).toHaveValue(EXTENSION_SECRET_MASK);
    await credential.fill("new-global-fixture");
    const original = await credential.elementHandle();
    await globalForm.getByTestId("extension-global-save").click();
    await expect(globalForm.getByRole("alert")).toBeVisible();
    await expect(credential).toHaveValue("new-global-fixture");
    expect(await credential.evaluate((element, previous) => element === previous, original)).toBe(
      true,
    );
    failSave = false;
    await globalForm.getByTestId("extension-global-save").click();
    await expect(credential).toHaveValue(EXTENSION_SECRET_MASK);
    expect(await credential.evaluate((element, previous) => element === previous, original)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    const created = await page.request.post("/rpc/sites/create", {
      headers: { "x-csrf-token": "orpc" },
      data: {
        json: {
          name: "Extension secret UI",
          domains: [`extension-secret-${locale}-${Date.now()}.test`],
          origins: [{ address: "origin.test" }],
        },
      },
    });
    expect(created.ok()).toBe(true);
    const {
      json: { site },
    } = (await created.json()) as { json: { site: Site } };
    try {
      await page.goto(`/sites/${site.id}?tab=extensions`);
      const card = page.getByTestId("site-extension");
      const siteCredential = card.getByTestId("extension-config-credential");
      await expect(siteCredential).toHaveAttribute("type", "password");
      await expect(siteCredential).toHaveValue(EXTENSION_SECRET_MASK);
      await siteCredential.fill("new-site-fixture");
      failSave = true;
      await card.getByTestId("site-extension-save").click();
      await expect(card.getByRole("alert")).toBeVisible();
      await expect(siteCredential).toHaveValue("new-site-fixture");
      failSave = false;
      await card.getByTestId("site-extension-save").click();
      await expect(siteCredential).toHaveValue(EXTENSION_SECRET_MASK);
      expect(writes).toEqual([
        { credential: "new-global-fixture" },
        { credential: "new-global-fixture" },
        { credential: "new-site-fixture" },
        { credential: "new-site-fixture" },
      ]);
      await expect(page.locator('[data-type="success"]')).toHaveCount(0, { timeout: 15_000 });
      expect(pageErrors).toEqual([]);
    } finally {
      const removed = await page.request.post("/rpc/sites/delete", {
        headers: { "x-csrf-token": "orpc" },
        data: { json: { id: site.id } },
      });
      expect(removed.ok()).toBe(true);
    }
  });
}
