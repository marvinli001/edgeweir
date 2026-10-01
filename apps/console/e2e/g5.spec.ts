import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * Written by scripts/e2e-g5.mjs on the default cluster (two nodes with rules-v2): dyn
 * (dyn.g5.test: redirect rules with value expression targets and query edits, dynamic and static
 * rewrites, bulk redirects /promo and /about), org (org.g5.test: origin a in the default group, b
 * in "api", an origin rule sending /api/ to "api" with Host backend.g5.internal on port 8081 and a
 * config rule with a 1 s read timeout), cache (cache.g5.test: an expression cache rule with a
 * browser TTL of 120 s, then a builder rule for /s/), gz (gz.g5.test: a config rule turning gzip
 * off, compression rules choosing gzip and none) and cfg (cfg.g5.test: config rules for Under
 * Attack, WebSocket and the log sample rate). Every test leaves them as it found them.
 */
type SiteRef = { id: string; name: string };
const state = JSON.parse(readFileSync(resolve("../../.e2e/g5-state.json"), "utf8")) as {
  dyn: SiteRef;
  org: SiteRef;
  cache: SiteRef;
  gz: SiteRef;
  cfg: SiteRef;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;
const OLD_TO_NEW = 'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")';
const V1_TO_V2 = 'wildcard_replace(http.request.uri.path, "/v1/*", "/v2/${1}")';
const CACHE_EXPRESSION =
  'starts_with(http.request.uri.path, "/c/") and not ends_with(http.request.uri.path, ".nocache")';

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g5-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g5-${name}-${scheme}-375.png`,
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

async function openTab(
  page: Page,
  siteId: string,
  tab: "rules" | "redirects" | "cache" | "origins",
) {
  await page.goto(`/sites/${siteId}?tab=${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

/** The rules of one phase section of the rules editor. */
const phaseRules = (page: Page, phase: string) =>
  page.getByTestId(`rules-phase-${phase}`).getByTestId("rule-row");

/** Saves the rules editor and waits for the saved state. */
/**
 * Clicks a save button and waits for its RPC to answer: the button turns
 * disabled while the mutation is still pending, so a reload right after the
 * click could read the old value.
 */
async function saved(page: Page, save: Locator, procedure: string | RegExp) {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      (typeof procedure === "string"
        ? response.url().includes(`/rpc/${procedure}`)
        : procedure.test(response.url())),
  );
  await save.click();
  expect((await answered).ok()).toBe(true);
}

async function saveRules(page: Page) {
  const save = page.getByTestId("rules-save");
  await expect(save).toBeEnabled();
  await saved(page, save, /\/rpc\/(rules|platformRules)\/save/);
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);
}

/** Removes a rule (its delete button) and saves. */
async function removeRule(page: Page, row: Locator) {
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await saveRules(page);
}

