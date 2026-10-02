import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  dnsRevisionReasonDefs,
  errorCodes,
  errorDefs,
  nodeErrorCodes,
  nodeErrorDefs,
  prefetchFailureReasonDefs,
  prefetchFailureReasons,
  revisionReasonCodes,
  revisionReasonDefs,
  taskErrorCodes,
  taskErrorDefs,
} from "@edgeweir/contract";
import { expressionErrorCodes, expressionErrorDefs } from "@edgeweir/rule-engine";
import { type ESTree, parseSync, Visitor } from "vite";
import { describe, expect, it } from "vitest";
import { m } from "../../src/web/paraglide/messages.js";

/**
 * A message in the inlang message format: a pattern, or variants chosen by selectors (English
 * plurals: `local countPlural = count: plural`, one `match` entry per plural category).
 */
type Message =
  | string
  | [{ declarations?: string[]; selectors?: string[]; match: Record<string, string> }];

const load = (locale: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${locale}.json`), "utf8"),
  ) as Record<string, Message>;
const settings = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../project.inlang/settings.json"), "utf8"),
) as { baseLocale: string; locales: string[] };

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
/** Every pattern a message can render: the message itself or each of its variants. */
const patterns = (message: Message | undefined): string[] =>
  message === undefined
    ? []
    : typeof message === "string"
      ? [message]
      : Object.values(message[0].match);

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
  const catalogs = [
    ["zh-CN", zh],
    ["en", en],
  ] as const;

  it("defaults to zh-CN and also ships en", () => {
    expect(settings.baseLocale).toBe("zh-CN");
    expect(settings.locales).toEqual(["zh-CN", "en"]);
  });

  it("has the same keys in every locale", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("uses the same placeholders in every locale and variant and never leaves a message empty", () => {
    for (const key of Object.keys(zh)) {
      if (key === "$schema") continue;
      const expected = placeholders(patterns(zh[key])[0] ?? "");
      for (const [locale, messages] of catalogs) {
        expect(patterns(messages[key]), `${locale} ${key}`).not.toEqual([]);
        for (const text of patterns(messages[key])) {
          expect(text.trim(), `${locale} ${key}`).toBeTruthy();
          expect(placeholders(text), `${locale} ${key}`).toEqual(expected);
        }
      }
    }
  });

  it("declares the inputs of variant messages and gives every plural category a variant", () => {
    for (const [locale, messages] of catalogs) {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const [key, message] of Object.entries(messages)) {
        if (typeof message === "string") continue;
        const [{ declarations = [], selectors = [], match }] = message;
        const at = `${locale} ${key}`;
        const inputs = declarations.flatMap((d) => /^input (\w+)$/.exec(d)?.[1] ?? []).sort();
        expect(inputs, at).toEqual(placeholders(patterns(message)[0] ?? ""));
        // Each selector is the plural category of an input.
        const plurals = new Map(
          declarations.flatMap((d) => {
            const local = /^local (\w+) = (\w+): plural$/.exec(d);
            return local ? [[local[1], local[2]] as const] : [];
          }),
        );
        expect(selectors, at).not.toEqual([]);
        for (const selector of selectors)
          expect(inputs, `${at} ${selector}`).toContain(plurals.get(selector));
        // Without a variant for a combination of categories, the message renders its key.
        const variants = Object.keys(match).map(
          (keys) =>
            new Map(
              keys
                .split(",")
                .map((pair) => pair.split("=").map((s) => s.trim()) as [string, string]),
            ),
        );
        for (const variant of variants) expect(selectors, at).toEqual([...variant.keys()]);
        const combinations = selectors.reduce<string[][]>(
          (partial) => partial.flatMap((head) => categories.map((category) => [...head, category])),
          [[]],
        );
        for (const combination of combinations) {
          const covered = variants.some((variant) =>
            selectors.every((selector, i) => [combination[i], "*"].includes(variant.get(selector))),
          );
          expect(covered, `${at} ${combination.join(", ")}`).toBe(true);
        }
      }
    }
  });

  it("pluralizes English counts and keeps zh-CN counts as they are", () => {
    expect(m.enroll_ttl_hours({ count: 1 }, { locale: "en" })).toBe("1 hour");
    expect(m.enroll_ttl_hours({ count: 24 }, { locale: "en" })).toBe("24 hours");
    expect(m.enroll_ttl_hours({ count: 1 }, { locale: "zh-CN" })).toBe("1 小时");
    expect(m.error_cluster_not_empty({ nodes: 1, sites: 2 }, { locale: "en" })).toBe(
      "The cluster still has 1 node and 2 sites",
    );
    expect(m.error_cluster_not_empty({ nodes: 0, sites: 1 }, { locale: "en" })).toBe(
      "The cluster still has 0 nodes and 1 site",
    );
    // Callers pass formatted numbers too.
    expect(m.purge_nodes_progress({ done: 0, total: "1" }, { locale: "en" })).toBe("0/1 node");
    expect(m.rollout_traffic_value({ requests: "1,000", errors: "1" }, { locale: "en" })).toBe(
      "1,000 requests, 1 5xx",
    );
  });

  it("localizes every API error code and revision reason (config and DNS) with the same parameters", () => {
    for (const code of errorCodes) {
      const key = `error_${code.toLowerCase()}`;
      expect(zh[key], key).toBeTruthy();
      for (const text of patterns(zh[key])) {
        expect(placeholders(text), key).toEqual([...errorDefs[code].params].sort());
      }
    }
    for (const code of revisionReasonCodes) {
      const key = `revision_reason_${code}`;
      expect(zh[key], key).toBeTruthy();
      for (const text of patterns(zh[key])) {
        expect(placeholders(text), key).toEqual([...revisionReasonDefs[code].params].sort());
      }
    }
    for (const [code, def] of Object.entries(dnsRevisionReasonDefs)) {
      const key = `dns_revision_reason_${code}`;
      expect(zh[key], key).toBeTruthy();
      for (const text of patterns(zh[key])) {
        expect(placeholders(text), key).toEqual([...def.params].sort());
      }
    }
  });

  it("localizes every node error code, task outcome code and expression error code with the same parameters", () => {
    const tables: [string, string, Record<string, { params: readonly string[] }>][] = [
      ["node_error_", "nodeErrorDefs", nodeErrorDefs],
      ["task_error_", "taskErrorDefs", taskErrorDefs],
      ["task_error_reason_", "prefetchFailureReasonDefs", prefetchFailureReasonDefs],
      ["rules_expr_", "expressionErrorDefs", expressionErrorDefs],
    ];
    expect(nodeErrorCodes.length).toBeGreaterThanOrEqual(6);
    expect(expressionErrorCodes).toContain("unknown_field");
    expect(taskErrorCodes.length).toBeGreaterThanOrEqual(6);
    expect(prefetchFailureReasons).toContain("status");
    for (const [prefix, table, defs] of tables) {
      for (const [code, def] of Object.entries(defs)) {
        const key = `${prefix}${code}`;
        for (const [locale, messages] of catalogs) {
          expect(messages[key], `${table}.${code} → ${locale} ${key}`).toBeTruthy();
          for (const text of patterns(messages[key])) {
            expect(placeholders(text), `${locale} ${key}`).toEqual([...def.params].sort());
          }
        }
      }
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
