import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schema } from "@edgeweir/db";
import { getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

// Documentation-consistency checks for the wrap-up audit items that only
// touched documents (dev-docs/audits/2026-09-25-wrapup.md CP-H8 and CP-M11).

const repo = resolve(import.meta.dirname, "../../../..");
const read = (file: string) => readFileSync(resolve(repo, file), "utf8");
/** Git-ignored maintainer records (ADRs, roadmaps, specs): checked in checkouts that have them. */
const DEV_DOCS = "dev-docs";
const hasDevDocs = existsSync(resolve(repo, DEV_DOCS, "adr"));

/** Sentence ends, semicolons, table cells and line breaks end a clause. */
function clauses(text: string): string[] {
  return text
    .split(/[。；;！？!?|\n]|\.(?=\s|$)/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Like clauses, but a semicolon does not end a sentence. */
function sentences(text: string): string[] {
  return text
    .split(/[。！？!?|\n]|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The text of the `## ...` section whose heading matches. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// --- CP-H8 -------------------------------------------------------------------

const SSH = /\bSSH\b/;
/** Sentences about GoEdge describe its control plane, which did keep SSH credentials. */
const ABOUT_GOEDGE = /GoEdge|RingH23/;
const NEVER_STORED = [
  /(?:绝不|从不|不)(?:保存|存储|存|入库)[^。；，,]{0,6}SSH/,
  /(?:\bnever|\bnot|n't)\s+(?:stores?|keeps?|saves?|persists?)\s+(?:any\s+|the\s+)?(?:node\s+)?SSH\b/i,
  /\bSSH (?:root )?credentials are never (?:stored|kept|saved|persisted)\b/i,
];
const STORE_VERB =
  /保存|存储|入库|存入|写入数据库|\bstor(?:e|es|ed|ing)\b|\bsav(?:e|es|ed|ing)\b|\bpersist(?:s|ed|ing)?\b|\bkept\b/gi;
const NEGATION = /绝不|从不|不|没有|\bnever\b|\bnot\b|n't\b|\bno\b/i;
const ENCRYPTED = /加密|encrypt/i;
const BY_DEFAULT = /默认|by default/i;
const OPT_IN = /可选|明确选择|除非|optional|\bopt(?:s|ed)?[ -]?in\b|\bunless\b|\bonly if\b/i;

function saysNeverStored(text: string): boolean {
  return clauses(text).some((c) => SSH.test(c) && NEVER_STORED.some((re) => re.test(c)));
}

/** Why a clause says that SSH credentials are, or may be, stored; empty when it does not. */
function storageClaims(clause: string): string[] {
  if (!SSH.test(clause) || ABOUT_GOEDGE.test(clause)) return [];
  const verbs = [...clause.matchAll(STORE_VERB)];
  const affirmative = verbs.filter(
    (m) => !NEGATION.test(clause.slice(Math.max(0, m.index - 12), m.index)),
  );
  const reasons: string[] = [];
  if (ENCRYPTED.test(clause)) reasons.push("stored encrypted");
  if (BY_DEFAULT.test(clause)) reasons.push("not stored only by default");
  if (verbs.length > 0 && OPT_IN.test(clause)) reasons.push("stored when the operator opts in");
  if (affirmative.length > 0) reasons.push(`stored ("${affirmative[0]?.[0]}")`);
  return reasons;
}

function storageStatements(text: string): string[] {
  return clauses(text).flatMap((c) => storageClaims(c).map((reason) => `${reason}: ${c}`));
}

/** The "> 更新记录：" block quote of an ADR. */
function updateRecord(file: string): string {
  const lines = read(file).split("\n");
  const start = lines.findIndex((l) => /^>\s*更新记录/.test(l));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && !l.startsWith(">"));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("CP-H8: SSH credentials are never stored", () => {
  const security = read("SECURITY.md");
  const [chinese = "", english = ""] = security.split('<a id="english"></a>');
  const docs: [string, string][] = [
    ["SECURITY.md (Chinese)", chinese],
    ["SECURITY.md (English summary)", english],
    ["README.md", read("README.md")],
    ["README.en.md", read("README.en.md")],
    ["ARCHITECTURE.md", read("ARCHITECTURE.md")],
    // Git-ignored maintainer documents: checked in checkouts that have them.
    ...["CLAUDE.md", `${DEV_DOCS}/specs/mvp.md`]
      .filter((file) => existsSync(resolve(repo, file)))
      .map((file): [string, string] => [file, read(file)]),
  ];

  it("finds both parts of SECURITY.md", () => {
    expect(chinese).toContain("## 信任基线");
    expect(english).toContain("**Trust baseline.**");
  });

  it.each(docs)("%s says so and never says they are or may be stored", (_, text) => {
    expect(saysNeverStored(text)).toBe(true);
    expect(storageStatements(text)).toEqual([]);
  });

  it("flags the wording SECURITY.md used before the fix", () => {
    const before = [
      "内部 CA 私钥、DNS 服务商 API 密钥、SSH 凭据（仅在运营者明确选择保存时）等，用主密钥 `EDGEWEIR_MASTER_KEY` 做信封加密。",
      "| 控制面默认不保存节点 SSH 凭据；SSH 远程安装是可选的一次性操作，凭据用完即弃 | 防范 |",
      "Secrets (CA key, certificate keys, DNS API credentials, optionally saved SSH credentials) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they reach the database.",
    ];
    for (const text of before) expect(storageStatements(text), text).not.toEqual([]);
  });

  describe.runIf(hasDevDocs)("ADR update records", () => {
    it.each([
      `${DEV_DOCS}/adr/0016-one-line-install.md`,
      `${DEV_DOCS}/adr/0018-trust-and-security-baseline.md`,
    ])("%s has an update record saying they are never stored", (file) => {
      const record = updateRecord(file);
      expect(record).not.toBe("");
      expect(saysNeverStored(record)).toBe(true);
    });
  });
});

// --- CP-M11 ------------------------------------------------------------------

const STATUS_DOCS = ["README.md", "README.en.md", "ARCHITECTURE.md"];

describe("CP-M11: README.md, README.en.md and ARCHITECTURE.md describe what is built", () => {
  it.each(STATUS_DOCS)("%s documents the active ACME helper and its process boundary", (file) => {
    const text = read(file);
    expect(text).toMatch(/certd/);
    expect(text).toMatch(/ACME/);
    expect(text).toMatch(/stdin\/stdout/);
    expect(
      sentences(text).filter(
        (sentence) => /certd/.test(sentence) && /only a skeleton|只有骨架/.test(sentence),
      ),
    ).toEqual([]);
  });

  it.each(STATUS_DOCS)("%s describes the optional ClickHouse logs", (file) => {
    const text = read(file);
    expect(text).toContain("EDGEWEIR_ANALYTICS=clickhouse");
    expect(text).toMatch(/sampl|采样/i);
    expect(text).toMatch(/7 days|7 天/);
    expect(text).not.toMatch(/console does not use either yet|控制台目前都不使用/);
  });
});

// --- U-14 --------------------------------------------------------------------

describe("U-14: no Valkey, which the console never used", () => {
  it("compose.yml has no valkey service and no cache profile", () => {
    const compose = read("compose.yml");
    // The indented lines under the top-level "services:" key.
    const services = /^services:\n((?: .*\n|\n)*)/m.exec(compose)?.[1] ?? "";
    expect(services).toMatch(/^ {2}console:$/m);
    expect(services).not.toMatch(/^ {2}valkey:$/m);
    expect(compose).not.toMatch(/valkey|\bprofiles: \["cache"\]|--profile cache/i);
  });

  it("no published document offers it", () => {
    const files = globSync(["README*.md", "ARCHITECTURE*.md", "docs/**/*.md"], { cwd: repo });
    expect(files).toContain("docs/deploy/docker.md");
    for (const file of files) expect(read(file), file).not.toMatch(/valkey/i);
  });
});

describe("CP-M11: ARCHITECTURE.md data model matches packages/db", () => {
  const dataModel = section(read("ARCHITECTURE.md"), /^## .*数据模型/m);

  it("has a data model section", () => {
    expect(dataModel).not.toBe("");
  });

  it("lists every migration in packages/db/migrations", () => {
    const migrations = readdirSync(resolve(repo, "packages/db/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -".sql".length));
    expect(migrations.length).toBeGreaterThan(0);
    for (const name of migrations) expect(dataModel, name).toContain(`\`${name}\``);
  });

  it("mentions every table defined in packages/db/src/schema", () => {
    const tables = Object.values(schema)
      .filter((value) => is(value, Table))
      .map((table) => getTableName(table));
    expect(tables).toContain("audit_log");
    for (const name of tables) expect(dataModel, name).toContain(`\`${name}\``);
  });
});

interface Link {
  file: string;
  target: string;
}

/** Relative link targets outside code: inline links, images and reference definitions. */
function relativeLinks(file: string): Link[] {
  const text = read(file)
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const targets = [
    ...[...text.matchAll(/\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map(
      (m) => m[1] ?? "",
    ),
    ...[...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((m) => m[1] ?? ""),
  ];
  return targets
    .filter((t) => t !== "" && !t.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(t))
    .map((target) => ({ file, target }));
}

describe("CP-M11: relative Markdown links", () => {
  const files = globSync(
    [
      "README*.md",
      "ARCHITECTURE.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CLAUDE.md",
      "docs/**/*.md",
      `${DEV_DOCS}/**/*.md`,
    ],
    { cwd: repo },
  ).sort();
  const links = files.flatMap(relativeLinks);

  it("finds the documents and their links", () => {
    expect(files).toEqual(expect.arrayContaining(["README.md", "docs/deploy/README.md"]));
    expect(links).toContainEqual({ file: "README.md", target: "ARCHITECTURE.md" });
  });

  it("resolve to existing files (anchors ignored)", () => {
    const broken = links.filter(({ file, target }) => {
      const path = decodeURIComponent(target.replace(/[?#].*$/, ""));
      const abs = path.startsWith("/")
        ? resolve(repo, `.${path}`)
        : resolve(repo, dirname(file), path);
      return !statSync(abs, { throwIfNoEntry: false })?.isFile();
    });
    expect(broken).toEqual([]);
  });

  it("never point from a published document into the git-ignored dev-docs", () => {
    const leaks = links.filter(({ file, target }) => {
      if (file.startsWith(`${DEV_DOCS}/`) || file === "CLAUDE.md") return false;
      const path = decodeURIComponent(target.replace(/[?#].*$/, ""));
      const abs = path.startsWith("/")
        ? resolve(repo, `.${path}`)
        : resolve(repo, dirname(file), path);
      return abs === resolve(repo, DEV_DOCS) || abs.startsWith(`${resolve(repo, DEV_DOCS)}/`);
    });
    expect(leaks).toEqual([]);
  });
});

describe.runIf(hasDevDocs)("CP-M11: dev-docs/adr/README.md index", () => {
  it("lists every ADR file with its number, title and status", () => {
    const files = readdirSync(resolve(repo, DEV_DOCS, "adr"))
      .filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const rows = new Map(
      [
        ...read(`${DEV_DOCS}/adr/README.md`).matchAll(
          /^\| \[ADR-(\d{4})\]\((\d{4}-[a-z0-9-]+\.md)\) \| ([^|]+?) \| ([^|]+?) \|/gm,
        ),
      ].map((m) => [m[2] ?? "", { id: m[1], title: m[3], status: m[4] }]),
    );
    expect([...rows.keys()].sort()).toEqual(files);
    for (const file of files) {
      const text = read(`${DEV_DOCS}/adr/${file}`);
      const heading = /^# ADR-(\d{4}): (.+)$/m.exec(text);
      const status = /^- 状态：(.+)$/m.exec(text);
      expect(rows.get(file), file).toEqual({
        id: file.slice(0, 4),
        title: heading?.[2]?.trim(),
        status: status?.[1]?.trim(),
      });
      expect(heading?.[1], file).toBe(file.slice(0, 4));
    }
  });
});

// --- U-14 --------------------------------------------------------------------

/** The required variables, each with the alternative that replaces it. */
const REQUIRED_VARIABLES = [
  ["EDGEWEIR_MASTER_KEY", "EDGEWEIR_MASTER_KEY_FILE"],
  ["POSTGRES_PASSWORD", "DATABASE_URL"],
  ["EDGEWEIR_PUBLIC_URL"],
];
const VARIABLE = /`([A-Z][A-Z0-9_]*)`/g;

/** The rows of the Markdown table that follows the line matching `label`. */
function tableAfter(text: string, label: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => label.test(l));
  if (start < 0) return [];
  let i = start + 1;
  while (i < lines.length && !lines[i]?.startsWith("|")) i++;
  const rows: string[] = [];
  while (i < lines.length && lines[i]?.startsWith("|")) rows.push(lines[i++] ?? "");
  return rows.slice(2);
}

/** The variables named in the first cell of each row. */
function firstCellVariables(rows: string[]): string[][] {
  return rows.map((row) =>
    [...(row.split("|")[1] ?? "").matchAll(VARIABLE)].map((m) => m[1] ?? ""),
  );
}

describe("U-14: the deployment documents agree on the required variables", () => {
  it.each([
    ["README.md", /^必填变量：$/],
    ["README.en.md", /^Required variables:$/],
    ["docs/deploy/docker.md", /^必填变量：$/],
    ["docs/deploy/docker.en.md", /^Required variables:$/],
  ])("%s lists them", (file, label) => {
    expect(firstCellVariables(tableAfter(read(file), label))).toEqual(REQUIRED_VARIABLES);
  });

  it.each([
    ["docs/reference/environment.md", /^## 必需$/],
    ["docs/reference/environment.en.md", /^## Required$/],
  ])("%s lists the console's own and names POSTGRES_PASSWORD", (file, heading) => {
    const required = section(read(file), new RegExp(heading.source, "m"));
    expect(firstCellVariables(tableAfter(required, heading)).flat().sort()).toEqual(
      REQUIRED_VARIABLES.flat()
        .filter((name) => name !== "POSTGRES_PASSWORD")
        .sort(),
    );
    expect(required).toContain("`POSTGRES_PASSWORD`");
  });

  it(".env.example's required block holds them and nothing else", () => {
    const text = read(".env.example");
    const block = text.slice(text.indexOf("# --- Required"), text.indexOf("# --- Optional"));
    const assigned = [...block.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(assigned.sort()).toEqual(REQUIRED_VARIABLES.flat().sort());
  });

  it.each(["README.md", "README.en.md"])("the quick start of %s writes them to .env", (file) => {
    const heredoc = /cat > \.env <<EOF\n([\s\S]*?)\nEOF/.exec(read(file))?.[1] ?? "";
    const written = [...heredoc.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(written).toEqual(REQUIRED_VARIABLES.map(([name]) => name));
  });
});
