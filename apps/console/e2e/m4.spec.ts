import { expect, test } from "@playwright/test";
import { login, pick } from "./helpers";

test("M4: IP list and rule editing with syntax errors, ordering and mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(
    page,
    process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
    process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
  );
  await page.getByTestId("nav-ip-lists").click();
  await page.getByTestId("ip-list-create").click();
  const name = `browser_${Date.now()}`;
  await page.getByRole("dialog").getByLabel("名称", { exact: true }).fill(name);
  await page.getByLabel("IP 地址和 CIDR").fill("192.0.2.55/24\n2001:db8::/32");
  await page.getByTestId("ip-list-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(`$${name}`, { exact: true })).toBeVisible();
  await page.getByTestId("nav-sites").click();
  await page
    .getByTestId("sites-table")
    .getByRole("row")
    .filter({ hasText: "rules.m4.test" })
    .getByRole("link")
    .first()
    .click();
  await page.getByTestId("tab-rules").click();
  await expect(page.getByTestId("rule-add-waf-custom")).toBeVisible();
  while (await page.getByTestId("rule-row").count())
    await page
      .getByTestId("rule-row")
      .first()
      .getByRole("button", { name: "删除", exact: true })
      .click();
  if (await page.getByTestId("rules-save").isEnabled()) {
    await page.getByTestId("rules-save").click();
    await expect(page.getByTestId("rules-save")).toBeDisabled();
  }
  await page.getByTestId("rule-add-waf-custom").click();
  let first = page.getByTestId("rule-row").first();
  // A new rule starts disabled.
  const enabled = first.getByRole("switch", { name: "启用", exact: true });
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await first.getByLabel("名称", { exact: true }).fill("Browser block");
  await first.getByLabel("表达式", { exact: true }).fill("http.host gt 4");
  await expect(first.getByRole("alert")).toHaveText(/检查第 11 个字符/);
  await first.getByLabel("表达式", { exact: true }).fill(`ip.src in $${name}`);
  await expect(first.getByRole("alert")).toHaveCount(0);
  await page.getByTestId("rule-add-waf-custom").click();
  const second = page.getByTestId("rule-row").nth(1);
  await second.getByLabel("名称", { exact: true }).fill("Browser log");
  await pick(page, second.getByLabel("动作", { exact: true }), "记录");
  // Keyboard sorting is accessible and shares the drag-and-drop reorder path.
  for (const row of await page.getByTestId("rule-row").all()) {
    await row.evaluate((el) =>
      Promise.all(
        el.getAnimations({ subtree: true }).map((a: { finished: Promise<unknown> }) => a.finished),
      ),
    );
  }
  const announcement = page.locator('[role="status"][aria-live="assertive"]');
  await second.getByRole("button", { name: "调整规则顺序" }).focus();
  await page.keyboard.press("Space");
  await expect(announcement).toHaveText(/^(已拿起规则 2|规则 2 移到第 2 位)$/);
  // KeyboardSensor registers its keydown listener in a timeout after pickup.
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowUp");
  await expect(announcement).toHaveText("规则 2 移到第 1 位");
  await page.keyboard.press("Space");
  await expect(announcement).toHaveText("规则 2 放在第 1 位");
  await expect(
    page.getByTestId("rule-row").first().getByLabel("名称", { exact: true }),
  ).toHaveValue("Browser log");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("rules-save")).toBeDisabled();
  await page.reload();
  first = page.getByTestId("rule-row").first();
  await expect(first.getByLabel("名称", { exact: true })).toHaveValue("Browser log");
  await page.screenshot({
    path: "../../.e2e/m4-rules-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "../../.e2e/m4-rules-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  // The list is in use: the refusal stays in the confirmation, which stays open.
  await page.goto("/ip-lists");
  await page
    .locator('[data-slot="card"]')
    .filter({ hasText: `$${name}` })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId("confirm-error")).toHaveText("IP 名单正在被规则或 L4 应用引用");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(errors).toEqual([]);
});
