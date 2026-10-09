import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * G14 in the browser, on a site of its own created here through the UI (unique per run):
 * g14-ui-<run> (g14-ui-<run>.test, origin whoami) in the cluster scripts/e2e-g14.mjs checks the G14
 * features on (clusterId of .e2e/m6-upgrade-state.json; the form's first cluster without it). Its
 * rules get every new WAF action, a rate limit that bans over the limit, a config rule overriding
 * CRS and the rules body limit; its CRS card exclusions by path; its challenge settings verified
 * crawlers, page texts and failure bans. A platform rule bans everywhere. When scripts/e2e-g14.mjs
 * left g14-crs with CRS matches, "按路径排除" runs from its top rules list. Everything is removed at
 * the end: the platform rule, the entry added to g14-crs and the site (scripts/e2e-g14.mjs
 * --cleanup also removes g14-ui-* sites and g14-* platform rules a failed run leaves).
 */
const ADMIN = [
  process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
] as const;
const RUN = Date.now().toString(36);
const SITE = `g14-ui-${RUN}`;
const DOMAIN = `${SITE}.test`;
/** The platform rule (scripts/e2e-g14.mjs --cleanup removes g14-* platform rules). */
const PLATFORM_RULE = `g14-ui-${RUN}`;
/** The site scripts/e2e-g14.mjs leaves with CRS in block mode and matched rules. */
const CRS_SITE = "g14-crs";
const UPGRADE_STATE = resolve("../../.e2e/m6-upgrade-state.json");
const CLUSTER_ID = existsSync(UPGRADE_STATE)
  ? (JSON.parse(readFileSync(UPGRADE_STATE, "utf8")) as { clusterId?: string }).clusterId
  : undefined;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g14-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 1280 px (${scheme})`,
    ).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g14-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"], [data-testid="rule-row"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1)`,
      ),
      `${name}: content wider than its card, rule or dialog at 375 px (${scheme})`,
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

/** The rules of one phase section of the rules editor. */
const phaseRules = (page: Page, phase: string) =>
  page.getByTestId(`rules-phase-${phase}`).getByTestId("rule-row");

/** Adds a rule to a phase and names it and its condition; returns its row. */
async function addRule(page: Page, phase: string, name: string, expression: string) {
  const rows = phaseRules(page, phase);
  const before = await rows.count();
  await page.getByTestId(`rule-add-${phase}`).click();
  await expect(rows).toHaveCount(before + 1);
  const row = rows.nth(before);
  await row.getByLabel("名称", { exact: true }).fill(name);
  await row.getByLabel("表达式", { exact: true }).fill(expression);
  return row;
}

/** A rule row's id, as its fields' ids carry it. */
async function ruleId(row: Locator) {
  const id = (await row.getByLabel("动作", { exact: true }).getAttribute("id"))?.slice(
    "action-".length,
  );
  expect(id, "the rule's id in its action select").toBeTruthy();
  return id as string;
}

let siteId = "";

