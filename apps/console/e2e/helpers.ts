import { expect, type Locator, type Page } from "@playwright/test";

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
  await page.getByTestId("logout").click();
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
