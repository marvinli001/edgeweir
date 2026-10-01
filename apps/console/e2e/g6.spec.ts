import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g6.mjs: cluster A with the nodes edge (configured
 * primary and backup addresses) and peer in node groups of the regions east
 * and north, both reporting host metrics; one probe in each region; the rule
 * "g6 east loss" (ruleId); the cluster's DNS binding on an account of the
 * hidden test provider (bindingProviderId), which writes every resolution
 * line, with the lines "tel" (telecom, backup group: peer's) and "uni"
 * (unicom). Every test leaves them as it found them; a rule left behind by a
 * failed run is named "g6 …", which the script's cleanup deletes.
 */
type Ref = { id: string; name: string };
const state = JSON.parse(readFileSync(resolve("../../.e2e/g6-state.json"), "utf8")) as {
  clusterId: string;
  regions: { east: Ref; north: Ref };
  probes: { east: Ref; north: Ref };
  nodes: { edge: Ref; peer: Ref };
  ruleId: string;
  bindingProviderId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const RESOLUTION_LINES = ["默认", "电信", "联通", "移动", "教育网", "境外"];

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g6-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g6-${name}-${scheme}-375.png`,
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

/**
 * Clicks a save button and waits for its RPC to answer: the button turns
 * disabled while the mutation is still pending, so a reload right after the
 * click could read the old value.
 */
async function saved(page: Page, save: Locator, procedure: string) {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes(`/rpc/${procedure}`),
  );
  await save.click();
  expect((await answered).ok()).toBe(true);
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (table: Locator, id: string) => table.locator(`[data-row-id="${id}"]`);

test("G6: the probes tab lists the regional probes online and shows a new probe's token once", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await expect(page.getByTestId("nav-regions")).toHaveText("区域与探针");
  await page.goto("/regions?tab=probes");
  await expect(page.getByTestId("page-title")).toHaveText("区域与探针");
  await expect(page.getByTestId("regions-tab-probes")).toHaveAttribute("aria-selected", "true");
  const table = page.getByTestId("probes-table");

  await test.step("both probes are online in their regions with targets and a last round", async () => {
    for (const key of ["east", "north"] as const) {
      const probe = row(table, state.probes[key].id);
      await expect(probe.getByTestId("probe-name")).toHaveText(state.probes[key].name);
      await expect(probe.getByTestId("probe-region")).toContainText(state.regions[key].name);
      await expect(probe.getByTestId("probe-online")).toBeVisible({ timeout: 60_000 });
      await expect(probe.getByTestId("probe-targets")).toHaveText(/^[1-9]\d*$/);
      await expect(probe.getByTestId("probe-loss")).toHaveText(/^丢包 [\d.]+%$/, {
        timeout: 60_000,
      });
    }
  });
  await check(page, "probes");

  await test.step("a probe's results name the nodes it measures", async () => {
    await row(table, state.probes.east.id).getByTestId("probe-name").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(`${state.probes.east.name} 的探测结果`);
    const results = dialog.getByTestId("probe-results-table");
    for (const node of [state.nodes.edge, state.nodes.peer])
      await expect(
        results.locator(`[data-testid="probe-result-row"][data-node="${node.name}"]`).first(),
      ).toBeVisible({ timeout: 60_000 });
    await check(page, "probe-results");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  await test.step("a probe is renamed and named back", async () => {
    const probe = row(table, state.probes.north.id);
    for (const name of [`${state.probes.north.name}-ui`, state.probes.north.name]) {
      await probe.getByTestId("probe-actions").click();
      await page.getByTestId("probe-rename").click();
      await page.getByLabel("探针名称", { exact: true }).fill(name);
      await saved(page, page.getByTestId("probe-rename-submit"), "probes/update");
      await expect(probe.getByTestId("probe-name")).toHaveText(name);
    }
  });

  await test.step("a new probe's token and command are shown once", async () => {
    await page.getByTestId("add-probe").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("probe-name-input").fill("g6-ui-probe");
    await dialog.getByTestId("probe-region-select").click();
    await page
      .getByRole("option", { name: new RegExp(`^${literal(state.regions.north.name)} \\(`) })
      .click();
    await dialog.getByTestId("probe-generate").click();
    const token = dialog.getByTestId("probe-token");
    await expect(token).toHaveText(/^ewp_\S+$/);
    const value = (await token.textContent()) ?? "";
    await expect(dialog.getByTestId("probe-command")).toContainText(value);
    await expect(dialog.getByTestId("probe-token-once")).toHaveText("仅显示一次");
    await check(page, "probe-token");
    await dialog.getByTestId("probe-token-close").click();
    await expect(dialog).toBeHidden();
    // Opened again, the dialog asks for a new probe: the token is gone.
    await page.getByTestId("add-probe").click();
    await expect(dialog.getByTestId("probe-name-input")).toHaveValue("");
    await expect(dialog.getByTestId("probe-token")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  await test.step("the probe interval is saved and restored", async () => {
    const interval = page.getByTestId("probe-settings-intervalSeconds");
    const save = page.getByTestId("probe-settings-save");
    await expect(interval).toHaveValue(/^\d+$/);
    const before = await interval.inputValue();
    const changed = String(Number(before) === 60 ? 59 : Number(before) + 1);
    await expect(save).toBeDisabled();
    await interval.fill(changed);
    await saved(page, save, "settings/setProbes");
    await page.reload();
    await expect(interval).toHaveValue(changed);
    await interval.fill(before);
    await saved(page, save, "settings/setProbes");
    await page.reload();
    await expect(interval).toHaveValue(before);
  });
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G6: a node shows its metrics, scheduling addresses with levels and the probe switch", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}`);
  const nodes = page.getByTestId("nodes-table");
  const edge = row(nodes, state.nodes.edge.id);
  await expect(edge.getByTestId("node-load")).toContainText("CPU", { timeout: 60_000 });
  await edge.getByTestId("node-open").click();
  await expect(page).toHaveURL(new RegExp(`node=${state.nodes.edge.id}`));
  const dialog = page.getByTestId("node-detail");
  await expect(dialog.getByTestId("node-detail-name")).toHaveText(state.nodes.edge.name);

  await test.step("host metrics", async () => {
    await expect(dialog.getByTestId("node-metric-cpu")).toHaveText(/^[\d.]+%$/, {
      timeout: 60_000,
    });
    await expect(dialog.getByTestId("node-metric-load")).toHaveText(/^[\d.]+ \/ [\d.]+ \/ [\d.]+$/);
    await expect(dialog.getByTestId("node-metric-memory")).toHaveText(/^[\d.]+%$/);
    await expect(dialog.getByTestId("node-metric-egress")).toHaveText(/bps$/);
    await expect(dialog.getByTestId("node-metric-connections")).toHaveText(/^[\d,]+$/);
  });

  await test.step("scheduling addresses with their level, source and reachability", async () => {
    const rows = dialog.getByTestId("node-address-row");
    await expect(rows.first()).toBeVisible();
    await expect(
      dialog.locator('[data-testid="node-address-row"][data-level="0"]'),
    ).not.toHaveCount(0);
    // The level DNS uses now is marked on its reachable addresses.
    await expect(dialog.getByTestId("node-address-in-use").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog.getByTestId("node-probe-results")).toBeVisible({ timeout: 60_000 });
  });
  await check(page, "node-detail");

  await test.step("a second backup address is configured, then the addresses are restored", async () => {
    const configuredBefore = await dialog
      .locator('[data-testid="node-address-row"][data-source="configured"]')
      .count();
    await dialog.getByTestId("node-addresses-edit").click();
    const editor = dialog.getByTestId("node-address-editor");
    await editor.getByTestId("node-address-add").click();
    await editor.getByTestId("node-address-input").last().fill("192.0.2.123");
    await pick(page, editor.getByTestId("node-address-level").last(), "备 2");
    await saved(page, editor.getByTestId("node-addresses-save"), "nodes/setAddresses");
    const added = dialog.locator(
      '[data-testid="node-address-row"][data-address="192.0.2.123"][data-level="2"]',
    );
    await expect(added).toHaveAttribute("data-source", "configured");
    await check(page, "node-addresses");

    await dialog.getByTestId("node-addresses-edit").click();
    if (configuredBefore === 0) {
      // The node used its reported addresses: back to them.
      await saved(page, editor.getByTestId("node-addresses-reset"), "nodes/setAddresses");
      await expect(
        dialog.locator('[data-testid="node-address-row"][data-source="configured"]'),
      ).toHaveCount(0);
    } else {
      const drafts = editor.getByTestId("node-address-draft");
      const count = await drafts.count();
      for (let i = 0; i < count; i++) {
        const draft = drafts.nth(i);
        if ((await draft.getByTestId("node-address-input").inputValue()) === "192.0.2.123") {
          await draft.getByTestId("node-address-remove").click();
          break;
        }
      }
      await saved(page, editor.getByTestId("node-addresses-save"), "nodes/setAddresses");
      await expect(
        dialog.locator('[data-testid="node-address-row"][data-source="configured"]'),
      ).toHaveCount(configuredBefore);
    }
    await expect(dialog.locator('[data-address="192.0.2.123"]')).toHaveCount(0);
  });

  await test.step("the node also probes, then stops", async () => {
    const toggle = dialog.getByTestId("node-probe-switch");
    await expect(toggle).toBeEnabled();
    await expect(dialog.getByTestId("node-probe-no-region")).toHaveCount(0);
    const before = await toggle.getAttribute("aria-checked");
    const after = before === "true" ? "false" : "true";
    await saved(page, toggle, "nodes/setProbe");
    await expect(toggle).toHaveAttribute("aria-checked", after);
    await expect(edge.getByTestId("node-probe-badge")).toHaveCount(after === "true" ? 1 : 0);
    await saved(page, toggle, "nodes/setProbe");
    await expect(toggle).toHaveAttribute("aria-checked", before ?? "false");
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/node=/);
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G6: a scheduling rule is created, edited, switched off and deleted; the preview lists the nodes", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=scheduling`);
  await expect(page.getByTestId("cluster-tab-scheduling")).toHaveAttribute("aria-selected", "true");
  const table = page.getByTestId("scheduling-rules-table");
  await expect(row(table, state.ruleId)).toBeVisible();
  const preview = page.getByTestId("scheduling-preview");
  await expect(
    preview.locator(`[data-testid="scheduling-preview-rule"][data-rule-id="${state.ruleId}"]`),
  ).toBeVisible();
  const added = table.getByRole("row").filter({ hasText: "g6 ui rule" });

  await test.step("a rule on CPU and the east probes' loss", async () => {
    await page.getByTestId("scheduling-rule-create").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("scheduling-rule-name-input").fill("g6 ui rule");
    const conditions = dialog.getByTestId("scheduling-condition");
    await expect(conditions).toHaveCount(1);
    await expect(conditions.first().getByTestId("scheduling-condition-metric")).toHaveText(
      "CPU 使用率",
    );
    // Node metrics have no aggregate or region.
    await expect(conditions.first().getByTestId("scheduling-condition-region")).toHaveCount(0);
    await conditions.first().getByTestId("scheduling-condition-threshold").fill("99.5");
    await conditions.first().getByTestId("scheduling-condition-duration").fill("600");
    await dialog.getByTestId("scheduling-condition-add").click();
    await expect(conditions).toHaveCount(2);
    const loss = conditions.nth(1);
    await pick(page, loss.getByTestId("scheduling-condition-metric"), "探测丢包率");
    await pick(page, loss.getByTestId("scheduling-condition-aggregate"), "最大");
    await loss.getByTestId("scheduling-condition-region").click();
    await page
      .getByRole("option", { name: new RegExp(`^${literal(state.regions.east.name)} \\(`) })
      .click();
    await pick(page, loss.getByTestId("scheduling-condition-comparator"), "≥");
    await loss.getByTestId("scheduling-condition-threshold").fill("100");
    await loss.getByTestId("scheduling-condition-duration").fill("600");
    await expect(dialog.getByTestId("scheduling-rule-action-select")).toHaveText("摘除节点");
    await check(page, "scheduling-editor");
    await saved(page, dialog.getByTestId("scheduling-rule-submit"), "scheduling/create");
    await expect(dialog).toBeHidden();
    await expect(added.getByTestId("scheduling-rule-name")).toHaveText("g6 ui rule");
    await expect(added.getByTestId("scheduling-rule-line")).toHaveText("全部线路");
    await expect(added.getByTestId("scheduling-rule-condition")).toHaveCount(2);
    await expect(added.getByTestId("scheduling-rule-condition").nth(1)).toContainText(
      `探测丢包率 (最大 · ${state.regions.east.name}) ≥ 100%`,
    );
  });

  await test.step("the preview evaluates the new rule on both nodes without acting", async () => {
    const block = preview.getByTestId("scheduling-preview-rule").filter({ hasText: "g6 ui rule" });
    for (const node of [state.nodes.edge, state.nodes.peer]) {
      const line = block.locator(
        `[data-testid="scheduling-preview-node"][data-node-id="${node.id}"]`,
      );
      await expect(line).toContainText(node.name, { timeout: 30_000 });
      await expect(line).toHaveAttribute("data-state", "idle");
      await expect(line.getByTestId("scheduling-preview-condition")).toHaveCount(2);
      await expect(line.getByTestId("scheduling-preview-outcome")).toHaveText("无变化");
    }
  });
  await check(page, "scheduling");

  await test.step("renamed with one condition and a shorter hold", async () => {
    await added.getByTestId("scheduling-rule-edit").click();
    const dialog = page.getByRole("dialog");
    const name = dialog.getByTestId("scheduling-rule-name-input");
    await expect(name).toHaveValue("g6 ui rule");
    await name.fill("g6 ui rule 2");
    await dialog.getByTestId("scheduling-rule-hold").fill("120");
    await dialog
      .getByTestId("scheduling-condition")
      .nth(1)
      .getByTestId("scheduling-condition-remove")
      .click();
    await expect(dialog.getByTestId("scheduling-condition")).toHaveCount(1);
    await saved(page, dialog.getByTestId("scheduling-rule-submit"), "scheduling/update");
    await expect(dialog).toBeHidden();
    await expect(added.getByTestId("scheduling-rule-name")).toHaveText("g6 ui rule 2");
    await expect(added.getByTestId("scheduling-rule-condition")).toHaveCount(1);
    await expect(added.getByTestId("scheduling-rule-condition")).toContainText(
      "CPU 使用率 > 99.5%",
    );
    await expect(added).toContainText("保持 120 秒");
  });

  await test.step("switched off, then deleted", async () => {
    const enabled = added.getByTestId("scheduling-rule-enabled");
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await saved(page, enabled, "scheduling/update");
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await expect(
      preview.getByTestId("scheduling-preview-rule").filter({ hasText: "g6 ui rule 2" }),
    ).toContainText("已停用");
    await added.getByTestId("scheduling-rule-delete").click();
    await saved(page, page.getByTestId("confirm-action"), "scheduling/delete");
    await expect(added).toHaveCount(0);
    await expect(row(table, state.ruleId)).toBeVisible();
  });
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G6: cluster DNS lines pick a resolution line, backup groups and a minimum; records show their line", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/clusters?cluster=${state.clusterId}&tab=dns`);
  await expect(page.getByTestId("cluster-dns")).toBeVisible();
  const save = page.getByTestId("dns-binding-save");
  const line = page.getByTestId("dns-line").first();
  await expect(line).toBeVisible();
  await expect(save).toBeDisabled();

  await test.step("the test provider offers every resolution line", async () => {
    // The binding's account is on the test provider, which writes every line.
    await expect(page.getByTestId("dns-resolution-default-only")).toHaveCount(0);
    const resolution = line.getByTestId("dns-line-resolution");
    await expect(resolution).toBeEnabled();
    const current = ((await resolution.textContent()) ?? "").trim();
    expect(RESOLUTION_LINES).toContain(current);
    await resolution.click();
    await expect(page.getByRole("option")).toHaveText(RESOLUTION_LINES);
    const other = current === "境外" ? "默认" : "境外";
    await page.getByRole("option", { name: other, exact: true }).click();
    await expect(resolution).toHaveText(other);
    await expect(save).toBeEnabled();
    await pick(page, resolution, current);
    await expect(save).toBeDisabled();
  });

  await test.step("the minimum of healthy addresses and the backup groups mark the form changed", async () => {
    const minimum = line.getByTestId("dns-line-min-healthy");
    const before = await minimum.inputValue();
    await minimum.fill(String(Number(before) + 1));
    await expect(save).toBeEnabled();
    await minimum.fill(before);
    await expect(save).toBeDisabled();

    // A line with a node group left to add as its backup, else one with a backup to take out.
    const lines = page.getByTestId("dns-line");
    const total = await lines.count();
    let index = -1;
    for (let i = 0; i < total && index < 0; i++)
      if (await lines.nth(i).getByTestId("dns-line-backup-add").count()) index = i;
    if (index >= 0) {
      const target = lines.nth(index);
      const backups = target.getByTestId("dns-line-backup");
      const count = await backups.count();
      await target.getByTestId("dns-line-backup-add").click();
      const option = page.getByRole("option").first();
      const name = ((await option.textContent()) ?? "").trim();
      await option.click();
      await expect(backups).toHaveCount(count + 1);
      await expect(backups.last()).toHaveAttribute("data-group", name);
      await expect(save).toBeEnabled();
      await check(page, "dns-lines");
      await target.getByRole("button", { name: `移除 ${name}`, exact: true }).click();
      await expect(backups).toHaveCount(count);
    } else {
      for (let i = 0; i < total && index < 0; i++)
        if (await lines.nth(i).getByTestId("dns-line-backup").count()) index = i;
      expect(index, "a line with a backup node group or room for one").toBeGreaterThanOrEqual(0);
      const target = lines.nth(index);
      const backups = target.getByTestId("dns-line-backup");
      const count = await backups.count();
      const name = (await backups.last().getAttribute("data-group")) ?? "";
      await target.getByRole("button", { name: `移除 ${name}`, exact: true }).click();
      await expect(backups).toHaveCount(count - 1);
      await expect(save).toBeEnabled();
      await check(page, "dns-lines");
      await pick(page, target.getByTestId("dns-line-backup-add"), name);
      await expect(backups).toHaveCount(count);
      await expect(backups.last()).toHaveAttribute("data-group", name);
    }
    await expect(save).toBeDisabled();
  });

  await test.step("records carry their resolution line, revisions their reason", async () => {
    const records = page
      .getByTestId("dns-current-records")
      .or(page.getByTestId("dns-manual-records"));
    await expect(records.getByRole("columnheader", { name: "解析线路" })).toBeVisible();
    const lines = records.getByTestId("dns-record-line");
    await expect(lines.first()).toBeVisible();
    for (const text of await lines.allTextContents()) expect(RESOLUTION_LINES).toContain(text);
    await expect(page.getByTestId("dns-revision-reason").first()).toHaveText(
      /^(保存绑定|节点健康变化|回滚|强制发布|智能调度：.+)/,
    );
  });
  await check(page, "dns");
  await logout(page);
  expect(pageErrors).toEqual([]);
});
