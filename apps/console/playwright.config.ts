import { defineConfig, devices } from "@playwright/test";

/**
 * UI smoke tests against a running console (compose.e2e.yml), driven by
 * scripts/e2e.sh which provides the base URL and admin credentials.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // The specs are one ordered story against one console (scripts/e2e.sh runs them in turn).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:13000",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], locale: "zh-CN" } }],
});
