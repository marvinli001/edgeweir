import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { login, pick } from "./helpers";

/**
 * Written by scripts/e2e-g8.mjs: hdr.g8.test on the default cluster (two nodes with rules-v3)
 * with computed request and response headers, two Link lines added with append, a User-Agent
 * wildcard, a Cookie block, a redirect to http.request.uri.args["next"], a 303 with a computed
 * query parameter and a 403 page with {{time}} and {{path}}; legacy.g8.test on cluster g8-legacy,
 * whose only node predates G8 (rules-v2 without rules-v3). Nothing here is saved.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g8-state.json"), "utf8")) as {
  hdrSiteId: string;
  legacySiteId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g8-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g8-${name}-${scheme}-375.png`,
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

async function openTab(page: Page, siteId: string, tab: "rules" | "errors") {
  await page.goto(`/sites/${siteId}?tab=${tab}`);
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

const phaseRules = (page: Page, phase: string) =>
  page.getByTestId(`rules-phase-${phase}`).getByTestId("rule-row");
/** The rule of a phase whose name is `name`. */
async function ruleNamed(page: Page, phase: string, name: string): Promise<Locator> {
  const rows = phaseRules(page, phase);
  await expect(rows.first()).toBeVisible();
  for (let i = 0; i < (await rows.count()); i++)
    if ((await rows.nth(i).getByLabel("名称", { exact: true }).inputValue()) === name)
      return rows.nth(i);
  throw new Error(`no ${phase} rule named ${name}`);
}

test("G8: header value expressions, response header lines, 303 and computed query parameters", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.hdrSiteId, "rules");
  const save = page.getByTestId("rules-save");
  await expect(page.getByTestId("rules-v3-unavailable")).toHaveCount(0);

  await test.step("a request header computed from ip.geoip.country", async () => {
    const row = await ruleNamed(page, "origin", "g8 country");
    await expect(row.getByTestId("rule-header-name")).toHaveValue("x-client-country");
    await expect(row.getByRole("tab", { name: "表达式", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(row.getByTestId("rule-header-value")).toHaveValue("ip.geoip.country");
    await expect(row.getByRole("alert")).toHaveCount(0);
    // Static and back keeps the expression: nothing to save.
    await row.getByRole("tab", { name: "静态", exact: true }).click();
    await expect(row.getByTestId("rule-header-value")).toHaveValue("");
    await expect(save).toBeEnabled();
    await row.getByRole("tab", { name: "表达式", exact: true }).click();
    await expect(row.getByTestId("rule-header-value")).toHaveValue("ip.geoip.country");
    await expect(save).toBeDisabled();
  });

  await test.step("response headers: a static Link line added with append, a computed one", async () => {
    const preload = await ruleNamed(page, "response-transform", "g8 link preload");
    await expect(preload.getByTestId("rule-header-append")).toHaveAttribute("aria-checked", "true");
    await expect(preload.getByRole("tab", { name: "静态", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(preload.getByTestId("rule-header-value")).toHaveValue("</a.css>; rel=preload");
    const status = await ruleNamed(page, "response-transform", "g8 cache status");
    await expect(status.getByTestId("rule-header-value")).toHaveValue("http.response.cache_status");
    await expect(status.getByTestId("rule-header-append")).toHaveAttribute("aria-checked", "false");
    // Removing a header hides its value and append; turning it back keeps neither.
    await status.getByTestId("rule-header-remove").click();
    await expect(status.getByTestId("rule-header-value")).toHaveCount(0);
    await expect(status.getByTestId("rule-header-append")).toHaveCount(0);
  });

  await test.step("303 with a computed next parameter", async () => {
    const login303 = await ruleNamed(page, "redirect", "g8 login");
    await expect(login303.getByLabel("状态码", { exact: true })).toHaveText("303");
    const param = login303.getByTestId("rule-set-query");
    await expect(param.getByTestId("rule-set-query-name")).toHaveValue("next");
    await expect(param.getByTestId("rule-set-query-expression")).toHaveValue(
      'http.request.uri.args["next"]',
    );
    // A broken expression says where and why.
    await param.getByTestId("rule-set-query-expression").fill('http.request.uri.args["a&b"]');
    await expect(param.getByRole("alert")).toHaveText("第 23 个字符：查询参数名称无效");
  });
  await check(page, "rules");
  // Leave without saving: reload drops the edits.
  await page.reload();
  const reloaded = await ruleNamed(page, "response-transform", "g8 cache status");
  await expect(reloaded.getByTestId("rule-header-value")).toHaveValue("http.response.cache_status");
  expect(pageErrors).toEqual([]);
});

test("G8: the field menu inserts cookies, query parameters and headers by name; new condition templates", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.hdrSiteId, "rules");
  await page.getByTestId("rule-add-waf-custom").click();
  const added = phaseRules(page, "waf-custom").last();
  const expression = added.locator("textarea");
  const id = (await expression.getAttribute("id")) ?? "";

  await test.step("Cookie equals, User-Agent and Referer wildcards", async () => {
    await pick(page, page.getByTestId(`${id}-template`), "Cookie 等于");
    await expect(expression).toHaveValue('http.request.cookies["session"] eq "value"');
    // The template's name is selected once the menu hands focus back: typing replaces it.
    await expect(expression).toBeFocused();
    await expect
      .poll(() =>
        expression.evaluate((el: { value: string; selectionStart: number; selectionEnd: number }) =>
          el.value.slice(el.selectionStart, el.selectionEnd),
        ),
      )
      .toBe("session");
    await page.keyboard.type("sid");
    await expect(expression).toHaveValue('http.request.cookies["sid"] eq "value"');
    await pick(page, page.getByTestId(`${id}-template`), "User-Agent 通配");
    await pick(page, page.getByTestId(`${id}-template`), "Referer 通配");
    await expect(expression).toHaveValue(
      'http.request.cookies["sid"] eq "value" and http.user_agent wildcard "*bot*" and http.referer wildcard "*://*.example.com/*"',
    );
    await expect(added.getByRole("alert")).toHaveCount(0);
  });

  await test.step("a query parameter by name, refused names stay out", async () => {
    await pick(page, page.getByTestId(`${id}-field`), "查询参数");
    const name = page.getByTestId(`${id}-named-name`);
    await expect(name).toBeFocused();
    await name.fill("a&b");
    await expect(page.getByTestId(`${id}-named-insert`)).toBeDisabled();
    await name.fill("page");
    await name.press("Enter");
    await expect(page.getByTestId(`${id}-named`)).toHaveCount(0);
    await expect(expression).toHaveValue(/ and http\.request\.uri\.args\["page"\] $/);
    // A field alone is not a condition yet.
    await expect(added.getByRole("alert")).toContainText("个字符");
    await pick(page, page.getByTestId(`${id}-field`), "请求头");
    await page.getByTestId(`${id}-named-name`).fill("X-Token");
    await page.getByTestId(`${id}-named-insert`).click();
    await expect(expression).toHaveValue(/http\.request\.headers\["X-Token"\] $/);
  });
  await check(page, "insert");
  await page.reload();
  expect(pageErrors).toEqual([]);
});

test("G8: error pages list {{time}} and {{path}}", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.hdrSiteId, "errors");
  const variables = page.getByTestId("error-page-variables");
  await expect(variables).toContainText("{{time}}");
  await expect(variables).toContainText("{{path}}");
  await expect(page.getByTestId("error-page-403")).toHaveValue(
    "<p>g8 {{status}} at {{time}} for {{path}}</p>",
  );
  await expect(page.getByTestId("error-pages-v3-unavailable")).toHaveCount(0);
  await check(page, "errors");
  expect(pageErrors).toEqual([]);
});

