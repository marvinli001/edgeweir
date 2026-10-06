/**
 * Screenshots of the lab pages (the lab must be running):
 *
 *   node lab/shots.ts <out-dir> [--pages overview,sites] [--base http://localhost:5180/]
 *
 * Every page in light and dark at 1440 and 375 px wide (zh-CN), plus the overview in English
 * and with reduced motion. Files: <page>-<theme>-<width>[-en|-reduced].png, full page.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium } from "@playwright/test";

const SHOP = "00000000-0000-4000-8005-000000000002";

export const PAGES: Record<string, string> = {
  login: "#/login",
  setup: "#/setup",
  overview: "#/overview",
  sites: "#/sites",
  site: `#/sites/${SHOP}`,
  origins: `#/sites/${SHOP}?tab=origins`,
  clusters: "#/clusters",
};

interface Shot {
  page: string;
  theme: "light" | "dark";
  width: 1440 | 375;
  locale: "zh-CN" | "en";
  reduced: boolean;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const out = process.argv[2];
if (!out || out.startsWith("--")) {
  console.error("usage: node lab/shots.ts <out-dir> [--pages a,b] [--base url]");
  process.exit(1);
}
const base = argValue("--base") ?? "http://localhost:5180/";
const only = argValue("--pages")?.split(",");
const font = argValue("--font") ?? "geist";

const shots: Shot[] = [];
for (const page of Object.keys(PAGES)) {
  if (only && !only.includes(page)) continue;
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 375] as const) {
      shots.push({ page, theme, width, locale: "zh-CN", reduced: false });
    }
  }
  if (page === "overview") {
    shots.push({ page, theme: "light", width: 1440, locale: "en", reduced: false });
    shots.push({ page, theme: "light", width: 1440, locale: "zh-CN", reduced: true });
  }
}

async function take(browser: Browser, shot: Shot) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.width === 375 ? 812 : 900 },
    deviceScaleFactor: 2,
    locale: shot.locale,
    colorScheme: shot.theme,
    reducedMotion: shot.reduced ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ({ theme, locale, font }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem("PARAGLIDE_LOCALE", locale);
      localStorage.setItem("edgeweir-lab:panel", "hidden");
      localStorage.setItem("edgeweir-lab:font", font);
    },
    { theme: shot.theme, locale: shot.locale, font },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}${PAGES[shot.page]}`);
  await page.waitForLoadState("networkidle");
  // First loads show a loader; wait until no status loader is left, then for entrances.
  await page
    .waitForFunction(() => !document.querySelector('[role="status"][aria-live="polite"]'), null, {
      timeout: 15_000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(2_200);
  const name = `${shot.page}-${shot.theme}-${shot.width}${shot.locale === "en" ? "-en" : ""}${
    shot.reduced ? "-reduced" : ""
  }.png`;
  await page.screenshot({ path: path.join(out as string, name), fullPage: true });
  await context.close();
  if (errors.length) console.warn(`${name}: ${errors.join(" | ")}`);
  console.log(name);
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const shot of shots) await take(browser, shot);
} finally {
  await browser.close();
}
