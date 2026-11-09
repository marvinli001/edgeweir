import type { Cluster, Revision, Site } from "@edgeweir/contract";
import { expect, type Page, test } from "@playwright/test";
import { errors, login, saved, siteTab } from "./helpers";

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";

// Sites these tests create; later sections expect the sites list to hold only theirs.
const created: string[] = [];

test.describe("small touch window", () => {
  test.use({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });

  test("top bar keeps every action inside the viewport", async ({ page }) => {
    await login(page, email, password);
    for (const locale of ["zh-CN", "en"]) {
      await page.evaluate((value) => localStorage.setItem("PARAGLIDE_LOCALE", value), locale);
      await page.goto("/system");
      await page.locator("html").evaluate((element) => element.ownerDocument.fonts.ready);
      const header = page.locator('[data-slot="top-bar"]');
      await expect(header).toBeVisible();
      expect(
        await page.locator("html").evaluate((element) => ({
          viewport: element.clientWidth,
          page: element.scrollWidth,
        })),
      ).toEqual({ viewport: 320, page: 320 });
      for (const action of await header.locator("button:visible, a:visible").all()) {
        const box = await action.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, right: rect.right };
        });
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(320);
      }
      await page.getByTestId("user-menu").tap();
      await expect(page.getByRole("menu").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("user-menu")).toBeFocused();
    }
  });
});

test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) {
    await page.request.post("/rpc/sites/delete", {
      headers: { "x-csrf-token": "orpc" },
      data: { json: { id } },
    });
  }
});

async function createSite(page: Page, name: string) {
  const response = await page.request.post("/rpc/sites/create", {
    headers: { "x-csrf-token": "orpc" },
    data: {
      json: {
        name,
        domains: [`settings-${Date.now()}.test`],
        origins: [{ address: "origin.test" }],
      },
    },
  });
  expect(response.ok()).toBe(true);
  const { json } = (await response.json()) as { json: { site: Site } };
  created.push(json.site.id);
  return json.site;
}

