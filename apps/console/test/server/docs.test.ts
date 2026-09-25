import { globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schema } from "@edgeweir/db";
import { getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

// Documentation-consistency checks for the wrap-up audit items that only
// touched documents (docs/audits/2026-09-25-wrapup.md CP-H8 and CP-M11).

const repo = resolve(import.meta.dirname, "../../../..");
const read = (file: string) => readFileSync(resolve(repo, file), "utf8");

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

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
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
    ["CLAUDE.md", read("CLAUDE.md")],
    ["docs/specs/mvp.md", read("docs/specs/mvp.md")],
    ["README.md", read("README.md")],
    ["README.zh-CN.md", read("README.zh-CN.md")],
    ["ARCHITECTURE.md", read("ARCHITECTURE.md")],
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

  it.each(["docs/adr/0016-one-line-install.md", "docs/adr/0018-trust-and-security-baseline.md"])(
    "%s has an update record saying they are never stored",
    (file) => {
      const record = updateRecord(file);
      expect(record).not.toBe("");
      expect(saysNeverStored(record)).toBe(true);
    },
  );
});

// --- CP-M11 ------------------------------------------------------------------

const STATUS_DOCS = ["README.md", "README.zh-CN.md", "ARCHITECTURE.md"];

describe("CP-M11: README.md, README.zh-CN.md and ARCHITECTURE.md describe what is not built yet", () => {
  const SKELETON = /skeleton|骨架/i;
  const NOT_YET = /skeleton|骨架|not yet|尚未|还没|MVP M3/i;
  const CERTD_WORK = /ACME|certificate|证书|DNS|lego|libdns/i;
  const NOT_USED = /does not use|doesn't use|not used|不使用|未使用|没有使用/i;
  const LATER = /\byet\b|目前|尚未|later|后续|将来|以后/i;

  it.each(STATUS_DOCS)("%s calls edgeweir-certd a skeleton that does not work yet", (file) => {
    const certd = sentences(read(file)).filter((s) => /certd/.test(s));
    expect(certd.some((s) => SKELETON.test(s))).toBe(true);
    const claims = certd.filter((s) => CERTD_WORK.test(s) && !NOT_YET.test(s));
    expect(claims).toEqual([]);
  });

  it.each(STATUS_DOCS)("%s says the console does not use ClickHouse or Valkey yet", (file) => {
    const mentions = paragraphs(read(file)).filter((p) => /ClickHouse|Valkey/.test(p));
    expect(
      mentions.some(
        (p) => /ClickHouse/.test(p) && /Valkey/.test(p) && NOT_USED.test(p) && LATER.test(p),
      ),
    ).toBe(true);
    const claims = mentions.filter((p) => !NOT_USED.test(p) && !LATER.test(p));
    expect(claims).toEqual([]);
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
      "ROADMAP.md",
      "CONTRIBUTING.md",
      "CLAUDE.md",
      "docs/**/*.md",
    ],
    { cwd: repo },
  ).sort();
  const links = files.flatMap(relativeLinks);

  it("finds the documents and their links", () => {
    expect(files).toEqual(expect.arrayContaining(["README.md", "docs/adr/README.md"]));
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
});

describe("CP-M11: docs/adr/README.md index", () => {
  it("lists every ADR file with its number, title and status", () => {
    const files = readdirSync(resolve(repo, "docs/adr"))
      .filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const rows = new Map(
      [
        ...read("docs/adr/README.md").matchAll(
          /^\| \[ADR-(\d{4})\]\((\d{4}-[a-z0-9-]+\.md)\) \| ([^|]+?) \| ([^|]+?) \|/gm,
        ),
      ].map((m) => [m[2] ?? "", { id: m[1], title: m[3], status: m[4] }]),
    );
    expect([...rows.keys()].sort()).toEqual(files);
    for (const file of files) {
      const text = read(`docs/adr/${file}`);
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
