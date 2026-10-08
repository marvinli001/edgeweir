import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * Written by scripts/e2e-g11.mjs: g11-multi (a, b and c.g11.test) with g11-wild first and g11-a,
 * g11-b and g11-rsa added, g11-mtls (m.g11.test, certificate g11-m) asking for optional client
 * certificates of the g11 client CA, g11-acme with Pebble's RSA certificate, and Pebble as the
 * custom ACME directory of the system settings (its account acme-g11@e2e.test in use). The
 * sites are removed by `node scripts/e2e-g11.mjs --cleanup`.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g11-state.json"), "utf8")) as {
  multiSiteId: string;
  mtlsSiteId: string;
  acmeEmail: string;
  pebble: string;
};
const ADMIN = ["admin@e2e.test", "e2e-admin-password-123"] as const;

test.describe.configure({ mode: "serial" });

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/g11-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/g11-${name}-${scheme}-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
    // Clipping hides content wider than its card (a PEM's long lines): the page itself does not overflow.
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"]')].every((card) => card.getBoundingClientRect().right <= window.innerWidth + 1 && card.scrollWidth <= card.clientWidth + 1)`,
      ),
      `${name}: a card's content is wider than the card at 375 px (${scheme})`,
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

test("G11: several certificates and client certificates on the HTTPS tab", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state.multiSiteId}?tab=https`);
  const first = page.getByLabel("证书", { exact: true });
  await expect(first).toContainText("g11-wild");
  for (const [n, name] of [
    [2, "g11-a"],
    [3, "g11-b"],
    [4, "g11-rsa"],
  ] as const)
    await expect(page.getByLabel(`证书 ${n}`, { exact: true })).toContainText(name);
  // Four is the most: no add button.
  await expect(page.getByTestId("https-certificate-add")).toHaveCount(0);
  await check(page, "https-certificates");

  // Remove the RSA certificate, then add it back.
  await page.getByTestId("https-certificate-remove-4").click();
  await expect(page.getByLabel("证书 4", { exact: true })).toHaveCount(0);
  await saved(page, page.getByTestId("https-save"), "https/update");
  await page.reload();
  await expect(page.getByLabel("证书 3", { exact: true })).toContainText("g11-b");
  await expect(page.getByLabel("证书 4", { exact: true })).toHaveCount(0);
  await page.getByTestId("https-certificate-add").click();
  await pick(page, page.getByLabel("证书 4", { exact: true }), "g11-rsa");
  await saved(page, page.getByTestId("https-save"), "https/update");
  await page.reload();
  await expect(page.getByLabel("证书 4", { exact: true })).toContainText("g11-rsa");

  // Client certificates: optional (left by the script), switched to required and back.
  await page.goto(`/sites/${state.mtlsSiteId}?tab=https`);
  const section = page.getByTestId("https-client-cert");
  const mode = section.getByLabel("客户端证书", { exact: true });
  await expect(mode).toContainText("可选");
  await expect(page.getByTestId("https-client-ca")).toHaveValue(/BEGIN CERTIFICATE/);
  await expect(section.getByRole("switch", { name: "向源站传递证书信息" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // HTTP/3 cannot be turned on together with client certificates.
  await expect(page.getByRole("switch", { name: "HTTP/3", exact: true })).toBeDisabled();
  await pick(page, mode, "必须");
  await saved(page, page.getByTestId("https-save"), "https/update");
  await page.reload();
  await expect(mode).toContainText("必须");
  await check(page, "https-client-certificates");
  await pick(page, mode, "可选");
  await saved(page, page.getByTestId("https-save"), "https/update");
  expect(pageErrors).toEqual([]);
});

test("G11: certificate authorities, key types and ACME accounts", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto("/system");
  await expect(page.getByTestId("acme-directory")).toBeVisible();
  await expect(page.getByTestId("acme-directory-url")).toHaveValue(state.pebble);
  await expect(page.getByTestId("acme-directory-origin")).toHaveText("已保存");
  await expect(page.getByTestId("acme-directory-ca-origin")).toHaveText("已保存");
  await expect(page.getByTestId("acme-directory-ca")).toHaveValue(/BEGIN CERTIFICATE/);
  await check(page, "system-acme-directory");

  await page.goto("/certificates");
  const account = page
    .getByTestId("acme-account")
    .filter({ hasText: state.acmeEmail })
    .filter({ hasText: state.pebble });
  await expect(account).toHaveCount(1);
  await expect(account).toContainText("自定义 ACME 目录");
  await expect(account.getByTestId("acme-account-certificates")).toContainText("使用中的证书：1");
  // In use: it cannot be deleted.
  await expect(account.getByTestId("acme-account-delete")).toBeDisabled();
  await check(page, "certificates-accounts");

  await page.getByTestId("cert-request").click();
  const dialog = page.getByRole("dialog");
  const ca = dialog.getByLabel("证书颁发机构", { exact: true });
  await pick(page, ca, "Google Trust Services");
  // Google Trust Services requires EAB.
  await expect(dialog.getByLabel("EAB 密钥 ID", { exact: true })).toHaveAttribute("required", "");
  await pick(page, ca, "自定义 ACME 目录");
  await expect(dialog.getByTestId("cert-acme-directory")).toHaveText(state.pebble);
  await expect(dialog.getByLabel("EAB 密钥 ID", { exact: true })).not.toHaveAttribute(
    "required",
    "",
  );
  const keyType = dialog.getByLabel("密钥类型", { exact: true });
  await expect(keyType).toContainText("ECDSA P-256");
  await pick(page, keyType, "RSA 2048");
  await expect(keyType).toContainText("RSA 2048");
  await check(page, "certificates-request");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});
