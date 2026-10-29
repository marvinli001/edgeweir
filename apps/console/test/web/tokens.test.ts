import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("design tokens (ADR-0064)", () => {
  it("installs Arc from its free registry with Hugeicons into components/arc", () => {
    const components = JSON.parse(read("components.json"));
    expect(components.iconLibrary).toBe("hugeicons");
    expect(components.registries).toEqual({ "@uiarc": "https://uiarc.dev/r/{name}.json" });
    expect(components.aliases.ui).toBe("@/components/arc");
  });

  it("sets the console in Inter with the platform CJK faces before the bundled fallback", () => {
    const tokens = read("src/web/tokens.css");
    const sans = /--ew-font-sans:\s*([^;]+);/.exec(tokens)?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(sans).toMatch(/^"Inter Variable", "PingFang SC", .*"Noto Sans SC Variable"/);
    const index = read("src/web/index.css");
    expect(index).toContain('@import "@fontsource-variable/inter";');
    expect(index).toContain('@import "@fontsource-variable/noto-sans-sc";');
    expect(index).toMatch(/--font-sans:\s*var\(--ew-font-sans\);/);
  });

  it("defines every brand, status and neutral token for both themes", () => {
    const tokens = read("src/web/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (selector: string) => {
      const start = tokens.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return tokens.slice(start, tokens.indexOf("\n}", start));
    };
    const names = (body: string) =>
      new Set([...body.matchAll(/(--ew-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
    const light = names(block(":root"));
    const dark = names(block(".dark"));
    for (const name of [
      "--ew-brand",
      "--ew-brand-hover",
      "--ew-brand-active",
      "--ew-brand-tint",
      "--ew-success",
      "--ew-warning",
      "--ew-error",
      "--ew-canvas",
      "--ew-panel",
      "--ew-hairline",
      "--ew-text",
      "--ew-text-secondary",
    ]) {
      expect(light.has(name), `:root ${name}`).toBe(true);
      expect(dark.has(name), `.dark ${name}`).toBe(true);
    }
    // Dark mode changes colors only: sizes, radii, type and motion come from :root.
    const colorOnly = [...dark].filter((name) =>
      /^--ew-(?:radius|text-(?:caption|dense|body|section|title|display|hero)|font|space|ease|duration|topbar|sidebar-width|gutter|content)/.test(
        name,
      ),
    );
    expect(colorOnly).toEqual([]);
  });

  it("keeps the status pages on Geist and their own neutral tokens", () => {
    const css = read("src/web/index.css");
    const status = css.slice(css.indexOf(".status-surface {"));
    expect(status).toMatch(/^\.status-surface \{[^}]*font-family:\s*"Geist Variable", sans-serif;/);
    expect(status).toMatch(/^\.status-surface \{[^}]*--background:\s*oklch\(1 0 0\);/);
    expect(status).toMatch(/\.dark \.status-surface \{[^}]*--background:\s*oklch\(0\.145 0 0\);/);
  });

  it("keeps a single ThemeProvider in the app", () => {
    const main = read("src/web/main.tsx");
    expect(main.match(/<ThemeProvider/g)).toHaveLength(1);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["next-themes"]).toBeUndefined();
  });
});
