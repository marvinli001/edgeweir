import { expect, test } from "@playwright/test";
import { login, pick } from "./helpers";

test("M3: request a certificate and configure HTTPS in both themes and mobile", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(
    page,
    process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
    process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
  );
  await page.getByTestId("nav-certificates").click();
  await expect(page.getByTestId("page-title")).toHaveText("证书");
  await page.getByTestId("cert-request").click();
  const name = `Browser certificate ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByLabel("域名", { exact: true }).fill("https.m3.test");
  await dialog.getByLabel("账户邮箱").fill("acme@e2e.test");
  await page.getByTestId("cert-request-submit").click();
  await expect(dialog).toBeHidden();
  const card = page.getByTestId("certificate-card").filter({ hasText: name });
  await expect(card).toContainText("可用", { timeout: 180_000 });
  await expect(card).toContainText("已开启自动续期");
  await page.screenshot({ path: "../../.e2e/m3-certificates-desktop.png", fullPage: true });
  await page.getByTestId("nav-sites").click();
  const row = page.getByTestId("sites-table").getByRole("row").filter({ hasText: "https.m3.test" });
  await row.getByRole("link").first().click();
  await page.getByTestId("tab-https").click();
  await pick(page, page.getByLabel("证书", { exact: true }), name);
  const force = page.getByRole("switch", { name: "强制 HTTPS", exact: true });
  if ((await force.getAttribute("aria-checked")) !== "true") await force.click();
  await page.getByTestId("https-save").click();
  await expect(page.getByTestId("https-save")).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("证书", { exact: true })).toContainText(name);
  await expect(force).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: "../../.e2e/m3-https-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "../../.e2e/m3-https-mobile.png", fullPage: true });
  expect(
    await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth"),
  ).toBe(true);
  expect(errors).toEqual([]);
});
