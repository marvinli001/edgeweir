import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pick, saved, shots, signedIn, test } from "./helpers";

/**
 * Written by scripts/e2e-h2.mjs on cluster A: the site h2-e2e (h2.e2e.test,
 * origin h2-origin:8080), left on HTTP/1.1 without gRPC. The test leaves it
 * as it found it.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/h2-state.json"), "utf8")) as {
  siteId: string;
};

const check = (page: Page, name: string) => shots(page, "h2", name);

test("HTTP/2 and gRPC: the pool settings switch the protocol towards the origins and gRPC", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signedIn(page);
  await page.goto(`/sites/${state.siteId}?tab=origins`);
  await expect(page.getByTestId("tab-origins")).toHaveAttribute("aria-selected", "true");
  const protocol = page.getByTestId("pool-protocol");
  const grpc = page.getByTestId("pool-grpc");
  const note = page.getByTestId("pool-grpc-note");
  const save = page.getByTestId("pool-save");

  // The script's last state: HTTP/1.1, gRPC off and unavailable with it.
  await expect(protocol).toHaveText("HTTP/1.1");
  await expect(grpc).toHaveAttribute("aria-checked", "false");
  await expect(grpc).toBeDisabled();
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId("pool-protocol-unavailable")).toHaveCount(0);
  await expect(save).toBeDisabled();

  await pick(page, protocol, "HTTP/2");
  await expect(grpc).toBeEnabled();
  await grpc.click();
  await expect(note).toHaveText("gRPC 请求不经过 OWASP CRS");
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(protocol).toHaveText("HTTP/2");
  await expect(grpc).toHaveAttribute("aria-checked", "true");
  await expect(note).toBeVisible();
  await check(page, "origins");

  // HTTP/1.1 takes gRPC off with it.
  await pick(page, protocol, "HTTP/1.1");
  await expect(grpc).toHaveAttribute("aria-checked", "false");
  await expect(grpc).toBeDisabled();
  await expect(note).toHaveCount(0);
  await saved(page, save, "sites/update");
  await page.reload();
  await expect(protocol).toHaveText("HTTP/1.1");
  await expect(grpc).toHaveAttribute("aria-checked", "false");
  expect(pageErrors).toEqual([]);
});
