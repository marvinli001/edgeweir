import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Locator, type Page, request } from "@playwright/test";

const OPERATOR = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  password: process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
};

/**
 * For tests that only need the signed-in operator: every test starts with the operator's
 * session, kept as Playwright storage state in .e2e/ (one file per console) for the next tests
 * and spec runs. A missing session, or one that no longer holds (a test signed out, the stack
 * was reset), is replaced by a sign-in through the API before the test starts. The login form
 * itself is tested with `login` (smoke.spec.ts).
 */
export const test = base.extend({
  storageState: async ({ baseURL }, use) => {
    await use(await operatorSession(baseURL ?? "http://localhost:13000"));
  },
});

/** The storage state file of the operator's session, signed in again when it no longer holds. */
async function operatorSession(baseURL: string): Promise<string> {
  const url = new URL(baseURL);
  const dir = resolve("../../.e2e");
  mkdirSync(dir, { recursive: true });
  // A parallel lane of scripts/e2e.sh (E2E_LANE) keeps a session of its own: another lane's
  // specs sign out.
  const lane = process.env.E2E_LANE ? `-${process.env.E2E_LANE}` : "";
  const file = resolve(dir, `operator-session-${url.port || "80"}${lane}.json`);
  if (existsSync(file)) {
    const context = await request.newContext({ baseURL, storageState: file });
    const response = await context.get("/api/auth/get-session");
    const session = response.ok() ? await response.json() : null;
    await context.dispose();
    if (session?.user?.email === OPERATOR.email) return file;
  }
  const context = await request.newContext({ baseURL });
  // better-auth rate-limits sign-ins (3 per 10 s per client); X-Retry-After says when to retry.
  for (let attempt = 1; ; attempt++) {
    const response = await context.post("/api/auth/sign-in/email", {
      headers: { origin: url.origin },
      data: OPERATOR,
    });
    if (response.status() !== 429) {
      expect(response.status(), `sign-in: ${await response.text()}`).toBe(200);
      break;
    }
    expect(attempt, "still rate-limited after retries").toBeLessThan(4);
    const seconds = Number(response.headers()["x-retry-after"]);
    await new Promise((r) => setTimeout(r, (seconds > 0 ? seconds : 11) * 1000 + 250));
  }
  await context.storageState({ path: file });
  await context.dispose();
  return file;
}

/** Opens the console's overview with the session the test started with (see `test`). */
export async function signedIn(page: Page) {
  await page.goto("/overview");
  await expect(page.getByTestId("page-title")).toHaveText("概览");
}

/**
 * Signs in through the login form. better-auth rate-limits sign-ins (3 per 10 s per client), and
 * the e2e run signs in several times in a row, so a rate-limited attempt waits and tries again,
 * as a person would.
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  for (let attempt = 1; ; attempt++) {
    await page.getByTestId("login-submit").click();
    const title = page.getByTestId("page-title");
    const error = page.getByTestId("login-error");
    await expect(title.or(error)).toBeVisible();
    if (await title.isVisible()) break;
    await expect(error).toHaveText("请求太频繁，请稍后再试");
    expect(attempt, "still rate-limited after retries").toBeLessThan(4);
    await page.waitForTimeout(11_000);
  }
  await expect(page.getByTestId("page-title")).toHaveText("概览");
}

export async function logout(page: Page) {
  await page.getByTestId("user-menu").click();
  // By keyboard: while the menu animates in, the pointer can come to rest on the language submenu's
  // trigger, which opens on hover and then covers the item.
  await page.getByTestId("logout").press("Enter");
  await expect(page).toHaveURL(/\/login/);
}

/** Opens a Base UI select and picks an option by its visible label. */
export async function pick(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * Clicks a save button and waits for its RPC to answer: the button turns
 * disabled while the mutation is still pending, so a reload right after the
 * click could read the old value.
 */
export async function saved(page: Page, save: Locator, procedure: string) {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/rpc/${procedure}`) && response.request().method() === "POST",
  );
  await save.click();
  expect((await answered).ok()).toBe(true);
}

/**
 * Full-page screenshots of the current page in light and dark, at 1280 and 375 px wide, as
 * `.e2e/<prefix>-<name>-<scheme>[-375].png`; fails when the page scrolls sideways at 375 px.
 */
export async function shots(page: Page, prefix: string, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/${prefix}-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/${prefix}-${name}-${scheme}-375.png`,
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

/** Uncaught page errors from now on; specs expect the list to stay empty. */
export function errors(page: Page) {
  const list: string[] = [];
  page.on("pageerror", (error) => list.push(error.message));
  return list;
}
