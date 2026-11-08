import { expect } from "@playwright/test";
import { signedIn, test } from "./helpers";

test("SSH options work by keyboard on phones in Chinese and English", async ({ page }) => {
  test.setTimeout(180_000);
  const password = process.env.E2E_SSH_PASSWORD!;
  const cluster = process.env.E2E_SSH_CLUSTER_ID!;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedIn(page);
  for (const locale of ["zh-CN", "en"] as const) {
    await page.evaluate((locale) => localStorage.setItem("PARAGLIDE_LOCALE", locale), locale);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/clusters?cluster=${cluster}&enroll=true`);
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("ssh-install-form")).toBeVisible();
    await expect(page.getByTestId("ssh-auth-agent")).toBeDisabled();
    await page.locator("#sshHost").fill("172.30.125.3");
    await page.locator("#sshUser").fill("deploy");
    await page.locator("#sshPassword").fill(password);
    await page.locator("#sshSudoPassword").fill(password);
    await page.locator("#sshJumpEnabled").focus();
    await page.keyboard.press("Space");
    await page.locator("#sshJumpHost").fill("172.30.124.10");
    await page.locator("#sshJumpPassword").fill(password);
    await dialog
      .getByRole("button", {
        name: locale === "en" ? "Scan jump fingerprint" : "扫描跳板机指纹",
        exact: true,
      })
      .press("Enter");
    await expect(page.locator("#sshJumpFingerprint")).toHaveValue(process.env.E2E_SSH_JUMP_KEY!);
    await page.locator("#sshJumpConfirmed").focus();
    await page.keyboard.press("Space");
    await page.getByTestId("ssh-scan").press("Enter");
    await expect(page.getByTestId("ssh-fingerprint")).toHaveText(process.env.E2E_SSH_TARGET_KEY!);
    if (locale === "zh-CN") {
      await page.getByTestId("ssh-install-start").press("Enter");
      await expect(page.getByTestId("ssh-run-summary")).toHaveAttribute("data-state", "finished", {
        timeout: 120_000,
      });
      await expect(page.getByTestId("ssh-run-host")).toHaveAttribute("data-state", "succeeded");
      await expect(page.getByTestId("ssh-cleanup")).toHaveText("已确认远端停止并清理");
      await page.getByTestId("enroll-close").press("Enter");
    } else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
    ).toBe(true);
    expect(
      await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }])),
    ).not.toContain(password);
  }
  expect(errors).toEqual([]);
});
