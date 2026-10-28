/**
 * Layout audit of the lab pages at phone width (the lab must be running):
 *
 *   node lab/audit.ts [--pages a,b] [--width 375] [--base http://localhost:5180/] [--targets]
 *
 * For every page: whether the document scrolls sideways (and the widest elements that stick out
 * of the viewport), and with --targets the visible controls smaller than 44 × 44 px on a touch
 * screen (row links, whose target is the row, and checkboxes and switches, whose hit area is
 * larger than what they draw, aside). Exits 1 when a page scrolls sideways.
 */
import { chromium } from "@playwright/test";
import { PAGES } from "./pages.ts";
import { STATE_KEY } from "./state.ts";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const base = argValue("--base") ?? "http://localhost:5180/";
const width = Number(argValue("--width") ?? 375);
const only = argValue("--pages")?.split(",");
const targets = process.argv.includes("--targets");

const browser = await chromium.launch();
let wide = 0;
try {
  for (const entry of PAGES) {
    if (only && !only.includes(entry.name)) continue;
    const context = await browser.newContext({
      viewport: { width, height: 812 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript((stateKey) => {
      localStorage.setItem("edgeweir-lab:panel", "hidden");
      localStorage.setItem(stateKey, "full");
    }, STATE_KEY);
    const page = await context.newPage();
    await page.goto(`${base}#${entry.path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_500);
    const report = await page.evaluate(
      ({ targets }) => {
        const viewport = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const describe = (element: Element) => {
          const testId = element.getAttribute("data-testid");
          const slot = element.getAttribute("data-slot");
          const text = (element.textContent ?? "").trim().slice(0, 30);
          return `${element.tagName.toLowerCase()}${testId ? `[${testId}]` : ""}${slot ? `{${slot}}` : ""} "${text}"`;
        };
        // Elements whose right edge passes the viewport and that are not inside a scroller.
        const out: string[] = [];
        if (scrollWidth > viewport) {
          for (const element of document.querySelectorAll("body *")) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.right <= viewport + 1) continue;
            let parent = element.parentElement;
            let clipped = false;
            while (parent && parent !== document.body) {
              const style = getComputedStyle(parent);
              if (style.overflowX !== "visible" && style.overflowX !== "clip") {
                clipped = parent.getBoundingClientRect().right <= viewport + 1;
                if (clipped) break;
              }
              parent = parent.parentElement;
            }
            if (!clipped) out.push(`${describe(element)} → ${Math.round(rect.right)}`);
          }
        }
        const small: string[] = [];
        if (targets) {
          for (const element of document.querySelectorAll(
            'button, a[href], [role="checkbox"], [role="switch"], [role="tab"], input, select',
          )) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) continue;
            // A row link's target is its whole row; checkboxes and switches draw a 44px hit area
            // around themselves; an input group's field is as tall as the group.
            if (
              element.closest("[data-row-link]") ||
              element.getAttribute("data-slot") === "checkbox" ||
              element.getAttribute("data-slot") === "switch" ||
              element.getAttribute("data-slot") === "input-group-control"
            )
              continue;
            if (rect.height < 44 || rect.width < 44) {
              small.push(
                `${describe(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
              );
            }
          }
        }
        return { viewport, scrollWidth, out: out.slice(0, 8), small };
      },
      { targets },
    );
    const sideways = report.scrollWidth > report.viewport;
    if (sideways) wide++;
    console.log(
      `${entry.name}: ${sideways ? `SCROLLS ${report.scrollWidth}/${report.viewport}` : "ok"}`,
    );
    for (const line of report.out) console.log(`  ${line}`);
    if (targets && report.small.length) {
      console.log(`  ${report.small.length} small targets`);
      for (const line of report.small.slice(0, 15)) console.log(`    ${line}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (wide) process.exitCode = 1;
