/**
 * Design lab: the real console (route tree, components, styles) on fixture data, without the
 * server. Development only; `vite build` of the console never sees this directory.
 *
 *   pnpm --filter @edgeweir/console lab        → http://localhost:5180/
 *   pnpm --filter @edgeweir/console lab:build  → dist/lab (relative base, opens from any path)
 */
import path from "node:path";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const app = path.resolve(import.meta.dirname, "..");

/** Serves the lab page at `/` (the routes live in the hash). */
function labIndex(): Plugin {
  return {
    name: "edgeweir-lab-index",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url?.startsWith("/?")) req.url = "/lab/lab.html";
        next();
      });
    },
  };
}

export default defineConfig({
  // The console's own root, so Tailwind scans src/web and public/ serves theme-init.js.
  root: app,
  base: "./",
  plugins: [
    labIndex(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: path.join(app, "src/web/routes"),
      generatedRouteTree: path.join(app, "src/web/routeTree.gen.ts"),
    }),
    react(),
    tailwindcss(),
    paraglideVitePlugin({
      project: path.join(app, "project.inlang"),
      outdir: path.join(app, "src/web/paraglide"),
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
  ],
  resolve: {
    alias: [
      // Fixture API and a signed-in session instead of the server.
      { find: /^@\/lib\/orpc$/, replacement: path.join(app, "lab/orpc.ts") },
      { find: /^@\/lib\/auth-client$/, replacement: path.join(app, "lab/auth-client.ts") },
      { find: /^@\//, replacement: `${path.join(app, "src/web")}/` },
    ],
  },
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: {
    outDir: path.join(app, "dist/lab"),
    emptyOutDir: true,
    rollupOptions: { input: path.join(app, "lab/lab.html") },
  },
});
