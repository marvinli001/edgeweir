// Bundles the server (src/server/main.ts) and the account recovery command
// (src/server/recover.ts), each with every dependency, into one ESM file
// apiece so the production image needs no node_modules.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/server");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
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
};

// The image runs main.js with --enable-source-maps; recover.js prints
// messages, not stack traces, and ships without a map.
const results = await Promise.all([
  build({
    ...options,
    entryPoints: [resolve(root, "src/server/main.ts")],
    outfile: resolve(out, "main.js"),
    sourcemap: "linked",
  }),
  build({
    ...options,
    entryPoints: [resolve(root, "src/server/recover.ts")],
    outfile: resolve(out, "recover.js"),
  }),
]);

await cp(resolve(root, "src/server/install"), resolve(out, "install"), { recursive: true });
await cp(resolve(root, "../../packages/db/migrations"), resolve(root, "dist/migrations"), {
  recursive: true,
});

for (const [file, { bytes }] of results.flatMap((r) => Object.entries(r.metafile.outputs))) {
  if (!file.endsWith(".js")) continue;
  const mib = (bytes / 1024 / 1024).toFixed(1);
  console.log(`server bundle: ${mib} MiB -> ${relative(root, resolve(file))}`);
}
