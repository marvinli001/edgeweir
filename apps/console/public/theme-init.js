// Applies the saved theme (or the OS preference) before first paint, so pages never flash the
// wrong color scheme. An external file because the CSP forbids inline scripts. ThemeProvider
// takes over once React mounts; keep the storage key and class names in sync with it
// (src/web/lib/theme.ts).
(() => {
  const root = document.documentElement;
  let theme = null;
  try {
    theme = window.localStorage.getItem("theme");
  } catch {}
  let dark = false;
  try {
    dark =
      theme === "dark" ||
      (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {}
  root.classList.add(dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
})();
