import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorCodes, errorDefs, revisionReasonCodes, revisionReasonDefs } from "@edgeweir/contract";
import { type ESTree, parseSync, Visitor } from "vite";
import { describe, expect, it } from "vitest";

const load = (locale: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${locale}.json`), "utf8"),
  ) as Record<string, string>;
const settings = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../project.inlang/settings.json"), "utf8"),
) as { baseLocale: string; locales: string[] };

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const root = resolve(import.meta.dirname, "../..");
const components = globSync("src/web/{routes,components}/**/*.tsx", { cwd: root });

/** Attributes that only carry human-readable text. */
const textAttributes = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "alt",
]);
/** Attributes and props that carry text but often hold example values ("us-east-1", "MacBook"). */
const hintAttributes = new Set(["placeholder", "label", "description"]);
/** The same in every language. Keep this short. */
const allowed = new Set(["Edgeweir"]);

/**
 * Heuristic for English prose: two words in a row ("Toggle Sidebar", "Search for") or a word that
 * starts with a capital on its own ("Loading", "Close…"). Identifiers, example values, units and
 * acronyms ("id, page", "Accept-Language", "MacBook", "HTTPS") pass.
 */
const isProse = (text: string) =>
  /\b[A-Za-z][a-z]+ [A-Za-z][a-z]+\b/.test(text) || /^[A-Z][a-z]{2,}(?:$|[\s.…!?,:])/.test(text);
const hasWord = (text: string) => /[A-Za-z]{2}/.test(text);

/** String literals an expression can evaluate to (literal, template text, either branch). */
function strings(node: ESTree.Node | null | undefined): string[] {
  if (!node) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? [node.value] : [];
    case "TemplateLiteral":
      return node.quasis.map((quasi) => quasi.value.cooked ?? "");
    case "ConditionalExpression":
      return [...strings(node.consequent), ...strings(node.alternate)];
    case "LogicalExpression":
      return [...strings(node.left), ...strings(node.right)];
    case "JSXExpressionContainer":
      return node.expression.type === "JSXEmptyExpression" ? [] : strings(node.expression);
    default:
      return [];
  }
}

/** Hard-coded English in one component file, as "file:line text". */
function englishLiterals(file: string): string[] {
  const source = readFileSync(resolve(root, file), "utf8");
  const { program, errors } = parseSync(file, source);
  expect(errors, file).toEqual([]);
  const found: string[] = [];
  const report = (node: { start: number }, text: string) => {
    const trimmed = text.trim();
    if (allowed.has(trimmed)) return;
    const line = source.slice(0, node.start).split("\n").length;
    found.push(`${file}:${line} ${JSON.stringify(trimmed)}`);
  };
  const children = (node: ESTree.JSXElement | ESTree.JSXFragment) => {
    for (const child of node.children) {
      if (child.type === "JSXText" && isProse(child.value.trim())) report(child, child.value);
      if (child.type === "JSXExpressionContainer") {
        for (const text of strings(child)) if (isProse(text.trim())) report(child, text);
      }
    }
  };
  new Visitor({
    JSXElement: children,
    JSXFragment: children,
    JSXAttribute(node) {
      if (node.name.type !== "JSXIdentifier") return;
      const name = node.name.name;
      const check = textAttributes.has(name) ? hasWord : hintAttributes.has(name) ? isProse : null;
      if (!check) return;
      for (const text of strings(node.value)) if (check(text.trim())) report(node, text);
    },
    // Default props such as `title = "Command Palette"`.
    AssignmentPattern(node) {
      if (node.left.type !== "Identifier") return;
      const name = node.left.name;
      if (!textAttributes.has(name) && !hintAttributes.has(name)) return;
      for (const text of strings(node.right)) if (isProse(text.trim())) report(node, text);
    },
  }).visit(program);
  return found;
}

describe("i18n messages", () => {
  const zh = load("zh-CN");
  const en = load("en");

  it("defaults to zh-CN and also ships en", () => {
    expect(settings.baseLocale).toBe("zh-CN");
    expect(settings.locales).toEqual(["zh-CN", "en"]);
  });

  it("has the same keys in every locale", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("uses the same placeholders in every locale and never leaves a message empty", () => {
    for (const key of Object.keys(zh)) {
      if (key === "$schema") continue;
      expect(zh[key]?.trim(), key).toBeTruthy();
      expect(en[key]?.trim(), key).toBeTruthy();
      expect(placeholders(en[key] ?? ""), key).toEqual(placeholders(zh[key] ?? ""));
    }
  });

  it("localizes every API error code and revision reason with the same parameters", () => {
    for (const code of errorCodes) {
      const key = `error_${code.toLowerCase()}`;
      expect(zh[key], key).toBeTruthy();
      expect(placeholders(zh[key] ?? ""), key).toEqual([...errorDefs[code].params].sort());
    }
    for (const code of revisionReasonCodes) {
      const key = `revision_reason_${code}`;
      expect(zh[key], key).toBeTruthy();
      expect(placeholders(zh[key] ?? ""), key).toEqual([...revisionReasonDefs[code].params].sort());
    }
  });

  it("keeps UI strings out of components (no hard-coded CJK in web sources)", () => {
    expect(components.length).toBeGreaterThan(5);
    for (const file of components) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(/[一-鿿]/.test(source), file).toBe(false);
    }
  });

  it("keeps English UI text out of components (JSX text, labels and accessibility attributes)", () => {
    const found = components.flatMap(englishLiterals);
    expect(found).toEqual([]);
  });
});
