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
// The site holds editions, each a root folder of the same type (`edition`) that
// the sidebar switches between, keeping the page's path. This repository is the
// `oss` edition. DOCS_EDITIONS adds others: a comma-separated list of
// `edition.json` files, each in a git repository whose Markdown it publishes
// (fields: slug, title {zh, en}, github, branch, index, sections; paths are
// relative to that repository's root). Links between editions are relative
// paths between the checkouts.
//
// Site-only pages come from doc/site. Old URLs (before editions) get redirect
// pages in doc/public. Output is generated and git-ignored.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const doc = resolve(import.meta.dirname, "..");
const repo = resolve(doc, "..");
const out = join(doc, "content/docs");
const redirects = join(doc, "public");
const LANGS = ["zh", "en"];
const strict = Boolean(process.env.CI) || process.argv.includes("--strict");

/** This repository's edition. A page is [slug, repository path of the Chinese source]. */
const OSS = {
  slug: "oss",
  title: { zh: "开源版", en: "Open source" },
  github: "https://github.com/marvinli001/edgeweir",
  branch: "master",
  index: "docs/README.md",
  sections: [
    {
      dir: "start",
      title: { zh: "入门", en: "Getting started" },
      pages: [
        ["concepts", "docs/guide/concepts.md"],
        ["first-site", "docs/guide/first-site.md"],
      ],
    },
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
        ["bunny", "docs/deploy/bunny.md"],
        ["render", "docs/deploy/render.md"],
        ["zeabur", "docs/deploy/zeabur.md"],
        ["networking", "docs/deploy/networking.md"],
      ],
    },
    {
      dir: "sites",
      title: { zh: "站点", en: "Sites" },
      pages: [
        ["overview", "docs/guide/overview.md"],
        ["site-management", "docs/guide/site-management.md"],
        ["domains", "docs/guide/domains.md"],
        ["origins-and-cache", "docs/guide/origins-and-cache.md"],
        ["image-convert", "docs/guide/image-convert.md"],
        ["markdown-agents", "docs/guide/markdown-agents.md"],
        ["https", "docs/guide/https.md"],
        ["error-pages", "docs/guide/error-pages.md"],
        ["l4", "docs/guide/l4.md"],
        ["usage-protection", "docs/guide/usage-protection.md"],
        ["access-logs", "docs/guide/access-logs.md"],
      ],
    },
    {
      dir: "security",
      title: { zh: "访问控制", en: "Access control" },
      pages: [
        ["rules", "docs/guide/rules.md"],
        ["access-control", "docs/guide/access-control.md"],
        ["bans", "docs/guide/bans.md"],
        ["challenges", "docs/guide/challenges.md"],
        ["waf", "docs/guide/waf.md"],
        ["attack-dashboard", "docs/guide/attack-dashboard.md"],
      ],
    },
    {
      dir: "infrastructure",
      title: { zh: "基础设施", en: "Infrastructure" },
      pages: [
        ["clusters", "docs/guide/clusters.md"],
        ["scheduling", "docs/guide/scheduling.md"],
        ["dns", "docs/guide/dns.md"],
      ],
    },
    {
      dir: "system",
      title: { zh: "系统", en: "System" },
      pages: [
        ["account", "docs/guide/account.md"],
        ["alerts", "docs/guide/alerts.md"],
        ["system", "docs/guide/system.md"],
      ],
    },
    {
      dir: "node",
      title: { zh: "节点", en: "Nodes" },
      pages: [
        ["index", "docs/node/README.md"],
        ["install", "docs/deploy/nodes.md"],
        ["configuration", "docs/node/configuration.md"],
        ["upgrades", "docs/guide/node-upgrades.md"],
        ["logs", "docs/guide/node-logs.md"],
        ["operations", "docs/node/operations.md"],
        ["troubleshooting", "docs/node/troubleshooting.md"],
      ],
    },
    {
      dir: "operations",
      title: { zh: "运维", en: "Operations" },
      pages: [
        ["upgrade", "docs/deploy/upgrade.md"],
        ["downgrade", "docs/deploy/downgrade.md"],
        ["backup", "docs/deploy/backup.md"],
        ["maintenance", "docs/deploy/maintenance.md"],
        ["troubleshooting", "docs/deploy/troubleshooting.md"],
      ],
    },
    {
      dir: "reference",
      title: { zh: "参考", en: "Reference" },
      pages: [
        ["api", "docs/reference/api.md"],
        ["api-sites", "docs/reference/api/sites.md"],
        ["api-security", "docs/reference/api/security.md"],
        ["api-certificates", "docs/reference/api/certificates.md"],
        ["api-clusters", "docs/reference/api/clusters.md"],
        ["api-dns", "docs/reference/api/dns.md"],
        ["api-monitoring", "docs/reference/api/monitoring.md"],
        ["api-system", "docs/reference/api/system.md"],
        ["environment", "docs/reference/environment.md"],
        ["cli", "docs/reference/cli.md"],
        ["errors", "docs/reference/errors.md"],
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
  ],
};

