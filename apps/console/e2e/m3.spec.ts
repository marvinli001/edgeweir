import { expect } from "@playwright/test";
import { pick, saved, signedIn, test } from "./helpers";

test("M3: request a certificate and configure HTTPS in both themes and mobile", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedIn(page);
  await page.getByTestId("nav-certificates").click();
  await expect(page.getByTestId("page-title")).toHaveText("证书");
  await page.getByTestId("cert-request").click();
  const name = `Browser certificate ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByLabel("域名", { exact: true }).fill("https.m3.test");
  await dialog.getByLabel("账户邮箱").fill("acme@e2e.test");
  // Pebble: the custom ACME directory of the system settings.
  await pick(page, dialog.getByLabel("证书颁发机构", { exact: true }), "自定义 ACME 目录");
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
  await saved(page, page.getByTestId("https-save"), "https/update");
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
