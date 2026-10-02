import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web sources import through "@" (vite.config.ts).
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src/web") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
