/**
 * CSS tokens for canvas and WebGL effects, which cannot take `var(--token)`: the token's value
 * is painted into a 1×1 canvas and read back as sRGB, so any color syntax the browser knows
 * (oklch, color-mix) works, and the effects follow the theme without color literals in code.
 */
import * as React from "react";

let probe: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (probe) return probe;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  probe = canvas.getContext("2d", { willReadFrequently: true });
  return probe;
}

/** A CSS color as sRGB channels 0–255 and alpha 0–1 (transparent black when unreadable). */
export function cssColorToRgba(color: string): [number, number, number, number] {
  const ctx = context();
  if (!ctx || !color) return [0, 0, 0, 0];
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "transparent";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  // A translucent fill comes back premultiplied against transparent black.
  return a === 0 ? [0, 0, 0, 0] : [r, g, b, a / 255];
}

/** The computed value of a custom property on <html> (where the theme class lives). */
export function readToken(name: `--${string}`): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A token as 0–1 RGB, the form WebGL libraries take. */
export function tokenVec3(name: `--${string}`): [number, number, number] {
  const [r, g, b] = cssColorToRgba(readToken(name));
  return [r / 255, g / 255, b / 255];
}

/**
 * A token as an `rgba(r, g, b, a)` string (legacy comma syntax), for libraries that parse only
 * that form.
 */
export function tokenRgb(name: `--${string}`, alpha?: number): string {
  const [r, g, b, a] = cssColorToRgba(readToken(name));
  return `rgba(${r}, ${g}, ${b}, ${Math.round((alpha ?? a) * 1000) / 1000})`;
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-font", "style"],
  });
  return () => observer.disconnect();
}

/** The theme on screen ("light" or "dark"); changes re-read every token. */
export function useThemeKey(): string {
  return React.useSyncExternalStore(
    subscribeTheme,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
}

/** Reads tokens through `read` again whenever the theme changes. */
export function useTokens<T>(read: () => T): T {
  const theme = useThemeKey();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme is what invalidates the tokens.
  return React.useMemo(read, [theme]);
}
