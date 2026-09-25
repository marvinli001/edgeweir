import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

/**
 * Landing page: an administrator picks a template in the system settings → visitors see it at `/`
 * with sign-in and sign-up → signed in, those become one console button → switched off again,
 * `/` goes straight to the console.
 */
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";

test("landing page template and login-aware header", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const saveTemplate = async (template: "none" | "horizon" | "orbit") => {
    await page.goto("/admin/settings");
    await page.getByTestId(`landing-template-${template}`).check({ force: true });
    if (template !== "none") {
      await page.getByLabel("品牌名称", { exact: true }).fill("E2E CDN");
      await page.getByLabel("注册链接", { exact: true }).fill("https://e2e.test/apply");
    }
    await page.getByTestId("landing-save").click();
    await expect(page.getByText("已保存")).toBeVisible();
  };

  await test.step("an administrator switches the landing page on", async () => {
    await login(page, adminEmail, adminPassword);
    await saveTemplate("horizon");
    await logout(page);
  });

  await test.step("a visitor sees sign-in and sign-up", async () => {
    await page.goto("/");
    await expect(page.getByTestId("landing-horizon")).toBeVisible();
    await expect(page.getByTestId("landing-brand")).toHaveText("E2E CDN");
    await expect(page.getByTestId("landing-login")).toHaveText("登录");
    await expect(page.getByTestId("landing-signup")).toHaveAttribute(
      "href",
      "https://e2e.test/apply",
    );
    await expect(page.getByTestId("landing-console")).toHaveCount(0);
  });

  await test.step("signed in, the header offers the console instead", async () => {
    await login(page, adminEmail, adminPassword);
    await page.goto("/");
    await expect(page.getByTestId("landing-console")).toHaveText("控制台");
    await expect(page.getByTestId("landing-login")).toHaveCount(0);
    await expect(page.getByTestId("landing-signup")).toHaveCount(0);
    await page.getByTestId("landing-console").click();
    await expect(page.getByTestId("page-title")).toHaveText("概览");
  });

  await test.step("switched off, / goes straight to the console", async () => {
    await saveTemplate("none");
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByTestId("page-title")).toHaveText("概览");
  });

  expect(pageErrors).toEqual([]);
});
