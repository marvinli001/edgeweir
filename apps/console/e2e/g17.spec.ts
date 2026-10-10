import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * G17 tags, batch operations, copying settings and cloning in the browser, on the sites
 * scripts/e2e-g17.mjs leaves (.e2e/g17-state.json): g17-src (rules choosing origin group "b",
 * cache rules, tag g17-source), g17-t1 and g17-t2 (tag g17-copy, the settings copied from
 * g17-src) and g17-bad (no group "b", nothing copied). Data of its own is unique per run: the
 * tags g17-ui-<run>… and the clone g17-ui-<run>.test, which the batch delete at the end removes.
 */
const ADMIN = [
  process.env.E2E_ADMIN_EMAIL ?? "admin@e2e.test",
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
] as const;
const RUN = Date.now().toString(36);
const STATE_FILE = resolve("../../.e2e/g17-state.json");
const state = existsSync(STATE_FILE)
  ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<
      "src" | "t1" | "t2" | "bad" | "clone",
      string
    >)
  : undefined;

test.describe.configure({ mode: "serial" });
test.skip(!state, "needs .e2e/g17-state.json from scripts/e2e-g17.mjs");

/** Screenshots in light and dark, desktop and 375 px, and no horizontal overflow on a phone. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [width, height, suffix] of [
      [1280, 900, ""],
      [375, 812, "-375"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `../../.e2e/g17-${name}-${scheme}${suffix}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
        `${name} overflows at ${width} px (${scheme})`,
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        `[...document.querySelectorAll('[data-slot="card"], [role="dialog"]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1)`,
      ),
      `${name}: content wider than its card or dialog at 375 px (${scheme})`,
    ).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

function errors(page: Page) {
  const list: string[] = [];
  page.on("pageerror", (error) => list.push(error.message));
  return list;
}

const rowNames = (page: Page) => page.getByTestId("site-link").allTextContents();

/** The site list filtered by one tag, through the tag filter. */
async function filterByTag(page: Page, tag: string) {
  await page.goto("/sites");
  await page.getByTestId("tag-filter").click();
  await page.getByTestId("tag-filter-option").filter({ hasText: tag }).click();
  await page.keyboard.press("Escape");
}

test("G17: tags filter the site list, are edited on a site and renamed or deleted", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await filterByTag(page, "g17-copy");
  await expect.poll(() => rowNames(page)).toEqual(expect.arrayContaining(["g17-t1", "g17-t2"]));
  expect((await rowNames(page)).sort()).toEqual(["g17-t1", "g17-t2"]);
  // All of g17-copy and g17-source: no site has both.
  await page.getByTestId("tag-filter").click();
  await page.getByTestId("tag-filter-option").filter({ hasText: "g17-source" }).click();
  await page.getByTestId("tag-match-all").click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("没有匹配的网站")).toBeVisible();
  await expect(page).toHaveURL(/match=all/);

  // A tag added on a site's overview, found again through the command palette.
  const tag = `g17-ui-${RUN}`;
  await page.goto(`/sites/${state?.t1}`);
  await page.getByTestId("site-tags-edit").click();
  await page.getByTestId("tag-picker-input").fill(`  ${tag.toUpperCase()} `);
  await page.getByTestId("tag-picker-input").press("Enter");
  await page.getByTestId("tag-picker-input").fill(tag);
  await page.getByTestId("tag-picker-input").press("Enter");
  // g17-copy and the new tag: the same name in another case is the same tag, one chip.
  await expect(page.getByTestId("tag-chip")).toHaveCount(2);
  await page.getByTestId("site-tags-save").click();
  await expect(page.getByTestId("site-tag").filter({ hasText: tag.toUpperCase() })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.type(tag);
  await page.getByTestId("command-tag").first().click();
  await expect.poll(() => rowNames(page)).toEqual(["g17-t1"]);

  // Rename it, then delete it in the tag manager.
  await page.getByTestId("manage-tags").click();
  const row = page.getByTestId("tag-row").filter({ hasText: tag.toUpperCase() });
  await row.getByTestId("tag-rename").click();
  await page.getByTestId("tag-rename-input").fill(`${tag}-renamed`);
  await page.getByTestId("tag-rename-save").click();
  const renamed = page.getByTestId("tag-row").filter({ hasText: `${tag}-renamed` });
  await expect(renamed).toContainText("1 个网站");
  await check(page, "tag-manager");
  await renamed.getByTestId("tag-delete").click();
  await page.getByTestId("confirm-action").click();
  await expect(renamed).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`/sites/${state?.t1}`);
  await expect(page.getByTestId("site-tag")).toHaveText(["g17-copy"]);
  expect(pageErrors).toEqual([]);
});

