import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../../scripts/ci-changes.sh");

it.each([
  ["docs/guide.md", false],
  ["docs/中文说明.md", false],
  ["docs/screenshots/phone.png", false],
  ["README.md", false],
  [".github/workflows/docs.yml", false],
  ["apps/console/src/web/help.md", true],
  ["Dockerfile", true],
  [".github/workflows/ci.yml", true],
  ["scripts/e2e.sh", true],
] as const)("detects product inputs in %s", (path, product) => {
  const cwd = mkdtempSync(join(tmpdir(), "edgeweir-ci-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    );
    const base = git("rev-parse", "HEAD");
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "changed\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "change");
    const changed = (from: string) =>
      execFileSync("bash", [script, from], { cwd, encoding: "utf8" }).trim();
    expect(changed(base)).toBe(String(product));
    expect(changed("0".repeat(40))).toBe("true");
    expect(changed("HEAD")).toBe("false");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
