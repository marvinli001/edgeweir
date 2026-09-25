import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assetPath } from "../../src/server/app";

/** The script as the console serves it (app.ts fills in the console URL). */
const script = readFileSync(assetPath("install", "install.sh"), "utf8").replaceAll(
  "__EDGEWEIR_CONSOLE_URL__",
  "http://console.test:3000",
);
const CA = "a".repeat(64);
const TOKEN = "ewt_AbCdEf0123456789-_xyz";

/** Commands the script must not reach while validating its input. */
const stubs = mkdtempSync(join(tmpdir(), "edgeweir-install-"));
const calls = join(stubs, "calls.log");
for (const name of ["curl", "cosign", "apt-get", "dnf", "yum", "systemctl", "tar"]) {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit 97\n`);
  chmodSync(path, 0o755);
}
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}, input = script) {
  writeFileSync(calls, "");
  const result = spawnSync("bash", ["-s", "--", ...args], {
    input,
    encoding: "utf8",
    env: { PATH: `${stubs}${delimiter}/usr/bin${delimiter}/bin`, HOME: stubs, ...env },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

const valid = ["--server", "https://console.example.com:8443", "--ca-sha256", CA];

describe("install.sh", () => {
  it("parses as bash", () => {
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  // shellcheck ships with the CI runners (ubuntu-latest); locally it is optional.
  it.runIf(!spawnSync("shellcheck", ["--version"]).error)("passes shellcheck", () => {
    const res = spawnSync("shellcheck", ["-s", "bash", "-"], { input: script, encoding: "utf8" });
    expect(res.stdout + res.stderr, "shellcheck findings").toBe("");
    expect(res.status).toBe(0);
  });

  it("is only function definitions until `main` on the last line", () => {
    const lines = script.split("\n");
    expect(lines.filter((l) => l.trim()).at(-1)).toBe('main "$@"');
    let inFunction = false;
    const topLevel: string[] = [];
    for (const line of lines) {
      if (inFunction) {
        if (line === "}") inFunction = false;
        continue;
      }
      if (/^[a-z_]+\(\) \{$/.test(line)) inFunction = true;
      else if (/^[a-z_]+\(\) \{ .* \}$/.test(line)) continue;
      else if (line.trim() && !line.startsWith("#")) topLevel.push(line);
    }
    expect(topLevel).toEqual(["set -euo pipefail", 'main "$@"']);
  });

  it("verifies the signature against exactly the tag being installed, before installing", () => {
    // `${REPO}` and `${VERSION}` are shell variables of the script.
    const shellVar = (name: string) => `\${${name}}`;
    const identity = `https://github.com/${shellVar("REPO")}/.github/workflows/release.yml@refs/tags/v${shellVar("VERSION")}`;
    expect(script).toContain(`--certificate-identity "${identity}"`);
    expect(script).toContain('REPO="edgeweir/edgeweir-node"');
    expect(script).not.toContain("certificate-identity-regexp");
    const main = script.slice(script.indexOf("main() {"));
    const order = [
      'fetch "checksums.txt"',
      "verify_signature",
      "pick_artifact",
      'fetch "$ARTIFACT"',
      "verify_checksum",
      "install_package",
      "enroll",
      "start_service",
    ].map((step) => main.indexOf(`\n  ${step}\n`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("pins cosign v3.1.3 by SHA-256 and passes the token to enroll through the environment", () => {
    expect(script).toContain('COSIGN_VERSION="3.1.3"');
    expect(script).toMatch(/COSIGN_SHA256_AMD64="[0-9a-f]{64}"/);
    expect(script).toMatch(/COSIGN_SHA256_ARM64="[0-9a-f]{64}"/);
    expect(script).toContain('EDGEWEIR_TOKEN="$TOKEN" /usr/bin/edgeweir-node enroll --server');
    // No command line carries the token.
    expect(script).not.toMatch(/--token[ =]"?\$/);
  });

  it("refuses --token on the command line", () => {
    const res = run([...valid, "--token", TOKEN]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--token is not accepted.*EDGEWEIR_TOKEN/);
    expect(res.calls).toBe("");
  });

  it("requires the token from EDGEWEIR_TOKEN or --token-file", () => {
    const missing = run(valid);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no enrollment token");
    expect(run(valid, { EDGEWEIR_TOKEN: "not a token" }).stderr).toContain("malformed");

    const file = join(stubs, "token");
    writeFileSync(file, `${TOKEN}\n`);
    // Past token validation, the next check (Linux / root) stops an unprivileged test run.
    for (const res of [
      run([...valid, "--token-file", file]),
      run(valid, { EDGEWEIR_TOKEN: TOKEN }),
    ]) {
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Linux only|run as root/);
      expect(res.calls).toBe("");
    }
  });

  it("validates the version, server, fingerprint and format before doing anything", () => {
    const cases: [string[], RegExp][] = [
      [[...valid, "--version", "1.2"], /semantic version/],
      [[...valid, "--version", "latest; rm -rf /"], /semantic version/],
      [[...valid, "--version", "v1.2.3/../../x"], /semantic version/],
      [["--server", "http://console:8443", "--ca-sha256", CA], /https:\/\//],
      [["--server", "https://console:8443", "--ca-sha256", "ABC"], /64 lowercase hex/],
      [[...valid, "--format", "snap"], /--format/],
      [[...valid, "--mirror", "file:///etc"], /--mirror/],
      [[...valid, "--bogus"], /unknown option/],
    ];
    for (const [args, message] of cases) {
      const res = run(args, { EDGEWEIR_TOKEN: TOKEN });
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stderr, args.join(" ")).toMatch(message);
      expect(res.calls).toBe("");
    }
    for (const version of ["0.2.0", "v0.2.0", "1.0.0-rc.1", "0.2.1-snapshot+abc1234"]) {
      const res = run([...valid, "--version", version], { EDGEWEIR_TOKEN: TOKEN });
      expect(res.stderr, version).not.toContain("semantic version");
    }
    expect(run(["--help"]).status).toBe(2);
  });

  it("executes nothing when the download is cut short", () => {
    const last = script.lastIndexOf('main "$@"');
    for (const cut of [last, last + 3, Math.floor(script.length / 2), 200]) {
      const res = run(valid, { EDGEWEIR_TOKEN: TOKEN }, script.slice(0, cut));
      expect(res.calls, `cut at ${cut}`).toBe("");
      expect(res.stderr, `cut at ${cut}`).not.toContain("[edgeweir]");
    }
  });
});
