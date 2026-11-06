import type { Site } from "@edgeweir/contract";
import { expect } from "@playwright/test";
import { pick, saved, signedIn, siteTab, test } from "./helpers";

test("M4: IP list and rule editing with syntax errors, ordering and mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signedIn(page);
  await page.getByTestId("nav-ip-lists").click();
  await page.getByTestId("ip-list-create").click();
  const name = `browser_${Date.now()}`;
  await page.getByRole("dialog").getByLabel("名称", { exact: true }).fill(name);
  // A bad entry is named in the dialog's language, not shown as a schema's JSON.
  await page.getByLabel("IP 地址和 CIDR").fill("192.0.2.55/24\n10.0.0.300");
  await page.getByTestId("ip-list-submit").click();
  await expect(page.getByTestId("form-error")).toHaveText("IP 地址或 CIDR 无效：10.0.0.300");
  await page.getByLabel("IP 地址和 CIDR").fill("192.0.2.55/24\n2001:db8::/32");
  await page.getByTestId("ip-list-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(`$${name}`, { exact: true })).toBeVisible();
  await page.getByTestId("nav-sites").click();
  // Other sections add sites too; search so this one is on the first page.
  await page.getByTestId("sites-search").fill("rules.m4.test");
  await page
    .getByTestId("sites-table")
    .getByRole("row")
    .filter({ hasText: "rules.m4.test" })
    .getByRole("link")
    .first()
    .click();
  await siteTab(page, "rules");
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
  await expect(first.getByRole("alert")).toHaveText("第 11 个字符：大小比较只用于数字字段");
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
  const handle = second.getByRole("button", { name: "调整规则顺序" });
  for (
    let step = 0;
    step < 100 && !(await handle.evaluate((node) => node === node.ownerDocument.activeElement));
    step++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(handle).toBeFocused();
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
  const accepted = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/rules/save") && response.request().method() === "POST",
  );
  const delivered = page.waitForResponse(
    async (response) => {
      if (!response.url().includes("/rpc/sites/get") || !response.ok()) return false;
      const timing = (await accepted).request().timing();
      // An earlier in-flight read cannot confirm this save.
      if (response.request().timing().startTime < timing.startTime + timing.responseStart)
        return false;
      const { json: site } = (await response.json()) as { json: Site };
      return (
        site.domains.includes("rules.m4.test") &&
        site.delivery.state === "live" &&
        site.delivery.totalNodes > 0
      );
    },
    { timeout: 120_000 },
  );
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  await expect(page.getByTestId("rules-save")).toBeDisabled();
  const notice = page.getByTestId("site-delivery-toast");
  await expect(notice).toContainText("已保存");
  await expect(notice).toContainText(/生效中 \d+\/\d+|已生效/);
  const { json: liveSite } = (await (await delivered).json()) as { json: Site };
  expect(liveSite.delivery.currentNodes).toBe(liveSite.delivery.totalNodes);
  await expect(notice).toContainText("已生效（在线节点）", { timeout: 120_000 });
  await expect(notice.locator('div[data-type="success"]')).toBeVisible();
  const siteUrl = page.url();
  await notice.getByRole("button", { name: "查看节点", exact: true }).click();
  await expect(page).toHaveURL(/\/clusters\?cluster=/);
  await page.goto(siteUrl);
  // A failed status lookup does not turn a saved rule into a failed save or an applied change.
  first = page.getByTestId("rule-row").first();
  await first.getByLabel("表达式", { exact: true }).fill("false");
  await page.route("**/rpc/sites/get**", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  await expect(notice).toContainText("已保存");
  await expect(notice).toContainText("暂时无法查询节点生效状态");
  await expect(notice.locator('div[data-type="info"]')).toBeVisible();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);
  await page.unroute("**/rpc/sites/get**");
  await page.reload();
  first = page.getByTestId("rule-row").first();
  await expect(first.getByLabel("名称", { exact: true })).toHaveValue("Browser log");
  await expect(first.getByLabel("表达式", { exact: true })).toHaveValue("false");
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
    .getByTestId("ip-list-card")
    .filter({ hasText: `$${name}` })
    .getByTestId("ip-list-actions")
    .click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId("confirm-error")).toHaveText(
    /^IP 名单正在被使用：Browser block \(.+\)$/,
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(errors).toEqual([]);
});
