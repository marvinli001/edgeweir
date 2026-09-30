import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
/**
 * The host the script checks: an unprivileged user on Linux, whoever runs the
 * tests (as root the checks would go on to depend on the machine, e.g. systemd).
 */
for (const [name, answer] of Object.entries({
  uname: '[ "$1" = "-s" ] && echo Linux',
  id: '[ "$1" = "-u" ] && echo 1000',
})) {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\n${answer} && exit 0\necho "${name} $*" >> "${calls}"\nexit 97\n`);
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
    expect(script).toContain('REPO="marvinli001/edgeweir-node"');
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
    // Past token validation, the root check stops the (stubbed) unprivileged run.
    for (const res of [
      run([...valid, "--token-file", file]),
      run(valid, { EDGEWEIR_TOKEN: TOKEN }),
    ]) {
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("run as root");
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
    // --no-modsecurity is an option like the others (past validation, the root check stops the run).
    const optOut = run([...valid, "--no-modsecurity"], { EDGEWEIR_TOKEN: TOKEN });
    expect(optOut.stderr).toContain("run as root");
    expect(optOut.calls).toBe("");
    for (const version of ["0.2.0", "v0.2.0", "1.0.0-rc.1", "0.2.1-snapshot+abc1234"]) {
      const res = run([...valid, "--version", version], { EDGEWEIR_TOKEN: TOKEN });
      expect(res.stderr, version).not.toContain("semantic version");
    }
    expect(run(["--help"]).status).toBe(2);
  });

  it("never adds the openresty.org repositories", () => {
    expect(script).not.toContain("openresty.org");
    expect(script).not.toMatch(/sources\.list\.d|yum\.repos\.d|pubkey\.gpg/);
    expect(script).toContain('OPENRESTY_PACKAGE="edgeweir-openresty"');
    expect(script).toContain('MODSECURITY_PACKAGE="edgeweir-openresty-modsecurity"');
    expect(script).toContain('NGINX_BIN="/usr/lib/edgeweir-openresty/nginx/sbin/nginx"');
  });

  it("downloads and verifies the OpenResty packages with edgeweir-node and installs them first", () => {
    const main = script.slice(script.indexOf("main() {"));
    const order = [
      'fetch "checksums.txt"',
      "verify_signature",
      "pick_artifact",
      "pick_openresty",
      'fetch "$ARTIFACT"',
      "fetch_openresty",
      "verify_checksum",
      "install_openresty",
      "install_package",
      "enroll",
    ].map((step) => main.indexOf(`\n  ${step}\n`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Every package is checked against the same signed checksums.txt.
    const verify = script.slice(script.indexOf("verify_checksum() {"));
    for (const name of ["$ARTIFACT", "$OPENRESTY_ARTIFACT", "$MODSECURITY_ARTIFACT"])
      expect(verify.slice(0, verify.indexOf("\n}"))).toContain(`verify_file "${name}"`);
    // From the same release source as edgeweir-node (mirror, then GitHub).
    const fetchOpenresty = script.slice(script.indexOf("fetch_openresty() {"));
    expect(fetchOpenresty.slice(0, fetchOpenresty.indexOf("\n}"))).toMatch(
      /fetch "\$OPENRESTY_ARTIFACT"[\s\S]*fetch "\$MODSECURITY_ARTIFACT"/,
    );
  });

  it("picks exactly one edgeweir-openresty file per package, format and architecture", () => {
    const names = [
      "edgeweir-node_0.3.0_amd64.deb",
      "edgeweir-node-0.3.0-1.x86_64.rpm",
      "edgeweir-node_0.3.0_linux_amd64.tar.gz",
      "edgeweir-openresty_1.31.1.1-1_amd64.deb",
      "edgeweir-openresty_1.31.1.1-1_arm64.deb",
      "edgeweir-openresty_1.31.1.1-1_amd64.deb.sbom.json",
      "edgeweir-openresty-1.31.1.1-1.x86_64.rpm",
      "edgeweir-openresty-1.31.1.1-1.aarch64.rpm",
      "edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb",
      "edgeweir-openresty-modsecurity_1.31.1.1-1_arm64.deb",
      "edgeweir-openresty-modsecurity-1.31.1.1-1.x86_64.rpm",
      "edgeweir-openresty-modsecurity-1.31.1.1-1.aarch64.rpm",
    ];
    // The script's own function, called in place of `main`.
    const pick = (list: string[], ...args: string[]) =>
      spawnSync("bash", ["-s", "--", ...args], {
        input: script.replace(
          /main "\$@"\s*$/,
          `openresty_artifact "$@" <<'NAMES'\n${list.join("\n")}\nNAMES\n`,
        ),
        encoding: "utf8",
      });
    const cases: [string[], string][] = [
      [["deb", "amd64", "edgeweir-openresty"], "edgeweir-openresty_1.31.1.1-1_amd64.deb"],
      [["deb", "arm64", "edgeweir-openresty"], "edgeweir-openresty_1.31.1.1-1_arm64.deb"],
      [["rpm", "x86_64", "edgeweir-openresty"], "edgeweir-openresty-1.31.1.1-1.x86_64.rpm"],
      [["rpm", "aarch64", "edgeweir-openresty"], "edgeweir-openresty-1.31.1.1-1.aarch64.rpm"],
      [
        ["deb", "amd64", "edgeweir-openresty-modsecurity"],
        "edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb",
      ],
      [
        ["rpm", "aarch64", "edgeweir-openresty-modsecurity"],
        "edgeweir-openresty-modsecurity-1.31.1.1-1.aarch64.rpm",
      ],
    ];
    for (const [args, file] of cases) {
      const res = pick(names, ...args);
      expect(res.status, args.join(" ")).toBe(0);
      expect(res.stdout).toBe(`${file}\n`);
    }
    const refused: [string[], string[]][] = [
      // Two versions of the same package, or none.
      [
        [...names, "edgeweir-openresty_1.31.1.2-1_amd64.deb"],
        ["deb", "amd64", "edgeweir-openresty"],
      ],
      [
        names.filter((n) => !n.startsWith("edgeweir-openresty-1")),
        ["rpm", "x86_64", "edgeweir-openresty"],
      ],
      // Architectures are named per format.
      [names, ["deb", "x86_64", "edgeweir-openresty"]],
      [names, ["rpm", "amd64", "edgeweir-openresty"]],
      [names, ["tar", "amd64", "edgeweir-openresty"]],
      [names, ["deb", "amd64", "edgeweir-openresty.*"]],
      [
        ["edgeweir-openresty_1.31.1.1-1_amd64.deb; rm -rf /"],
        ["deb", "amd64", "edgeweir-openresty"],
      ],
    ];
    for (const [list, args] of refused) {
      const res = pick(list, ...args);
      expect(res.status, args.join(" ")).not.toBe(0);
      expect(res.stdout).toBe("");
    }
  });

  it("picks the OpenResty packages for the machine, with --no-modsecurity and glibc checks", () => {
    const work = mkdtempSync(join(tmpdir(), "edgeweir-openresty-"));
    const tools = join(work, "bin");
    mkdirSync(tools);
    for (const tool of ["awk", "grep"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(found, join(tools, tool));
    }
    const lines = [
      "edgeweir-node_0.3.0_amd64.deb",
      "edgeweir-openresty_1.31.1.1-1_amd64.deb",
      "edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb",
      "edgeweir-openresty-1.31.1.1-1.x86_64.rpm",
      "edgeweir-openresty-modsecurity-1.31.1.1-1.x86_64.rpm",
    ];
    writeFileSync(
      join(work, "checksums.txt"),
      lines.map((name, i) => `${String(i).repeat(64)}  ${name}`).join("\n"),
    );
    const stub = (name: string, body: string) => {
      writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(tools, name), 0o755);
    };
    const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
    const pickFor = (format: string, extra = "") =>
      spawnSync(bash, ["-s"], {
        input: script.replace(
          /main "\$@"\s*$/,
          `constants\nWORK="${work}" FORMAT=${format} ARCH=amd64 RPM_ARCH=x86_64 WITH_MODSECURITY=true\n${extra}\npick_openresty\necho "$OPENRESTY_FORMAT $OPENRESTY_ARTIFACT $MODSECURITY_ARTIFACT"\n`,
        ),
        encoding: "utf8",
        env: { PATH: tools },
      });
    try {
      stub("getconf", 'echo "glibc 2.36"');
      expect(pickFor("deb").stdout).toBe(
        "deb edgeweir-openresty_1.31.1.1-1_amd64.deb edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb\n",
      );
      expect(pickFor("rpm").stdout).toBe(
        "rpm edgeweir-openresty-1.31.1.1-1.x86_64.rpm edgeweir-openresty-modsecurity-1.31.1.1-1.x86_64.rpm\n",
      );
      expect(pickFor("deb", "WITH_MODSECURITY=false").stdout).toBe(
        "deb edgeweir-openresty_1.31.1.1-1_amd64.deb \n",
      );
      // The tar.gz takes the machine's package format, else an installed edgeweir-openresty.
      const noPackages = pickFor("tar");
      expect(noPackages.status).toBe(1);
      expect(noPackages.stderr).toContain("edgeweir-openresty comes as .deb and .rpm only");
      stub("rpm", "exit 0");
      expect(pickFor("tar").stdout).toMatch(/^rpm edgeweir-openresty-1\.31\.1\.1-1\.x86_64\.rpm /);
      stub("dpkg", "exit 0");
      expect(pickFor("tar").stdout).toMatch(/^deb edgeweir-openresty_1\.31\.1\.1-1_amd64\.deb /);
      // Older C libraries cannot run the packages.
      stub("getconf", 'echo "glibc 2.31"');
      const old = pickFor("deb");
      expect(old.status).toBe(1);
      expect(old.stderr).toContain("needs glibc 2.34 or later (this machine has 2.31)");
      // Without the module in the release, only --no-modsecurity goes on.
      stub("getconf", 'echo "glibc 2.34"');
      writeFileSync(join(work, "checksums.txt"), `${"a".repeat(64)}  ${lines[1]}\n`);
      expect(pickFor("deb").stderr).toContain("--no-modsecurity skips it");
      expect(pickFor("deb", "WITH_MODSECURITY=false").status).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("compares glibc versions numerically", () => {
    const atLeast = (have: string, want: string) =>
      spawnSync("bash", ["-s", "--", have, want], {
        input: script.replace(/main "\$@"\s*$/, 'version_at_least "$@"\n'),
      }).status;
    expect(atLeast("2.34", "2.34")).toBe(0);
    expect(atLeast("2.36", "2.34")).toBe(0);
    expect(atLeast("3.0", "2.34")).toBe(0);
    expect(atLeast("2.4", "2.34")).not.toBe(0);
    expect(atLeast("2.31", "2.34")).not.toBe(0);
    expect(atLeast("1.99", "2.34")).not.toBe(0);
    expect(atLeast("2.36; rm", "2.34")).not.toBe(0);
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