test("G17: the copy dialog previews each target and copies to the others when one fails", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  await page.goto(`/sites/${state?.src}`);
  await page.getByTestId("site-copy").click();
  const pickTarget = async (name: string) => {
    await page.getByRole("searchbox", { name: "目标网站" }).fill(name);
    await page.getByTestId("site-option").filter({ hasText: name }).click();
  };
  await pickTarget("g17-t1");
  await pickTarget("g17-bad");
  await page.getByTestId("copy-part-cacheRules").click();
  await page.getByTestId("copy-part-rules").click();
  await page.getByTestId("copy-preview").click();
  const targets = page.getByTestId("copy-preview-target");
  await expect(targets).toHaveCount(2);
  // t1 has both already (scripts/e2e-g17.mjs); bad lacks the origin group the rules choose.
  await expect(targets.filter({ hasText: "g17-t1" })).toContainText("无变化");
  await expect(targets.filter({ hasText: "g17-bad" }).getByTestId("copy-preview-error")).toHaveText(
    "规则「to-b」选择的源站组 b 在该网站不存在",
  );
  await check(page, "copy-preview");
  await page.getByTestId("copy-apply").click();
  const results = page.getByTestId("copy-result-target");
  await expect(results.filter({ hasText: "g17-t1" })).toHaveAttribute("data-ok", "true");
  await expect(results.filter({ hasText: "g17-bad" })).toHaveAttribute("data-ok", "false");
  await page.getByTestId("copy-done").click();

  // The cache rules alone reach bad.
  await page.getByTestId("site-copy").click();
  await pickTarget("g17-bad");
  await page.getByTestId("copy-part-cacheRules").click();
  await page.getByTestId("copy-preview").click();
  await expect(page.getByTestId("copy-change-cacheRules")).toHaveText("0 → 1 项");
  await page.getByTestId("copy-apply").click();
  await expect(page.getByTestId("copy-result-target")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("copy-result-target")).toContainText("缓存规则");
  await page.getByTestId("copy-done").click();
  expect(pageErrors).toEqual([]);
});

test("G17: a clone opens with the source's tags; batch actions turn sites off and on, tag and delete them", async ({
  page,
}) => {
  const pageErrors = errors(page);
  await login(page, ...ADMIN);
  const domain = `g17-ui-${RUN}.test`;
  await page.goto(`/sites/${state?.src}`);
  await page.getByTestId("site-clone").click();
  await page.getByTestId("clone-domains").fill(domain);
  await expect(page.getByTestId("clone-tags").getByTestId("tag-chip")).toHaveText(["g17-source"]);
  await check(page, "clone");
  await page.getByTestId("clone-submit").click();
  await expect(page.getByTestId("page-title")).toHaveText(domain);
  await expect(page.getByTestId("site-tag")).toHaveText(["g17-source"]);

  // Turn t1 and t2 off and on again, from the list filtered by their tag.
  await filterByTag(page, "g17-copy");
  await expect.poll(() => rowNames(page)).toHaveLength(2);
  await page.getByTestId("select-page").click();
  await expect(page.getByTestId("batch-count")).toHaveText("已选 2 个");
  await check(page, "batch-bar");
  await page.getByTestId("batch-disable").click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId("sites-table").getByText("已停用")).toHaveCount(2);
  await page.getByTestId("batch-enable").click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId("sites-table").getByText("已停用")).toHaveCount(0);

  // A tag on both, then off both.
  const batchTag = `g17-batch-${RUN}`;
  await page.getByTestId("batch-addTags").click();
  await page.getByTestId("batch-tags-input").fill(batchTag);
  await page.getByTestId("batch-tags-submit").click();
  await expect(page.getByTestId("site-tag").filter({ hasText: batchTag })).toHaveCount(2);
  await page.getByTestId("batch-removeTags").click();
  await page.getByTestId("batch-tags-input").fill(batchTag);
  await page.getByTestId("batch-tags-input").press("Enter");
  await page.getByTestId("batch-tags-submit").click();
  await expect(page.getByTestId("site-tag").filter({ hasText: batchTag })).toHaveCount(0);
  await page.getByTestId("batch-clear").click();
  await expect(page.getByTestId("sites-batch-bar")).toHaveCount(0);

  // Delete the clone: the button waits for the number of sites to be typed.
  await page.goto("/sites");
  await page.getByRole("searchbox", { name: "搜索名称、域名或标签" }).fill(domain);
  await expect.poll(() => rowNames(page)).toEqual([domain]);
  await page.getByTestId("select-site").first().click();
  await page.getByTestId("batch-delete").click();
  await expect(page.getByTestId("confirm-action")).toBeDisabled();
  await page.getByTestId("batch-delete-confirm").fill("2");
  await expect(page.getByTestId("confirm-action")).toBeDisabled();
  await page.getByTestId("batch-delete-confirm").fill("1");
  await page.getByTestId("confirm-action").click();
  await expect(page.getByText("没有匹配的网站")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
