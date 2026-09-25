import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const expectedRevision = process.env.E2E_EXPECT_REVISION;

test("login -> admin clusters & nodes -> console sites, then switch to English", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Login (zh-CN is the default locale).
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("login-submit")).toHaveText("登录");
  await login(page, email, password);

  // Admins switch to the admin area for clusters & nodes.
  await page.getByTestId("area-admin").click();
  await expect(page.getByTestId("page-title")).toHaveText("平台概览");
  await expect(page.getByTestId("nav-sites")).toHaveCount(0);

  // Clusters & nodes: the enrolled node is online with its applied revision.
  await page.getByTestId("nav-clusters").click();
  await expect(page.getByTestId("page-title")).toHaveText("集群与节点");
  const nodes = page.getByTestId("nodes-table");
  await expect(nodes).toBeVisible();
  await expect(nodes.getByTestId("node-name")).toHaveText("edge-e2e-1");
  await expect(nodes.getByTestId("node-online")).toBeVisible();
  if (expectedRevision) {
    await expect(nodes.getByTestId("node-applied-revision")).toHaveText(`#${expectedRevision}`);
    await expect(page.getByTestId("cluster-latest-revision")).toContainText(expectedRevision);
  }
  await expect(page.getByTestId("revisions-table")).toBeVisible();

  // The "add node" dialog produces a one-time install command with the CA pin.
  await page.getByTestId("add-node").click();
  await page.getByLabel("节点名称", { exact: true }).fill("edge-ui");
  await page.getByTestId("generate-install-command").click();
  const command = page.getByTestId("install-command");
  await expect(command).toContainText("/install.sh | sudo bash -s --");
  await expect(command).toContainText("--token ewt_");
  await expect(command).toContainText(/--ca-sha256 [0-9a-f]{64}/);
  await page.keyboard.press("Escape");

  // Back to the console. Sites: demo.test created through the API is listed; create one through the UI.
  await page.getByTestId("area-console").click();
  await expect(page.getByTestId("nav-clusters")).toHaveCount(0);
  await page.getByTestId("nav-sites").click();
  await expect(page.getByTestId("page-title")).toHaveText("网站");
  const sites = page.getByTestId("sites-table");
  await expect(sites.getByText("demo.test")).toBeVisible();
  await page.getByTestId("new-site").click();
  await page.getByLabel("名称", { exact: true }).fill("ui-site");
  await page.getByLabel("域名", { exact: true }).fill("ui.test");
  await page.getByLabel("源站地址", { exact: true }).fill("whoami");
  await page.getByTestId("create-site-submit").click();
  // The new site opens on its detail page; the list shows it too.
  await expect(page.getByTestId("page-title")).toHaveText("ui-site");
  await page.getByTestId("nav-sites").click();
  await expect(sites.getByText("ui.test")).toBeVisible();

  // i18n: switch to English from the user menu; the UI reloads in English.
  await page.getByTestId("user-menu").click();
  await page.getByTestId("language-menu").hover();
  await page.getByTestId("locale-en").click();
  await expect(page.getByTestId("page-title")).toHaveText("Sites");
  await page.getByTestId("area-admin").click();
  await page.getByTestId("nav-clusters").click();
  await expect(page.getByTestId("page-title")).toHaveText("Clusters & nodes");

  expect(pageErrors).toEqual([]);
});
