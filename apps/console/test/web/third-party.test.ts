import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workspace = resolve(root, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const allWeb = globSync("src/web/**/*.{ts,tsx,css}", {
  cwd: root,
  exclude: ["src/web/paraglide/**", "src/web/routeTree.gen.ts"],
});

/** Licenses third-party code in the web UI may carry (ADR-0034). */
const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "OFL-1.1",
  "Unlicense",
  "0BSD",
]);

interface Manifest {
  name: string;
  version: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Whether an SPDX expression is satisfiable with allowed licenses (OR picks one, AND needs all). */
function satisfiable(expression: string): boolean {
  const tokens = expression.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let i = 0;
  const or = (): boolean => {
    let ok = and();
    while (tokens[i] === "OR") {
      i++;
      ok = and() || ok;
    }
    return ok;
  };
  const and = (): boolean => {
    let ok = term();
    while (tokens[i] === "AND") {
      i++;
      ok = term() && ok;
    }
    return ok;
  };
  const term = (): boolean => {
    const token = tokens[i++];
    if (token === "(") {
      const ok = or();
      i++;
      return ok;
    }
    return ALLOWED.has((token ?? "").replace(/\+$/, ""));
  };
  const ok = or();
  return ok && i === tokens.length;
}

function licenseOf(pkg: Manifest): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  const legacy = (pkg.licenses ?? []).map((l) => l.type).filter(Boolean);
  return legacy.length > 0 ? `(${legacy.join(" OR ")})` : "UNKNOWN";
}

/** Node resolution from a package's real directory (pnpm keeps dependencies beside it). */
function findPackage(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = resolve(dir, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Bare package names the web UI imports. A CSS `@import` brings in that package's stylesheet only
 * (shadcn's is inside its CLI package), so its dependencies are not followed (`leaf`).
 */
function webPackages(): { name: string; leaf: boolean }[] {
  const names = new Map<string, boolean>();
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms,
    /^\s*import\s+"([^"]+)"/gm,
    /\bimport\(\s*"([^"]+)"\s*\)/g,
    /^@import\s+"([^"]+)"/gm,
  ];
  for (const file of allWeb) {
    const source = read(file);
    for (const pattern of patterns) {
      for (const m of source.matchAll(pattern)) {
        const spec = m[1] as string;
        if (
          !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/|$)/.test(spec) ||
          spec.startsWith("node:")
        )
          continue;
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : (spec.split("/")[0] as string);
        const leaf = pattern.source.startsWith("^@import");
        names.set(name, (names.get(name) ?? true) && leaf);
      }
    }
  }
  // Workspace packages are this project's own code (AGPL-3.0-only); their dependencies still count.
  return [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, leaf]) => ({ name, leaf }));
}

/** Every package the web UI's imports pull in, with its license. */
function webClosure(): Map<string, { version: string; license: string; dir: string }> {
  const seen = new Map<string, { version: string; license: string; dir: string }>();
  const visit = (dir: string, leaf = false) => {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    seen.set(key, { version: pkg.version, license: licenseOf(pkg), dir });
    if (leaf) return;
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const found = findPackage(dir, dep);
      if (found) visit(found);
      else if (!pkg.optionalDependencies?.[dep]) throw new Error(`${key}: ${dep} not installed`);
    }
  };
  for (const { name, leaf } of webPackages()) {
    const dir = findPackage(root, name);
    if (!dir) throw new Error(`${name} is imported by src/web but not installed`);
    visit(dir, leaf);
  }
  return seen;
}

