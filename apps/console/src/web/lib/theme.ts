/**
 * Theme storage and the light lock, shared by ThemeProvider and the routes. Kept free of DOM
 * globals other than localStorage so the Vitest suite can load it.
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

/*
 * Light lock. The landing page has a fixed light palette, so while it is on screen the root stays
 * light whatever the user picked; their choice comes back as soon as it leaves. Components hold the
 * lock while mounted (useLightTheme). public/theme-init.js also locks the first paint of `/`, before
 * React knows whether `/` is the landing page or a redirect to the console; the first holder or
 * the redirect (releaseInitialLightLock) takes over from it.
 */
let holders = 0;
let initialLock = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function isLightLocked(): boolean {
  return initialLock || holders > 0;
}

export function subscribeLightLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called once at startup with what theme-init.js decided for the first paint. */
export function setInitialLightLock(locked: boolean): void {
  if (initialLock === locked) return;
  initialLock = locked;
  emit();
}

/** `/` turned out not to be the landing page (it redirects): drop the first-paint lock. */
export function releaseInitialLightLock(): void {
  setInitialLightLock(false);
}

/** Holds the light lock; call the returned function to let go (idempotent). */
export function holdLightLock(): () => void {
  holders++;
  initialLock = false;
  emit();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holders--;
    emit();
  };
}
