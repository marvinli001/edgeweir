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
  await page.getByLabel("初始化令牌").fill("ews_not-the-token");
  await page.getByLabel("姓名").fill("E2E Admin");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByTestId("setup-submit").click();
  // Server errors are localized by their stable code.
  await expect(page.getByTestId("setup-error")).toHaveText("初始化令牌无效");

  await page.getByLabel("初始化令牌").fill(setupToken);
  await page.getByTestId("setup-submit").click();
  // Without a node the console starts with adding one: the add-node dialog of the default cluster.
  await expect(page.getByTestId("page-title")).toHaveText("集群与节点");
  await expect(page.getByTestId("install-command")).toContainText("EDGEWEIR_TOKEN");
  const primary = page.getByTestId("nav-primary-action");
  await expect(primary).toHaveText("添加节点");
  await expect(primary).toHaveAttribute("data-action", "add-node");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("install-command")).toBeHidden();
  // The only account runs the whole console: every page is in the sidebar.
  await expect(page.getByTestId("nav-clusters")).toBeVisible();

  expect(pageErrors).toEqual([]);
});
