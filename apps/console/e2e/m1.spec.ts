import { expect, test } from "@playwright/test";
import { login, pick, saved } from "./helpers";

/**
 * MVP M1 acceptance (dev-docs/specs/mvp.md §1): the operator creates and edits a site → creates a
 * cluster, a region and a node group and moves the e2e node into it (still online, revision in
 * sync) → audit log shows names and filters by action → English shows revision reasons and errors
 * in English.
 */
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";
const nodeName = process.env.E2E_NODE_NAME ?? "edge-e2e-1";

test("M1: site editing, clusters, node groups, audit and i18n", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await test.step("the operator creates a site, then edits its domains and origin", async () => {
    await login(page, adminEmail, adminPassword);
    await page.getByTestId("nav-sites").click();
    await expect(page.getByTestId("page-title")).toHaveText("网站");
    await page.getByTestId("new-site").click();
    await page.getByLabel("名称", { exact: true }).fill("edited-site");
    await page.getByLabel("域名", { exact: true }).fill("edited.test");
    // Private and other special-purpose origin addresses are refused unless the origin allow list
    // has them (the e2e allow list is only the Docker network), with the range named in the error.
    await page.getByLabel("源站地址", { exact: true }).fill("10.0.0.10");
    await page.getByTestId("create-site-submit").click();
    await expect(page.getByTestId("site-form-error")).toHaveText(
      "源站地址 10.0.0.10 属于特殊用途地址段 10.0.0.0/8，不在源站地址允许清单中",
    );
    await page.getByLabel("源站地址", { exact: true }).fill("origin.edited.test");
    await page.getByTestId("create-site-submit").click();
    // Creating a site opens its detail page.
    await expect(page.getByTestId("page-title")).toHaveText("edited-site");

    await page.getByTestId("tab-domains").click();
    await page.getByTestId("domain-input").fill("www.edited.test");
    await page.getByTestId("domain-add").click();
    await page.getByTestId("domains-save").click();
    // The saved notice follows the change onto the node.
    const notice = page.getByTestId("site-delivery-toast");
    await expect(notice).toContainText("已保存");
    await expect(notice).toContainText(/生效中 \d+\/\d+|已生效/);
    await expect(page.getByTestId("domain-list")).toContainText("www.edited.test");

    await page.getByTestId("tab-origins").click();
    await page.getByTestId("origin-address").fill("whoami");
    await page.getByTestId("origin-port").fill("80");
    await saved(page, page.getByTestId("origins-save"), "sites/update");
    await expect(page.getByTestId("origins-save")).toBeDisabled();

    // The edits are stored: a reload shows them.
    await page.reload();
    await expect(page.getByTestId("origin-address")).toHaveValue("whoami");
    await page.getByTestId("tab-domains").click();
    await expect(page.getByTestId("domain-list")).toContainText("edited.test");
    await expect(page.getByTestId("domain-list")).toContainText("www.edited.test");

    // Every site is listed, whichever surface created it.
    await page.getByTestId("nav-sites").click();
    const sites = page.getByTestId("sites-table");
    await expect(sites.getByText("edited-site")).toBeVisible();
    await expect(sites.getByText("demo.test")).toBeVisible();
  });

  await test.step("the operator adds a region, a cluster and a node group, and moves the node", async () => {
    // Regions are a view of the clusters page.
    await page.getByTestId("nav-clusters").click();
    await page.getByTestId("clusters-view-regions").click();
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

    // A dialog starts fresh each time it opens: a canary switch left on is off again.
    const canary = page.getByTestId("node-group-canary");
    await page.getByTestId("create-node-group").click();
    await canary.click();
    await expect(canary).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByTestId("create-node-group").click();
    await expect(canary).toHaveAttribute("aria-checked", "false");
    await page.getByLabel("节点组", { exact: true }).fill("group-a");
    await pick(page, page.getByTestId("region-select"), "华东 (cn-east)");
    await page.getByTestId("node-group-submit").click();
    const groups = page.getByTestId("node-groups-table");
    await expect(groups.getByText("group-a")).toBeVisible();
    await expect(groups.getByText("华东 · cn-east")).toBeVisible();

    const nodes = page.getByTestId("nodes-table");
    const row = nodes.locator("[data-row-id]").filter({ hasText: nodeName });
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
      audit.getByTestId("audit-actor").filter({ hasText: "E2E Admin" }).first(),
    ).toBeVisible();

    // Actions are labelled; the code stays below the label.
    await pick(page, page.getByTestId("audit-filter-action"), "移动节点");
    await expect(audit.getByTestId("audit-action-label")).toHaveText(["移动节点"]);
    await expect(audit.getByTestId("audit-action")).toHaveText(["node.move"]);
    await expect(audit.getByTestId("audit-actor")).toHaveText(["E2E Admin"]);
    await expect(audit.getByTestId("audit-target")).toHaveText([nodeName]);

    // The details show where the request came from and the metadata.
    await audit.getByTestId("audit-details").click();
    const detail = page.getByTestId("audit-detail");
    await expect(detail).toContainText("node.move");
    await expect(detail.getByTestId("audit-detail-ip")).not.toHaveText("—");
    await expect(detail.getByTestId("audit-detail-user-agent")).not.toHaveText("—");
    await expect(detail.getByTestId("audit-detail-metadata")).toContainText('"nodeGroupId"');
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    await pick(page, page.getByTestId("audit-filter-action"), "修改网站");
    await expect(audit.getByTestId("audit-action")).toHaveText(["site.update", "site.update"]);
    await expect(audit.getByTestId("audit-actor")).toHaveText(["E2E Admin", "E2E Admin"]);
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
    await expect(reasons.filter({ hasText: "Site edited-site updated" }).first()).toBeVisible();
    await expect(reasons.filter({ hasText: "Cluster default created" })).toHaveCount(1);

    // A refused action explains itself in English (stable error code, localized in the UI).
    await page.getByTestId("cluster-actions").click();
    await page.getByTestId("cluster-delete").click();
    await page.getByTestId("confirm-action").click();
    await expect(page.getByTestId("confirm-error")).toHaveText(
      /^The cluster still has \d+ nodes? and \d+ sites?$/,
    );
    await page.keyboard.press("Escape");
  });

  expect(pageErrors).toEqual([]);
});
