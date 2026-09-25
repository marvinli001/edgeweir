import { expect, test } from "@playwright/test";
import { login, logout, pick } from "./helpers";

/**
 * MVP M1 acceptance (docs/specs/mvp.md §1): second organization and member → member sees only
 * the console → member creates and edits a site → admin creates a cluster, a region and a node
 * group and moves the e2e node into it (still online, revision in sync) → audit log shows names
 * and filters by action → English shows revision reasons and errors in English.
 */
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const memberEmail = process.env.E2E_MEMBER_EMAIL ?? "member@e2e.test";
const memberPassword = process.env.E2E_MEMBER_PASSWORD ?? "e2e-member-password-123";
const nodeName = process.env.E2E_NODE_NAME ?? "edge-e2e-1";

test("M1: tenants, members, site editing, clusters, node groups, audit and i18n", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await test.step("admin creates a second organization with a member", async () => {
    await login(page, adminEmail, adminPassword);
    await page.getByTestId("area-admin").click();
    await page.getByTestId("nav-organizations").click();
    await expect(page.getByTestId("page-title")).toHaveText("组织与用户");

    await page.getByTestId("create-org").click();
    await page.getByLabel("组织名称", { exact: true }).fill("Tenant Org");
    await pick(page, page.getByTestId("default-cluster-select"), "default");
    await page.getByTestId("org-submit").click();
    const orgs = page.getByTestId("orgs-table");
    await expect(orgs.getByText("Tenant Org")).toBeVisible();
    await expect(orgs.getByText("tenant-org")).toBeVisible();

    await page.getByTestId("tab-users").click();
    await page.getByTestId("create-user").click();
    await page.getByLabel("姓名", { exact: true }).fill("E2E Member");
    await page.getByLabel("邮箱", { exact: true }).fill(memberEmail);
    await page.getByLabel("密码", { exact: true }).fill(memberPassword);
    await pick(page, page.getByTestId("org-select"), "Tenant Org");
    await page.getByTestId("user-submit").click();
    const users = page.getByTestId("users-table");
    await expect(users.getByText("E2E Member")).toBeVisible();
    await expect(users.getByText("Tenant Org · 成员")).toBeVisible();
    await logout(page);
  });

  await test.step("the member only sees the console; /admin redirects", async () => {
    await login(page, memberEmail, memberPassword);
    await expect(page.getByTestId("area-admin")).toHaveCount(0);
    await expect(page.getByTestId("area-console")).toHaveCount(0);
    await expect(page.getByTestId("nav-clusters")).toHaveCount(0);
    await expect(page.getByTestId("nav-members")).toHaveCount(0);
    for (const path of ["/admin", "/admin/clusters", "/admin/organizations"]) {
      await page.goto(path);
      await expect(page.getByTestId("page-title")).toHaveText("概览");
      await expect(page).not.toHaveURL(/\/admin/);
    }
  });

  await test.step("the member creates a site, then edits its domains and origin", async () => {
    await page.getByTestId("nav-sites").click();
    await expect(page.getByTestId("page-title")).toHaveText("网站");
    await page.getByTestId("new-site").click();
    await page.getByLabel("名称", { exact: true }).fill("tenant-site");
    await page.getByLabel("域名", { exact: true }).fill("tenant.test");
    await page.getByLabel("源站地址", { exact: true }).fill("10.0.0.10");
    await page.getByTestId("create-site-submit").click();
    // Creating a site opens its detail page.
    await expect(page.getByTestId("page-title")).toHaveText("tenant-site");

    await page.getByTestId("tab-domains").click();
    await page.getByTestId("domain-input").fill("www.tenant.test");
    await page.getByTestId("domain-add").click();
    await page.getByTestId("domains-save").click();
    await expect(page.getByText(/已保存，版本 #\d+/)).toBeVisible();
    await expect(page.getByTestId("domain-list")).toContainText("www.tenant.test");

    await page.getByTestId("tab-origins").click();
    await page.getByTestId("origin-address").fill("whoami");
    await page.getByTestId("origin-port").fill("80");
    await page.getByTestId("origins-save").click();
    await expect(page.getByTestId("origins-save")).toBeDisabled();

    // The edits are stored: a reload shows them.
    await page.reload();
    await expect(page.getByTestId("origin-address")).toHaveValue("whoami");
    await page.getByTestId("tab-domains").click();
    await expect(page.getByTestId("domain-list")).toContainText("tenant.test");
    await expect(page.getByTestId("domain-list")).toContainText("www.tenant.test");

    // Tenants see only their organization's sites.
    await page.getByTestId("nav-sites").click();
    const sites = page.getByTestId("sites-table");
    await expect(sites.getByText("tenant-site")).toBeVisible();
    await expect(sites.getByText("demo.test")).toHaveCount(0);
    await logout(page);
  });

  await test.step("admin adds a region, a cluster and a node group, and moves the node", async () => {
    await login(page, adminEmail, adminPassword);
    await page.getByTestId("area-admin").click();

    await page.getByTestId("nav-regions").click();
    await page.getByTestId("create-region").click();
    await page.getByLabel("名称", { exact: true }).fill("华东");
    await page.getByLabel("代码", { exact: true }).fill("cn-east");
    await page.getByTestId("region-submit").click();
    await expect(page.getByTestId("regions-table").getByText("华东")).toBeVisible();

    await page.getByTestId("nav-clusters").click();
    await expect(page.getByTestId("page-title")).toHaveText("集群与节点");
    await page.getByTestId("create-cluster").click();
    await page.getByLabel("集群名称", { exact: true }).fill("edge-b");
    await page.getByTestId("cluster-submit").click();
    await expect(page.getByTestId("cluster-name")).toHaveText("edge-b");
    await pick(page, page.getByTestId("cluster-select"), "default");
    await expect(page.getByTestId("cluster-name")).toHaveText("default");

    await page.getByTestId("create-node-group").click();
    await page.getByLabel("节点组", { exact: true }).fill("group-a");
    await pick(page, page.getByTestId("region-select"), "华东 (cn-east)");
    await page.getByTestId("node-group-submit").click();
    const groups = page.getByTestId("node-groups-table");
    await expect(groups.getByText("group-a")).toBeVisible();
    await expect(groups.getByText("华东 · cn-east")).toBeVisible();

    const nodes = page.getByTestId("nodes-table");
    const row = nodes.getByRole("row").filter({ hasText: nodeName });
    await row.getByTestId("node-actions").click();
    await page.getByTestId("node-move").click();
    await pick(page, page.getByTestId("move-group-select"), "group-a · 华东");
    await page.getByTestId("move-submit").click();
    await expect(row.getByTestId("node-group")).toHaveText("group-a");

    // Moving between node groups does not disturb the node: online, on the latest revision.
    await expect(row.getByTestId("node-online")).toBeVisible();
    await expect
      .poll(
        async () => {
          const latest = (await page.getByTestId("cluster-latest-revision").textContent()) ?? "";
          const applied = (await row.getByTestId("node-applied-revision").textContent()) ?? "";
          return (
            latest.replace(/\D/g, "") !== "" &&
            latest.replace(/\D/g, "") === applied.replace(/\D/g, "")
          );
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(true);
    await expect(row.getByTestId("node-up-to-date")).toBeVisible();
  });

  await test.step("the audit log shows who did what and filters by action", async () => {
    await page.getByTestId("nav-audit").click();
    await expect(page.getByTestId("page-title")).toHaveText("审计日志");
    const audit = page.getByTestId("audit-table");
    await expect(
      audit.getByTestId("audit-actor").filter({ hasText: "E2E Member" }).first(),
    ).toBeVisible();
    await expect(
      audit.getByTestId("audit-actor").filter({ hasText: "E2E Admin" }).first(),
    ).toBeVisible();

    await pick(page, page.getByTestId("audit-filter-action"), "node.move");
    await expect(audit.getByTestId("audit-action")).toHaveText(["node.move"]);
    await expect(audit.getByTestId("audit-actor")).toHaveText(["E2E Admin"]);
    await expect(audit.getByTestId("audit-target")).toHaveText([nodeName]);

    await pick(page, page.getByTestId("audit-filter-action"), "site.update");
    await expect(audit.getByTestId("audit-action")).toHaveText(["site.update", "site.update"]);
    await expect(audit.getByTestId("audit-actor")).toHaveText(["E2E Member", "E2E Member"]);
  });

  await test.step("in English, revision reasons and errors are English", async () => {
    await page.getByTestId("user-menu").click();
    await page.getByTestId("language-menu").hover();
    await page.getByTestId("locale-en").click();
    await expect(page.getByTestId("page-title")).toHaveText("Audit log");

    await page.getByTestId("nav-clusters").click();
    await expect(page.getByTestId("page-title")).toHaveText("Clusters & nodes");
    await expect(page.getByTestId("cluster-name")).toHaveText("default");
    const reasons = page.getByTestId("revisions-table").getByTestId("revision-reason");
    await expect(reasons.filter({ hasText: "Site tenant-site updated" }).first()).toBeVisible();
    await expect(reasons.filter({ hasText: "Site tenant-site created" })).toHaveCount(1);

    // A refused action explains itself in English (stable error code, localized in the UI).
    await page.getByTestId("cluster-actions").click();
    await page.getByTestId("cluster-delete").click();
    await page.getByTestId("confirm-action").click();
    await expect(page.getByTestId("confirm-error")).toHaveText(
      /^The cluster still has \d+ node\(s\) and \d+ site\(s\)$/,
    );
    await page.keyboard.press("Escape");
  });

  expect(pageErrors).toEqual([]);
});
