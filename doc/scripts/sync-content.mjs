// Builds doc/content/docs from the repository's Markdown, the single source of
// truth. Each page is plain GitHub Markdown in the repository (`name.md` is
// Simplified Chinese, `name.en.md` English); here it becomes MDX for Fumadocs:
//
//   - the H1 becomes `title`, a one-line paragraph right after it `description`
//   - relative links to published pages become site URLs, links to other
//     repository files become GitHub URLs, and a link to a missing or
//     git-ignored file (absent on GitHub) fails
//   - GitHub alerts (`> [!NOTE]` …) become <Callout>
//   - SECURITY.md drops its English summary (SECURITY.en.md is the English page)
//
// Site-only pages come from doc/site. Output is generated and git-ignored.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const doc = resolve(import.meta.dirname, "..");
const repo = resolve(doc, "..");
const out = join(doc, "content/docs");
const GITHUB = "https://github.com/marvinli001/edgeweir";
const BRANCH = "master";
const LANGS = ["zh", "en"];
const strict = Boolean(process.env.CI) || process.argv.includes("--strict");

/** Folder titles and page order. A page is [slug, repository path of the Chinese source]. */
const SECTIONS = [
  {
    dir: "deploy",
    title: { zh: "部署", en: "Deployment" },
    pages: [
      ["index", "docs/deploy/README.md"],
      ["docker", "docs/deploy/docker.md"],
      ["baota", "docs/deploy/baota.md"],
      ["deploy-script", "docs/deploy/deploy-script.md"],
      ["railway", "docs/deploy/railway.md"],
      ["fly", "docs/deploy/fly.md"],
      ["networking", "docs/deploy/networking.md"],
      ["nodes", "docs/deploy/nodes.md"],
      ["upgrade", "docs/deploy/upgrade.md"],
      ["backup", "docs/deploy/backup.md"],
    ],
  },
  {
    dir: "guide",
    title: { zh: "使用指南", en: "Guides" },
    pages: [
      ["first-site", "docs/guide/first-site.md"],
      ["account", "docs/guide/account.md"],
      ["system", "docs/guide/system.md"],
      ["origins-and-cache", "docs/guide/origins-and-cache.md"],
      ["https", "docs/guide/https.md"],
      ["rules", "docs/guide/rules.md"],
      ["bans", "docs/guide/bans.md"],
      ["challenges", "docs/guide/challenges.md"],
      ["waf", "docs/guide/waf.md"],
      ["dns-and-alerts", "docs/guide/dns-and-alerts.md"],
      ["access-logs", "docs/guide/access-logs.md"],
      ["node-upgrades", "docs/guide/node-upgrades.md"],
    ],
  },
  {
    dir: "reference",
    title: { zh: "参考", en: "Reference" },
    pages: [
      ["environment", "docs/reference/environment.md"],
      ["cli", "docs/reference/cli.md"],
      ["api", "docs/reference/api.md"],
    ],
  },
  {
    dir: "project",
    title: { zh: "项目", en: "Project" },
    pages: [
      ["architecture", "ARCHITECTURE.md"],
      ["security", "SECURITY.md"],
      ["contributing", "CONTRIBUTING.md"],
      ["licensing", "LICENSING.md"],
    ],
  },
];

const CALLOUT = {
  NOTE: "info",
  TIP: "idea",
  IMPORTANT: "warning",
  WARNING: "warning",
  CAUTION: "error",
};

const english = (file) => file.replace(/\.md$/, ".en.md");
const siteUrl = (lang, slug) =>
  `/${lang}/${slug.replace(/(^|\/)index$/, "")}`.replace(/\/$/, "") || "/";

// Repository path (either language) -> page slug.
const pages = [];
for (const section of SECTIONS) {
  for (const [name, source] of section.pages) {
    if (!source) continue;
    const slug = `${section.dir}/${name}`;
    pages.push({ slug, source });
  }
}
const slugOf = new Map();
for (const { slug, source } of pages) {
  slugOf.set(source, slug);
  slugOf.set(english(source), slug);
}

// Files GitHub will have: tracked plus new, not ignored. Directories are their prefixes.
const published = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean),
);
const publishedDirs = new Set(
  [...published].flatMap((file) =>
    file
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
  ),
);

const problems = [];
const parser = unified().use(remarkParse).use(remarkGfm);
const printer = unified()
  .use(remarkStringify, { bullet: "-", fences: true, rule: "-", resourceLink: true })
  .use(remarkGfm)
  .use(remarkMdx);

function toText(node) {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  return (node.children ?? []).map(toText).join("");
}

