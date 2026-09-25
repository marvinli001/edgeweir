import { globSync, readFileSync } from "node:fs";
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

  it("scans every appica component it imports, and nothing else", () => {
    const imported = new Set(
      webSources
        .filter((file) => file.includes("components/appica/"))
        .flatMap((file) =>
          [...read(file).matchAll(/@appica\/ui-react\/([a-z-]+)/g)].map((m) => m[1]),
        ),
    );
    const scanned = new Set(
      [...read("src/web/appica-bridge.css").matchAll(/dist\/components\/([a-z-]+)";/g)].map(
        (m) => m[1],
      ),
    );
    expect([...scanned].sort()).toEqual([...imported].sort());
  });
});
