import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const webSources = globSync("src/web/{routes,components,lib}/**/*.{ts,tsx}", { cwd: root });
/** Everything the browser gets from src/web, minus generated code. */
const allWeb = globSync("src/web/**/*.{ts,tsx,css}", {
  cwd: root,
  exclude: ["src/web/paraglide/**", "src/web/routeTree.gen.ts"],
});

describe("UI rules (ADR-0003)", () => {
  it("never uses skeleton placeholders or pulsing blocks (loading is TopProgress and LoadingState)", () => {
    expect(allWeb.length).toBeGreaterThan(20);
    for (const file of allWeb) {
      const source = read(file);
      expect(/\bSkeleton\b|skeleton-shimmer/.test(source), file).toBe(false);
      expect(/\banimate-pulse\b/.test(source), file).toBe(false);
    }
  });

  it("uses no description slots: one-line safety notes use SafetyNote, alerts keep their message", () => {
    // CardDescription, DialogDescription, SheetDescription, AlertDialogDescription,
    // FieldDescription, EmptyDescription… are the explanatory paragraphs decision 7 rules out.
    // An alert's AlertDescription is the alert message itself (ErrorState), so it stays.
    const found = webSources.flatMap((file) =>
      [...read(file).matchAll(/<([A-Z][A-Za-z]*Description)\b/g)]
        .map((m) => m[1] as string)
        .filter((name) => name !== "AlertDescription")
        .map((name) => `${file}: <${name}>`),
    );
    expect(found).toEqual([]);
  });

  it("spells out no colors in TS/TSX: they come from CSS tokens", () => {
    // Hex (#rgb, #rrggbb, #rrggbbaa) and functional notation with literal channels. Named keywords
    // (white, transparent, currentColor) and Tailwind palette classes are tokens already.
    const color =
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/;
    const found = allWeb
      .filter((file) => !file.endsWith(".css"))
      .flatMap((file) =>
        read(file)
          .split("\n")
          .flatMap((line, i) => (color.test(line) ? [`${file}:${i + 1} ${line.trim()}`] : [])),
      );
    expect(found).toEqual([]);
  });

  it("links nothing on other sites except a short allow list (no phone-home, self-hosted assets)", () => {
    const allowed = [
      // ICP filing lookup: sites served from mainland China must link their filing number here.
      "https://beian.miit.gov.cn/",
      // This project's own source ("Powered by Edgeweir", the AGPL source offer).
      "https://github.com/marvinli001/edgeweir",
      // This project's operating guide and the bundled GeoIP data's required attribution.
      "https://github.com/marvinli001/edgeweir/blob/master/docs/guide/rules.md",
      "https://ipinfo.io",
      // XML namespace name, never fetched.
      "http://www.w3.org/2000/svg",
    ];
    // Reserved documentation names (RFC 2606, RFC 6761) in placeholders and examples.
    const reserved = /^(?:[a-z0-9-]+\.)*(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)$/;
    const files = [
      ...allWeb,
      "index.html",
      ...globSync("public/**/*", { cwd: root }).filter((file) =>
        statSync(resolve(root, file)).isFile(),
      ),
    ];
    const found = files.flatMap((file) =>
      [...read(file).matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>\\]*/g)]
        .map((m) => m[0])
        .filter((url) => {
          if (allowed.includes(url)) return false;
          const host = /^[a-z]+:\/\/([^/:?#]+)/.exec(url)?.[1];
          return host === undefined ? false : !reserved.test(host);
        })
        .map((url) => `${file}: ${url}`),
    );
    expect(found).toEqual([]);
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

  it("keeps the landing templates neutral: no other vendor's name in their code or copy", () => {
    // The templates must not read as a copy of a commercial CDN's site (mvp.md 0.1).
    const vendors = /fastly|bunny|cloudflare|akamai|cloudfront|gcore|edgio|vercel|netlify/i;
    const files = [
      ...globSync("src/web/components/landing/**/*", { cwd: root }),
      "src/web/components/landing-settings.tsx",
      "src/web/routes/index.tsx",
    ];
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) expect(read(file), file).not.toMatch(vendors);
    for (const locale of ["zh-CN", "en"]) {
      const messages = JSON.parse(read(`messages/${locale}.json`)) as Record<string, string>;
      for (const [key, text] of Object.entries(messages)) {
        if (key.startsWith("landing_")) expect(text, `${locale} ${key}`).not.toMatch(vendors);
      }
    }
  });
});