describe("third-party code in the web UI (ADR-0034)", () => {
  it("ships only packages under allowed licenses (MIT, Apache-2.0, ISC, BSD, OFL-1.1, Unlicense, 0BSD)", () => {
    const closure = webClosure();
    expect(closure.size).toBeGreaterThan(30);
    const own = /^@edgeweir\//;
    const offending = [...closure.entries()]
      .filter(([key]) => !own.test(key))
      .filter(([, info]) => !satisfiable(info.license))
      .map(([key, info]) => `${key}: ${info.license}`);
    expect(offending).toEqual([]);
  });

  it("parses license expressions the way the check above relies on", () => {
    expect(satisfiable("MIT")).toBe(true);
    expect(satisfiable("(MIT OR GPL-3.0)")).toBe(true);
    expect(satisfiable("MIT AND CC-BY-4.0")).toBe(false);
    expect(satisfiable("EPL-2.0 OR GPL-3.0-or-later")).toBe(false);
    expect(satisfiable("Apache-2.0 AND (MIT OR BSD-3-Clause)")).toBe(true);
    expect(satisfiable("SEE LICENSE IN LICENSE")).toBe(false);
    expect(satisfiable("UNKNOWN")).toBe(false);
  });

  it("bundles one copy of Motion, 13.5.x, shared with appica-ui", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies.motion).toMatch(/^13\.5\.\d+$/);
    const lock = readFileSync(resolve(workspace, "pnpm-lock.yaml"), "utf8");
    const versions = new Set(
      [...lock.matchAll(/^ {2}'?motion@(\d+\.\d+\.\d+)/gm)].map((m) => m[1] as string),
    );
    expect([...versions]).toEqual([pkg.dependencies.motion]);
    // motion re-exports framer-motion of the same version; nothing else may pull in another one.
    const framer = new Set(
      [...lock.matchAll(/^ {2}'?framer-motion@(\d+\.\d+\.\d+)/gm)].map((m) => m[1] as string),
    );
    expect([...framer]).toEqual([pkg.dependencies.motion]);
  });

  it("lists every adapted source file and every effect library in THIRD-PARTY-NOTICES.md", () => {
    const notices = read("THIRD-PARTY-NOTICES.md");
    // Files that say they were adapted or generated from someone else's code.
    const adapted = allWeb.filter((file) =>
      /^\s*(?:\/\*|\*|\/\/).*\b(?:adapted from|generated by|copied from)\b/im.test(
        read(file).split("\n").slice(0, 8).join("\n"),
      ),
    );
    expect(adapted.length).toBeGreaterThan(5);
    const missingFiles = adapted
      .map((file) => file.replace(/^.*\//, ""))
      .filter((base) => !notices.includes(`\`${base}\``));
    expect(missingFiles).toEqual([]);
    // Packages the effects import directly, at the installed version.
    const effectPackages = new Set(
      globSync("src/web/components/effects/*.{ts,tsx}", { cwd: root }).flatMap((file) =>
        [...read(file).matchAll(/from\s+"([^".@/][^"]*|@[^"/]+\/[^"/]+)[^"]*"/g)]
          .map((m) => m[1] as string)
          .filter((spec) => spec !== "react" && !spec.startsWith("react/"))
          .map((spec) => (spec.startsWith("@") ? spec : (spec.split("/")[0] as string))),
      ),
    );
    const missingPackages = [...effectPackages].filter((name) => {
      const dir = findPackage(root, name);
      const version = dir
        ? (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest).version
        : "?";
      return !new RegExp(
        `\\[${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\][^\\n]*\\| ${version.replace(/\./g, "\\.")}\\b`,
        "i",
      ).test(notices);
    });
    expect(missingPackages).toEqual([]);
  });

  it("lists every bundled font in THIRD-PARTY-NOTICES.md", () => {
    const notices = read("THIRD-PARTY-NOTICES.md");
    const fonts = [
      ...read("src/web/index.css").matchAll(/@import "(@fontsource[^/"]*\/[^/"]+)/g),
    ].map((m) => m[1] as string);
    expect(fonts.length).toBeGreaterThan(1);
    const missing = fonts.filter((name) => {
      const dir = findPackage(root, name);
      const version = dir
        ? (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest).version
        : "?";
      return !notices.includes(`\`${name}\` ${version}`);
    });
    expect(missing).toEqual([]);
  });
});