function rewriteUrl(url, source, lang) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return url;
  const [, path = "", hash = ""] = /^([^#?]*)(.*)$/.exec(url) ?? [];
  const target = posix.normalize(
    path.startsWith("/")
      ? path.slice(1)
      : posix.join(posix.dirname(source), decodeURIComponent(path)),
  );
  const slug = slugOf.get(target);
  if (slug) return siteUrl(lang, slug) + hash;
  const clean = target.replace(/\/$/, "");
  const isDir = publishedDirs.has(clean);
  if (!isDir && !published.has(clean)) {
    problems.push(`${source}: broken link ${url}`);
    return url;
  }
  return `${GITHUB}/${isDir ? "tree" : "blob"}/${BRANCH}/${clean}${hash}`;
}

function transform(markdown, source, lang) {
  // SECURITY.md: the English summary after the marker is replaced by SECURITY.en.md.
  const tree = parser.parse(markdown.split('<a id="english"></a>')[0]);
  let description;

  const h1 = tree.children.findIndex((n) => n.type === "heading" && n.depth === 1);
  if (h1 < 0) throw new Error(`${source}: no H1`);
  const title = toText(tree.children[h1]).trim();
  const next = tree.children[h1 + 1];
  const nextText = next?.type === "paragraph" ? toText(next).trim() : "";
  const oneLine =
    next?.type === "paragraph" &&
    next.position.start.line === next.position.end.line &&
    nextText.length <= 160 &&
    next.children.every((c) => c.type === "text" || c.type === "inlineCode");
  if (oneLine) description = nextText;
  tree.children.splice(0, h1 + (oneLine ? 2 : 1));

  visit(tree, (node, index, parent) => {
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url) {
      node.url = rewriteUrl(node.url, source, lang);
    }
    if (node.type === "html" && parent && index !== undefined) {
      if (/^<!--[\s\S]*-->$/.test(node.value.trim())) {
        parent.children.splice(index, 1);
        return index;
      }
      problems.push(`${source}: raw HTML is not published: ${node.value.slice(0, 60)}`);
      parent.children.splice(index, 1);
      return index;
    }
    if (node.type === "blockquote" && parent && index !== undefined) {
      const first = node.children[0];
      const text = first?.type === "paragraph" ? first.children[0] : undefined;
      const match =
        text?.type === "text"
          ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(text.value)
          : null;
      if (!match) return;
      text.value = text.value.slice(match[0].length);
      if (text.value === "") first.children.shift();
      if (first.children.length === 0) node.children.shift();
      parent.children[index] = {
        type: "mdxJsxFlowElement",
        name: "Callout",
        attributes: [{ type: "mdxJsxAttribute", name: "type", value: CALLOUT[match[1]] }],
        children: node.children,
      };
    }
  });

  const front = [`title: ${JSON.stringify(title)}`];
  if (description) front.push(`description: ${JSON.stringify(description)}`);
  return `---\n${front.join("\n")}\n---\n\n${printer.stringify(tree)}`;
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

rmSync(out, { recursive: true, force: true });
const sources = {};

for (const lang of LANGS) {
  for (const section of SECTIONS) {
    const suffix = lang === "zh" ? "" : `.${lang}`;
    write(
      join(out, section.dir, `meta${suffix}.json`),
      `${JSON.stringify({ title: section.title[lang], defaultOpen: true, pages: section.pages.map(([name]) => name) }, null, 2)}\n`,
    );
  }
}

for (const { slug, source } of pages) {
  for (const lang of LANGS) {
    const file = lang === "zh" ? source : english(source);
    if (!existsSync(join(repo, file))) {
      if (lang === "zh") problems.push(`${source}: missing`);
      continue;
    }
    const target = `${slug}${lang === "zh" ? "" : `.${lang}`}.mdx`;
    write(join(out, target), transform(readFileSync(join(repo, file), "utf8"), file, lang));
    sources[target] = file;
  }
}

// Site-only pages (the overview), already MDX.
for (const file of globSync("**/*.mdx", { cwd: join(doc, "site") })) {
  write(join(out, file), readFileSync(join(doc, "site", file), "utf8"));
  sources[file] = `doc/site/${file}`;
}
const ROOT_TITLE = { zh: "文档", en: "Docs" };
const topLevel = SECTIONS.filter((s) => !s.dir.includes("/")).map((s) => s.dir);
for (const lang of LANGS) {
  write(
    join(out, `meta${lang === "zh" ? "" : `.${lang}`}.json`),
    `${JSON.stringify({ title: ROOT_TITLE[lang], pages: ["index", ...topLevel] }, null, 2)}\n`,
  );
}
write(join(doc, "content/sources.json"), `${JSON.stringify(sources, null, 2)}\n`);

for (const problem of problems) console.warn(`sync-content: ${problem}`);
if (strict && problems.length > 0) process.exit(1);
console.log(`sync-content: ${Object.keys(sources).length} pages`);
