/**
 * Screenshots of the lab pages (the lab must be running):
 *
 *   node lab/shots.ts <out-dir> [--pages overview,site-logs] [--themes light,dark]
 *     [--widths 1440,375] [--locale zh-CN|en] [--state full|empty|error|loading] [--reduced]
 *     [--base http://localhost:5180/] [--concurrency 4]
 *
 * Every page of lab/pages.ts by default, in light and dark at 1440 and 375 px wide, zh-CN, on
 * fixture data. Files: <page>-<theme>-<width>[-en][-<state>][-reduced].png, full page; the lab
 * panel is hidden. Waits for fonts and until no LoadingState or TopProgress is left (except in
 * the loading state), then for entrances. Page errors and fixture answers outside their schema
 * are printed after the file name.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { PAGES } from "./pages.ts";
import { LAB_STATES, type LabState, STATE_KEY } from "./state.ts";

type Theme = "light" | "dark";
type Locale = "zh-CN" | "en";

interface Shot {
  page: string;
  theme: Theme;
  width: number;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  console.error(
    "usage: node lab/shots.ts <out-dir> [--pages a,b] [--themes light,dark] [--widths 1440,375]" +
      " [--locale zh-CN|en] [--state full|empty|error|loading] [--reduced] [--base url]" +
      " [--concurrency n]",
  );
  process.exit(1);
}

const list = (name: string) =>
  argValue(name)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const out = process.argv[2];
if (!out || out.startsWith("--")) fail("missing <out-dir>");
const base = argValue("--base") ?? "http://localhost:5180/";
const only = list("--pages");
const themes = (list("--themes") ?? ["light", "dark"]) as Theme[];
const widths = (list("--widths") ?? ["1440", "375"]).map(Number);
const locale = (argValue("--locale") ?? "zh-CN") as Locale;
const state = (argValue("--state") ?? "full") as LabState;
const reduced = process.argv.includes("--reduced");
const concurrency = Math.max(1, Number(argValue("--concurrency") ?? 4));

const unknownPages = only?.filter((name) => !PAGES.some((page) => page.name === name)) ?? [];
if (unknownPages.length) fail(`unknown pages: ${unknownPages.join(", ")}`);
if (themes.some((theme) => theme !== "light" && theme !== "dark")) fail("themes: light, dark");
if (widths.some((width) => !Number.isInteger(width) || width < 280)) fail("widths: pixels");
if (locale !== "zh-CN" && locale !== "en") fail("locale: zh-CN or en");
if (!LAB_STATES.includes(state)) fail(`state: ${LAB_STATES.join(", ")}`);

const shots: Shot[] = [];
for (const page of PAGES) {
  if (only && !only.includes(page.name)) continue;
  for (const theme of themes) {
    for (const width of widths) shots.push({ page: page.name, theme, width });
  }
}

const fileName = (shot: Shot) =>
  `${shot.page}-${shot.theme}-${shot.width}${locale === "en" ? "-en" : ""}${
    state === "full" ? "" : `-${state}`
  }${reduced ? "-reduced" : ""}.png`;

async function take(browser: Browser, shot: Shot) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.width < 768 ? 812 : 900 },
    deviceScaleFactor: 2,
    locale,
    colorScheme: shot.theme,
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ({ theme, locale, state, stateKey }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem("PARAGLIDE_LOCALE", locale);
      localStorage.setItem("edgeweir-lab:panel", "hidden");
      localStorage.setItem(stateKey, state);
    },
    { theme: shot.theme, locale, state, stateKey: STATE_KEY },
  );
  const notes: string[] = [];
  const name = fileName(shot);
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => notes.push(`error: ${error.message}`));
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[lab]")) notes.push(text);
    });
    const route = PAGES.find((candidate) => candidate.name === shot.page)?.path ?? "/";
    await page.goto(`${base}#${route}`, { timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (state === "loading") {
      // The loader fades in after a short delay.
      await page.waitForTimeout(1_500);
    } else {
      // First loads show a loader and the top bar; wait until both are gone for a moment.
      await page
        .waitForFunction(
          () => {
            const w = window as unknown as { __labQuietSince?: number };
            const busy =
              document.querySelector('[role="status"][aria-live="polite"]') ||
              document.querySelector('[data-testid="top-progress"][data-active]');
            if (busy) {
              w.__labQuietSince = undefined;
              return false;
            }
            w.__labQuietSince ??= performance.now();
            return performance.now() - w.__labQuietSince > 400;
          },
          null,
          { timeout: 15_000, polling: 100 },
        )
        .catch(() => notes.push("still loading after 15 s"));
      // Entrances (animate-enter with staggered delays) and number roll-ins.
      await page.waitForTimeout(1_800);
    }
    // A dev server reload in between leaves an empty root: that shot is retried.
    if (await page.evaluate(() => !document.getElementById("root")?.childElementCount)) {
      throw new Error("the page is blank");
    }
    await page.screenshot({
      path: path.join(out as string, name),
      fullPage: true,
      timeout: 60_000,
    });
  } finally {
    await context.close();
  }
  console.log(notes.length ? `${name}\n  ${[...new Set(notes)].join("\n  ")}` : name);
}

/** One more try for a shot that failed (the dev server reloading, a slow first compile). */
async function attempt(browser: Browser, shot: Shot): Promise<boolean> {
  for (let tries = 1; ; tries++) {
    try {
      await take(browser, shot);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      if (tries >= 2) {
        console.error(`${fileName(shot)} failed: ${reason}`);
        return false;
      }
    }
  }
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const failed: string[] = [];
try {
  const queue = [...shots];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let shot = queue.shift(); shot; shot = queue.shift()) {
        if (!(await attempt(browser, shot))) failed.push(fileName(shot));
      }
    }),
  );
} finally {
  await browser.close();
}
if (failed.length) {
  console.error(`${failed.length} of ${shots.length} shots failed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
