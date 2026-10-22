import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pick, saved, shots, signedIn, test } from "./helpers";

/**
 * Written by scripts/e2e-g19.mjs on cluster A: the site that presents the
 * cluster's origin client certificate (g19-mtls), the site that trusts the
 * Origin CA alone (g19-oca) and the revoked certificate issued from a CSR.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/g19-state.json"), "utf8")) as {
  mtlsSiteId: string;
  ocaSiteId: string;
  fromCsrId: string;
};

const check = (page: Page, name: string) => shots(page, "g19", name);

test("origin protection: the certificates page's Origin CA and origin client tabs", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signedIn(page);
  await page.goto("/certificates");
  await expect(page.getByTestId("cert-tab-certificates")).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("cert-tab-origin-ca").click();
  await expect(page).toHaveURL(/tab=origin-ca/);
  await expect(page.getByTestId("origin-ca")).toBeVisible();
  await expect(page.getByTestId("origin-ca-fingerprint")).toHaveText(/^[0-9a-f]{64}$/);
  const list = page.getByTestId("origin-cert-list");
  await expect(list.getByTestId("origin-cert-revoked").first()).toHaveText("已吊销");
  await check(page, "origin-ca");

  // Issue one with a generated key: shown once, then listed; revoke it.
  await page.getByTestId("origin-cert-issue").click();
  await page.getByTestId("origin-cert-hostnames").fill("ui.g19.e2e.test\n*.ui.g19.e2e.test");
  await pick(page, page.getByTestId("origin-cert-validity"), "3 年");
  const issued = page.waitForResponse((r) => r.url().includes("/rpc/originCertificates/issue"));
  await page.getByTestId("origin-cert-issue-submit").click();
  expect((await issued).ok()).toBe(true);
  await expect(page.getByTestId("origin-cert-pem")).toContainText("BEGIN CERTIFICATE");
  await expect(page.getByTestId("origin-cert-key")).toContainText("BEGIN PRIVATE KEY");
  await expect(page.getByText("私钥只显示一次")).toBeVisible();
  await check(page, "issued");
  await page.getByTestId("origin-cert-done").click();
  const row = page.getByTestId("origin-cert").filter({ hasText: "ui.g19.e2e.test" });
  await expect(row).toHaveCount(1);
  await row.getByTestId("origin-cert-revoke").click();
  await page.getByTestId("confirm-action").click();
  await expect(row.getByTestId("origin-cert-revoked")).toBeVisible();
  await expect(row.getByTestId("origin-cert-revoke")).toHaveCount(0);

  await page.getByTestId("cert-tab-origin-client").click();
  await expect(page).toHaveURL(/tab=origin-client/);
  await expect(page.getByTestId("origin-client-ca")).toBeVisible();
  await expect(page.getByTestId("origin-client-certificates")).toBeVisible();
  await check(page, "origin-client");
  expect(pageErrors).toEqual([]);
});

test("origin protection: a pool's trust and client certificate", async ({ page }) => {
  await signedIn(page);
  await page.goto(`/sites/${state.ocaSiteId}?tab=origins`);
  const trust = page.getByTestId("pool-tls-trust");
  const verify = page.getByTestId("pool-tls-verify");
  const clientCertificate = page.getByTestId("pool-client-certificate");
  const save = page.getByTestId("pool-save");
  await expect(trust).toHaveText("Origin CA");
  await expect(clientCertificate).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("pool-tls-trust-unavailable")).toHaveCount(0);
  await check(page, "pool");
  // Without verification there is no trust to choose; the page is left as found.
  await verify.click();
  await expect(trust).toBeDisabled();
  await expect(trust).toHaveText("系统 CA");
  await verify.click();
  await pick(page, trust, "Origin CA");
  await expect(save).toBeDisabled();

  await page.goto(`/sites/${state.mtlsSiteId}?tab=origins`);
  await expect(clientCertificate).toHaveAttribute("aria-checked", "true");
  await expect(trust).toBeDisabled();
  await clientCertificate.click();
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(clientCertificate).toHaveAttribute("aria-checked", "false");
  await clientCertificate.click();
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(clientCertificate).toHaveAttribute("aria-checked", "true");
});
