import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { pick, saved, shots, signedIn, test } from "./helpers";

/**
 * Written by scripts/e2e-pp.mjs on cluster A: the site pp-e2e (pp.e2e.test),
 * left with PROXY protocol v2 to h2-origin:8083 and a gRPC health check of
 * e2e.Echo. The test leaves it as it found it.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/pp-state.json"), "utf8")) as {
  siteId: string;
};

test("PROXY protocol and gRPC health checks: an origin's version and the probe type", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signedIn(page);
  await page.goto(`/sites/${state.siteId}?tab=origins`);
  await expect(page.getByTestId("tab-origins")).toHaveAttribute("aria-selected", "true");
  const version = page.getByTestId("origin-proxy-protocol").first();
  const note = page.getByTestId("origin-proxy-protocol-note");
  const save = page.getByTestId("origins-save");
  const type = page.getByTestId("origins-health-type");
  const service = page.getByTestId("origins-health-grpc-service");

  // The script's last state.
  await expect(version).toHaveText("v2");
  await expect(note).toHaveText("源站须支持 PROXY protocol");
  await expect(page.getByTestId("origins-proxy-unavailable")).toHaveCount(0);
  await expect(type).toHaveText("gRPC");
  await expect(service).toHaveValue("e2e.Echo");
  await expect(page.getByTestId("origins-health-path")).toHaveCount(0);
  await expect(page.getByTestId("origins-health-method")).toHaveCount(0);
  await shots(page, "pp", "origins");

  // v1, saved and read back, then v2 again.
  await pick(page, version, "v1");
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(version).toHaveText("v1");
  await pick(page, version, "v2");
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(version).toHaveText("v2");

  // Off hides the note; HTTP probes bring back their fields (not saved).
  await pick(page, version, "关闭");
  await expect(note).toHaveCount(0);
  await pick(page, type, "HTTP");
  await expect(service).toHaveCount(0);
  await expect(page.getByTestId("origins-health-path")).toHaveValue("/");
  expect(pageErrors).toEqual([]);
});
