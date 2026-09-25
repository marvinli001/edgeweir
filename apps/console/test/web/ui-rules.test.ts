import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const webSources = globSync("src/web/{routes,components,lib}/**/*.{ts,tsx}", { cwd: root });

describe("UI rules (ADR-0003)", () => {
  it("never uses skeleton placeholders outside the shadcn primitives", () => {
    for (const file of webSources) {
      if (file.includes("components/ui/")) continue;
      expect(/\bSkeleton\b|skeleton-shimmer/.test(read(file)), file).toBe(false);
    }
  });

  it("imports appica-ui only through src/web/components/appica", () => {
    const outside = webSources.filter(
      (file) => !file.includes("components/appica/") && read(file).includes("@appica/ui-react"),
    );
    expect(outside).toEqual([]);
  });

  it("never loads appica's global tokens, only the scoped bridge", () => {
    const css = globSync("src/web/**/*.css", { cwd: root }).map(read).join("\n");
    expect(css).not.toMatch(/@import[^;]*@appica\/ui-react/);
    expect(read("src/web/index.css")).toContain('@import "./appica-bridge.css"');
    const main = read("src/web/main.tsx");
    expect(main).not.toContain("@appica/ui-react/providers");
  });

  it("scans every appica component it imports (and their internal deps), and nothing else", () => {
    const dist = resolve(root, "node_modules/@appica/ui-react/dist/components");
    const imported = new Set(
      webSources
        .filter((file) => file.includes("components/appica/"))
        .flatMap((file) =>
          [...read(file).matchAll(/@appica\/ui-react\/([a-z-]+)/g)].map((m) => m[1] as string),
        ),
    );
    // Components that style themselves with another component's variants need that file scanned too.
    const needed = new Set(imported);
    for (const name of imported) {
      for (const file of globSync("*.js", { cwd: resolve(dist, name) })) {
        const source = readFileSync(resolve(dist, name, file), "utf8");
        for (const m of source.matchAll(/from '\.\.\/([a-z-]+)\/[^']+'/g))
          needed.add(m[1] as string);
      }
    }
    const sources = [...read("src/web/appica-bridge.css").matchAll(/@source "([^"]+)";/g)].map(
      (m) => m[1] as string,
    );
    for (const source of sources) {
      expect(existsSync(resolve(root, "src/web", source)), source).toBe(true);
    }
    const scanned = new Set(
      sources.map((source) => source.match(/dist\/components\/([a-z-]+)/)?.[1] ?? source),
    );
    expect([...scanned].sort()).toEqual([...needed].sort());
  });
});
