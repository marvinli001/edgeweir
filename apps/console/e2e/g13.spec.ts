import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * G13 access control in the browser, on data of its own created here through the UI (unique per
 * run): the IP list g13_ui_<run> (供规则引用, 100.64.13.77 and 2001:db8:13::/48) and the site
 * g13-ui-<run> (g13-ui-<run>.test, origin whoami) in the default cluster that scripts/e2e-g13.mjs
 * checks access-control-v1 on (clusterId of .e2e/m6-upgrade-state.json; the form's first cluster
 * without it). The site ends with the list as its block list, hotlink protection, a user agent
 * rule, CORS, WebSocket origins and security headers. Both stay after the run: remove the site
 * first, then the list (a site's list cannot be deleted).
 */
const ADMIN = [
  process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
] as const;
const RUN = Date.now().toString(36);
const SITE = `g13-ui-${RUN}`;
const DOMAIN = `${SITE}.test`;
const LIST = `g13_ui_${RUN}`;
/** On the list only: no global list or ban of the other specs covers it. */
const ADDRESS = "100.64.13.77";
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
      path: `../../.e2e/g13-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 1280 px (${scheme})`,
    ).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g13-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1)`,
      ),
      `${name}: content wider than its card or dialog at 375 px (${scheme})`,
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

const CARDS = ["site-lists", "geo", "hotlink", "ua", "cors", "websocket", "headers"] as const;

let siteId = "";

test("G13: every access control card renders and saves", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  // The IP list the site will block.
  await page.goto("/ip-lists");
  await page.getByTestId("ip-list-create").click();
  await page.getByRole("dialog").getByLabel("名称", { exact: true }).fill(LIST);
  await page.getByLabel("IP 地址和 CIDR").fill(`${ADDRESS}\n2001:db8:13::/48`);
  await page.getByTestId("ip-list-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(`$${LIST}`, { exact: true })).toBeVisible();

  // The site.
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

  await page.goto(`/sites/${siteId}?tab=access`);
  for (const card of [...CARDS, "ip-check"])
    await expect(page.getByTestId(`${card}-card`)).toBeVisible();
  // The cluster's nodes run access-control-v1: no card says they cannot.
  for (const card of CARDS) await expect(page.getByTestId(`${card}-unavailable`)).toHaveCount(0);
  // A new site: everything off, the user agent list empty, the defaults in place.
  await expect(page.getByTestId("hotlink-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("ua-add-empty")).toBeVisible();
  await expect(page.getByTestId("websocket-idle")).toHaveValue("3600");
  await check(page, "access-new");

  // Site lists: the list as a block list; the allow side's checkbox for it waits.
  await page.getByTestId(`site-block-lists-${LIST}`).click();
  await expect(page.getByTestId("site-block-lists-count")).toHaveText("1");
  await expect(
    page.getByTestId(`site-allow-lists-${LIST}`).locator('[data-slot="checkbox"]'),
  ).toHaveAttribute("data-disabled", "");
  await saved(page, page.getByTestId("site-lists-save"), "accessControl/update");

  // Geo: on without a country, subdivision or ASN is refused in the browser, naming the field.
  await page.getByTestId("geo-enabled").click();
  await expect(page.getByTestId("geo-mode")).toBeVisible();
  await page.getByTestId("geo-save").click();
  await expect(page.getByTestId("geo-error")).toHaveText("检查「国家（ISO 代码）」");
  await page.getByTestId("geo-enabled").click();
  await expect(page.getByTestId("geo-save")).toBeDisabled();

  // Hotlink: on, the extensions start as the defaults; a denied source; a bad one is named first.
  await page.getByTestId("hotlink-enabled").click();
  await expect(page.getByTestId("hotlink-extensions")).toHaveValue(/^jpg, jpeg, png, gif/);
  await page.getByTestId("hotlink-denied").fill("leech.example\nnot a host");
  await page.getByTestId("hotlink-save").click();
  await expect(page.getByTestId("hotlink-error")).toHaveText("检查「禁止的来源」第 2 项");
  await page.getByTestId("hotlink-denied").fill("leech.example\n.leech.example");
  await saved(page, page.getByTestId("hotlink-save"), "accessControl/update");

  // User agents: one deny rule.
  await page.getByTestId("ua-add-empty").click();
  await expect(page.getByTestId("ua-rule-action")).toHaveText("拒绝");
  await page.getByTestId("ua-rule-pattern").fill("*g13-scanner*");
  await saved(page, page.getByTestId("ua-save"), "accessControl/update");

  // CORS: credentials cannot go with "*"; then one origin with credentials.
  await page.getByTestId("cors-enabled").click();
  await page.getByTestId("cors-origins").fill("*");
  await page.getByTestId("cors-credentials").click();
  await page.getByTestId("cors-save").click();
  await expect(page.getByTestId("cors-error")).toHaveText("允许凭据时来源不能用 *");
  await page.getByTestId("cors-origins").fill("https://app.g13.test");
  await saved(page, page.getByTestId("cors-save"), "accessControl/update");

  // WebSocket: listed origins only, a shorter idle timeout.
  await pick(page, page.getByTestId("websocket-origins-mode"), "仅允许列表中的来源");
  await page.getByTestId("websocket-origins").fill("https://app.g13.test");
  await page.getByTestId("websocket-idle").fill("600");
  await saved(page, page.getByTestId("websocket-save"), "accessControl/update");

  // Security headers.
  await page.getByTestId("headers-nosniff").click();
  await pick(page, page.getByTestId("headers-frame"), "DENY");
  await pick(page, page.getByTestId("headers-referrer"), "strict-origin-when-cross-origin");
  await page.getByTestId("headers-hide-server").click();
  await saved(page, page.getByTestId("headers-save"), "accessControl/update");

  // Every card saved its own part: after a reload all of them are there, and nothing is unsaved.
  await page.reload();
  await expect(page.getByTestId("site-block-lists-count")).toHaveText("1");
  await expect(page.getByTestId("geo-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("hotlink-enabled")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("hotlink-denied")).toHaveValue("leech.example\n.leech.example");
  await expect(page.getByTestId("ua-rule-pattern")).toHaveValue("*g13-scanner*");
  await expect(page.getByTestId("cors-origins")).toHaveValue("https://app.g13.test");
  await expect(page.getByTestId("cors-credentials")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("websocket-origins")).toHaveValue("https://app.g13.test");
  await expect(page.getByTestId("websocket-idle")).toHaveValue("600");
  await expect(page.getByTestId("headers-nosniff")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("headers-frame")).toHaveText("DENY");
  await expect(page.getByTestId("headers-referrer")).toHaveText("strict-origin-when-cross-origin");
  for (const card of CARDS) await expect(page.getByTestId(`${card}-save`)).toBeDisabled();
  await check(page, "access-saved");
  expect(pageErrors).toEqual([]);
});

test("G13: the IP check on the access tab and on the IP lists page", async ({ page }) => {
  expect(siteId, "the first test created the site").not.toBe("");
  const pageErrors = errors(page);
  await login(page, ...ADMIN);

  // On the site: the address is on its block list.
  await page.goto(`/sites/${siteId}?tab=access`);
  const card = page.getByTestId("ip-check-card");
  await card.getByTestId("ip-check-input").fill(ADDRESS);
  await card.getByTestId("ip-check-submit").click();
  await expect(card.getByTestId("ip-check-address")).toHaveText(ADDRESS);
  await expect(card.getByTestId("ip-check-verdict")).toHaveText("本站拦截名单拦截");
  const row = card.getByTestId("ip-check-list").filter({ hasText: `$${LIST}` });
  await expect(row).toContainText(`${ADDRESS}/32`);
  await expect(row.getByTestId("ip-check-site-role")).toHaveText("本站拦截");
  await expect(card.getByTestId("ip-check-cluster")).toHaveCount(1);
  await expect(card.getByTestId("ip-check-geoip")).toHaveText("不检查地区（GeoIP）");
  await check(page, "ip-check-card");

  // An address that is not one is named in the console's language.
  await card.getByTestId("ip-check-input").fill("100.64.13.300");
  await card.getByTestId("ip-check-submit").click();
  await expect(card.getByTestId("ip-check-error")).toHaveText("IP 地址无效");

  // On the IP lists page: for the site, then for no site.
  await page.goto("/ip-lists");
  await page.getByTestId("ip-check-open").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("搜索网站", { exact: true }).fill(SITE);
  await pick(page, dialog.getByTestId("ip-check-site"), SITE);
  await dialog.getByTestId("ip-check-input").fill("2001:db8:13::1");
  await dialog.getByTestId("ip-check-submit").click();
  await expect(dialog.getByTestId("ip-check-verdict")).toHaveText("本站拦截名单拦截");
  await expect(dialog.getByTestId("ip-check-list").filter({ hasText: `$${LIST}` })).toContainText(
    "2001:db8:13::/48",
  );
  await check(page, "ip-lists-check");

  await pick(page, dialog.getByTestId("ip-check-site"), "不选网站");
  await dialog.getByTestId("ip-check-submit").click();
  await expect(dialog.getByTestId("ip-check-verdict")).toHaveCount(0);
  const listRow = dialog.getByTestId("ip-check-list").filter({ hasText: `$${LIST}` });
  await expect(listRow).toBeVisible();
  await expect(listRow.getByTestId("ip-check-site-role")).toHaveCount(0);
  await expect(dialog.getByTestId("ip-check-cluster").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
