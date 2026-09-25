// Applies the saved theme (or the OS preference) before first paint, so pages never flash the
// wrong color scheme. An external file because the CSP forbids inline scripts. ThemeProvider
// takes over once React mounts; keep the storage key and class names in sync with it.
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem("theme");
  } catch {}
  const dark =
    theme === "dark" ||
    (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.add(dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
})();
