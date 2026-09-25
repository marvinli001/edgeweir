// Bundles the server (src/server/main.ts) and every dependency into a single
// ESM file so the production image needs no node_modules.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/server");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, "src/server/main.ts")],
  outfile: resolve(out, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "linked",
  legalComments: "linked",
  metafile: true,
  logLevel: "warning",
  // Optional native/peer modules that are never used at runtime.
  external: [
    "pg-native",
    "vite",
    "lightningcss",
    "@electric-sql/pglite",
    "mongodb",
    "@prisma/client",
    "kysely-codegen",
  ],
  banner: {
    js: [
      "import { createRequire as __edgeweirCreateRequire } from 'node:module';",
      "const require = __edgeweirCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

await cp(resolve(root, "src/server/install"), resolve(out, "install"), { recursive: true });
await cp(resolve(root, "../../packages/db/migrations"), resolve(root, "dist/migrations"), {
  recursive: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`server bundle: ${(bytes / 1024 / 1024).toFixed(1)} MiB -> dist/server/main.js`);
