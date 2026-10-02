import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migration tests replay the whole migration chain in PGlite, often twice;
    // on a shared CI runner with test files in parallel that takes seconds.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
