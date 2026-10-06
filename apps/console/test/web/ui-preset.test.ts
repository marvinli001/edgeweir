import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("shadcn preset", () => {
  it("components.json and theme resolve to preset b2DcSALVz", () => {
    const components = JSON.parse(readFileSync(resolve(root, "components.json"), "utf8"));
    expect(components.style).toBe("base-rhea");
    expect(components.iconLibrary).toBe("hugeicons");
    expect(components.menuColor).toBe("inverted-translucent");
    expect(components.menuAccent).toBe("subtle");

    const out = execFileSync(
      resolve(root, "node_modules/.bin/shadcn"),
      ["preset", "resolve", "--json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    const preset = JSON.parse(out.slice(out.indexOf("{"))) as {
      code: string;
      values: Record<string, string>;
    };
    expect(preset.code).toBe("b2DcSALVz");
    expect(preset.values).toMatchObject({
      style: "rhea",
      theme: "blue",
      iconLibrary: "hugeicons",
      font: "geist",
    });
  });

  it("keeps a single ThemeProvider in the app", () => {
    const main = readFileSync(resolve(root, "src/web/main.tsx"), "utf8");
    expect(main.match(/<ThemeProvider/g)).toHaveLength(1);
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.dependencies["next-themes"]).toBeUndefined();
  });
});
