/**
 * A short walkthrough video of the lab (the lab must be running):
 *
 *   node lab/record.ts <out-dir> [--theme dark] [--base http://localhost:5180/] [--ffmpeg path]
 *
 * Globe and rolling digits, spotlight hover, the primary button press, sidebar icons, page
 * changes, the command menu, the segmented tabs, the traffic path, a toast and the cluster beams.
 * Frames come from the DevTools screencast (JPEG, high quality) and are encoded at 25 fps with
 * Playwright's own ffmpeg build (VP8, high bitrate): walkthrough-<theme>.webm, 1440×900.
 */
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const out = process.argv[2];
if (!out || out.startsWith("--")) {
  console.error("usage: node lab/record.ts <out-dir> [--theme light|dark] [--base url]");
  process.exit(1);
}
const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const base = arg("--base") ?? "http://localhost:5180/";
const theme = arg("--theme") === "dark" ? "dark" : "light";
const ffmpeg =
  arg("--ffmpeg") ??
  globSync(
    path.join(
      os.homedir(),
      process.platform === "darwin" ? "Library/Caches" : ".cache",
      "ms-playwright/ffmpeg-*/ffmpeg-*",
    ),
  )[0];
if (!ffmpeg) throw new Error("Playwright's ffmpeg not found: npx playwright install ffmpeg");

/** Moves the pointer in steps so hover effects follow it. */
async function glide(page: Page, from: [number, number], to: [number, number], ms: number) {
  const steps = Math.max(2, Math.round(ms / 16));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
    await page.waitForTimeout(ms / steps);
  }
}

async function centerOf(page: Page, selector: string): Promise<[number, number]> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not found: ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: theme,
  locale: "zh-CN",
});
await context.addInitScript((scheme) => {
  localStorage.setItem("theme", scheme);
  localStorage.setItem("PARAGLIDE_LOCALE", "zh-CN");
  localStorage.setItem("edgeweir-lab:panel", "hidden");
}, theme);
const page = await context.newPage();

// Screencast: every painted frame with its time.
const frames: { at: number; data: Buffer }[] = [];
const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", (frame) => {
  frames.push({
    at: frame.metadata.timestamp ?? Date.now() / 1000,
    data: Buffer.from(frame.data, "base64"),
  });
  void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
});

// Overview: the globe turns, the digits roll in.
await page.goto(`${base}#/overview`);
await page.waitForSelector('[data-testid="edge-network"]');
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
await page.waitForTimeout(2400);

// Spotlight across the live tiles and the edge network card.
await glide(page, [560, 470], [1000, 440], 900);
await glide(page, [1000, 440], [1340, 470], 700);
await glide(page, [1340, 470], [1340, 620], 500);
await glide(page, [1340, 620], [1080, 620], 600);

// Sidebar icons play on hover.
for (const id of ["nav-overview", "nav-ip-lists", "nav-alerts", "nav-system"]) {
  const [x, y] = await centerOf(page, `[data-testid="${id}"]`);
  await glide(page, [x + 40, y - 10], [x, y], 160);
  await page.waitForTimeout(380);
}

// The primary button: hover lifts it, pressing pushes it flat.
const [px, py] = await centerOf(page, '[data-testid="nav-primary-action"]');
await glide(page, [px, py + 60], [px, py], 300);
await page.waitForTimeout(350);
await page.mouse.down();
await page.waitForTimeout(260);
await page.mouse.up();
await page.waitForTimeout(900);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// Sites: the trend column.
await page.click('[data-testid="nav-sites"]');
await page.waitForSelector('[data-testid="sites-table"]');
await page.waitForTimeout(1300);

// Command menu: search and open a site.
await page.keyboard.press("Meta+k");
await page.waitForTimeout(500);
await page.keyboard.type("shop", { delay: 90 });
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="live-requests"]');
await page.waitForTimeout(1400);

// Read the live chart.
const chart = await page.locator(".live-chart").boundingBox();
if (chart) {
  await glide(
    page,
    [chart.x + 40, chart.y + chart.height / 2],
    [chart.x + chart.width - 80, chart.y + chart.height / 2],
    1400,
  );
}

// Segmented tabs: the thumb slides to the origins tab and its traffic path.
await page.click('[data-testid="tab-origins"]');
await page.waitForSelector('[data-testid="origin-topology"] .react-flow__node');
await page.waitForTimeout(2000);

// A toast: purge the site's cache.
await page.click('[data-testid="tab-overview"]');
await page.waitForTimeout(700);
await page
  .getByRole("button", { name: /清除缓存/ })
  .first()
  .click();
await page.waitForTimeout(600);
await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
await page.waitForTimeout(1800);

// Clusters: beams to the nodes.
await page.click('[data-testid="nav-clusters"]');
await page.waitForSelector('[data-testid="cluster-links"]');
await page.waitForTimeout(2600);

await cdp.send("Page.stopScreencast");
await context.close();
await browser.close();

// Constant 25 fps: each output frame shows the newest screencast frame at its time.
const file = path.join(out, `walkthrough-${theme}.webm`);
const encoder = spawn(
  ffmpeg,
  [
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-framerate",
    "25",
    "-i",
    "pipe:0",
    "-y",
    "-an",
    "-c:v",
    "vp8",
    "-b:v",
    "8M",
    "-qmin",
    "0",
    "-qmax",
    "20",
    "-crf",
    "4",
    "-deadline",
    "good",
    "-threads",
    "4",
    file,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const start = frames[0]?.at ?? 0;
const end = frames.at(-1)?.at ?? 0;
let index = 0;
for (let t = start; t <= end; t += 1 / 25) {
  while (index + 1 < frames.length && (frames[index + 1]?.at ?? 0) <= t) index++;
  const frame = frames[index];
  if (frame && !encoder.stdin.write(frame.data)) {
    await new Promise((resolve) => encoder.stdin.once("drain", resolve));
  }
}
encoder.stdin.end();
await new Promise((resolve) => encoder.on("close", resolve));
console.log(`${file} (${(end - start).toFixed(1)} s)`);