test("G8: a cluster with a node without rules-v3 locks the additions", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await openTab(page, state.legacySiteId, "rules");
  await expect(page.getByTestId("rules-v3-unavailable")).toHaveText(
    "所在集群有节点不支持，暂时无法开启",
  );
  await expect(page.getByTestId("rules-v2-unavailable")).toHaveCount(0);
  const row = await ruleNamed(page, "request-transform", "g8 old");
  await expect(row.getByTestId("rule-header-value")).toHaveValue("2");
  await expect(row.getByRole("tab", { name: "表达式", exact: true })).toBeDisabled();
  const id = (await row.locator("textarea").getAttribute("id")) ?? "";
  // The menus leave the rules-v3 fields and templates out.
  await page.getByTestId(`${id}-field`).click();
  await expect(page.getByRole("option", { name: "http.host", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "请求头", exact: true })).toBeVisible();
  for (const option of ["Cookie", "查询参数", "http.user_agent", "http.request.id"])
    await expect(page.getByRole("option", { name: option, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId(`${id}-template`).click();
  await expect(page.getByRole("option", { name: "Host 等于", exact: true })).toBeVisible();
  for (const option of ["Cookie 等于", "查询参数等于", "User-Agent 通配", "Referer 通配"])
    await expect(page.getByRole("option", { name: option, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await check(page, "legacy-rules");

  await openTab(page, state.legacySiteId, "errors");
  const variables = page.getByTestId("error-page-variables");
  await expect(variables).toContainText("{{host}}");
  await expect(variables).not.toContainText("{{time}}");
  await page.getByTestId("error-page-503").fill("<p>{{path}}</p>");
  await expect(page.getByTestId("error-pages-v3-unavailable")).toHaveText(
    "所在集群有节点不支持，暂时无法开启",
  );
  await check(page, "legacy-errors");
  await page.reload();
  expect(pageErrors).toEqual([]);
});
