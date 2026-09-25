import { expect, type Page, test } from "@playwright/test";
import { login, logout } from "./helpers";

/**
 * Landing page: an administrator picks a template in the system settings → visitors see it at `/`
 * with sign-in and sign-up, light-only (also with a dark OS preference or a stored dark choice) and
 * without horizontal scrolling at 375px, the loader while `/` resolves, the error state when it
 * fails, and nothing loaded from other origins → signed in, sign-in and sign-up become one console
 * button, and the console gets the dark choice back → the second template passes the same checks
 * → switched off again, `/` goes straight to the console in the user's theme.
 */
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";

const phone = { width: 375, height: 812 };
const desktop = { width: 1280, height: 720 };

/** The root is light (class and color-scheme) whatever the stored choice or the OS says. */
async function expectLightRoot(page: Page) {
  const html = page.locator("html");
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).toHaveCSS("color-scheme", "light");
}

async function expectDarkRoot(page: Page) {
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
}

/** Nothing wider than the viewport: no horizontal scrolling on a phone. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = Number(
    await page.evaluate(
      "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth",
    ),
  );
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

/** Checks one template at 375px and on a dark OS with a stored dark choice. */
async function checkTemplate(page: Page, testId: string, path = "/") {
  await page.setViewportSize(phone);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(path);
  await expect(page.getByTestId(testId)).toBeVisible();
  await expect(page.getByTestId("landing-headline")).toBeVisible();
  await expectLightRoot(page);
  await expectNoHorizontalOverflow(page);
  // Scroll through once so every section has rendered, then measure again.
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize(desktop);
  await expectLightRoot(page);
}

test("landing page template and login-aware header", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Fonts and images are self-hosted: a visitor's browser talks to this console only.
  const origin = new URL(process.env.E2E_BASE_URL ?? "http://localhost:13000").origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !/^(data|blob):/.test(url)) foreign.push(url);
  });

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

  await test.step("the landing page stays light and fits a 375px screen", async () => {
    // A visitor who chose dark in the console before, on a dark OS.
    await page.evaluate("localStorage.setItem('theme', 'dark')");
    await checkTemplate(page, "landing-horizon");
  });

  await test.step("`/` shows the loader (still light) while it resolves", async () => {
    const slow = "**/rpc/landing/get**";
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/");
    await expect(page.getByTestId("landing-pending")).toBeVisible();
    await expect(page.getByTestId("landing-pending").getByLabel("加载中")).toBeVisible();
    await expectLightRoot(page);
    await expect(page.getByTestId("landing-horizon")).toBeVisible();
    await page.unroute(slow);
  });

  await test.step("`/` shows the error state when it cannot load, and recovers on retry", async () => {
    const landingGet = "**/rpc/landing/get**";
    await page.route(landingGet, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "boom" },
        }),
      }),
    );
    await page.goto("/");
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await page.unroute(landingGet);
    await alert.getByRole("button", { name: "重试" }).click();
    await expect(page.getByTestId("landing-horizon")).toBeVisible();
    await expectLightRoot(page);
  });

  await test.step("signed in, the header offers the console instead", async () => {
    await login(page, adminEmail, adminPassword);
    await expectDarkRoot(page);
    await page.goto("/");
    await expect(page.getByTestId("landing-console")).toHaveText("控制台");
    await expect(page.getByTestId("landing-login")).toHaveCount(0);
    await expect(page.getByTestId("landing-signup")).toHaveCount(0);
    await expectLightRoot(page);
    await page.getByTestId("landing-console").click();
    await expect(page.getByTestId("page-title")).toHaveText("概览");
    // Leaving the landing page gives the stored dark choice back.
    await expectDarkRoot(page);
  });

  await test.step("the second template passes the same checks", async () => {
    await checkTemplate(page, "landing-orbit", "/?preview=orbit");
    await expectNoHorizontalOverflow(page);
    await saveTemplate("orbit");
    await logout(page);
    await checkTemplate(page, "landing-orbit");
    await expect(page.getByTestId("landing-login")).toHaveText("登录");
    await login(page, adminEmail, adminPassword);
  });

  await test.step("switched off, / goes straight to the console", async () => {
    await saveTemplate("none");
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByTestId("page-title")).toHaveText("概览");
    await expectDarkRoot(page);
  });

  expect(foreign, "requests to other origins").toEqual([]);
  expect(pageErrors).toEqual([]);
});
