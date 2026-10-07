import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG AA contrast of the console's token pairs (ADR-0034 §7), computed from index.css itself:
 * the light (`:root`) and dark (`.dark`) declarations are parsed, `var()` references and
 * `color-mix(in oklch|oklab, …)` resolved, OKLCH converted to sRGB (per-channel clipping, as an
 * sRGB screen shows it), translucent layers composited over their backdrop in sRGB, then compared
 * with the WCAG 2 relative-luminance ratio. A token edit that breaks a pair fails here.
 */

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/index.css"), "utf8");

// ---------------------------------------------------------------------------------------------
// Parsing

/** The custom properties of a top-level rule (outside @media and @layer) with this selector. */
function declarations(selector: string): Record<string, string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      if (depth === 0 && source.slice(start, i).trim() === selector) {
        let inner = 1;
        let end = i + 1;
        for (; inner > 0; end++) {
          if (source[end] === "{") inner++;
          else if (source[end] === "}") inner--;
        }
        return parseBody(source.slice(i + 1, end - 1));
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (char === ";" && depth === 0) {
      start = i + 1;
    }
  }
  throw new Error(`no top-level rule ${selector} in index.css`);
}

function parseBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of splitTopLevel(body, ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    if (name.startsWith("--"))
      out[name] = part
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " ");
  }
  return out;
}

/** Splits on a separator outside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const light = declarations(":root");
/** `.dark` sits on the same element as `:root`, so it overrides it and `var()` sees both. */
const dark = { ...light, ...declarations(".dark") };
const themes = { light, dark } as const;
type Theme = keyof typeof themes;

// ---------------------------------------------------------------------------------------------
// Color math

