import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  holdLightLock,
  isLightLocked,
  isLocalStorage,
  readStoredTheme,
  releaseInitialLightLock,
  setInitialLightLock,
  storeTheme,
  subscribeLightLock,
} from "../../src/web/lib/theme";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

/** Runs public/theme-init.js against a minimal document, as the browser does before first paint. */
function themeInit({
  path,
  stored = null,
  osDark = false,
  storageBlocked = false,
}: {
  path: string;
  stored?: string | null;
  osDark?: boolean;
  storageBlocked?: boolean;
}) {
  const classes = new Set<string>();
  const html = {
    classList: { add: (name: string) => classes.add(name) },
    style: {} as { colorScheme?: string },
    dataset: {} as Record<string, string>,
  };
  const window = {
    location: { pathname: path },
    matchMedia: (query: string) => ({
      matches: osDark && query === "(prefers-color-scheme: dark)",
    }),
    get localStorage() {
      if (storageBlocked) throw new Error("SecurityError: access to storage is denied");
      return { getItem: (key: string) => (key === "theme" ? stored : null) };
    },
  };
  runInNewContext(read("public/theme-init.js"), { window, document: { documentElement: html } });
  return {
    classes: [...classes],
    colorScheme: html.style.colorScheme,
    lock: html.dataset.themeLock,
  };
}

/** Replaces globalThis.localStorage for one test (Node ships its own). */
function stubLocalStorage(descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  releaseInitialLightLock();
});

describe("theme-init.js (first paint)", () => {
  it("paints the landing route light and locks it, even with a stored or OS dark choice", () => {
    for (const options of [
      { stored: "dark" },
      { osDark: true },
      { stored: "system", osDark: true },
    ]) {
      expect(themeInit({ path: "/", ...options })).toEqual({
        classes: ["light"],
        colorScheme: "light",
        lock: "light",
      });
    }
  });

  it("applies the stored choice, then the OS preference, everywhere else", () => {
    expect(themeInit({ path: "/overview", stored: "dark" })).toEqual({
      classes: ["dark"],
      colorScheme: "dark",
      lock: undefined,
    });
    expect(themeInit({ path: "/login", osDark: true }).classes).toEqual(["dark"]);
    expect(themeInit({ path: "/sites", stored: "light", osDark: true }).classes).toEqual(["light"]);
  });

  it("works with storage disabled (falls back to the OS preference)", () => {
    expect(themeInit({ path: "/overview", storageBlocked: true, osDark: true }).classes).toEqual([
      "dark",
    ]);
    expect(themeInit({ path: "/", storageBlocked: true, osDark: true }).classes).toEqual(["light"]);
  });
});

describe("theme storage (ThemeProvider)", () => {
  it("never touches localStorage directly, only through lib/theme's guarded helpers", () => {
    expect(read("src/web/components/theme-provider.tsx")).not.toMatch(/\blocalStorage\b/);
  });

  it("reads nothing and saves nothing, without throwing, when storage is blocked", () => {
    stubLocalStorage({
      get() {
        throw new Error("SecurityError: access to storage is denied");
      },
    });
    expect(readStoredTheme("theme")).toBeNull();
    expect(() => storeTheme("theme", "dark")).not.toThrow();
    expect(isLocalStorage(null)).toBe(false);
  });

  it("survives getItem/setItem throwing (quota, private mode)", () => {
    const failing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    stubLocalStorage({ value: failing });
    expect(readStoredTheme("theme")).toBeNull();
    expect(() => storeTheme("theme", "light")).not.toThrow();
  });

  it("round-trips a valid choice and ignores anything else", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    stubLocalStorage({ value: storage });
    storeTheme("theme", "dark");
    expect(readStoredTheme("theme")).toBe("dark");
    values.set("theme", "sepia");
    expect(readStoredTheme("theme")).toBeNull();
    expect(isLocalStorage(storage as unknown as Storage)).toBe(true);
  });
});

describe("light lock (landing page)", () => {
  it("holds light while a holder is mounted and gives the theme back when it leaves", () => {
    let changes = 0;
    const unsubscribe = subscribeLightLock(() => changes++);
    expect(isLightLocked()).toBe(false);
    const release = holdLightLock();
    expect(isLightLocked()).toBe(true);
    release();
    release(); // idempotent
    expect(isLightLocked()).toBe(false);
    expect(changes).toBe(2);
    unsubscribe();
  });

  it("keeps the first-paint lock until the landing page takes it over or `/` redirects", () => {
    setInitialLightLock(true);
    expect(isLightLocked()).toBe(true);
    const release = holdLightLock();
    release();
    expect(isLightLocked()).toBe(false); // the landing page left: the user's theme is back

    setInitialLightLock(true);
    releaseInitialLightLock(); // `/` redirected to the console
    expect(isLightLocked()).toBe(false);
  });
});
