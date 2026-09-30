import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g2.mjs: the bench site (Under Attack js, CC off, no
 * rules) with the path_level and ip_banned events of its CC run. Every test
 * leaves the site and the platform settings as it found them.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g2-state.json"), "utf8")) as {
  benchSiteId: string;
  benchSiteName: string;
  benchHost: string;
  /** client-a, banned automatically for going over ipQps. */
  bannedAddress: string;
  /** The path escalated by the CC run. */
  attackedPath: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const SAMPLE_JA4 = "t13d1516h2_8daaf6152771_02713d6af862";

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g2-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g2-${name}-${scheme}-375.png`,
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

async function openSecurityTab(page: Page) {
  await page.goto(`/sites/${state.benchSiteId}`);
  await page.getByTestId("tab-security").click();
  await expect(page).toHaveURL(/tab=security/);
  await expect(page.getByTestId("protection-under-attack")).toBeVisible();
}

/** Clicks a switch that asks for confirmation and confirms. */
async function confirmSwitch(page: Page, testId: string, title: string, screenshot?: string) {
  await page.getByTestId(testId).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(title);
  if (screenshot) await check(page, screenshot);
  await dialog.getByTestId("confirm-action").click();
  await expect(dialog).toBeHidden();
}

test("G2: the site's security tab turns Under Attack off and on, edits the CC policy and shows node levels and events", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openSecurityTab(page);
  const underAttack = page.getByTestId("protection-under-attack");
  const on = page.getByTestId("protection-under-attack-on");
  await expect(underAttack).toHaveAttribute("aria-checked", "true");
  await expect(on).toHaveText("已开启");
  await expect(page.getByTestId("protection-under-attack-type")).toHaveText("JS 计算");

  await confirmSwitch(page, "protection-under-attack", "关闭 Under Attack？");
  await expect(underAttack).toHaveAttribute("aria-checked", "false");
  await expect(on).toHaveCount(0);
  await confirmSwitch(
    page,
    "protection-under-attack",
    "开启 Under Attack？",
    "under-attack-dialog",
  );
  await expect(underAttack).toHaveAttribute("aria-checked", "true");
  await expect(on).toBeVisible();
  await pick(page, page.getByTestId("protection-under-attack-type"), "工作量证明");
  await expect(page.getByTestId("protection-under-attack-type")).toHaveText("工作量证明");
  await page.reload();
  await expect(page.getByTestId("protection-under-attack-type")).toHaveText("工作量证明");
  await pick(page, page.getByTestId("protection-under-attack-type"), "JS 计算");
  await expect(page.getByTestId("protection-under-attack-type")).toHaveText("JS 计算");

  // CC policy: custom thresholds that start from the template.
  const enabled = page.getByTestId("cc-enabled");
  const follow = page.getByTestId("cc-follow-template");
  const urlQps = page.getByTestId("cc-url-qps");
  const ipQps = page.getByTestId("cc-ip-qps");
  const save = page.getByTestId("cc-save");
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(follow).toHaveAttribute("aria-checked", "false");
  await expect(save).toBeDisabled();
  await enabled.click();
  await follow.click();
  await expect(urlQps).toBeDisabled();
  await expect(urlQps).toHaveValue("200");
  await follow.click();
  await expect(urlQps).toBeEnabled();
  await expect(urlQps).toHaveValue("200");
  await urlQps.fill("30");
  await ipQps.fill("80");
  await pick(page, page.getByTestId("cc-max-level"), "工作量证明");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await expect(follow).toHaveAttribute("aria-checked", "false");
  await expect(urlQps).toHaveValue("30");
  await expect(ipQps).toHaveValue("80");
  await expect(page.getByTestId("cc-max-level")).toHaveText("工作量证明");

  // What the nodes report and what happened during the CC run.
  const nodes = page.getByTestId("security-node-row");
  await expect(nodes).toHaveCount(2);
  await expect(nodes.first().getByTestId("security-node-level")).toHaveText("正常");
  await expect(page.getByTestId("security-top-ips")).toContainText(state.bannedAddress);
  await expect(page.getByTestId("security-top-paths")).toContainText(state.attackedPath);
  const events = page.getByTestId("security-event-row");
  // The attacked path went from normal to Cookie 302 (then on to JS).
  await expect(
    events
      .filter({ hasText: "路径级别" })
      .filter({ hasText: state.attackedPath })
      .filter({ hasText: "正常 → Cookie 跳转" }),
  ).toHaveCount(1);
  await expect(events.filter({ hasText: "自动封禁" }).first()).toContainText(state.bannedAddress);
  await check(page, "security-tab");
  await pick(page, page.getByTestId("security-event-kind"), "自动封禁");
  await expect(events.filter({ hasText: "路径级别" })).toHaveCount(0);
  await expect(events.first()).toHaveAttribute("data-kind", "ip_banned");
  await expect(events.first()).toContainText(state.bannedAddress);
  await pick(page, page.getByTestId("security-event-kind"), "路径级别");
  await expect(events.filter({ hasText: "自动封禁" })).toHaveCount(0);
  await expect(events.first()).toHaveAttribute("data-kind", "path_level");

  // Back to CC off for bench.sh.
  await enabled.click();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(underAttack).toHaveAttribute("aria-checked", "true");
  await page.goto("/admin/audit?action=site.protection_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("site.protection_update");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G2: administrators turn platform Under Attack on and off and edit the CC template", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/admin/settings");
  const platform = page.getByTestId("platform-under-attack");
  const badge = page.getByTestId("platform-under-attack-on");
  await expect(platform).toHaveAttribute("aria-checked", "false");
  await expect(badge).toHaveCount(0);
  await expect(page.getByTestId("platform-under-attack-type")).toHaveText("JS 计算");
  await confirmSwitch(
    page,
    "platform-under-attack",
    "为所有网站开启 Under Attack？",
    "platform-dialog",
  );
  await expect(platform).toHaveAttribute("aria-checked", "true");
  await expect(badge).toHaveText("已开启");

  // Every site shows it.
  await openSecurityTab(page);
  await expect(page.getByTestId("protection-platform-on")).toHaveText(
    "平台已为所有网站开启 Under Attack",
  );
  await page.goto("/admin/settings");
  await confirmSwitch(page, "platform-under-attack", "关闭平台 Under Attack？");
  await expect(platform).toHaveAttribute("aria-checked", "false");
  await expect(badge).toHaveCount(0);
  await page.reload();
  await expect(platform).toHaveAttribute("aria-checked", "false");
  await openSecurityTab(page);
  await expect(page.getByTestId("protection-platform-on")).toHaveCount(0);

  // CC template.
  await page.goto("/admin/settings");
  const urlQps = page.getByTestId("cc-template-url-qps");
  const save = page.getByTestId("cc-template-save");
  await expect(urlQps).toHaveValue("200");
  await expect(save).toBeDisabled();
  await urlQps.fill("250");
  await pick(page, page.getByTestId("cc-template-max-level"), "JS 计算");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(urlQps).toHaveValue("250");
  await expect(page.getByTestId("cc-template-max-level")).toHaveText("JS 计算");
  await check(page, "admin-protection");
  await urlQps.fill("200");
  await pick(page, page.getByTestId("cc-template-max-level"), "图片验证码");
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(urlQps).toHaveValue("200");
  await expect(page.getByTestId("cc-template-max-level")).toHaveText("图片验证码");
  await page.goto("/admin/audit?action=system.cc_template_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("system.cc_template_update");
  await page.goto("/admin/audit?action=system.protection_update");
  await expect(page.getByTestId("audit-action").first()).toHaveText("system.protection_update");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G2: the rules editor offers the challenge action and tls.ja4 in expressions and rate limit keys", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.benchSiteId}`);
  await page.getByTestId("tab-rules").click();
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  await expect(page.getByTestId("rule-row")).toHaveCount(0);

  await page.getByTestId("rule-add-waf-custom").click();
  const challenge = page.getByTestId("rule-row").first();
  const ruleId = (await challenge.getByLabel("动作", { exact: true }).getAttribute("id"))?.slice(
    "action-".length,
  );
  expect(ruleId).toBeTruthy();
  await challenge.getByLabel("名称", { exact: true }).fill("G2 JA4 challenge");
  await pick(page, page.getByTestId(`expr-${ruleId}-field`), "tls.ja4");
  const expression = challenge.getByLabel("表达式", { exact: true });
  await expect(expression).toHaveValue("true and tls.ja4 ");
  await expect(challenge.getByRole("alert")).toBeVisible();
  await expression.fill(`tls.ja4 eq "${SAMPLE_JA4}"`);
  await expect(challenge.getByRole("alert")).toHaveCount(0);
  await pick(page, page.locator(`#action-${ruleId}`), "挑战");
  const type = page.locator(`#challenge-${ruleId}`);
  await expect(type).toHaveText("JS 计算");
  await pick(page, type, "工作量证明");

  await page.getByTestId("rule-add-ratelimit").click();
  const rate = page.getByTestId("rule-row").nth(1);
  await rate.getByLabel("名称", { exact: true }).fill("G2 JA4 rate");
  await pick(page, rate.getByLabel("限速键", { exact: true }), "tls.ja4");
  await check(page, "rules");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("rules-save")).toBeDisabled();

  await page.reload();
  const saved = page.getByTestId("rule-row");
  await expect(saved).toHaveCount(2);
  await expect(saved.first().getByLabel("名称", { exact: true })).toHaveValue("G2 JA4 challenge");
  await expect(saved.first().getByLabel("表达式", { exact: true })).toHaveValue(
    `tls.ja4 eq "${SAMPLE_JA4}"`,
  );
  await expect(saved.first().getByLabel("动作", { exact: true })).toHaveText("挑战");
  await expect(saved.first().getByLabel("挑战类型", { exact: true })).toHaveText("工作量证明");
  await expect(saved.nth(1).getByLabel("限速键", { exact: true })).toHaveText("tls.ja4");

  // The bench site keeps no rules.
  while (await saved.count())
    await saved.first().getByRole("button", { name: "删除", exact: true }).click();
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("rules-save")).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  await expect(page.getByTestId("rule-row")).toHaveCount(0);
  await logout(page);
  expect(pageErrors).toEqual([]);
});
