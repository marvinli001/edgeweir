// Build real Linux release archives and sign only the local fixtures. Private keys
// stay in ignored .e2e/upgrade-keys; nodes receive only the public key.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const run = async (command, args, options = {}) =>
  (await execute(command, args, { maxBuffer: 4 * 1024 * 1024, ...options })).stdout;
const repo = resolve(process.env.EDGEWEIR_NODE_CONTEXT ?? "../edgeweir-node"),
  root = resolve(".e2e/upgrade-releases"),
  keys = resolve(".e2e/upgrade-keys");
await mkdir(root, { recursive: true });
await mkdir(keys, { recursive: true, mode: 0o700 });
const config = JSON.parse(
  await run("docker", [
    "compose",
    "-f",
    "compose.e2e.yml",
    "--profile",
    "upgrades",
    "config",
    "--format",
    "json",
  ]),
);
const nodeImage = config.services.node.image;
const architecture = (
  await run("docker", ["run", "--rm", "--entrypoint", "uname", nodeImage, "-m"])
).trim();
const arch = architecture === "aarch64" ? "arm64" : architecture === "x86_64" ? "amd64" : null;
assert.ok(arch);
const env = { ...process.env, COSIGN_PASSWORD: "" };
for (const key of ["release", "wrong"]) {
  try {
    await readFile(`${keys}/${key}.key`);
  } catch {
    await run("cosign", ["generate-key-pair", "--output-key-prefix", `${keys}/${key}`], { env });
  }
}
const versions = { good: "0.0.2-m6", signature: "0.0.3-m6", broken: "0.0.4-m6", ui: "0.0.5-m6" };
for (const [kind, version] of Object.entries(versions)) {
  const folder = `edgeweir-node_${version}_linux_${arch}`,
    stage = resolve(".e2e/upgrade-stage", folder),
    dest = resolve(root, "releases", `v${version}`);
  await mkdir(stage, { recursive: true });
  await mkdir(dest, { recursive: true });
  const binary = resolve(stage, "edgeweir-node");
  const buildEnv = { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch };
  if (kind === "broken") {
    const source = resolve(".e2e/upgrade-stage/broken.go");
    await writeFile(
      source,
      `package main\nimport("fmt";"os")\nfunc main(){if len(os.Args)>1 && os.Args[1]=="version" {fmt.Println("edgeweir-node ${version} (deliberately broken test fixture)");return};os.Exit(42)}\n`,
    );
    await run("go", ["build", "-trimpath", "-o", binary, source], { env: buildEnv });
  } else {
    await run(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        `-s -w -X github.com/marvinli001/edgeweir-node/internal/version.Version=${version}`,
        "-o",
        binary,
        "./cmd/edgeweir-node",
      ],
      { cwd: repo, env: buildEnv },
    );
  }
  await cp(resolve(repo, "lua"), resolve(stage, "lua"), { recursive: true });
  const archive = resolve(dest, `${folder}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", resolve(stage, ".."), folder], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const sha = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(resolve(dest, "checksums.txt"), `${sha}  ${folder}.tar.gz\n`);
  await run(
    "cosign",
    [
      "sign-blob",
      "--yes",
      "--use-signing-config=false",
      "--key",
      `${keys}/${kind === "signature" ? "wrong" : "release"}.key`,
      "--bundle",
      resolve(dest, "checksums.txt.sigstore.json"),
      resolve(dest, "checksums.txt"),
    ],
    { env },
  );
}
const volumes = config.volumes;
// docker cp copies to our dedicated volumes through a throwaway fixture helper.
const helper = `${config.name}-upgrade-fixture-copy`;
await run("docker", [
  "run",
  "-d",
  "--name",
  helper,
  "--user",
  "0",
  "--entrypoint",
  "sh",
  "-v",
  `${volumes["upgrade-releases"].name}:/releases`,
  "-v",
  `${volumes["upgrade-trust"].name}:/trust`,
  nodeImage,
  "-c",
  "sleep 300",
]);
try {
  await run("docker", ["cp", `${root}/.`, `${helper}:/releases/`]);
  await run("docker", ["cp", `${keys}/release.pub`, `${helper}:/trust/release.pub`]);
  await run("docker", [
    "exec",
    helper,
    "sh",
    "-c",
    "chmod -R a+rX /releases; chmod 644 /trust/release.pub",
  ]);
} finally {
  await run("docker", ["rm", "-f", helper]);
}
await writeFile(".e2e/upgrade-fixtures.json", JSON.stringify({ versions, arch }, null, 2) + "\n");
console.log(
  `UPGRADE FIXTURES OK: ${arch}, valid/wrong-key/broken-startup/UI releases; private keys kept local`,
);