test("site navigation keeps links, history, keyboard access and drafts", async ({ page }) => {
  const pageErrors = errors(page);
  await login(page, email, password);
  const site = await createSite(page, "Navigation smoke");
  const siteUrl = `/sites/${site.id}`;
  await page.route("**/rpc/extensions/list**", (route) => route.fulfill({ json: { json: [] } }));
  await page.goto(siteUrl);

  await test.step("every original destination stays reachable", async () => {
    for (const tab of [
      "overview",
      "domains",
      "origins",
      "https",
      "cache",
      "rules",
      "redirects",
      "errors",
      "security",
      "access",
      "crawlers",
      "analytics",
      "attacks",
      "logs",
    ]) {
      await siteTab(page, tab);
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      expect(new URL(page.url()).searchParams.get("tab") ?? "overview").toBe(tab);
    }
    // A direct link still exposes Extensions when none are installed.
    await page.goto(`${siteUrl}?tab=extensions`);
    await expect(page.getByTestId("site-tab-group")).toHaveText("性能与交付");
    await expect(page.getByTestId("tab-extensions")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("tab-rules").click();
    await expect(page.getByTestId("tab-extensions")).toHaveCount(0);
  });

  await test.step("deep links, refresh and history follow the route", async () => {
    await page.goto(`${siteUrl}?tab=logs&range=1h&ip=203.0.113.9&path=%2Fnav`);
    await expect(page.getByTestId("site-tab-group")).toHaveText("观测");
    await expect(page.getByTestId("tab-logs")).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).searchParams.get("ip")).toBe("203.0.113.9");
    await siteTab(page, "https");
    await expect(page.getByTestId("tab-https")).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).searchParams.get("range")).toBe("1h");
    expect(new URL(page.url()).searchParams.has("ip")).toBe(false);
    expect(new URL(page.url()).searchParams.has("path")).toBe(false);
    const url = page.url();
    await page.reload();
    await expect(page.getByTestId("site-tab-group")).toHaveText("接入");
    await expect(page.getByTestId("tab-https")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("back-link").click();
    await expect(page).toHaveURL(/\/sites$/);
    await page.goBack();
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId("site-tab-group")).toHaveText("接入");
    await expect(page.getByTestId("tab-https")).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page).toHaveURL(/\/sites$/);
    await page.goBack();
    await expect(page.getByTestId("tab-https")).toHaveAttribute("aria-selected", "true");
  });

  await test.step("phone navigation works by keyboard in both languages and themes", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const locale of ["zh-CN", "en"]) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem("PARAGLIDE_LOCALE", locale);
            localStorage.setItem("theme", theme);
          },
          { locale, theme },
        );
        await page.goto(`${siteUrl}?tab=https&range=1h`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const group = page.getByTestId("site-tab-group");
        await expect(group).toHaveAccessibleName(
          locale === "en" ? "Site settings group" : "网站设置分组",
        );
        for (
          let step = 0;
          step < 30 && !(await group.evaluate((node) => node === node.ownerDocument.activeElement));
          step++
        ) {
          await page.keyboard.press("Tab");
        }
        await expect(group).toBeFocused();
        await group.press("ArrowDown");
        const chosen = page.getByRole("option", { selected: true });
        await expect(chosen).toBeVisible();
        await expect(chosen).toBeFocused();
        await page.keyboard.press("End");
        const observability = page.locator('[role="option"][data-site-tabs~="analytics"]');
        await expect(observability).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(group).toHaveText(locale === "en" ? "Observability" : "观测");
        const analytics = page.getByTestId("tab-analytics");
        await expect(analytics).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Tab");
        await expect(analytics).toBeFocused();
        await analytics.press("End");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("tab-logs")).toBeFocused();
        await expect(page.getByTestId("tab-logs")).toHaveAttribute("aria-selected", "true");
        await siteTab(page, "errors");
        await expect(group).toHaveText(locale === "en" ? "Performance & delivery" : "性能与交付");
        expect(
          await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
        ).toBe(true);
        await expect
          .poll(() =>
            page.evaluate(
              'document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity).length',
            ),
          )
          .toBe(0);
      }
    }
  });

  await test.step("blocked group switches keep the active tab and unsaved draft", async () => {
    await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "zh-CN"));
    await page.goto(siteUrl);
    const group = page.getByTestId("site-tab-group");
    const name = page.getByTestId("site-name-input");
    await name.fill("Unsaved navigation draft");
    await expect(page.getByTestId("site-name-save")).toBeEnabled();
    await group.click();
    await page.getByRole("option", { name: "观测", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "放弃未保存的更改？" });
    await expect(dialog).toBeVisible();
    await expect(group).toHaveText("概览");
    await expect(page.getByTestId("tab-overview")).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(name).toHaveValue("Unsaved navigation draft");
    await expect(group).toHaveText("概览");
    expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
    await group.click();
    await page.getByRole("option", { name: "观测", exact: true }).click();
    await dialog.getByTestId("confirm-action").click();
    await expect(group).toHaveText("观测");
    await expect(page.getByTestId("tab-analytics")).toHaveAttribute("aria-selected", "true");
  });
  expect(pageErrors).toEqual([]);
});

