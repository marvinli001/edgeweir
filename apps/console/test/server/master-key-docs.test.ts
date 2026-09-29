import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";

const repo = resolve(import.meta.dirname, "../../../..");
/** Every place that tells operators how to generate secrets. */
const DOCS = [
  ".env.example",
  "compose.yml",
  "compose.baota.yml",
  "docs/deploy/docker.md",
  "docs/deploy/baota.md",
  "README.md",
  "README.en.md",
];
const RUNS = 200;

interface Documented {
  file: string;
  /** The variable the command is assigned to, when the docs show an assignment. */
  variable?: string;
  command: string;
}

/** `VAR=$(cmd)`, inline code containing `openssl rand`, and bare `openssl rand -x N` mentions. */
function documentedCommands(): Documented[] {
  const found: Documented[] = [];
  for (const file of DOCS) {
    const text = readFileSync(resolve(repo, file), "utf8");
    for (const m of text.matchAll(/(?:([A-Z_]+)=)?\$\((openssl rand[^)]*)\)/g)) {
      found.push({ file, variable: m[1], command: (m[2] ?? "").trim() });
    }
    for (const m of text.matchAll(/`(openssl rand[^`]*)`/g)) {
      found.push({ file, command: (m[1] ?? "").trim() });
    }
    for (const m of text.matchAll(/openssl rand -\w+ \d+(?![^\n`)]*\|)/g)) {
      found.push({ file, command: m[0].trim() });
    }
  }
  return found;
}

/** Runs a documented command RUNS times in one shell and returns every output. */
function run(command: string): string[] {
  const out = execFileSync(
    "sh",
    ["-c", `i=0; while [ $i -lt ${RUNS} ]; do ${command}; i=$((i+1)); done`],
    {
      encoding: "utf8",
    },
  );
  return out.split("\n").filter(Boolean);
}

describe("documented secret generation commands", () => {
  const documented = documentedCommands();

  it("finds the master key command in the deploy docs", () => {
    const files = new Set(
      documented.filter((d) => d.command.startsWith("openssl rand")).map((d) => d.file),
    );
    expect(files).toContain("docs/deploy/docker.md");
    expect(files).toContain(".env.example");
  });

  it(`only produce master keys that envelope.ts accepts (${RUNS} runs each)`, () => {
    const commands = [...new Set(documented.map((d) => d.command))];
    expect(commands).toContain("openssl rand -base64 32");
    for (const command of commands) {
      const values = run(command);
      expect(values, command).toHaveLength(RUNS);
      for (const value of values) {
        expect(() => new MasterKey(value), `${command} -> ${value}`).not.toThrow();
      }
    }
  });

  it("produce database passwords that fit into DATABASE_URL unescaped", () => {
    const passwords = documented.filter((d) => d.variable === "POSTGRES_PASSWORD");
    for (const { command } of passwords) {
      for (const value of run(command)) {
        expect(value, command).toMatch(/^[A-Za-z0-9]+$/);
      }
    }
  });
});
