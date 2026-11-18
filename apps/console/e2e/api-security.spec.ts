import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { errors, pick, saved, shots, signedIn, siteTab, test } from "./helpers";

const state = JSON.parse(readFileSync(resolve("../../.e2e/api-security-state.json"), "utf8")) as {
  siteId: string;
  host: string;
};

test.describe.configure({ mode: "serial" });

test("API security: saved modes, sampled endpoints and observations render on desktop and phone", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(`/sites/${state.siteId}`);
  await siteTab(page, "api-security");
  await expect(page.getByTestId("api-schema-mode")).toContainText("执行");
  await expect(page.getByTestId("api-jwt-mode")).toContainText("执行");
  await expect(page.getByTestId("api-graphql-mode")).toContainText("观察");
  await expect(page.getByTestId("api-security-unsupported")).toHaveCount(0);
  await expect(page.getByTestId("api-jwt-issuer")).toHaveValue("https://issuer.api.test");
  await expect(page.getByTestId("api-jwt-audiences")).toHaveValue("api-test");
  await expect(page.getByTestId("api-discovery-results")).toContainText("采样请求数");
  await expect(page.getByTestId("api-discovered-endpoint").first()).toBeVisible();
  await expect(page.getByTestId("api-observation").first()).toBeVisible();
  await expect(page.getByTestId("api-security-save")).toBeDisabled();
  await shots(page, "api-security", "overview");

  const endpoint = page.getByTestId("api-discovered-endpoint").first();
  await endpoint.getByTestId("api-endpoint-confirm").click();
  await page.getByTestId("api-endpoint-path").fill("/ui-confirmed/{id}");
  await saved(page, page.getByTestId("api-endpoint-confirm-submit"), "apiSecurity/confirmEndpoint");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("api-discovery-results")).toContainText("/ui-confirmed/{id}");
  await expect(page.getByTestId("api-schema-endpoints")).not.toContainText("/ui-confirmed/{id}");
  await expect(page.getByTestId("api-security-save")).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test("API security: import previews issue locations and cannot enable schema enforcement", async ({
  page,
}) => {
  const pageErrors = errors(page);
  let updates = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/apiSecurity/update")) updates++;
  });
  await signedIn(page);
  await page.goto(`/sites/${state.siteId}?tab=api-security`);
  await page.getByTestId("api-import-open").click();
  const document = {
    openapi: "3.1.0",
    info: { title: "Preview", version: "1" },
    paths: {
      "/ui-preview": {
        get: {
          parameters: [{ name: "value", in: "query", schema: { type: "string", format: "email" } }],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  await page.getByTestId("api-import-document").fill(JSON.stringify(document));
  await page.getByTestId("api-import-submit").click();
  await expect(page.getByTestId("api-import-preview")).toBeVisible();
  await expect(page.getByTestId("api-import-issues")).toContainText("format");
  await expect(page.getByTestId("api-import-preview")).toContainText("/ui-preview");
  await page.getByTestId("api-import-submit").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByTestId("api-schema-settings").getByTestId("api-import-issues"),
  ).toBeVisible();
  await page.getByTestId("api-schema-mode").click();
  await expect(page.getByRole("option", { name: "执行", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.getByTestId("api-security-save").click();
  await expect(page.getByTestId("api-security-save-error")).toContainText("修正导入问题");
  expect(updates).toBe(0);
  await shots(page, "api-security", "import-issues");
  expect(pageErrors).toEqual([]);
});

test("API security: exceptions save, toggle and delete; enforcement requires an explicit save", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await signedIn(page);
  await page.goto(`/sites/${state.siteId}?tab=api-security`);
  await page.getByTestId("api-exception-add").click();
  await pick(page, page.getByTestId("api-exception-check"), "GraphQL");
  await pick(page, page.getByTestId("api-exception-method"), "POST");
  await page.getByTestId("api-exception-path").fill("/ui-exception");
  await page.getByTestId("api-exception-reason").fill("UI compatibility check");
  await page.getByTestId("api-exception-done").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await pick(page, page.getByTestId("api-graphql-mode"), "执行");
  await page.getByTestId("api-security-save").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("开启执行");
  await saved(page, page.getByTestId("confirm-action"), "apiSecurity/update");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.reload();
  const row = page.getByTestId("api-exception-row").filter({ hasText: "/ui-exception" });
  await expect(row).toBeVisible();
  await expect(page.getByTestId("api-graphql-mode")).toContainText("执行");
  await row.getByRole("switch").click();
  await saved(page, page.getByTestId("api-security-save"), "apiSecurity/update");
  await page.reload();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await row.getByRole("button", { name: "删除/ui-exception的例外", exact: true }).click();
  await pick(page, page.getByTestId("api-graphql-mode"), "观察");
  await saved(page, page.getByTestId("api-security-save"), "apiSecurity/update");
  await page.reload();
  await expect(page.getByTestId("api-exception-row")).toHaveCount(0);
  await expect(page.getByTestId("api-security-save")).toBeDisabled();
  expect(pageErrors).toEqual([]);
});