test("cache groups preserve drafts, validation and saved values, with phone keyboard access", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, email, password);
  const site = await createSite(page, "Cache groups smoke");
  const siteUrl = `/sites/${site.id}`;
  try {
    const configured = await page.request.post("/rpc/sites/update", {
      headers: { "x-csrf-token": "orpc" },
      data: {
        json: {
          id: site.id,
          cacheSettings: {
            ...site.cacheSettings,
            cacheKey: {
              ...site.cacheSettings.cacheKey,
              query: "include",
              queryParams: ["version"],
              headers: ["accept-language"],
            },
          },
        },
      },
    });
    expect(configured.ok()).toBe(true);
    await page.goto(siteUrl);
    await siteTab(page, "cache");

    await test.step("common operations need no group opened", async () => {
      await expect(page.getByTestId("dev-mode-card")).toBeVisible();
      await expect(page.getByTestId("cache-rules-card")).toBeVisible();
      await page.getByTestId("cache-purge-entries").fill("/asset.css");
      await expect(page.getByTestId("cache-purge-submit")).toBeEnabled();
      for (const name of ["behavior", "optimization", "response"]) {
        await expect(page.getByTestId(`cache-group-${name}-trigger`)).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        const content = page.getByTestId(`cache-group-${name}-content`);
        await expect(content).toHaveCount(1);
        await expect(content).toBeHidden();
      }
    });

    const behavior = page.getByTestId("cache-group-behavior-trigger");
    const keyCard = page.getByTestId("cache-key-card");
    const headers = page.getByTestId("cache-key-headers");
    await test.step("folded drafts survive other saves and navigation", async () => {
      await behavior.click();
      await expect(headers).toHaveValue("accept-language");
      const original = await headers.elementHandle();
      await headers.fill("accept-language, x-cache-draft");
      await behavior.click();
      await expect(keyCard).toBeHidden();
      await page.getByTestId("cache-rule-add").click();
      await page.getByTestId("cache-rule-prefixes").last().fill("/assets/");
      await saved(page, page.getByTestId("cache-save"), "sites/update");
      await expect(page.getByTestId("cache-save")).toBeDisabled();
      await siteTab(page, "rules");
      const dialog = page.getByRole("dialog", { name: "放弃未保存的更改？" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("tab-cache")).toHaveAttribute("aria-selected", "true");
      await behavior.click();
      await expect(headers).toHaveValue("accept-language, x-cache-draft");
      expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
      await saved(page, page.getByTestId("cache-key-save"), "sites/update");
      await expect(page.getByTestId("cache-key-save")).toBeDisabled();
      await page.reload();
      await expect(behavior).toHaveAttribute("aria-expanded", "false");
      await behavior.click();
      await expect(headers).toHaveValue("accept-language, x-cache-draft");
    });

    await test.step("validation reveals folded fields for correction", async () => {
      await headers.fill("bad:header");
      await behavior.click();
      await keyCard
        .locator("form")
        .evaluate((form) => (form as unknown as { requestSubmit(): void }).requestSubmit());
      await expect(behavior).toHaveAttribute("aria-expanded", "true");
      await expect(keyCard.getByTestId("site-save-error")).toBeVisible();
      await headers.fill("accept-language, x-cache-draft");
      const params = page.getByTestId("cache-key-params");
      await expect(params).toHaveValue("version");
      await params.clear();
      await behavior.click();
      await expect(params).toBeHidden();
      await keyCard
        .locator("form")
        .evaluate((form) => (form as unknown as { requestSubmit(): void }).requestSubmit());
      await expect(behavior).toHaveAttribute("aria-expanded", "true");
      await expect(params).toBeVisible();
      await expect(params).toBeFocused();
      await params.fill("version, locale");
      await saved(page, page.getByTestId("cache-key-save"), "sites/update");
      await expect(page.getByTestId("cache-key-save")).toBeDisabled();
      await page.reload();
      await behavior.click();
      await expect(params).toHaveValue("version, locale");
      await expect(headers).toHaveValue("accept-language, x-cache-draft");
    });

    await test.step("phone keyboard access in both languages and themes", async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      for (const locale of ["zh-CN", "en"]) {
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            ({ locale, theme }) => {
              localStorage.setItem("PARAGLIDE_LOCALE", locale);
              localStorage.setItem("theme", theme);
            },
            { locale, theme },
          );
          await page.goto(`${siteUrl}?tab=cache`);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(behavior).toHaveAccessibleName(
            locale === "en" ? "Cache behavior" : "缓存行为",
          );
          await expect(behavior).toHaveAccessibleDescription(/Cache key|缓存键/);
          await page.getByTestId("tab-cache").click();
          for (const name of ["behavior", "optimization", "response"]) {
            const trigger = page.getByTestId(`cache-group-${name}-trigger`);
            const content = page.getByTestId(`cache-group-${name}-content`);
            for (
              let step = 0;
              step < 60 &&
              !(await trigger.evaluate((node) => node === node.ownerDocument.activeElement));
              step++
            ) {
              await page.keyboard.press("Tab");
            }
            await expect(trigger).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            await expect(content).toBeVisible();
            await page.keyboard.press("Space");
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await expect(content).toBeHidden();
            await expect(trigger).toBeFocused();
          }
          expect(
            await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
          ).toBe(true);
          for (const name of ["behavior", "optimization", "response"])
            await page.getByTestId(`cache-group-${name}-trigger`).click();
          await expect(page.getByTestId("charset-card")).toBeVisible();
          expect(
            await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
          ).toBe(true);
        }
      }
    });
    expect(pageErrors).toEqual([]);
  } finally {
    const removed = await page.request.post("/rpc/sites/delete", {
      headers: { "x-csrf-token": "orpc" },
      data: { json: { id: site.id } },
    });
    expect(removed.ok()).toBe(true);
  }
});