test("G14: the new WAF actions, rate limit bans, the CRS override and the rules body limit", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  // The cluster in the address is the new site's (the form's first cluster without one).
  await page.goto(CLUSTER_ID ? `/sites?cluster=${CLUSTER_ID}` : "/sites");
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill(SITE);
  await page.getByLabel("域名", { exact: true }).fill(DOMAIN);
  await page.getByLabel("源站地址", { exact: true }).fill("whoami");
  await page.getByTestId("create-site-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText(SITE);
  siteId = /\/sites\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  expect(siteId, "the new site's id in the address").not.toBe("");

  await page.goto(`/sites/${siteId}?tab=rules`);
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  // The cluster's nodes run waf-v2, rules-body-v1 and challenge-v2: nothing is locked.
  for (const id of ["rules-waf-v2", "rules-body", "rules-challenge-v2"])
    await expect(page.getByTestId(`${id}-unavailable`)).toHaveCount(0);

  // Ban: a custom duration and a /24; a site's rule has no scope to choose.
  const ban = await addRule(page, "waf-custom", "G14 ban", 'http.request.uri.path eq "/g14-trap"');
  await pick(page, ban.getByLabel("动作", { exact: true }), "封禁");
  await expect(ban.getByTestId("rule-ban-scope")).toHaveCount(0);
  await expect(ban.getByTestId("rule-ban-duration")).toHaveText("1 小时");
  await expect(ban.getByTestId("rule-ban-prefix-v4")).toHaveText("/32");
  await expect(ban.getByTestId("rule-ban-prefix-v6")).toHaveText("/64");
  await pick(page, ban.getByTestId("rule-ban-duration"), "自定义");
  await ban.getByTestId("rule-ban-seconds").fill("900");
  await pick(page, ban.getByTestId("rule-ban-prefix-v4"), "/24");

  // Custom response: the error page hides type and body, and is for 4xx and 5xx only.
  const respond = await addRule(
    page,
    "waf-custom",
    "G14 respond",
    'starts_with(http.request.uri.path, "/g14-respond")',
  );
  await pick(page, respond.getByLabel("动作", { exact: true }), "自定义响应");
  await expect(respond.getByTestId("rule-respond-status")).toHaveValue("403");
  await respond.getByTestId("rule-respond-error-page").click();
  await expect(respond.getByTestId("rule-respond-type")).toHaveCount(0);
  await expect(respond.getByTestId("rule-respond-body")).toHaveCount(0);
  await respond.getByTestId("rule-respond-status").fill("200");
  await expect(respond.getByTestId("rule-respond-error-page")).toHaveCount(0);
  await expect(respond.getByTestId("rule-respond-body")).toBeVisible();
  await respond.getByTestId("rule-respond-status").fill("503");
  await expect(respond.getByTestId("rule-respond-error-page")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await pick(page, respond.getByTestId("rule-respond-type"), "application/json");
  await respond.getByTestId("rule-respond-body").fill('{"g14":"maintenance"}');

  // Close.
  const close = await addRule(
    page,
    "waf-custom",
    "G14 close",
    'http.request.uri.path eq "/g14-close"',
  );
  await pick(page, close.getByLabel("动作", { exact: true }), "断开连接");

  // Skip: the remaining rules by default; CRS and challenges instead.
  const skip = await addRule(page, "waf-custom", "G14 skip", "ip.src in {192.0.2.14}");
  await pick(page, skip.getByLabel("动作", { exact: true }), "跳过");
  await expect(skip.getByTestId("rule-skip-rules")).toHaveAttribute("aria-checked", "true");
  await skip.getByTestId("rule-skip-crs").click();
  await skip.getByTestId("rule-skip-challenges").click();
  await skip.getByTestId("rule-skip-rules").click();
  await expect(skip.getByTestId("rule-skip-rules")).toHaveAttribute("aria-checked", "false");

  // Log with an access log line; its condition from the JSON template; the body and crawler
  // fields are offered in this phase.
  const log = await addRule(page, "waf-custom", "G14 log", "true");
  const logId = await ruleId(log);
  await page.getByTestId(`expr-${logId}-field`).click();
  await expect(
    page.getByRole("option", { name: "http.request.body.raw", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "http.request.bot.verified", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await pick(page, page.getByTestId(`expr-${logId}-template`), "JSON 字段等于");
  await expect(log.getByLabel("表达式", { exact: true })).toHaveValue(
    'json_value("user.role") eq "admin"',
  );
  await expect(log.getByRole("alert")).toHaveCount(0);
  await pick(page, log.getByLabel("动作", { exact: true }), "记录");
  await log.getByTestId("rule-log-access-log").click();
  await expect(log.getByTestId("rule-log-access-log")).toHaveAttribute("aria-checked", "true");

  // Rate limit: a ban under 60 seconds is refused when saving, naming the field.
  const rate = await addRule(page, "ratelimit", "G14 rate", 'http.request.uri.path eq "/g14-rate"');
  await expect(rate.getByTestId("rule-rate-ban")).toHaveValue("0");
  await rate.getByTestId("rule-rate-ban").fill("30");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("site-save-error")).toHaveText(
    "检查规则「G14 rate」的超额后封禁（秒）",
  );
  await rate.getByTestId("rule-rate-ban").fill("600");

  // Config: the request's CRS mode; a cache rule's body fields are not offered.
  const config = await addRule(
    page,
    "config",
    "G14 CRS detect",
    'starts_with(http.request.uri.path, "/g14-upload")',
  );
  await pick(page, config.getByTestId("rule-config-crs"), "仅检测");
  const cache = await addRule(page, "cache", "G14 cache", "true");
  await page.getByTestId(`expr-${await ruleId(cache)}-field`).click();
  await expect(page.getByRole("option", { name: "http.host", exact: true })).toBeVisible();
  await expect(
    page.getByRole("option", { name: "http.request.body.raw", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await cache.getByRole("button", { name: "删除", exact: true }).click();

  await check(page, "rules");
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  await expect(page.getByTestId("rules-save")).toBeDisabled();

  await page.reload();
  const waf = phaseRules(page, "waf-custom");
  await expect(waf).toHaveCount(5);
  await expect(waf.nth(0).getByLabel("动作", { exact: true })).toHaveText("封禁");
  await expect(waf.nth(0).getByTestId("rule-ban-duration")).toHaveText("自定义");
  await expect(waf.nth(0).getByTestId("rule-ban-seconds")).toHaveValue("900");
  await expect(waf.nth(0).getByTestId("rule-ban-prefix-v4")).toHaveText("/24");
  await expect(waf.nth(1).getByLabel("动作", { exact: true })).toHaveText("自定义响应");
  await expect(waf.nth(1).getByTestId("rule-respond-status")).toHaveValue("503");
  await expect(waf.nth(1).getByTestId("rule-respond-type")).toHaveText("application/json");
  await expect(waf.nth(1).getByTestId("rule-respond-body")).toHaveValue('{"g14":"maintenance"}');
  await expect(waf.nth(2).getByLabel("动作", { exact: true })).toHaveText("断开连接");
  await expect(waf.nth(3).getByLabel("动作", { exact: true })).toHaveText("跳过");
  for (const [target, checked] of [
    ["rules", "false"],
    ["rate_limits", "false"],
    ["crs", "true"],
    ["challenges", "true"],
  ] as const)
    await expect(waf.nth(3).getByTestId(`rule-skip-${target}`)).toHaveAttribute(
      "aria-checked",
      checked,
    );
  await expect(waf.nth(4).getByLabel("动作", { exact: true })).toHaveText("记录");
  await expect(waf.nth(4).getByTestId("rule-log-access-log")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(phaseRules(page, "ratelimit").first().getByTestId("rule-rate-ban")).toHaveValue(
    "600",
  );
  await expect(phaseRules(page, "config").first().getByTestId("rule-config-crs")).toHaveText(
    "仅检测",
  );
  await expect(phaseRules(page, "cache")).toHaveCount(0);

  // The rules body limit: 1024 to 1048576 bytes, saved with the content settings.
  const limit = page.getByTestId("rules-body-limit");
  await expect(limit).toHaveValue("65536");
  await expect(page.getByTestId("rules-body-limit-unavailable")).toHaveCount(0);
  await limit.fill("512");
  await expect(page.getByTestId("rules-body-limit-save")).toBeDisabled();
  await limit.fill("131072");
  await saved(page, page.getByTestId("rules-body-limit-save"), "sites/update");
  await expect(page.getByTestId("rules-body-limit-save")).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("rules-body-limit")).toHaveValue("131072");
  await check(page, "rules-saved");
  expect(pageErrors).toEqual([]);
});

test("G14: a platform rule bans everywhere", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/rules");
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  const rule = await addRule(
    page,
    "waf-custom",
    PLATFORM_RULE,
    `http.request.uri.path eq "/${PLATFORM_RULE}"`,
  );
  await pick(page, rule.getByLabel("动作", { exact: true }), "封禁");
  await expect(rule.getByTestId("rule-ban-scope")).toHaveText("本站");
  await pick(page, rule.getByTestId("rule-ban-scope"), "全局");
  await pick(page, rule.getByTestId("rule-ban-prefix-v6"), "/48");
  await saved(page, page.getByTestId("rules-save"), "platformRules/save");
  await expect(page.getByTestId("rules-save")).toBeDisabled();

  await page.reload();
  const kept = phaseRules(page, "waf-custom").last();
  await expect(kept.getByLabel("名称", { exact: true })).toHaveValue(PLATFORM_RULE);
  await expect(kept.getByTestId("rule-ban-scope")).toHaveText("全局");
  await expect(kept.getByTestId("rule-ban-prefix-v6")).toHaveText("/48");
  await check(page, "platform-rules");

  // The platform keeps no rule of this run.
  await kept.getByRole("button", { name: "删除", exact: true }).click();
  await saved(page, page.getByTestId("rules-save"), "platformRules/save");
  await page.reload();
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  const inputs = await phaseRules(page, "waf-custom").getByLabel("名称", { exact: true }).all();
  const names = await Promise.all(inputs.map((input) => input.inputValue()));
  expect(names).not.toContain(PLATFORM_RULE);
  expect(pageErrors).toEqual([]);
});

test("G14: CRS exclusions by path and target, and 按路径排除 from the top CRS rules", async ({
  page,
}) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  await page.goto(`/sites/${siteId}?tab=security`);
  await expect(page.getByTestId("waf-card")).toBeVisible();
  await expect(page.getByTestId("waf-exclusion-entries-unavailable")).toHaveCount(0);
  // Every path: the chips.
  await page.getByTestId("waf-exclusion-input").fill("942100");
  await page.getByTestId("waf-exclusion-add").click();
  await expect(page.getByTestId("waf-exclusion")).toHaveCount(1);

  // By path and target: refused with a bad path, then added and edited in the dialog.
  const entries = page.getByTestId("waf-exclusion-entry");
  await expect(entries).toHaveCount(0);
  await page.getByTestId("waf-exclusion-entry-add").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("exclusion-path").fill("/g14 editor");
  await dialog.getByTestId("exclusion-rule-ids").fill("941100, 941160");
  await dialog.getByTestId("exclusion-submit").click();
  await expect(dialog.getByTestId("form-error")).toHaveText("路径以 / 开头，不含 ?、# 或空白");
  await dialog.getByTestId("exclusion-path").fill("/g14/editor");
  await pick(page, dialog.getByTestId("exclusion-match"), "精确");
  await dialog.getByTestId("exclusion-targets").fill("ARGS:html, ARGS_NAMES:x");
  await dialog.getByTestId("exclusion-submit").click();
  await expect(dialog.getByTestId("form-error")).toHaveText(
    "目标为 ARGS:名称、REQUEST_COOKIES:名称 或 REQUEST_HEADERS:名称，最多 16 个",
  );
  await dialog.getByTestId("exclusion-targets").fill("ARGS:html");
  await check(page, "exclusion-dialog");
  await dialog.getByTestId("exclusion-submit").click();
  await expect(dialog).toBeHidden();
  await expect(entries).toHaveCount(1);
  await expect(entries.first().getByTestId("waf-exclusion-entry-path")).toHaveText("/g14/editor");
  await expect(entries.first().getByTestId("waf-exclusion-entry-match")).toHaveText("精确");
  await expect(entries.first().getByTestId("waf-exclusion-entry-rules")).toHaveText(
    "941100 941160",
  );
  await expect(entries.first().getByTestId("waf-exclusion-entry-targets")).toHaveText("ARGS:html");

  await entries.first().getByTestId("waf-exclusion-entry-edit").click();
  await expect(dialog.getByTestId("exclusion-path")).toHaveValue("/g14/editor");
  await expect(dialog.getByTestId("exclusion-targets")).toHaveValue("ARGS:html");
  await pick(page, dialog.getByTestId("exclusion-match"), "前缀");
  await dialog.getByTestId("exclusion-path").fill("/g14/editor/");
  await dialog.getByTestId("exclusion-targets").fill("");
  await dialog.getByTestId("exclusion-submit").click();
  await expect(dialog).toBeHidden();
  await expect(entries.first().getByTestId("waf-exclusion-entry-match")).toHaveText("前缀");
  await expect(entries.first().getByTestId("waf-exclusion-entry-targets")).toHaveCount(0);
  await saved(page, page.getByTestId("waf-save"), "waf/update");
  await expect(page.getByTestId("waf-save")).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId("waf-exclusion")).toHaveCount(1);
  await expect(page.getByTestId("waf-exclusion").first()).toHaveAttribute("data-rule-id", "942100");
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveAttribute("data-path", "/g14/editor/");
  await check(page, "waf-card");

  // Removing the path entry keeps the rules every path skips.
  await entries.first().getByTestId("waf-exclusion-entry-remove").click();
  await expect(entries).toHaveCount(0);
  await saved(page, page.getByTestId("waf-save"), "waf/update");
  await page.reload();
  await expect(entries).toHaveCount(0);
  await expect(page.getByTestId("waf-exclusion")).toHaveCount(1);

  // From the top CRS rules of the site scripts/e2e-g14.mjs leaves with matches, if it is there.
  await page.goto(`/sites?q=${CRS_SITE}`);
  await expect(
    page.getByTestId("site-link").first().or(page.getByText("没有匹配的网站")),
  ).toBeVisible();
  const link = page.getByTestId("site-link").filter({ hasText: new RegExp(`^${CRS_SITE}$`) });
  if ((await link.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: `${CRS_SITE} is not there` });
  } else {
    await link.click();
    await expect(page.getByTestId("page-title")).toHaveText(CRS_SITE);
    await page.getByTestId("tab-security").click();
    const top = page.getByTestId("waf-top-rules");
    const item = top
      .locator("li")
      .filter({ has: page.getByTestId("row-actions") })
      .first();
    await expect(item).toBeVisible();
    const ruleIdText = (await item.locator("span").first().innerText()).trim();
    const path = `/${SITE}/`;
    await item.getByTestId("row-actions").click();
    await page.getByTestId("waf-top-exclude-path").click();
    await expect(dialog.getByTestId("exclusion-rule-ids")).toHaveValue(ruleIdText);
    await expect(dialog.getByTestId("exclusion-path")).toHaveValue("");
    await dialog.getByTestId("exclusion-submit").click();
    await expect(dialog.getByTestId("form-error")).toHaveText("请填写路径");
    await dialog.getByTestId("exclusion-path").fill(path);
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/waf/update") && response.request().method() === "POST",
    );
    await dialog.getByTestId("exclusion-submit").click();
    expect((await answered).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    const added = page.locator(`[data-testid="waf-exclusion-entry"][data-path="${path}"]`);
    await expect(added).toHaveCount(1);
    await expect(added.getByTestId("waf-exclusion-entry-rules")).toHaveText(ruleIdText);
    // The site keeps the exclusions it had.
    await added.getByTestId("waf-exclusion-entry-remove").click();
    await saved(page, page.getByTestId("waf-save"), "waf/update");
    await page.reload();
    await expect(page.getByTestId("waf-card")).toBeVisible();
    await expect(added).toHaveCount(0);
  }
  expect(pageErrors).toEqual([]);
});

test("G14: verified crawlers, challenge page texts and challenge failure bans", async ({
  page,
}) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${siteId}?tab=security`);
  await expect(page.getByTestId("protection-verified-bots")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("protection-challenge-v2-unavailable")).toHaveCount(0);
  await page.getByTestId("protection-verified-bots").click();
  // Failure bans start from the defaults.
  await expect(page.getByTestId("protection-failure-threshold")).toHaveCount(0);
  await page.getByTestId("protection-failure-ban-enabled").click();
  await expect(page.getByTestId("protection-failure-threshold")).toHaveValue("10");
  await expect(page.getByTestId("protection-failure-ban-seconds")).toHaveValue("600");
  await page.getByTestId("protection-failure-threshold").fill("5");
  await page.getByTestId("protection-failure-ban-seconds").fill("900");
  await page.getByTestId("protection-text-titleZh").fill("G14 正在确认访问");
  await page.getByTestId("protection-text-hintZh").fill("请稍候 <b>片刻</b>");
  await page.getByTestId("protection-text-titleEn").fill("G14 checking your visit");
  await saved(page, page.getByTestId("protection-save"), "protection/update");
  await expect(page.getByTestId("protection-save")).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId("protection-verified-bots")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("protection-failure-ban-enabled")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("protection-failure-threshold")).toHaveValue("5");
  await expect(page.getByTestId("protection-failure-ban-seconds")).toHaveValue("900");
  await expect(page.getByTestId("protection-text-titleZh")).toHaveValue("G14 正在确认访问");
  await expect(page.getByTestId("protection-text-hintZh")).toHaveValue("请稍候 <b>片刻</b>");
  await expect(page.getByTestId("protection-text-titleEn")).toHaveValue("G14 checking your visit");
  await expect(page.getByTestId("protection-text-hintEn")).toHaveValue("");
  await check(page, "security");
  expect(pageErrors).toEqual([]);
});

test("G14: the bans list filters rule bans", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/bans");
  await pick(page, page.getByTestId("ban-filter-source"), "规则");
  await expect(page.getByTestId("ban-filter-source")).toHaveText("规则");
  // Rule bans scripts/e2e-g14.mjs left, each with its rule; or none.
  // The list keeps the unfiltered rows until the filtered ones arrive: wait for those.
  const table = page.getByTestId("bans-table");
  const sources = table.getByTestId("ban-source");
  await expect(sources.filter({ hasNotText: "规则" })).toHaveCount(0);
  await expect(table.or(page.getByText("没有符合条件的封禁"))).toBeVisible();
  if (await table.isVisible())
    await expect(table.getByTestId("ban-rule")).toHaveCount(await sources.count());
  await check(page, "bans-rule");
  await pick(page, page.getByTestId("ban-filter-source"), "全部来源");
  await expect(page.getByTestId("ban-filter-source")).toHaveText("全部来源");
  expect(pageErrors).toEqual([]);
});

test("G14: the site goes", async ({ page }) => {
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