/** OKLCH with alpha; hue `null` when powerless (achromatic), as CSS Color 4 treats it. */
interface Oklch {
  l: number;
  c: number;
  h: number | null;
  alpha: number;
}
/** Gamma-encoded sRGB channels in 0–1 plus alpha. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const toGamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const clip = (x: number) => Math.min(1, Math.max(0, x));

/** Björn Ottosson's OKLab matrices (the ones CSS Color 4 uses). */
function oklabToRgb(l: number, a: number, b: number, alpha: number): Rgba {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clip(toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: clip(toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: clip(toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
    alpha,
  };
}

function rgbToOklab({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const ACHROMATIC = 1e-4;

function toOklch(rgba: Rgba): Oklch {
  const [l, a, b] = rgbToOklab(rgba);
  const c = Math.hypot(a, b);
  const h = c < ACHROMATIC ? null : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h, alpha: rgba.alpha };
}

function oklchToRgb({ l, c, h, alpha }: Oklch): Rgba {
  const rad = ((h ?? 0) * Math.PI) / 180;
  return oklabToRgb(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
}

/** A parsed color keeps OKLCH when written in OKLCH (mixing happens there, before clipping). */
type Color = { kind: "oklch"; value: Oklch } | { kind: "rgb"; value: Rgba };

const asOklch = (color: Color): Oklch =>
  color.kind === "oklch" ? color.value : toOklch(color.value);
const asRgb = (color: Color): Rgba =>
  color.kind === "rgb" ? color.value : oklchToRgb(color.value);

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, alpha: 0 },
  black: { r: 0, g: 0, b: 0, alpha: 1 },
  white: { r: 1, g: 1, b: 1, alpha: 1 },
};

function parseNumber(text: string, percentScale = 1): number {
  return text.endsWith("%") ? (Number.parseFloat(text) / 100) * percentScale : Number(text);
}

/** Resolves a token value in a theme to a color. */
function parseColor(value: string, vars: Record<string, string>, seen: string[] = []): Color {
  const text = value.trim();
  if (text in NAMED) return { kind: "rgb", value: NAMED[text] as Rgba };
  const varRef = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(text);
  if (varRef) {
    const name = varRef[1] as string;
    if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(" → ")}`);
    const next = vars[name] ?? varRef[2];
    if (next === undefined) throw new Error(`undefined ${name}`);
    return parseColor(next, vars, [...seen, name]);
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const channel = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16) / 255;
    return {
      kind: "rgb",
      value: {
        r: channel(0),
        g: channel(2),
        b: channel(4),
        alpha: digits.length === 8 ? channel(6) : 1,
      },
    };
  }
  const oklch =
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+|none)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (oklch) {
    const c = parseNumber(oklch[2] as string, 0.4);
    return {
      kind: "oklch",
      value: {
        l: parseNumber(oklch[1] as string),
        c,
        h: oklch[3] === "none" || c < ACHROMATIC ? null : Number(oklch[3]),
        alpha: oklch[4] === undefined ? 1 : parseNumber(oklch[4]),
      },
    };
  }
  const mix = /^color-mix\(\s*in\s+(oklch|oklab)\s*,(.*)\)$/.exec(text);
  if (mix) {
    const [first, second] = splitTopLevel(mix[2] as string, ",").map((part) => {
      const percent = /\s+([\d.]+)%$/.exec(part);
      return {
        color: parseColor(percent ? part.slice(0, percent.index) : part, vars, seen),
        weight: percent ? Number(percent[1]) / 100 : undefined,
      };
    });
    if (!first || !second) throw new Error(`bad color-mix: ${text}`);
    return colorMix(mix[1] as "oklch" | "oklab", first, second);
  }
  throw new Error(`unsupported color: ${text}`);
}

/** CSS Color 5 color-mix(): normalized weights, premultiplied alpha, shorter hue, missing hues. */
function colorMix(
  space: "oklch" | "oklab",
  first: { color: Color; weight: number | undefined },
  second: { color: Color; weight: number | undefined },
): Color {
  let p1 = first.weight ?? (second.weight === undefined ? 0.5 : 1 - second.weight);
  let p2 = second.weight ?? 1 - p1;
  const sum = p1 + p2;
  const scale = sum < 1 ? sum : 1;
  p1 /= sum;
  p2 /= sum;
  const a = asOklch(first.color);
  const b = asOklch(second.color);
  const alpha = a.alpha * p1 + b.alpha * p2;
  if (alpha === 0) return { kind: "rgb", value: { ...NAMED.transparent } as Rgba };
  const premix = (x: number, y: number) => (x * a.alpha * p1 + y * b.alpha * p2) / alpha;
  if (space === "oklab") {
    const lab = (color: Oklch) => {
      const rad = ((color.h ?? 0) * Math.PI) / 180;
      return [color.l, color.c * Math.cos(rad), color.c * Math.sin(rad)] as const;
    };
    const [la, aa, ba] = lab(a);
    const [lb, ab, bb] = lab(b);
    const l = premix(la, lb);
    const aOut = premix(aa, ab);
    const bOut = premix(ba, bb);
    const c = Math.hypot(aOut, bOut);
    return {
      kind: "oklch",
      value: {
        l,
        c,
        h: c < ACHROMATIC ? null : ((Math.atan2(bOut, aOut) * 180) / Math.PI + 360) % 360,
        alpha: alpha * scale,
      },
    };
  }
  // A powerless hue (achromatic or fully transparent) takes the other color's hue.
  const ha = a.h ?? b.h;
  const hb = b.h ?? a.h;
  let h: number | null = null;
  if (ha !== null && hb !== null) {
    let delta = hb - ha;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    h = (ha + delta * p2 + 360) % 360;
  }
  return {
    kind: "oklch",
    value: { l: premix(a.l, b.l), c: premix(a.c, b.c), h, alpha: alpha * scale },
  };
}

/** Source-over compositing of a translucent color on an opaque backdrop (in sRGB, as browsers do). */
function over(top: Rgba, backdrop: Rgba): Rgba {
  const a = top.alpha;
  return {
    r: top.r * a + backdrop.r * (1 - a),
    g: top.g * a + backdrop.g * (1 - a),
    b: top.b * a + backdrop.b * (1 - a),
    alpha: 1,
  };
}

const luminance = ({ r, g, b }: Rgba) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

function ratio(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------------------------
// Pairs

/**
 * A layer expression: a token name (`card`), a token with a Tailwind alpha (`destructive/10`),
 * or layers stacked bottom-first with `>` (`foreground > glass-overlay`: the glass over text).
 */
function layer(theme: Theme, expression: string): Rgba {
  const [name, alpha] = expression.trim().split("/") as [string, string | undefined];
  const vars = themes[theme];
  const color = asRgb(parseColor(vars[`--${name}`] ?? name, vars));
  return alpha === undefined ? color : { ...color, alpha: color.alpha * (Number(alpha) / 100) };
}

/** The opaque color a stack of layers composites to; the page canvas is the bottom of every stack. */
function surface(theme: Theme, stack: string): Rgba {
  return stack
    .split(">")
    .reduce((backdrop, expression) => over(layer(theme, expression), backdrop), {
      ...layer(theme, "canvas"),
      alpha: 1,
    });
}

function measure(theme: Theme, fg: string, bg: string): number {
  const backdrop = surface(theme, bg);
  return ratio(over(layer(theme, fg), backdrop), backdrop);
}

interface Pair {
  fg: string;
  bg: string;
  /** Where the pair occurs, for the failure message. */
  use: string;
}

function failures(theme: Theme, pairs: Pair[], min: number): string[] {
  return pairs.flatMap(({ fg, bg, use }) => {
    const value = measure(theme, fg, bg);
    return value + 1e-9 < min
      ? [`${theme}: ${fg} on ${bg} = ${value.toFixed(2)}:1 < ${min}:1 (${use})`]
      : [];
  });
}

const SURFACES = ["background", "card", "well", "raised", "popover", "sidebar", "muted"];

function textPairs(): Pair[] {
  return [
    ...["foreground", "muted-foreground"].flatMap((fg) =>
      SURFACES.map((bg) => ({ fg, bg, use: "body and secondary text on the surface ladder" })),
    ),
    { fg: "card-foreground", bg: "card", use: "card text" },
    { fg: "popover-foreground", bg: "popover", use: "menus, dialogs, toasts" },
    { fg: "secondary-foreground", bg: "secondary", use: "secondary buttons and badges" },
    { fg: "accent-foreground", bg: "accent", use: "highlighted menu items" },
    { fg: "primary-foreground", bg: "primary", use: "primary buttons" },
    { fg: "primary-ink", bg: "card", use: "links and link buttons" },
    { fg: "primary-ink", bg: "background", use: "links on the page" },
    { fg: "primary-ink", bg: "popover", use: "links in dialogs" },
    { fg: "primary-ink", bg: "card > tint-primary", use: "primary badges" },
    { fg: "destructive", bg: "card", use: "field errors" },
    { fg: "destructive", bg: "popover", use: "destructive menu items" },
    { fg: "destructive", bg: "card > tint-destructive", use: "destructive buttons and badges" },
    { fg: "destructive", bg: "background > tint-destructive", use: "error alerts on the page" },
    { fg: "destructive", bg: "popover > wash", use: "highlighted destructive menu item" },
    { fg: "foreground", bg: "popover > wash", use: "highlighted menu item" },
    { fg: "muted-foreground", bg: "popover > wash", use: "shortcut in a highlighted item" },
    { fg: "muted-foreground", bg: "card > wash", use: "hovered table row" },
    { fg: "sidebar-foreground", bg: "sidebar", use: "sidebar items" },
    { fg: "sidebar-foreground/70", bg: "sidebar", use: "sidebar group labels" },
    { fg: "sidebar-accent-foreground", bg: "sidebar-accent", use: "active sidebar item" },
    {
      fg: "sidebar-primary-foreground",
      bg: "sidebar-primary",
      use: "sidebar primary (logo tile, badges)",
    },
  ];
}

/**
 * Non-text UI (WCAG 1.4.11): the focus ring's 1px border (the 30% halo is a glow on top of it)
 * and the boundary of checkboxes and switch tracks.
 */
function uiPairs(): Pair[] {
  return [
    ...["background", "card", "well", "popover"].map((bg) => ({
      fg: "ring",
      bg,
      use: "focus border",
    })),
    ...["background", "card", "popover"].map((bg) => ({
      fg: "control-edge",
      bg,
      use: "checkbox and switch boundary",
    })),
  ];
}

const DATA = [
  "signal",
  "metric",
  "status-2xx",
  "status-3xx",
  "status-4xx",
  "status-5xx",
  "series-1",
  "series-2",
  "series-3",
  "series-4",
  "series-5",
  "series-other",
  "state-good",
  "state-warn",
];

/**
 * Data colors index.css documents as below 3:1 on the card and always printed with a text label
 * or value (DESIGN.md, the Labelled Color Rule). Each entry quotes the comment that documents it;
 * the test checks that the comment is still there.
 */
const LABELLED: { theme: Theme; tokens: string[]; comment: string }[] = [
  {
    theme: "light",
    tokens: ["status-3xx", "status-4xx"],
    comment: "3xx/4xx sit below 3:1 in light mode, so their values are always labeled as text too.",
  },
  {
    theme: "light",
    tokens: ["series-3", "series-4", "series-5"],
    comment:
      "slots 3–5 sit below 3:1 in light mode, so the legend and the list always print the values.",
  },
  {
    theme: "light",
    tokens: ["state-warn"],
    comment: "Node and cluster states; always shown with a text label.",
  },
];

// ---------------------------------------------------------------------------------------------

describe("color math", () => {
  const hex = (color: Rgba) =>
    `#${[color.r, color.g, color.b]
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;

  it("converts OKLCH to sRGB like the CSS reference values", () => {
    // Tailwind v4 palette entries with their published sRGB fallbacks.
    const cases: [string, string][] = [
      ["oklch(1 0 0)", "#ffffff"],
      ["oklch(0 0 0)", "#000000"],
      ["oklch(0.488 0.243 264.376)", "#1447e6"],
      ["oklch(0.97 0.014 254.604)", "#eff6ff"],
      ["oklch(0.696 0.17 162.48)", "#00bc7d"],
    ];
    for (const [input, expected] of cases) {
      const got = asRgb(parseColor(input, {}));
      const want = asRgb(parseColor(expected, {}));
      for (const channel of ["r", "g", "b"] as const) {
        expect(Math.abs(got[channel] - want[channel]), `${input} → ${hex(got)}`).toBeLessThan(
          3 / 255,
        );
      }
    }
  });

  it("resolves var(), color-mix() and alpha, and composites in sRGB", () => {
    const vars = { "--a": "oklch(0.6 0.1 200)", "--b": "var(--a)" };
    expect(asRgb(parseColor("var(--b)", vars))).toEqual(
      asRgb(parseColor("oklch(0.6 0.1 200)", {})),
    );
    const half = asRgb(parseColor("color-mix(in oklch, var(--a) 40%, transparent)", vars));
    expect(half.alpha).toBeCloseTo(0.4);
    expect(half.r).toBeCloseTo(asRgb(parseColor("oklch(0.6 0.1 200)", {})).r);
    const plate = asOklch(parseColor("color-mix(in oklch, oklch(0.5 0.2 260), black 40%)", {}));
    expect(plate.l).toBeCloseTo(0.3);
    expect(plate.c).toBeCloseTo(0.12);
    expect(plate.h).toBeCloseTo(260);
    expect(asRgb(parseColor("oklch(0.5 0 0 / 25%)", {})).alpha).toBeCloseTo(0.25);
    const grey = over({ r: 1, g: 1, b: 1, alpha: 0.5 }, { r: 0, g: 0, b: 0, alpha: 1 });
    expect(grey.r).toBeCloseTo(0.5);
    expect(ratio(NAMED.white as Rgba, NAMED.black as Rgba)).toBeCloseTo(21);
  });

  it("parses every color token of both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const vars = themes[theme];
      for (const name of [
        "--canvas",
        "--foreground",
        "--primary",
        "--ring",
        "--glass",
        "--glass-overlay",
      ]) {
        expect(vars[name], `${theme} ${name}`).toBeDefined();
        expect(() => parseColor(vars[name] as string, vars)).not.toThrow();
      }
    }
  });
});