test("enrollment progress retries failed requests, keeps progress and opens site creation", async ({
  page,
}) => {
  const pageErrors = errors(page);
  let progress: "error" | "waiting" | "partial" | "ready" = "error";
  await page.route("**/rpc/settings/nodeChannelCheck**", (route) =>
    route.fulfill({
      json: {
        json: {
          url: "https://node.test:8443",
          result: "ok",
          candidate: null,
          checkedAt: new Date().toISOString(),
        },
      },
    }),
  );
  await page.route("**/rpc/clusters/getEnrollmentToken**", (route) => {
    if (progress === "error") return route.abort("failed");
    return route.fulfill({
      json: {
        json: {
          tokenId: "00000000-0000-4000-8000-000000000001",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          usedAt: progress === "waiting" ? null : new Date().toISOString(),
          node:
            progress === "waiting"
              ? null
              : {
                  id: "00000000-0000-4000-8000-000000000002",
                  clusterId: "00000000-0000-4000-8000-000000000003",
                  name: "edge-progress",
                  online: true,
                  applyState: "applied",
                  appliedRevision: 1,
                  dataPlaneHealthy: progress === "ready",
                  schedulingAddresses:
                    progress === "ready"
                      ? [{ address: "203.0.113.1", level: 0, source: "reported", reachable: true }]
                      : [],
                  dnsIssue: null,
                },
        },
      },
    });
  });
  await login(page, email, password);
  await page.goto("/clusters?enroll=true");
  await page.getByTestId("enroll-method-manual").click();
  await expect(page.getByTestId("install-command")).toBeVisible();
  const failure = page.getByRole("alert").filter({ hasText: "注册进度查询失败" });
  const steps = page.getByTestId("enroll-progress");
  await expect(failure).toBeVisible();
  await expect(steps).toHaveCount(0);
  await expect(page.getByTestId("enroll-create-site")).toHaveCount(0);

  progress = "waiting";
  await failure.getByRole("button", { name: "重试", exact: true }).click();
  await expect(failure).toBeHidden();
  await expect(steps.locator('[data-step="waiting"]')).toHaveText("等待节点注册");

  progress = "partial";
  await expect(page.getByTestId("enroll-node-link")).toHaveText("edge-progress");
  await expect(steps.locator('[data-tone="good"]')).toHaveCount(3);
  await expect(page.getByTestId("enroll-create-site")).toHaveCount(0);
  progress = "error";
  await expect(failure).toBeVisible();
  await expect(page.getByTestId("enroll-node-link")).toHaveText("edge-progress");
  await expect(steps.locator('[data-tone="good"]')).toHaveCount(3);
  await expect(steps.locator(".dot-pulse")).toHaveCount(0);

  progress = "ready";
  await failure.getByRole("button", { name: "重试", exact: true }).click();
  await expect(failure).toBeHidden();
  await expect(steps.locator('[data-tone="good"]')).toHaveCount(5);
  await page.getByTestId("enroll-create-site").click();
  await expect(page).toHaveURL(/\/sites\?create=true$/);
  await expect(page.getByTestId("create-site-submit")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a failed node channel check has its own retry without hiding enrollment progress", async ({
  page,
}) => {
  const pageErrors = errors(page);
  let failed = true;
  await page.route("**/rpc/settings/nodeChannelCheck**", (route) =>
    failed
      ? route.abort("failed")
      : route.fulfill({
          json: {
            json: {
              url: "https://node.test:8443",
              result: "unreachable",
              candidate: null,
              checkedAt: new Date().toISOString(),
            },
          },
        }),
  );
  await login(page, email, password);
  await page.goto("/clusters?enroll=true");
  await page.getByTestId("enroll-method-manual").click();
  const failure = page.getByRole("alert").filter({ hasText: "节点通道检查查询失败" });
  await expect(failure).toBeVisible();
  await expect(page.getByTestId("enroll-progress")).toContainText("等待节点注册");
  failed = false;
  await failure.getByRole("button", { name: "重试", exact: true }).click();
  await expect(failure).toBeHidden();
  await expect(page.getByTestId("node-channel-check")).toHaveAttribute(
    "data-result",
    "unreachable",
  );
  await expect(page.getByTestId("node-channel-fix")).toBeVisible();
  await expect(page.getByTestId("enroll-progress")).toContainText("等待节点注册");
  expect(pageErrors).toEqual([]);
});

