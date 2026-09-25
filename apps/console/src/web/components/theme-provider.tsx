import * as React from "react";
import {
  holdLightLock,
  isLightLocked,
  isLocalStorage,
  isTheme,
  type ResolvedTheme,
  readStoredTheme,
  setInitialLightLock,
  storeTheme,
  subscribeLightLock,
  type Theme,
} from "@/lib/theme";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  disableTransitionOnChange?: boolean;
};

type ThemeProviderState = {
  theme: Theme;
  /** What is on screen: light while a light-only page holds the lock, else the choice or the OS. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

// public/theme-init.js marks the first paint of the landing route as light-locked.
if (typeof document !== "undefined") {
  setInitialLightLock(document.documentElement.dataset.themeLock === "light");
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark";
  }

  return "light";
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}",
    ),
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const editableParent = target.closest("input, textarea, select, [contenteditable='true']");
  if (editableParent) {
    return true;
  }

  return false;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(
    () => readStoredTheme(storageKey) ?? defaultTheme,
  );

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      storeTheme(storageKey, nextTheme);
      setThemeState(nextTheme);
    },
    [storageKey],
  );

  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(getSystemTheme);
  const locked = React.useSyncExternalStore(subscribeLightLock, isLightLocked, () => false);
  const chosenTheme = theme === "system" ? systemTheme : theme;
  const resolvedTheme = locked ? "light" : chosenTheme;

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = () => {
      setSystemTheme(getSystemTheme());
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  // public/theme-init.js applies the same class before first paint; this keeps it in sync. A layout
  // effect, so entering or leaving a light-only page never paints a frame in the other scheme.
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    if (root.classList.contains(resolvedTheme) && root.style.colorScheme === resolvedTheme) {
      return;
    }

    const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null;

    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;

    if (restoreTransitions) {
      restoreTransitions();
    }
  }, [resolvedTheme, disableTransitionOnChange]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() !== "d") {
        return;
      }

      // A light-only page would not show the change; do not flip the saved choice unseen.
      if (locked) {
        return;
      }

      setTheme(chosenTheme === "dark" ? "light" : "dark");
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [chosenTheme, locked, setTheme]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (!isLocalStorage(event.storageArea)) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      if (isTheme(event.newValue)) {
        setThemeState(event.newValue);
        return;
      }

      setThemeState(defaultTheme);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultTheme, storageKey]);

  const value = React.useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
    }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
};

/**
 * Keeps the page light while the calling component is mounted (the landing page has a fixed light
 * palette); the user's theme returns when it unmounts.
 */
export function useLightTheme() {
  React.useLayoutEffect(() => holdLightLock(), []);
}