describe.each(["light", "dark"] as const)("WCAG AA contrast, %s theme", (theme) => {
  it("body text reaches 4.5:1 on every surface it sits on", () => {
    expect(failures(theme, textPairs(), 4.5)).toEqual([]);
  });

  it("the focus ring and control boundaries reach 3:1 against the surfaces around them", () => {
    expect(failures(theme, uiPairs(), 3)).toEqual([]);
  });

  it("data strokes reach 3:1 on the card, except the documented labelled ones", () => {
    const labelled = LABELLED.filter((entry) => entry.theme === theme);
    for (const entry of labelled) expect(css).toContain(entry.comment);
    const exempt = new Set(labelled.flatMap((entry) => entry.tokens));
    const pairs = DATA.filter((token) => !exempt.has(token)).map((fg) => ({
      fg,
      bg: "card",
      use: "chart strokes, status lights",
    }));
    expect(failures(theme, pairs, 3)).toEqual([]);
  });

  it("text on glass passes over the worst backdrop (foreground-colored content behind it)", () => {
    const pairs = ["glass", "glass-overlay"].flatMap((glass) =>
      ["foreground", "muted-foreground"].map((fg) => ({
        fg,
        bg: `foreground > ${glass}`,
        use: glass === "glass" ? "sticky header" : "⌘K and toasts",
      })),
    );
    expect(failures(theme, pairs, 4.5)).toEqual([]);
  });
});