test("configuration history: retry, keyboard paging and oldest rollback on a phone", async ({
  page,
}) => {
  const pageErrors = errors(page);
  let failNextPage = true;
  // A real empty cluster hides releases; the retained-history UI fixture includes a node count.
  await page.route("**/rpc/clusters/list**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Cluster[] };
    body.json = body.json.map((cluster) => ({
      ...cluster,
      nodeCount: Math.max(1, cluster.nodeCount),
      latestRevision: cluster.latestRevision && { ...cluster.latestRevision, revision: 125 },
    }));
    await route.fulfill({ json: body });
  });
  await page.route("**/rpc/clusters/revisions**", (route) => {
    const { json: input } = route.request().postDataJSON() as {
      json: { id: string; before?: number; limit: number };
    };
    expect(input.limit).toBe(20);
    if (input.before === 106 && failNextPage) return route.abort("failed");
    const history: Revision[] = Array.from({ length: 125 }, (_, index) => ({
      clusterId: input.id,
      revision: 125 - index,
      contentHash: (125 - index).toString(16).padStart(64, "0"),
      siteCount: 1,
      reason: "History fixture",
      reasonCode: "",
      reasonParams: {},
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    return route.fulfill({
      json: {
        json: history
          .filter((row) => input.before === undefined || row.revision < input.before)
          .slice(0, input.limit),
      },
    });
  });
  await page.route("**/rpc/clusters/rollbackPreview**", (route) => {
    const { json: input } = route.request().postDataJSON() as { json: { revision: number } };
    expect(input.revision).toBe(1);
    return route.fulfill({
      json: {
        json: {
          revision: 1,
          currentRevision: 125,
          unchanged: false,
          sites: {
            added: [],
            changed: [],
            removed: [{ id: "00000000-0000-4000-8000-000000000001", name: "history.test" }],
          },
        },
      },
    });
  });
  await login(page, email, password);
  await page.goto("/clusters?tab=releases");
  const table = page.getByTestId("revisions-table");
  const rows = table.locator("tbody tr");
  const more = page.getByTestId("revisions-more");
  const section = page.locator("section").filter({ has: table });
  await expect(rows).toHaveCount(20);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveText("重试");
  await expect(section.getByRole("alert")).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toHaveAttribute("data-row-id", "125");

  failNextPage = false;
  await more.press("Enter");
  await expect(rows).toHaveCount(40);
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(table.locator('[data-row-id="105"]').getByTestId("revision-rollback")).toBeFocused();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (let loaded = 40; loaded < 125; loaded += 20) {
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(Math.min(loaded + 20, 125));
    await expect(
      table.locator(`[data-row-id="${125 - loaded}"]`).getByTestId("revision-rollback"),
    ).toBeFocused();
  }
  await expect(more).toHaveCount(0);
  expect(await rows.evaluateAll((list) => list.map((row) => Number(row.dataset.rowId)))).toEqual(
    Array.from({ length: 125 }, (_, index) => 125 - index),
  );
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );

  await table.locator('[data-row-id="1"]').getByTestId("revision-rollback").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("以 #1 的配置发布新版本？");
  await expect(page.getByTestId("rollback-preview")).toContainText("history.test");
  await expect(page.getByTestId("confirm-action")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("rule delivery RPC fixtures keep saved, live and unavailable states separate", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, email, password);
  const site = await createSite(page, "Delivery smoke");
  const siteUrl = `/sites/${site.id}?tab=rules`;
  let delivery: "partial" | "live" | "offline" | "unavailable" = "partial";
  // Only delivery responses are fixtures; saves use the real console without an enrolled node.
  await page.route("**/rpc/sites/get**", async (route) => {
    if (delivery === "unavailable") return route.fulfill({ status: 503, body: "unavailable" });
    const response = await route.fetch();
    const body = (await response.json()) as { json: Site };
    body.json.delivery = {
      state: delivery === "offline" ? "pending" : delivery,
      totalNodes: delivery === "offline" ? 0 : 2,
      currentNodes: delivery === "live" ? 2 : delivery === "partial" ? 1 : 0,
      servingNodes: delivery === "offline" ? 0 : 2,
      canary: null,
    };
    await route.fulfill({ json: body });
  });
  await page.goto(siteUrl);
  await page.getByTestId("rule-add-waf-custom").click();
  let rule = page.getByTestId("rule-row").last();
  await rule.getByLabel("名称", { exact: true }).fill("Delivery fixture");
  await rule.getByLabel("表达式", { exact: true }).fill("true");
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  const notice = page.getByTestId("site-delivery-toast");
  await expect(notice).toContainText("已保存");
  await expect(notice).toContainText("生效中 1/2");
  await expect(notice.locator('div[data-type="loading"]')).toBeVisible();
  delivery = "live";
  await expect(notice).toContainText("已生效（在线节点）");
  await expect(notice.locator('div[data-type="success"]')).toBeVisible();
  await notice.getByRole("button", { name: "查看节点", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/clusters\\?cluster=${site.clusterId}$`));

  delivery = "offline";
  await page.goto(siteUrl);
  rule = page.getByTestId("rule-row").last();
  await rule.getByLabel("表达式", { exact: true }).fill("false");
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  await expect(notice).toContainText("没有在线节点");
  await expect(notice.locator('div[data-type="info"]')).toBeVisible();
  await expect(notice).not.toContainText("已生效");

  await rule.getByLabel("表达式", { exact: true }).fill("true");
  delivery = "unavailable";
  await saved(page, page.getByTestId("rules-save"), "rules/save");
  await expect(notice).toContainText("已保存");
  await expect(notice).toContainText("暂时无法查询节点生效状态");
  await expect(notice.locator('div[data-type="info"]')).toBeVisible();
  await expect(page.getByTestId("site-save-error")).toHaveCount(0);
  await page.unroute("**/rpc/sites/get**");
  await page.goto("/rules");
  await page.getByTestId("rule-add-waf-custom").click();
  rule = page.getByTestId("rule-row").last();
  await rule.getByLabel("名称", { exact: true }).fill("Platform delivery fixture");
  await rule.getByLabel("表达式", { exact: true }).fill("true");
  await saved(page, page.getByTestId("rules-save"), "platformRules/save");
  const platformNotice = page.getByTestId("rules-delivery-toast");
  await expect(platformNotice).toContainText("已保存");
  await expect(platformNotice).toContainText("请逐集群查看节点生效状态");
  await expect(platformNotice.locator('div[data-type="info"]')).toBeVisible();
  await expect(platformNotice).not.toContainText("已生效");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
    true,
  );
  await platformNotice.getByRole("button", { name: "查看节点", exact: true }).click();
  await expect(page).toHaveURL(/\/clusters$/);
  expect(pageErrors).toEqual([]);
});
