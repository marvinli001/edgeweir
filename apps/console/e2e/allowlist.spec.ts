import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers";

/**
 * Written by scripts/e2e-allowlist.mjs: an AccessKey (removed by its --cleanup). The list is off
 * when these tests start and when they end.
 */
const state = JSON.parse(readFileSync(resolve("../../.e2e/allowlist-state.json"), "utf8")) as {
  key: string;
};

test.describe.configure({ mode: "serial" });

/** Saves the list through /api/v1 from `where`: keys are not limited by it. */
function saveList(cidrs: string[], where: "host" | "client-a" = "host") {
  const script = `
const r = await fetch(process.env.URL, {
  method: "PUT",
  headers: { "content-type": "application/json", "x-api-key": process.env.KEY },
  body: process.env.BODY,
});
if (!r.ok) throw new Error(r.status + " " + (await r.text()));
console.log(JSON.stringify(await r.json()));
`;
  const env = [
    "-e",
    `KEY=${state.key}`,
    "-e",
    `BODY=${JSON.stringify({ cidrs })}`,
    "-e",
    "URL=http://console:3000/api/v1/settings/login-allow-list",
  ];
  if (where === "host") {
    const url = `${test.info().project.use.baseURL}/api/v1/settings/login-allow-list`;
    return execFileSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, URL: url, KEY: state.key, BODY: JSON.stringify({ cidrs }) },
    }).toString();
  }
  return execFileSync("docker", [
    "compose",
    "-f",
    "../../compose.e2e.yml",
    "exec",
    "-T",
    ...env,
    "client-a",
    "node",
    "--input-type=module",
    "-e",
    script,
  ]).toString();
}

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `../../.e2e/allowlist-${name}-${scheme}.png`,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/allowlist-${name}-${scheme}-375.png`,
      animations: "disabled",
    });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
      `${name} overflows at 375 px (${scheme})`,
    ).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("the card shows the current IP, refuses a list without it and adds it", async ({ page }) => {
  await page.goto("/system");
  const card = page.getByTestId("login-allow-list-card");
  const current = card.getByTestId("login-allow-list-current");
  await expect(current).toContainText("当前 IP：");
  const ip = /当前 IP：([0-9a-f.:]+)/.exec((await current.textContent()) ?? "")?.[1] ?? "";
  expect(ip).toMatch(/^[0-9a-f.:]+$/);
  // The host reaches the console through Docker's port mapping: a private address.
  await expect(card.getByTestId("login-allow-list-proxy-hint")).toBeVisible();
  const list = card.getByTestId("login-allow-list");
  await expect(list).toHaveValue("");

  await list.fill("192.0.2.0/24");
  await card.getByTestId("login-allow-list-save").click();
  await expect(card.getByTestId("login-allow-list-error")).toHaveText(
    `名单不含当前 IP ${ip}，保存后将无法登录`,
  );
  await card.getByTestId("login-allow-list-add-current").click();
  await expect(card.getByTestId("login-allow-list-add-current")).toBeDisabled();
  await card.getByTestId("login-allow-list-save").click();
  const host = ip.includes(":") ? `${ip}/128` : `${ip}/32`;
  await expect(list).toHaveValue([host, "192.0.2.0/24"].sort().join("\n"));
  await card.scrollIntoViewIfNeeded();
  await check(page, "card");

  await list.fill("");
  await card.getByTestId("login-allow-list-save").click();
  await expect(list).toHaveValue("");
});

test("outside the list the session goes back to sign-in, which says why", async ({ page }) => {
  // client-a puts only its own address on the list.
  const saved = JSON.parse(saveList([], "client-a")) as { currentIp: string };
  saveList([saved.currentIp], "client-a");
  try {
    await page.goto("/overview");
    await expect(page).toHaveURL(/\/login/);
    await page.context().clearCookies();
    await page
      .getByLabel("邮箱", { exact: true })
      .fill(process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test");
    await page
      .getByLabel("密码", { exact: true })
      .fill(process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toHaveText("此 IP 不在登录白名单内");
    await check(page, "login");
  } finally {
    saveList([]);
  }
});
