import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers";

/**
 * MCP (ADR-0076) in the browser: the system card, the consent page and connected apps. Runs after
 * scripts/e2e-mcp.mjs, which leaves MCP switched on (its --cleanup switches it off).
 */
test.describe.configure({ mode: "serial" });

const REDIRECT = "http://127.0.0.1:47124/callback";

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `../../.e2e/mcp-${name}-${scheme}.png`, animations: "disabled" });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `../../.e2e/mcp-${name}-${scheme}-375.png`,
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

test("the system card shows the switch and the server URL", async ({ page, baseURL }) => {
  await page.goto("/system");
  await expect(page.getByTestId("mcp-enabled")).toBeChecked();
  await expect(page.getByTestId("mcp-url")).toHaveText(`${baseURL}/mcp`);
  // A loopback console is fine for clients on the same machine: no HTTPS note.
  await expect(page.getByTestId("mcp-https")).toHaveCount(0);
  await page.getByTestId("mcp-url").scrollIntoViewIfNeeded();
  await check(page, "system");
});

test("the consent page grants read and write, and connected apps revoke it", async ({
  page,
  baseURL,
}) => {
  const registered = await page.request.post("/api/auth/oauth2/register", {
    data: {
      client_name: "E2E Browser",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "edgeweir:read edgeweir:write offline_access",
    state: "browser",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  });
  // Nothing listens on the client's loopback port: answer for it.
  await page.route(`${REDIRECT}**`, (route) => route.fulfill({ status: 200, body: "client" }));

  await page.goto(`/api/auth/oauth2/authorize?${params}`);
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(page.getByTestId("consent-title")).toHaveText("连接 E2E Browser");
  await expect(page.getByTestId("consent-localhost")).toBeVisible();
  await expect(page.getByTestId("consent-read")).toHaveAttribute("aria-selected", "true");
  await check(page, "consent");
  await page.getByTestId("consent-write").click();
  await page.getByTestId("consent-allow").click();
  await page.waitForURL((url) => url.href.startsWith(REDIRECT));
  const back = new URL(page.url());
  expect(back.searchParams.get("state")).toBe("browser");
  expect(back.searchParams.get("code")).toBeTruthy();

  await page.goto("/security");
  const apps = page.getByTestId("connected-apps");
  const row = apps.locator("li", { hasText: "E2E Browser" });
  await expect(row).toContainText("读写");
  await row.scrollIntoViewIfNeeded();
  await check(page, "apps");
  await row.getByTestId("revoke-app").click();
  await page.getByRole("dialog").getByTestId("confirm-action").click();
  await expect(apps.locator("li", { hasText: "E2E Browser" })).toHaveCount(0);
});