test("G5: the rule editor shows dynamic redirects, rewrites with query edits and config overrides", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.dyn.id, "rules");
  const save = page.getByTestId("rules-save");

  await test.step("a redirect computed by regex_replace, with its query edits", async () => {
    const redirect = phaseRules(page, "redirect").first();
    await expect(redirect.getByLabel("名称", { exact: true })).toHaveValue("g5 old to new");
    await expect(redirect.getByRole("tab", { name: "表达式", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const target = redirect.getByLabel("目标", { exact: true });
    await expect(target).toHaveValue(OLD_TO_NEW);
    await expect(redirect.getByRole("alert")).toHaveCount(0);
    await expect(redirect.getByLabel("状态码", { exact: true })).toHaveText("301");
    await expect(redirect.getByTestId("rule-preserve-query")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(redirect.getByTestId("rule-set-query")).toHaveCount(1);
    await expect(redirect.getByTestId("rule-set-query-name")).toHaveValue("from");
    await expect(redirect.getByTestId("rule-set-query-value")).toHaveValue("old site");
    await expect(redirect.getByTestId("rule-remove-query")).toHaveValue("utm_source");
    await expect(save).toBeDisabled();

    // Static and back keeps the expression: nothing to save.
    await redirect.getByRole("tab", { name: "静态", exact: true }).click();
    await expect(redirect.getByLabel("目标", { exact: true })).toHaveValue("/");
    await expect(save).toBeEnabled();
    await redirect.getByRole("tab", { name: "表达式", exact: true }).click();
    await expect(target).toHaveValue(OLD_TO_NEW);
    await expect(save).toBeDisabled();

    // The value parser marks where a target stops making sense.
    await target.fill("concat(http.host)");
    await expect(redirect.getByRole("alert")).toHaveText(/^检查第 \d+ 个字符$/);
    await target.fill(OLD_TO_NEW);
    await expect(redirect.getByRole("alert")).toHaveCount(0);

    await redirect.getByTestId("rule-set-query-add").click();
    await expect(redirect.getByTestId("rule-set-query")).toHaveCount(2);
    await expect(save).toBeEnabled();
    await redirect.getByTestId("rule-set-query").nth(1).getByRole("button").click();
    await expect(redirect.getByTestId("rule-set-query")).toHaveCount(1);
    await expect(save).toBeDisabled();
  });

  await test.step("a dynamic and a static rewrite", async () => {
    const [dynamic, legacy] = [
      phaseRules(page, "request-transform").nth(0),
      phaseRules(page, "request-transform").nth(1),
    ];
    await expect(dynamic.getByLabel("名称", { exact: true })).toHaveValue("g5 v1 to v2");
    await expect(dynamic.getByLabel("目标", { exact: true })).toHaveValue(V1_TO_V2);
    await expect(dynamic.getByTestId("rule-preserve-query")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(dynamic.getByTestId("rule-set-query-name")).toHaveValue("v");
    await expect(dynamic.getByTestId("rule-set-query-value")).toHaveValue("2");
    await expect(legacy.getByLabel("名称", { exact: true })).toHaveValue("g5 legacy");
    await expect(legacy.getByRole("tab", { name: "静态", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(legacy.getByLabel("目标", { exact: true })).toHaveValue("/modern");
    await expect(legacy.getByTestId("rule-preserve-query")).toHaveAttribute("aria-checked", "true");
    await expect(legacy.getByTestId("rule-remove-query")).toHaveValue("debug");
  });
  await check(page, "rules-dynamic");

  await test.step("config overrides: Under Attack, WebSocket and the log sample rate", async () => {
    await openTab(page, state.cfg.id, "rules");
    const config = phaseRules(page, "config");
    await expect(config).toHaveCount(3);
    await expect(config.nth(0).getByTestId("rule-config-underAttack")).toHaveText("开启");
    await expect(config.nth(0).getByTestId("rule-config-websocket")).toHaveText("不更改");
    await expect(config.nth(1).getByTestId("rule-config-websocket")).toHaveText("关闭");
    // Basis points shown as a percentage.
    await expect(config.nth(2).getByTestId("rule-config-logSampleRate")).toHaveValue("100");
    await expect(config.nth(2).getByTestId("rule-config-originReadTimeoutMs")).toHaveValue("");
    await expect(page.getByTestId("rules-save")).toBeDisabled();
  });
  await check(page, "rules-config");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G5: compression and origin rules are added, saved and removed; global rules pick no origin group", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  await test.step("a compression rule preferring gzip over zstd", async () => {
    await openTab(page, state.gz.id, "rules");
    const rules = phaseRules(page, "compression");
    await expect(rules).toHaveCount(2);
    await expect(rules.nth(0).getByTestId("rule-compression-algorithm")).toHaveAttribute(
      "data-coding",
      "gzip",
    );
    await expect(rules.nth(1).getByTestId("rule-compression-none")).toBeVisible();
    await expect(phaseRules(page, "config").first().getByTestId("rule-config-gzip")).toHaveText(
      "关闭",
    );

    await page.getByTestId("rule-add-compression").click();
    await expect(rules).toHaveCount(3);
    const added = rules.nth(2);
    await added.getByLabel("名称", { exact: true }).fill("G5 UI compression");
    await added.getByLabel("表达式", { exact: true }).fill('http.request.uri.path eq "/g5-ui"');
    await expect(added.getByTestId("rule-compression-none")).toBeVisible();
    await pick(page, added.getByTestId("rule-compression-add"), "Zstandard");
    await pick(page, added.getByTestId("rule-compression-add"), "Gzip");
    await added.getByRole("button", { name: "上移 Gzip", exact: true }).click();
    const order = added.getByTestId("rule-compression-algorithm");
    await expect(order).toHaveCount(2);
    await expect(order.nth(0)).toHaveAttribute("data-coding", "gzip");
    await expect(order.nth(1)).toHaveAttribute("data-coding", "zstd");
    await saveRules(page);

    await page.reload();
    const saved = phaseRules(page, "compression").nth(2);
    await expect(saved.getByLabel("名称", { exact: true })).toHaveValue("G5 UI compression");
    await expect(saved.getByTestId("rule-compression-algorithm").nth(0)).toHaveAttribute(
      "data-coding",
      "gzip",
    );
    await expect(saved.getByTestId("rule-compression-algorithm").nth(1)).toHaveAttribute(
      "data-coding",
      "zstd",
    );
    await check(page, "rules-compression");
    await removeRule(page, saved);
    await page.reload();
    await expect(phaseRules(page, "compression")).toHaveCount(2);
  });

  await test.step('an origin rule sending /g5-ui/ to the group "api"', async () => {
    await openTab(page, state.org.id, "rules");
    const rules = phaseRules(page, "origin");
    await expect(rules).toHaveCount(1);
    const existing = rules.first();
    await expect(existing.getByLabel("动作", { exact: true })).toHaveText("源站覆盖");
    await expect(existing.getByTestId("rule-origin-group")).toHaveText("api");
    await expect(existing.getByTestId("rule-origin-host")).toHaveValue("backend.g5.internal");
    await expect(existing.getByTestId("rule-origin-port")).toHaveValue("8081");
    // Milliseconds shown in seconds.
    await expect(
      phaseRules(page, "config").first().getByTestId("rule-config-originReadTimeoutMs"),
    ).toHaveValue("1");

    await page.getByTestId("rule-add-origin").click();
    await expect(rules).toHaveCount(2);
    const added = rules.nth(1);
    await added.getByLabel("名称", { exact: true }).fill("G5 UI origin");
    await added
      .getByLabel("表达式", { exact: true })
      .fill('starts_with(http.request.uri.path, "/g5-ui/")');
    await pick(page, added.getByLabel("动作", { exact: true }), "源站覆盖");
    const group = added.getByTestId("rule-origin-group");
    // The first group other than the default is preselected.
    await expect(group).toHaveText("api");
    await pick(page, group, "默认组");
    await expect(group).toHaveText("默认组");
    await pick(page, group, "api");
    await added.getByTestId("rule-origin-port").fill("8082");
    await saveRules(page);

    await page.reload();
    const saved = phaseRules(page, "origin").nth(1);
    await expect(saved.getByLabel("名称", { exact: true })).toHaveValue("G5 UI origin");
    await expect(saved.getByTestId("rule-origin-group")).toHaveText("api");
    await expect(saved.getByTestId("rule-origin-host")).toHaveValue("");
    await expect(saved.getByTestId("rule-origin-port")).toHaveValue("8082");
    await check(page, "rules-origin");
    await removeRule(page, saved);
    await page.reload();
    await expect(phaseRules(page, "origin")).toHaveCount(1);
  });

  await test.step("global rules override Host, SNI and port but no group", async () => {
    await page.goto("/rules");
    await expect(page.getByTestId("page-title")).toHaveText("全局规则");
    const rules = phaseRules(page, "origin");
    const before = await rules.count();
    await page.getByTestId("rule-add-origin").click();
    const added = rules.nth(before);
    await pick(page, added.getByLabel("动作", { exact: true }), "源站覆盖");
    await expect(added.getByTestId("rule-origin-host")).toBeVisible();
    await expect(added.getByTestId("rule-origin-group")).toHaveCount(0);
    // Nothing saved.
    await page.reload();
    await expect(phaseRules(page, "origin")).toHaveCount(before);
  });
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G5: bulk redirects are added, imported, saved and removed", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.dyn.id, "redirects");
  const count = page.getByTestId("bulk-redirects-count");
  const save = page.getByTestId("bulk-redirects-save");
  const filter = page.getByTestId("bulk-redirects-filter");
  const rows = page.getByTestId("bulk-redirect-row");
  await expect(count).toHaveText(/^\d+ \/ 5,000$/);
  const before = Number((await count.textContent())?.split(" / ")[0]);
  expect(before).toBeGreaterThanOrEqual(2);
  await expect(save).toBeDisabled();

  await filter.fill("/promo");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("bulk-redirect-source")).toHaveValue("/promo");
  await expect(rows.first().getByTestId("bulk-redirect-target")).toHaveValue(
    /^https:\/\/example\.test\/sale/,
  );
  await expect(rows.first().getByTestId("bulk-redirect-status")).toHaveText("302");
  await expect(rows.first().getByTestId("bulk-redirect-preserve-query")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // A new entry goes first and clears the filter.
  await page.getByTestId("bulk-redirects-add").click();
  await expect(filter).toHaveValue("");
  const added = rows.first();
  await added.getByTestId("bulk-redirect-source").fill("/g5-ui");
  await added.getByTestId("bulk-redirect-target").fill("/g5-ui-target");
  await pick(page, added.getByTestId("bulk-redirect-status"), "307");
  await expect(count).toHaveText(`${before + 1} / 5,000`);

  // Pasted lines: a bad line is named, then the good ones are merged.
  await page.getByTestId("bulk-redirects-import").click();
  const lines = page.getByTestId("bulk-redirects-lines");
  await lines.fill("/g5-import /g5-ui 308\nnot-a-source /x");
  await page.getByTestId("bulk-redirects-import-submit").click();
  await expect(page.getByTestId("form-error")).toHaveText("第 2 行无效");
  await lines.fill("/g5-import /g5-ui 308\n# comment\n/g5-import-2,https://example.test/two");
  await page.getByTestId("bulk-redirects-import-submit").click();
  await expect(lines).toHaveCount(0);
  await expect(count).toHaveText(`${before + 3} / 5,000`);
  await saved(page, save, "bulkRedirects/save");
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);

  await page.reload();
  await expect(count).toHaveText(`${before + 3} / 5,000`);
  await filter.fill("/g5-");
  await expect(rows).toHaveCount(3);
  const entry = (source: string) =>
    page.locator(`[data-testid="bulk-redirect-row"][data-source="${source}"]`);
  await expect(entry("/g5-ui").getByTestId("bulk-redirect-target")).toHaveValue("/g5-ui-target");
  await expect(entry("/g5-ui").getByTestId("bulk-redirect-status")).toHaveText("307");
  await expect(entry("/g5-import").getByTestId("bulk-redirect-status")).toHaveText("308");
  await expect(entry("/g5-import-2").getByTestId("bulk-redirect-target")).toHaveValue(
    "https://example.test/two",
  );
  await expect(entry("/g5-import-2").getByTestId("bulk-redirect-status")).toHaveText("301");
  await check(page, "bulk-redirects");

  // Leave the table as the script left it.
  while (await rows.count())
    await rows.first().getByRole("button", { name: "移除", exact: true }).click();
  await saved(page, save, "bulkRedirects/save");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(count).toHaveText(`${before} / 5,000`);
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G5: the cache tab keeps expression rules in advanced mode with their browser TTL", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.cache.id, "cache");
  const rows = page.getByTestId("cache-rule-row");
  const save = page.getByTestId("cache-save");
  await expect(rows).toHaveCount(2);
  const [expression, built] = [rows.nth(0), rows.nth(1)];

  await expect(expression.getByTestId("cache-rule-advanced")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The builder cannot show ends_with.
  await expect(expression.getByTestId("cache-rule-builder")).toBeDisabled();
  await expect(expression.getByTestId("cache-rule-expression")).toHaveValue(CACHE_EXPRESSION);
  await expect(expression.getByTestId("cache-rule-browser-ttl")).toHaveValue("120");
  await expect(built.getByTestId("cache-rule-builder")).toHaveAttribute("aria-selected", "true");
  await expect(built.getByTestId("cache-rule-prefixes")).toHaveValue("/s/");
  await expect(built.getByTestId("cache-rule-browser-ttl")).toHaveValue("");
  await expect(save).toBeDisabled();

  // Builder to expression and back.
  await built.getByTestId("cache-rule-advanced").click();
  await expect(built.getByTestId("cache-rule-expression")).toHaveValue(
    'starts_with(http.request.uri.path, "/s/")',
  );
  await built.getByTestId("cache-rule-builder").click();
  await expect(built.getByTestId("cache-rule-prefixes")).toHaveValue("/s/");
  await expect(save).toBeDisabled();

  // An expression the parser refuses keeps the card from saving.
  const editor = expression.getByTestId("cache-rule-expression");
  await editor.fill(`${CACHE_EXPRESSION} and`);
  await expect(expression.getByRole("alert")).toHaveText(/^检查第 \d+ 个字符$/);
  await expect(save).toBeDisabled();
  await editor.fill(CACHE_EXPRESSION);
  await expect(expression.getByRole("alert")).toHaveCount(0);

  await expression.getByTestId("cache-rule-browser-ttl").fill("300");
  await built.getByTestId("cache-rule-extensions").fill("css, JS");
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);
  await page.reload();
  await expect(expression.getByTestId("cache-rule-advanced")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The expression is kept, not replaced by a match-all builder condition.
  await expect(expression.getByTestId("cache-rule-expression")).toHaveValue(CACHE_EXPRESSION);
  await expect(expression.getByTestId("cache-rule-browser-ttl")).toHaveValue("300");
  await expect(built.getByTestId("cache-rule-builder")).toHaveAttribute("aria-selected", "true");
  await expect(built.getByTestId("cache-rule-prefixes")).toHaveValue("/s/");
  await expect(built.getByTestId("cache-rule-extensions")).toHaveValue("css, js");
  await check(page, "cache");

  // Back to the script's rules.
  await expression.getByTestId("cache-rule-browser-ttl").fill("120");
  await built.getByTestId("cache-rule-extensions").fill("");
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(expression.getByTestId("cache-rule-browser-ttl")).toHaveValue("120");
  await expect(built.getByTestId("cache-rule-extensions")).toHaveValue("");
  await logout(page);
  expect(pageErrors).toEqual([]);
});

test("G5: the origins tab edits origin groups and keeps the default group and used groups", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.org.id, "origins");
  const rows = page.getByTestId("origin-row");
  const save = page.getByTestId("origins-save");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("origin-group")).toHaveValue("");
  await expect(rows.nth(1).getByTestId("origin-group")).toHaveValue("api");
  await expect(page.getByTestId("origins-groups-unavailable")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // Requests without an origin rule need the default group.
  await rows.nth(0).getByTestId("origin-group").fill("web");
  await expect(page.getByTestId("origins-default-group-required")).toBeVisible();
  await expect(save).toBeDisabled();
  await rows.nth(0).getByTestId("origin-group").fill("");
  await expect(page.getByTestId("origins-default-group-required")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // The origin rule still sends /api/ to "api".
  await rows.nth(1).getByTestId("origin-group").fill("api2");
  await save.click();
  await expect(page.getByTestId("site-save-error")).toHaveText("规则无效");
  await rows.nth(1).getByTestId("origin-group").fill("api");
  await expect(save).toBeDisabled();

  // A third origin in a group of its own.
  await page.getByTestId("origin-add").click();
  await expect(rows).toHaveCount(3);
  await rows.nth(2).getByTestId("origin-address").fill("g4-origin-b");
  await rows.nth(2).getByTestId("origin-port").fill("8080");
  await rows.nth(2).getByTestId("origin-group").fill("spare");
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).getByTestId("origin-group")).toHaveValue("spare");
  await expect(rows.nth(1).getByTestId("origin-group")).toHaveValue("api");
  await check(page, "origins");

  await rows.nth(2).getByRole("button", { name: "移除", exact: true }).click();
  await saved(page, save, "sites/update");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(rows).toHaveCount(2);
  await logout(page);
  expect(pageErrors).toEqual([]);
});
