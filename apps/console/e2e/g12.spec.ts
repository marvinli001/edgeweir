import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * Written by scripts/e2e-g12.mjs: g12-basic (Basic on /private/, users alice and bob), g12-url
 * (signed URLs A for .mp4, B under /b/, C under /c/, D for the rest) and g12-fwd (forward
 * authentication), with failures counted on g12-basic. The sites are removed by
 * `node scripts/e2e-g12.mjs --cleanup`.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g12-state.json"), "utf8")) as {
  basicSiteId: string;
  urlSiteId: string;
  fwdSiteId: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g12-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g12-${name}-${scheme}-375.png`,
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

const kinds = (page: Page) => page.getByTestId("auth-rule-kind");

test("G12: access authentication rules: add, edit, reorder, delete", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.urlSiteId}?tab=access`);
  await expect(kinds(page)).toHaveText(["URL 鉴权 A", "URL 鉴权 B", "URL 鉴权 C", "URL 鉴权 D"]);
  await check(page, "access-rules");

  await page.goto(`/sites/${state.basicSiteId}?tab=access`);
  await expect(kinds(page)).toHaveText(["Basic 认证"]);
  // The saved users: names only, passwords write-only.
  await page.getByTestId("auth-rule-edit").first().click();
  await expect(page.getByTestId("auth-user-name")).toHaveCount(2);
  await expect(page.getByTestId("auth-user-password").first()).toHaveAttribute(
    "placeholder",
    "已保存，留空不修改",
  );
  await expect(page.getByTestId("auth-user-password").first()).toHaveValue("");
  await check(page, "access-basic-dialog");
  await page.keyboard.press("Escape");

  // A new rule: signed URLs of kind B under /videos/, with a generated key.
  await page.getByTestId("auth-add").click();
  await pick(page, page.getByTestId("auth-kind"), "URL 鉴权 B");
  await page.getByTestId("auth-prefixes").fill("/videos/");
  await page.getByTestId("auth-primary-generate").click();
  await expect(page.getByTestId("auth-key-generated")).toBeVisible();
  await expect(page.getByTestId("auth-primary-key")).toHaveValue(/^[A-Za-z0-9]{32}$/);
  await check(page, "access-url-dialog");
  await page.getByTestId("auth-rule-done").click();
  await expect(kinds(page)).toHaveText(["Basic 认证", "URL 鉴权 B"]);
  await saved(page, page.getByTestId("auth-save"), "authRules/update");
  await page.reload();
  await expect(kinds(page)).toHaveText(["Basic 认证", "URL 鉴权 B"]);

  // Edit its validity, move it first.
  await page.getByTestId("auth-rule-edit").nth(1).click();
  await expect(page.getByTestId("auth-primary-key")).toHaveAttribute(
    "placeholder",
    "已保存，留空不修改",
  );
  await page.getByTestId("auth-validity").fill("600");
  await page.getByTestId("auth-rule-done").click();
  await page.getByRole("button", { name: "上移" }).nth(1).click();
  await expect(kinds(page)).toHaveText(["URL 鉴权 B", "Basic 认证"]);
  await saved(page, page.getByTestId("auth-save"), "authRules/update");
  await page.reload();
  await expect(kinds(page)).toHaveText(["URL 鉴权 B", "Basic 认证"]);

  // Sign a URL with it, in the console.
  await page.getByTestId("auth-rule-sign").first().click();
  await page.getByTestId("auth-sign-url").fill("/videos/intro.mp4");
  await page.getByTestId("auth-sign-validity").fill("120");
  await page.getByTestId("auth-sign-submit").click();
  await expect(page.getByTestId("auth-signed-url")).toHaveText(
    /^\/[0-9]+\/[0-9a-f]{32}\/videos\/intro\.mp4$/,
  );
  await check(page, "access-sign");
  await page.keyboard.press("Escape");

  // Delete it again.
  await page.getByTestId("auth-rule-delete").first().click();
  await expect(kinds(page)).toHaveText(["Basic 认证"]);
  await saved(page, page.getByTestId("auth-save"), "authRules/update");
  await page.reload();
  await expect(kinds(page)).toHaveText(["Basic 认证"]);
  expect(pageErrors).toEqual([]);
});

test("G12: failures on the security tab, an empty access tab", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.basicSiteId}?tab=security`);
  await expect(page.getByTestId("auth-failures-count")).not.toHaveText("0");
  await page.getByTestId("auth-failures-card").scrollIntoViewIfNeeded();
  await check(page, "security-failures");

  await page.goto(`/sites/${state.fwdSiteId}?tab=access`);
  await expect(kinds(page)).toHaveCount(5);
  // Remove every rule: the empty state with its action.
  for (let i = 0; i < 5; i++) await page.getByTestId("auth-rule-delete").first().click();
  await expect(page.getByTestId("auth-add-empty")).toBeVisible();
  await check(page, "access-empty");
  expect(pageErrors).toEqual([]);
});
