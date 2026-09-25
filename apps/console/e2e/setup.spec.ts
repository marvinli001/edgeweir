import { expect, test } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const setupToken = process.env.E2E_SETUP_TOKEN ?? "";

test("first-run setup needs the setup token printed in the console log", async ({ page }) => {
  expect(setupToken, "E2E_SETUP_TOKEN (from the console log)").toMatch(/^ews_/);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Setup token").fill("ews_not-the-token");
  await page.getByLabel("姓名").fill("E2E Admin");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByLabel("组织名称").fill("E2E Org");
  await page.getByTestId("setup-submit").click();
  // Server errors are localized by their stable code.
  await expect(page.getByTestId("setup-error")).toHaveText("Setup token 无效");

  await page.getByLabel("Setup token").fill(setupToken);
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText("概览");
  await expect(page.getByTestId("area-admin")).toBeVisible();

  expect(pageErrors).toEqual([]);
});
