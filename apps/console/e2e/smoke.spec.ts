import { expect, test } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const expectedRevision = process.env.E2E_EXPECT_REVISION;

test("login -> clusters & nodes -> sites, then switch to English", async ({ page }) => {
  // Login (zh-CN is the default locale).
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("登录 Edgeweir")).toBeVisible();
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText("概览");

  // Clusters & nodes: the enrolled node is online with its applied revision.
  await page.getByTestId("nav-clusters").click();
  await expect(page.getByTestId("page-title")).toHaveText("集群与节点");
  const nodes = page.getByTestId("nodes-table");
  await expect(nodes).toBeVisible();
  await expect(nodes.getByText("edge-e2e-1")).toBeVisible();
  await expect(nodes.getByTestId("node-online")).toBeVisible();
  if (expectedRevision) {
    await expect(nodes.getByTestId("node-applied-revision")).toHaveText(`#${expectedRevision}`);
    await expect(page.getByTestId("cluster-latest-revision")).toContainText(expectedRevision);
  }
  await expect(page.getByTestId("revisions-table")).toBeVisible();

  // Sites: demo.test created through the API is listed.
  await page.getByTestId("nav-sites").click();
  await expect(page.getByTestId("page-title")).toHaveText("网站");
  await expect(page.getByTestId("sites-table").getByText("demo.test")).toBeVisible();

  // i18n: switch to English from the user menu; the UI reloads in English.
  await page.getByTestId("user-menu").click();
  await page.getByTestId("language-menu").hover();
  await page.getByTestId("locale-en").click();
  await expect(page.getByTestId("page-title")).toHaveText("Sites");
  await page.getByTestId("nav-clusters").click();
  await expect(page.getByTestId("page-title")).toHaveText("Clusters & nodes");
});