/** Site URLs before editions: old slug -> source. Each gets a redirect to the page's new URL. */
const LEGACY = {
  deploy: "docs/deploy/README.md",
  "deploy/docker": "docs/deploy/docker.md",
  "deploy/baota": "docs/deploy/baota.md",
  "deploy/deploy-script": "docs/deploy/deploy-script.md",
  "deploy/railway": "docs/deploy/railway.md",
  "deploy/fly": "docs/deploy/fly.md",
  "deploy/bunny": "docs/deploy/bunny.md",
  "deploy/render": "docs/deploy/render.md",
  "deploy/zeabur": "docs/deploy/zeabur.md",
  "deploy/networking": "docs/deploy/networking.md",
  "deploy/nodes": "docs/deploy/nodes.md",
  "deploy/upgrade": "docs/deploy/upgrade.md",
  "deploy/backup": "docs/deploy/backup.md",
  ...Object.fromEntries(
    [
      "first-site",
      "domains",
      "site-management",
      "usage-protection",
      "account",
      "system",
      "origins-and-cache",
      "image-convert",
      "https",
      "rules",
      "access-control",
      "bans",
      "challenges",
      "attack-dashboard",
      "waf",
      "error-pages",
      "scheduling",
      "l4",
      "access-logs",
      "node-logs",
      "node-upgrades",
    ].map((name) => [`guide/${name}`, `docs/guide/${name}.md`]),
  ),
  "guide/dns-and-alerts": "docs/guide/dns.md",
  "reference/environment": "docs/reference/environment.md",
  "reference/cli": "docs/reference/cli.md",
  "reference/api": "docs/reference/api.md",
  "project/architecture": "ARCHITECTURE.md",
  "project/security": "SECURITY.md",
  "project/contributing": "CONTRIBUTING.md",
  "project/licensing": "LICENSING.md",
};

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
const toPosix = (path) => path.split(sep).join("/");

function gitRoot(dir) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function loadEdition(file) {
  const path = resolve(file);
  const edition = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["slug", "title", "github", "branch", "index", "sections"]) {
    if (!edition[key]) throw new Error(`${file}: missing ${key}`);
  }
  if (edition.slug === OSS.slug) throw new Error(`${file}: slug ${edition.slug} is taken`);
  return { ...edition, root: gitRoot(dirname(path)) };
}

const editions = [
  { ...OSS, root: repo },
  ...(process.env.DOCS_EDITIONS ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean)
    .map(loadEdition),
];

// Files GitHub will have, per repository: tracked plus new, not ignored, as
// absolute paths. Directories are their prefixes.
const published = new Set();
const publishedDirs = new Set();
for (const { root } of editions) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    published.add(join(root, file));
    const parts = file.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) publishedDirs.add(join(root, ...parts.slice(0, i)));
  }
}

// Absolute source path (either language) -> page.
const pages = [];
for (const edition of editions) {
  pages.push({ edition, slug: `${edition.slug}/index`, source: edition.index });
  for (const section of edition.sections) {
    for (const [name, source] of section.pages) {
      pages.push({ edition, slug: `${edition.slug}/${section.dir}/${name}`, source });
    }
  }
}
const slugOf = new Map();
for (const page of pages) {
  const abs = join(page.edition.root, page.source);
  slugOf.set(abs, page.slug);
  slugOf.set(english(abs), page.slug);
}

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

function githubUrl(abs) {
  const edition = editions.find(({ root }) => abs === root || abs.startsWith(root + sep));
  if (!edition) return undefined;
  const isDir = publishedDirs.has(abs);
  if (!isDir && !published.has(abs)) return undefined;
  return `${edition.github}/${isDir ? "tree" : "blob"}/${edition.branch}/${toPosix(relative(edition.root, abs))}`;
}

