import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLES } from "../../src/server/lib/env";

const repo = resolve(import.meta.dirname, "../../../..");

describe(".env.example", () => {
  const text = readFileSync(resolve(repo, ".env.example"), "utf8");
  const documented = new Set(
    [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? ""),
  );

  it("documents every variable the console reads", () => {
    for (const name of ENV_VARIABLES) expect(documented, name).toContain(name);
  });

  it("documents the variables compose files interpolate", () => {
    for (const file of ["compose.yml", "compose.baota.yml", "compose.baota-host.yml"]) {
      const compose = readFileSync(resolve(repo, file), "utf8");
      // ${VAR}, ${VAR:-default} and ${VAR:?error}
      for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g)) {
        expect(documented, `${file}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
