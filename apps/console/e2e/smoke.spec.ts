import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const expectedRevision = process.env.E2E_EXPECT_REVISION;

test("login -> clusters & nodes -> sites, then switch to English", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Login (zh-CN is the default locale).
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("login-submit")).toHaveText("登录");
  await login(page, email, password);
  // Signed in, `/` goes straight to the console.
  await page.goto("/");
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("page-title")).toHaveText("概览");

  // The overview lists the enrolled node; with nodes the sidebar's primary action is a new site.
  await expect(page.getByTestId("home-nodes").getByTestId("home-node")).toContainText("edge-e2e-1");
  await expect(page.getByTestId("nav-primary-action")).toHaveText("新建网站");

  // Ctrl+K (⌘K) opens the command menu with every page.
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("option", { name: "审计日志" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("审计日志");

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

  // The "add node" dialog shows a one-time install command with the CA pin at once. The
  // token travels in EDGEWEIR_TOKEN, never as an argument (the process list would show it).
  await page.getByTestId("add-node").click();
  const command = page.getByTestId("install-command");
  const token = /export EDGEWEIR_TOKEN='(ewt_[A-Za-z0-9_-]+)'/;
  await expect(command).toContainText(token);
  await expect(command).toContainText(
    "/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server https://",
  );
  await expect(command).toContainText(/--ca-sha256 [0-9a-f]{64}/);
  await expect(command).not.toContainText("--token");
  await expect(page.getByTestId("enroll-token-once")).toHaveText("仅显示一次");
  const first = (await command.textContent())?.match(token)?.[1];
  expect(first).toBeTruthy();
  // A node name is an option: it mints another token.
  await page.getByTestId("enroll-options").click();
  await page.getByLabel("节点名称", { exact: true }).fill("edge-ui");
  await page.getByTestId("generate-install-command").click();
  await expect(command).toContainText(token);
  await expect(command).not.toContainText(first ?? "");
  await expect(page.getByLabel("节点名称", { exact: true })).toHaveCount(0);
  const second = (await command.textContent())?.match(token)?.[1];
  const enroll = page.getByRole("dialog");
  // Closing only changes the search: the session checked on entering the console holds, so the
  // dialog closes at once even when the console is a slow round trip away (behind a CDN).
  const sessionChecks: string[] = [];
  await page.route("**/api/auth/get-session", async (route) => {
    sessionChecks.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await page.getByTestId("enroll-close").click();
  await expect(enroll).toBeHidden({ timeout: 1_500 });
  expect(sessionChecks).toEqual([]);
  await page.unroute("**/api/auth/get-session");
  // Opened again, the dialog shows a new node's command, the options closed and empty.
  await page.getByTestId("add-node").click();
  await expect(command).toContainText(token);
  await expect(command).not.toContainText(second ?? "");
  await page.getByTestId("enroll-options").click();
  await expect(page.getByLabel("节点名称", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(enroll).toBeHidden();

  // Sites: demo.test created through the API is listed; create one through the UI.
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
  await page.getByTestId("nav-clusters").click();
  await expect(page.getByTestId("page-title")).toHaveText("Clusters & nodes");

  expect(pageErrors).toEqual([]);
});

test("follows the OS color scheme and keeps a manual choice", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const html = page.locator("html");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");
  await expect(html).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveClass(/\blight\b/);

  // A manual choice wins over the OS and survives a reload.
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);

  // Back to following the OS.
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-system").click();
  await expect(html).toHaveClass(/\blight\b/);

  expect(pageErrors).toEqual([]);
});