function rewriteUrl(url, page, file, lang) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return url;
  const [, path = "", hash = ""] = /^([^#?]*)(.*)$/.exec(url) ?? [];
  const decoded = decodeURIComponent(path);
  const target = decoded.startsWith("/")
    ? join(page.edition.root, decoded)
    : resolve(dirname(join(page.edition.root, file)), decoded);
  const clean = target.replace(/[/\\]$/, "");
  const slug = slugOf.get(clean);
  if (slug) return siteUrl(lang, slug) + hash;
  const remote = githubUrl(clean);
  if (!remote) {
    problems.push(`${page.edition.slug}:${file}: broken link ${url}`);
    return url;
  }
  return remote + hash;
}

function transform(markdown, page, file, lang) {
  // SECURITY.md: the English summary after the marker is replaced by SECURITY.en.md.
  const tree = parser.parse(markdown.split('<a id="english"></a>')[0]);
  let description;

  const h1 = tree.children.findIndex((n) => n.type === "heading" && n.depth === 1);
  if (h1 < 0) throw new Error(`${page.edition.slug}:${file}: no H1`);
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
      node.url = rewriteUrl(node.url, page, file, lang);
    }
    if (node.type === "html" && parent && index !== undefined) {
      if (/^<!--[\s\S]*-->$/.test(node.value.trim())) {
        parent.children.splice(index, 1);
        return index;
      }
      problems.push(
        `${page.edition.slug}:${file}: raw HTML is not published: ${node.value.slice(0, 60)}`,
      );
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
  return { title, description, mdx: `---\n${front.join("\n")}\n---\n\n${printer.stringify(tree)}` };
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const suffixOf = (lang) => (lang === "zh" ? "" : `.${lang}`);

rmSync(out, { recursive: true, force: true });
rmSync(redirects, { recursive: true, force: true });
const sources = {};
const indexes = {};

for (const lang of LANGS) {
  const suffix = suffixOf(lang);
  for (const edition of editions) {
    write(
      join(out, edition.slug, `meta${suffix}.json`),
      json({
        title: edition.title[lang],
        root: "edition",
        pages: ["index", ...edition.sections.map((s) => s.dir)],
      }),
    );
    for (const section of edition.sections) {
      write(
        join(out, edition.slug, section.dir, `meta${suffix}.json`),
        json({
          title: section.title[lang],
          defaultOpen: true,
          pages: section.pages.map(([name]) => name),
        }),
      );
    }
  }
}

for (const page of pages) {
  for (const lang of LANGS) {
    const file = lang === "zh" ? page.source : english(page.source);
    const abs = join(page.edition.root, file);
    if (!existsSync(abs)) {
      if (lang === "zh") problems.push(`${page.edition.slug}:${page.source}: missing`);
      continue;
    }
    const target = `${page.slug}${suffixOf(lang)}.mdx`;
    const result = transform(readFileSync(abs, "utf8"), page, file, lang);
    write(join(out, target), result.mdx);
    sources[target] =
      githubUrl(abs) ?? `${page.edition.github}/blob/${page.edition.branch}/${file}`;
    if (page.slug === `${page.edition.slug}/index`) {
      indexes[lang] ??= [];
      indexes[lang].push({ ...result, href: siteUrl(lang, page.slug) });
    }
  }
}

// Site-only pages (the landing page), already MDX. `{/* editions */}` becomes a
// card per edition.
for (const file of globSync("**/*.mdx", { cwd: join(doc, "site") })) {
  const lang = file.endsWith(".en.mdx") ? "en" : "zh";
  const cards = (indexes[lang] ?? [])
    .map(
      ({ title, description, href }) =>
        `  <Card title=${JSON.stringify(title)} href=${JSON.stringify(href)}${description ? ` description=${JSON.stringify(description)}` : ""} />`,
    )
    .join("\n");
  const text = readFileSync(join(doc, "site", file), "utf8").replace(
    "{/* editions */}",
    `<Cards>\n${cards}\n</Cards>`,
  );
  write(join(out, file), text);
  sources[file] = `${OSS.github}/blob/${OSS.branch}/doc/site/${file}`;
}
const ROOT_TITLE = { zh: "文档", en: "Docs" };
for (const lang of LANGS) {
  write(
    join(out, `meta${suffixOf(lang)}.json`),
    json({ title: ROOT_TITLE[lang], pages: ["index", ...editions.map((e) => e.slug)] }),
  );
}
write(join(doc, "content/sources.json"), json(sources));

// Redirects from the URLs before editions. Relative targets keep DOCS_BASE_PATH.
for (const [old, source] of Object.entries(LEGACY)) {
  const slug = slugOf.get(join(repo, source));
  if (!slug) {
    problems.push(`legacy URL ${old}: ${source} is not a page`);
    continue;
  }
  for (const lang of LANGS) {
    const from = `/${lang}/${old}`;
    const to = `${posix.relative(from, siteUrl(lang, slug))}/`;
    write(
      join(redirects, lang, old, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><a href="${to}">${to}</a>\n`,
    );
  }
}

for (const problem of problems) console.warn(`sync-content: ${problem}`);
if (strict && problems.length > 0) process.exit(1);
console.log(
  `sync-content: ${Object.keys(sources).length} pages, editions ${editions.map((e) => e.slug).join(", ")}`,
);
