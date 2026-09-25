// Applies the saved theme (or the OS preference) before first paint, so pages never flash the
// wrong color scheme. An external file because the CSP forbids inline scripts. ThemeProvider
// takes over once React mounts; keep the storage key, class names and lock attribute in sync with
// it (src/web/lib/theme.ts).
//
// `/` is the landing page, which is light-only: paint it light and mark the lock, so a dark choice
// never flashes there. When `/` turns out to redirect to the console, the router drops the lock.
(() => {
  const root = document.documentElement;
  const landing = window.location.pathname === "/";
  let theme = null;
  try {
    theme = window.localStorage.getItem("theme");
  } catch {}
  let dark = false;
  if (!landing) {
    try {
      dark =
        theme === "dark" ||
        (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {}
  }
  if (landing) root.dataset.themeLock = "light";
  root.classList.add(dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
})();
