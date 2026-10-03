import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assetPath } from "../../src/server/app";
import type { AppContext } from "../../src/server/lib/context";
import { loadEnv } from "../../src/server/lib/env";
import { ConfigEventBus } from "../../src/server/lib/events";
import { createLogger } from "../../src/server/lib/logger";
import { startNodeChannel } from "../../src/server/node-channel/server";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";
import { TEST_MASTER_KEY } from "./helpers";

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

  it("needs no token and skips enrollment on a host that is already enrolled", () => {
    const state = mkdtempSync(join(tmpdir(), "edgeweir-state-"));
    writeFileSync(join(state, "identity.json"), "{}\n");
    const enrolled = script.replace('STATE_DIR="/var/lib/edgeweir-node"', `STATE_DIR="${state}"`);
    try {
      // Past the token, the root check stops the (stubbed) unprivileged run.
      const res = run(valid, {}, enrolled);
      expect(res.status).toBe(1);
      expect(res.stderr).not.toContain("no enrollment token");
      expect(res.stderr).toContain("run as root");
      const given = run(valid, { EDGEWEIR_TOKEN: TOKEN }, enrolled);
      expect(given.stderr).toContain("the token is not used");
      // enroll() returns without running edgeweir-node; the service is still started.
      const steps = run(
        valid,
        {},
        enrolled.replace(
          /main "\$@"\s*$/,
          'constants\nparse_args "$@"\nread_token\nenroll\necho enroll-skipped\n',
        ),
      );
      expect(steps.status).toBe(0);
      expect(steps.stdout).toContain("enroll-skipped");
      expect(steps.stderr).toContain("run this command with --force");
      // Without identity.json the token is required as before.
      rmSync(join(state, "identity.json"));
      expect(run(valid, {}, enrolled).stderr).toContain("no enrollment token");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("enrolls an enrolled host again with --force and a new token", () => {
    const state = mkdtempSync(join(tmpdir(), "edgeweir-state-"));
    const bin = mkdtempSync(join(tmpdir(), "edgeweir-force-"));
    writeFileSync(join(state, "identity.json"), "{}\n");
    // edgeweir-node and systemctl as stubs that log their calls (never the token).
    writeFileSync(
      join(bin, "edgeweir-node"),
      `#!/bin/sh\necho "edgeweir-node $* token=\${EDGEWEIR_TOKEN:+set}" >> "${calls}"\nexit 0\n`,
    );
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(bin, "edgeweir-node"), 0o755);
    chmodSync(join(bin, "systemctl"), 0o755);
    const enrolled = script
      .replace('STATE_DIR="/var/lib/edgeweir-node"', `STATE_DIR="${state}"`)
      .replaceAll("/usr/bin/edgeweir-node", join(bin, "edgeweir-node"));
    const steps = (args: string[], env: Record<string, string> = {}) =>
      run(
        args,
        { PATH: `${bin}${delimiter}${stubs}${delimiter}/usr/bin${delimiter}/bin`, ...env },
        enrolled.replace(
          /main "\$@"\s*$/,
          'constants\nparse_args "$@"\nread_token\nenroll\necho enrolled\n',
        ),
      );
    try {
      expect(script).toContain("--force              enroll again on an enrolled host");
      // --force needs a token, even though the host has an identity.
      const missing = steps([...valid, "--force"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("no enrollment token");
      expect(missing.calls).toBe("");

      const forced = steps([...valid, "--force"], { EDGEWEIR_TOKEN: TOKEN });
      expect(forced.status).toBe(0);
      expect(forced.stdout).toContain("enrolled");
      // The running node is stopped first; start_service starts it again.
      expect(forced.calls.trim().split("\n")).toEqual([
        "systemctl stop edgeweir-node.service",
        `edgeweir-node enroll --force --server https://console.example.com:8443 --ca-sha256 ${CA} --state-dir ${state} token=set`,
      ]);
      expect(forced.calls).not.toContain(TOKEN);

      // Without --force nothing is enrolled or stopped.
      const kept = steps(valid, { EDGEWEIR_TOKEN: TOKEN });
      expect(kept.status).toBe(0);
      expect(kept.calls).toBe("");
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("restarts a running tar install, which no package script does", () => {
    const ok = mkdtempSync(join(tmpdir(), "edgeweir-systemctl-"));
    writeFileSync(join(ok, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(ok, "systemctl"), 0o755);
    try {
      const start = (format: string) =>
        run(
          [],
          { PATH: `${ok}${delimiter}${stubs}${delimiter}/usr/bin${delimiter}/bin` },
          script.replace(
            /main "\$@"\s*$/,
            `constants\nNO_START=false\nFORMAT=${format}\nstart_service\n`,
          ),
        );
      const tar = start("tar");
      expect(tar.status).toBe(0);
      const lines = tar.calls.trim().split("\n");
      expect(lines.indexOf("systemctl try-restart edgeweir-node.service")).toBeGreaterThan(-1);
      expect(lines.indexOf("systemctl try-restart edgeweir-node.service")).toBeLessThan(
        lines.indexOf("systemctl enable --now edgeweir-node.service"),
      );
      const deb = start("deb");
      expect(deb.status).toBe(0);
      expect(deb.calls).not.toContain("try-restart");
      expect(deb.calls).toContain("systemctl enable --now edgeweir-node.service");
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  });

  it("downloads from GitHub with one note when the mirror lacks the files", () => {
    // curl ... -o DEST URL: the console's mirror answers 404, GitHub serves
    // the file unless $GITHUB_DOWN is set.
    const bin = mkdtempSync(join(tmpdir(), "edgeweir-fetch-"));
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/sh",
        'dest=""',
        'while [ $# -gt 1 ]; do [ "$1" = "-o" ] && dest="$2"; shift; done',
        `echo "curl $1" >> "${calls}"`,
        'case "$1" in https://github.com/*) [ -z "$GITHUB_DOWN" ] && echo ok > "$dest" && exit 0 ;; esac',
        'echo "curl: (22) The requested URL returned error: 404" >&2',
        "exit 22",
      ].join("\n"),
    );
    chmodSync(join(bin, "curl"), 0o755);
    const fetchTwo = (env: Record<string, string>, mirrorOnly = false) =>
      run(
        [],
        { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, ...env },
        script.replace(
          /main "\$@"\s*$/,
          [
            "constants",
            "MIRROR=http://console.test:3000/downloads/edgeweir-node",
            `MIRROR_ONLY=${mirrorOnly}`,
            "VERSION=0.1.0",
            'WORK="$(mktemp -d)"',
            `trap 'rm -rf "$WORK"' EXIT`,
            'fetch "checksums.txt"',
            'fetch "edgeweir-node_0.1.0_amd64.deb"',
            'cat "$WORK/checksums.txt" "$WORK/edgeweir-node_0.1.0_amd64.deb"',
            "",
          ].join("\n"),
        ),
      );
    const mirror = "http://console.test:3000/downloads/edgeweir-node/v0.1.0";
    const github = "https://github.com/marvinli001/edgeweir-node/releases/download/v0.1.0";
    const notFound = "curl: (22) The requested URL returned error: 404";
    try {
      const ok = fetchTwo({});
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toBe("ok\nok\n");
      expect(ok.calls.trim().split("\n")).toEqual([
        `curl ${mirror}/checksums.txt`,
        `curl ${github}/checksums.txt`,
        `curl ${mirror}/edgeweir-node_0.1.0_amd64.deb`,
        `curl ${github}/edgeweir-node_0.1.0_amd64.deb`,
      ]);
      expect(ok.stderr).not.toContain("curl:");
      expect(ok.stderr.match(/no copy at /g)).toHaveLength(1);
      expect(ok.stderr).toContain(`no copy at ${mirror}, downloading from GitHub`);

      // Every source failed: each one's error, then the failure.
      const down = fetchTwo({ GITHUB_DOWN: "1" });
      expect(down.status).toBe(1);
      expect(down.stderr).toContain(`${mirror}/checksums.txt: ${notFound}`);
      expect(down.stderr).toContain(`${github}/checksums.txt: ${notFound}`);
      expect(down.stderr).toContain("failed to download checksums.txt");

      // --mirror-only: neither GitHub nor the note.
      const only = fetchTwo({}, true);
      expect(only.status).toBe(1);
      expect(only.calls.trim().split("\n")).toEqual([`curl ${mirror}/checksums.txt`]);
      expect(only.stderr).not.toContain("no copy at");
      expect(only.stderr).toContain(`${mirror}/checksums.txt: ${notFound}`);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("lets apt's _apt user read the downloaded packages", () => {
    const main = script.slice(script.indexOf("main() {"));
    expect(main).toMatch(
      /\n {2}WORK="\$\(mktemp -d\)"\n {2}trap 'rm -rf "\$WORK"' EXIT\n(?: {2}#.*\n)* {2}chmod 0755 "\$WORK"\n/,
    );
  });

  /** sha256sum with its check mode (coreutils; /sbin/sha256sum on macOS). */
  const sha256sum = spawnSync("sh", ["-c", "command -v sha256sum"], {
    encoding: "utf8",
  }).stdout.trim();

  /**
   * A root shell on a Linux host with systemd and apt, faked in a temporary
   * directory: systemctl, apt-get, cosign and sleep log their calls, curl
   * serves release v0.3.0 from the console's mirror, and `edgeweir-node
   * healthcheck` fails $HEALTH_FAILURES times (-1: always) before it passes.
   * An enrolled host has identity.json in its state directory.
   */
  function fakeHost(enrolled: boolean) {
    const root = mkdtempSync(join(tmpdir(), "edgeweir-host-"));
    const [bin, state, release, systemd] = ["bin", "state", "release", "systemd"].map((dir) =>
      join(root, dir),
    ) as [string, string, string, string];
    for (const dir of [bin, state, release, systemd]) mkdirSync(dir);
    if (enrolled) writeFileSync(join(state, "identity.json"), "{}\n");
    const stub = (name: string, lines: string[]) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${lines.join("\n")}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const logged = (name: string) => `echo "${name} $*" >> "${calls}"`;
    stub("id", ['[ "$1" = "-u" ] && echo 0']);
    stub("uname", ['case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac']);
    stub("getconf", ['echo "glibc 2.36"']);
    stub("getent", ["exit 0"]);
    for (const name of ["dpkg", "apt-get", "systemctl", "cosign", "sleep"])
      stub(name, [logged(name)]);
    // curl ... -o DEST URL
    stub("curl", [
      logged("curl"),
      'dest=""',
      'while [ $# -gt 1 ]; do [ "$1" = "-o" ] && dest="$2"; shift; done',
      `case "$1" in */v0.3.0/*) [ -n "$dest" ] && cp "${release}/\${1##*/}" "$dest" && exit 0 ;; esac`,
      "exit 22",
    ]);
    const healthchecks = join(root, "healthchecks");
    stub("edgeweir-node", [
      logged("edgeweir-node"),
      '[ "$1" = healthcheck ] || exit 0',
      `n=$(($(cat "${healthchecks}" 2>/dev/null || echo 0) + 1))`,
      `echo "$n" > "${healthchecks}"`,
      'if [ "$HEALTH_FAILURES" -lt 0 ] || [ "$n" -le "$HEALTH_FAILURES" ]; then',
      '  echo "unhealthy: data plane has no site table yet" >&2',
      "  exit 1",
      "fi",
      'echo "healthy: revision 7, 2 sites" >&2',
    ]);
    if (sha256sum) symlinkSync(sha256sum, join(bin, "sha256sum"));
    else stub("sha256sum", ["exit 1"]);
    const nginx = join(root, "nginx");
    writeFileSync(nginx, "");
    chmodSync(nginx, 0o755);
    const packages = [
      "edgeweir-node_0.3.0_amd64.deb",
      "edgeweir-openresty_1.31.1.1-1_amd64.deb",
      "edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb",
    ];
    for (const name of packages) writeFileSync(join(release, name), `${name}\n`);
    writeFileSync(
      join(release, "checksums.txt"),
      packages
        .map((name) => `${createHash("sha256").update(`${name}\n`).digest("hex")}  ${name}\n`)
        .join(""),
    );
    writeFileSync(join(release, "checksums.txt.sigstore.json"), "{}\n");
    const input = script
      .replace('STATE_DIR="/var/lib/edgeweir-node"', `STATE_DIR="${state}"`)
      .replace('NGINX_BIN="/usr/lib/edgeweir-openresty/nginx/sbin/nginx"', `NGINX_BIN="${nginx}"`)
      .replace("/run/systemd/system", systemd)
      .replaceAll("/usr/bin/edgeweir-node", join(bin, "edgeweir-node"));
    return {
      input,
      node: join(bin, "edgeweir-node"),
      install(args: string[], env: Record<string, string> = {}, text = input) {
        rmSync(healthchecks, { force: true });
        const res = run(
          args,
          {
            PATH: `${bin}${delimiter}${stubs}${delimiter}/usr/bin${delimiter}/bin`,
            HEALTH_FAILURES: "0",
            ...env,
          },
          text,
        );
        // The script's temporary directory, as $WORK.
        const work = /-o (\S+)\/checksums\.txt /.exec(res.calls)?.[1];
        const log = work ? res.calls.replaceAll(work, "$WORK") : res.calls;
        return { ...res, lines: log.split("\n").filter(Boolean) };
      },
      remove: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  const started = [
    "systemctl daemon-reload",
    "systemctl disable --now openresty.service",
    "systemctl try-restart edgeweir-node.service",
    "systemctl enable --now edgeweir-node.service",
  ];

  it("reports the healthcheck once the started node passes it", () => {
    const main = script.slice(script.indexOf("main() {"));
    expect(main).toMatch(/\n {2}enroll\n {2}start_service\n {2}check_health\n\}/);
    const host = fakeHost(true);
    try {
      const res = host.install(valid, { HEALTH_FAILURES: "2" });
      expect(res.status, res.stderr).toBe(0);
      // Every 3 seconds until it passes.
      const check = "edgeweir-node healthcheck";
      expect(res.lines).toEqual([...started, check, "sleep 3", check, "sleep 3", check]);
      expect(res.stderr).toContain(
        "waiting up to 90s for edgeweir-node to apply its configuration",
      );
      expect(res.stderr).toContain("done: edgeweir-node is healthy (revision 7, 2 sites)");
    } finally {
      host.remove();
    }
  });

  it("exits non-zero with the journal hint when the node stays unhealthy", () => {
    const host = fakeHost(true);
    try {
      const short = host.install(valid, {
        HEALTH_FAILURES: "-1",
        EDGEWEIR_HEALTHCHECK_TIMEOUT: "9",
      });
      expect(short.status).toBe(1);
      expect(short.lines.filter((l) => l === "edgeweir-node healthcheck")).toHaveLength(3);
      expect(short.lines.filter((l) => l === "sleep 3")).toHaveLength(2);
      expect(short.stderr).toContain(
        "error:\u001b[0m edgeweir-node is installed but not healthy after 9s (unhealthy: data plane has no site table yet); see journalctl -u edgeweir-node -n 50",
      );
      expect(short.stderr).not.toContain("done:");
      // 90 seconds by default.
      const full = host.install(valid, { HEALTH_FAILURES: "-1" });
      expect(full.status).toBe(1);
      expect(full.lines.filter((l) => l === "edgeweir-node healthcheck")).toHaveLength(30);
      expect(full.lines.filter((l) => l === "sleep 3")).toHaveLength(29);
      expect(full.stderr).toContain("not healthy after 90s");
    } finally {
      host.remove();
    }
  });

  it("neither starts nor checks the node with --no-start", () => {
    const host = fakeHost(true);
    try {
      const res = host.install([...valid, "--no-start"], { HEALTH_FAILURES: "-1" });
      expect(res.status, res.stderr).toBe(0);
      expect(res.lines).toEqual([]);
      expect(res.stderr).toContain("--no-start given, the service was not started");
      expect(res.stderr).not.toContain("waiting up to");
    } finally {
      host.remove();
    }
  });

  it("only starts and checks an enrolled host unless --version is given", () => {
    const host = fakeHost(true);
    const fresh = fakeHost(false);
    try {
      const res = host.install(valid, { EDGEWEIR_TOKEN: TOKEN });
      expect(res.status, res.stderr).toBe(0);
      // No download (not even of the latest version), no package, no enrollment.
      expect(res.lines).toEqual([...started, "edgeweir-node healthcheck"]);
      expect(res.stderr).toContain("the token is not used");
      expect(res.stderr).toContain("already enrolled: nothing is downloaded or reinstalled");
      expect(res.stderr).toContain("done: edgeweir-node is healthy");

      // Which runs install packages.
      const installs = (args: string[], env: Record<string, string> = {}, text = host.input) =>
        host
          .install(
            args,
            env,
            text.replace(
              /main "\$@"\s*$/,
              'constants\nparse_args "$@"\nread_token\ninstalling && echo install || echo keep\n',
            ),
          )
          .stdout.trim();
      expect(installs(valid)).toBe("keep");
      expect(installs([...valid, "--version", "0.3.0"])).toBe("install");
      expect(installs([...valid, "--force"], { EDGEWEIR_TOKEN: TOKEN })).toBe("install");
      // An enrolled host without edgeweir-node installs the latest version.
      expect(installs(valid, {}, host.input.replaceAll(host.node, `${host.node}-missing`))).toBe(
        "install",
      );
      expect(installs(valid, { EDGEWEIR_TOKEN: TOKEN }, fresh.input)).toBe("install");
    } finally {
      host.remove();
      fresh.remove();
    }
  });

  it.runIf(sha256sum)(
    "installs the --version given on an enrolled host before starting and checking it",
    () => {
      const host = fakeHost(true);
      try {
        const res = host.install([...valid, "--version", "0.3.0"]);
        expect(res.status, res.stderr).toBe(0);
        const mirror = "http://console.test:3000/downloads/edgeweir-node/v0.3.0";
        const fetched = (name: string) =>
          `curl -fsSL --retry 3 --connect-timeout 15 -o $WORK/${name} ${mirror}/${name}`;
        const [node, openresty, modsecurity] = [
          "edgeweir-node_0.3.0_amd64.deb",
          "edgeweir-openresty_1.31.1.1-1_amd64.deb",
          "edgeweir-openresty-modsecurity_1.31.1.1-1_amd64.deb",
        ];
        const installed = [
          fetched("checksums.txt"),
          fetched("checksums.txt.sigstore.json"),
          "cosign verify-blob --bundle $WORK/checksums.txt.sigstore.json --certificate-identity https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v0.3.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com $WORK/checksums.txt",
          fetched(node),
          fetched(openresty),
          fetched(modsecurity),
          `apt-get install -y --no-install-recommends $WORK/${openresty} $WORK/${modsecurity}`,
          `apt-get install -y --no-install-recommends $WORK/${node}`,
        ];
        // The package restarts a running service itself; the identity is kept.
        expect(res.lines).toEqual([
          ...installed,
          ...started.filter((l) => !l.includes("try-restart")),
          "edgeweir-node healthcheck",
        ]);
        expect(res.stderr).toContain("installing edgeweir-node 0.3.0 (deb, amd64)");
        expect(res.stderr).toContain("already enrolled; to enroll again");
        expect(res.stderr).toContain("done: edgeweir-node is healthy");

        // With --no-start the packages are installed, nothing else.
        const quiet = host.install([...valid, "--version", "0.3.0", "--no-start"]);
        expect(quiet.status, quiet.stderr).toBe(0);
        expect(quiet.lines).toEqual(installed);
      } finally {
        host.remove();
      }
    },
  );

  it("checks the node channel before downloading anything, unless already enrolled", () => {
    const main = script.slice(script.indexOf("main() {"));
    const order = ["check_system", "check_server", "resolve_version", 'fetch "checksums.txt"'].map(
      (step) => main.indexOf(step),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(main).toContain("if enrolling; then\n    check_server\n  fi");
    // No token goes to the reachability check.
    const check = script.slice(script.indexOf("check_server() {"));
    expect(check.slice(0, check.indexOf("\n}"))).not.toContain("TOKEN");

    const authority = (server: string) =>
      spawnSync("bash", ["-s"], {
        input: script.replace(/main "\$@"\s*$/, `SERVER='${server}'\nserver_authority\n`),
        encoding: "utf8",
      }).stdout;
    expect(authority("https://console.example.com")).toBe("console.example.com:443\n");
    expect(authority("https://console.example.com:8443/")).toBe("console.example.com:8443\n");
    expect(authority("https://10.0.0.1:8443/x")).toBe("10.0.0.1:8443\n");
    expect(authority("https://[2001:db8::1]")).toBe("[2001:db8::1]:443\n");
    expect(authority("https://[2001:db8::1]:8443")).toBe("[2001:db8::1]:8443\n");
  });

  const hostTools = ["curl", "openssl", "sha256sum", "awk", "timeout"].flatMap((tool) => {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    return found ? [[tool, found] as const] : [];
  });
  const hasTools = ["curl", "openssl", "sha256sum", "awk"].every((tool) =>
    hostTools.some(([name]) => name === tool),
  );

  it.runIf(hasTools)(
    "finds an unreachable node channel and a TLS-terminating proxy in front of it",
    async () => {
      // Only TLS and the 404 for "/" are needed: no database (the certificate names
      // fall back to the environment's).
      const log = createLogger({ test: true });
      const ctx = {
        env: loadEnv({
          NODE_ENV: "test",
          DATABASE_URL: "postgres://unused",
          EDGEWEIR_MASTER_KEY: TEST_MASTER_KEY,
          EDGEWEIR_PUBLIC_URL: "http://console.test:3000",
          HOST: "127.0.0.1",
          NODE_API_PORT: "0",
          LOG_LEVEL: "error",
        }),
        nodeCa: await CertificateAuthority.load(await generateCa("Test CA")),
        events: new ConfigEventBus("postgres://unused", log),
        log,
      } as unknown as AppContext;
      const channel = await startNodeChannel(ctx);
      const tools = mkdtempSync(join(tmpdir(), "edgeweir-check-server-"));
      try {
        const address = channel.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
        const link = (except: string[] = []) => {
          rmSync(tools, { recursive: true, force: true });
          mkdirSync(tools);
          for (const [name, path] of hostTools)
            if (!except.includes(name)) symlinkSync(path, join(tools, name));
        };
        // Asynchronous: the node channel answers from this process's event loop.
        const check = (server: string, ca: string) =>
          new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(bash, ["-s"], { env: { PATH: tools } });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("close", (status) => resolve({ status, stdout, stderr }));
            child.stdin.end(
              script.replace(
                /main "\$@"\s*$/,
                `constants\nSERVER='${server}'\nCA_SHA256='${ca}'\ncheck_server\necho checked\n`,
              ),
            );
          });
        const server = `https://127.0.0.1:${address.port}`;
        const pin = ctx.nodeCa.fingerprintSha256;
        link();

        // The console presents its node CA last: the pin matches.
        const ok = await check(server, pin);
        expect(ok.stderr).toContain("presents the pinned CA");
        expect(ok.stdout).toBe("checked\n");

        // Another CA in front (a proxy or CDN terminating TLS) is refused before any download.
        const proxied = await check(server, "b".repeat(64));
        expect(proxied.status).toBe(1);
        expect(proxied.stderr).toContain("does not present the console's node CA");
        expect(proxied.stderr).toContain("layer-4");

        // Without openssl only reachability is checked.
        link(["openssl"]);
        const plain = await check(server, "b".repeat(64));
        expect(plain.stdout).toBe("checked\n");
        expect(plain.stderr).toContain("openssl not installed");

        // A port nobody listens on.
        const closed = await new Promise<number>((resolve) => {
          const probe = createServer().listen(0, "127.0.0.1", () => {
            const port = (probe.address() as { port: number }).port;
            probe.close(() => resolve(port));
          });
        });
        link();
        const unreachable = await check(`https://127.0.0.1:${closed}`, pin);
        expect(unreachable.status).toBe(1);
        expect(unreachable.stderr).toContain("cannot reach the node channel");
        expect(unreachable.stderr).toContain(`127.0.0.1:${closed}`);
      } finally {
        rmSync(tools, { recursive: true, force: true });
        await channel.close();
      }
    },
    60_000,
  );

  it("executes nothing when the download is cut short", () => {
    const last = script.lastIndexOf('main "$@"');
    for (const cut of [last, last + 3, Math.floor(script.length / 2), 200]) {
      const res = run(valid, { EDGEWEIR_TOKEN: TOKEN }, script.slice(0, cut));
      expect(res.calls, `cut at ${cut}`).toBe("");
      expect(res.stderr, `cut at ${cut}`).not.toContain("[edgeweir]");
    }
  });
});
