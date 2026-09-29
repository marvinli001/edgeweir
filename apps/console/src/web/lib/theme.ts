/**
 * Theme storage for ThemeProvider. Kept free of DOM globals other than localStorage so the Vitest
 * suite can load it.
 */
export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const THEMES: readonly string[] = ["dark", "light", "system"];

export function isTheme(value: string | null | undefined): value is Theme {
  return typeof value === "string" && THEMES.includes(value);
}

/**
 * localStorage, or null where the browser refuses it: with site data blocked, reading
 * `window.localStorage` itself throws a SecurityError.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved choice, or null when there is none or storage is unavailable. */
export function readStoredTheme(key: string): Theme | null {
  try {
    const value = storage()?.getItem(key);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves the choice; without storage it simply lasts until the page is closed. */
export function storeTheme(key: string, theme: Theme): void {
  try {
    storage()?.setItem(key, theme);
  } catch {
    // Storage disabled or full: keep the choice in memory only.
  }
}

/** Whether a `storage` event came from localStorage (not sessionStorage). */
export function isLocalStorage(area: Storage | null): boolean {
  const local = storage();
  return local !== null && area === local;
}
