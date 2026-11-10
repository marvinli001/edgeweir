// Build products the e2e run keeps per commit outside Docker, so a new VM or
// a pruned build cache loads them instead of compiling again. The cache is
// $E2E_CACHE_DIR (default ~/.cache/edgeweir-e2e):
//   images/edgeweir-node-<commit>-<arch>.tar.gz   old node images (pre-g3,
//     pre-g8): docker save of the image built from that edgeweir-node commit
//   openresty/<tree>-<arch>/               the edgeweir-openresty packages of
//     `make openresty-packages`, by the git tree of packaging/openresty
//   dist/<commit>-goreleaser-<version>-<arch>/   the goreleaser snapshot
//     (dist/) of a clean edgeweir-node commit with those packages
// scripts/e2e-fixtures.sh fills it; CI keeps it between runs (fixtures job).
//
//   node scripts/e2e-cache.mjs image IMAGE COMMIT [NODE_CONTEXT]
//     IMAGE built from COMMIT in Docker: kept, loaded from the cache or
//     built and cached (scripts/e2e-g3.mjs and e2e-g8.mjs do the same)
//   node scripts/e2e-cache.mjs openresty restore|save NODE_CONTEXT ARCH FILE...
//     restore copies cached FILEs into NODE_CONTEXT/out/openresty (exit 1
//     when they are not cached), save keeps them (scripts/e2e.sh after
//     `make openresty-packages`); both only for a clean packaging/openresty
//   node scripts/e2e-cache.mjs dist restore|save NODE_CONTEXT ARCH GORELEASER_VERSION
//     the same for NODE_CONTEXT/dist, only for a clean edgeweir-node checkout
//   node scripts/e2e-cache.mjs images NODE_CONTEXT
//     OLD_NODE_IMAGES built and cached unless they are cached already
//   node scripts/e2e-cache.mjs prune NODE_CONTEXT ARCH GORELEASER_VERSION
//     drops every cached build the current checkout does not use
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./e2e-lib.mjs";

const CACHE = process.env.E2E_CACHE_DIR || join(homedir(), ".cache", "edgeweir-e2e");
const COMMIT_LABEL = "dev.edgeweir.e2e.node-commit";
/** Old edge nodes of scripts/e2e-g3.mjs and e2e-g8.mjs: the image and the edgeweir-node commit it is built from. */
export const OLD_NODE_IMAGES = {
  // Last commit before G3 (proto v0.10.1): no brotli-v1, zstd-v1 or modsecurity-v1.
  preG3: { image: "edgeweir-node:pre-g3", commit: "6da3403" },
  // Last commit before G8 (proto v0.21.0): rules-v2 but no rules-v3.
  preG8: { image: "edgeweir-node:pre-g8", commit: "7e1338f" },
};

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const git = async (context, ...args) =>
  (await execute("git", ["-C", context, ...args])).stdout.trim();
const sh = (script, ...args) =>
  execute("sh", ["-c", script, "sh", ...args], { maxBuffer: 16 * 1024 * 1024 });
const dockerArch = async () =>
  (await execute("docker", ["version", "--format", "{{.Server.Arch}}"])).stdout.trim();

/** The commit an image was built from (COMMIT_LABEL), or null when it is missing or unlabelled. */
async function imageCommit(image) {
  try {
    const { stdout } = await execute("docker", [
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${COMMIT_LABEL}"}}`,
      image,
    ]);
    return stdout.trim() || "unlabelled";
  } catch {
    return null;
  }
}

/**
 * `image` built from archived edgeweir-node `commit` with refreshed download
 * transport: an image with that commit's label is kept, one from the cache
 * loaded, otherwise built and saved to the cache. An existing image without
 * the label (built before the cache) is kept too. Returns what it did.
 */
const imageFile = (sha, arch) =>
  join(CACHE, "images", `edgeweir-node-${sha.slice(0, 12)}-${arch}.tar.gz`);
// The archive's own tag, so that loading it never moves a tag in use.
const cacheTag = (sha) => `edgeweir-e2e-cache/edgeweir-node:${sha.slice(0, 12)}`;
const commitOf = (nodeContext, commit) =>
  git(nodeContext, "rev-parse", "--verify", `${commit}^{commit}`);

/** docker save of `image` (built from `sha`) into the cache. */
async function saveImage(image, sha, file) {
  await mkdir(join(CACHE, "images"), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  try {
    await execute("docker", ["tag", image, cacheTag(sha)]);
    await sh(
      'set -o pipefail 2>/dev/null; docker save "$1" | gzip -1 >"$2"',
      cacheTag(sha),
      partial,
    );
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
    await execute("docker", ["rmi", cacheTag(sha)]).catch(() => {});
  }
}

export async function ensureNodeImage(image, commit, nodeContext) {
  const sha = await commitOf(nodeContext, commit);
  const present = await imageCommit(image);
  if (present === sha || present === "unlabelled") return "present";
  const arch = await dockerArch();
  const file = imageFile(sha, arch);
  if (await exists(file)) {
    const { stdout } = await sh('gzip -dc "$1" | docker load', file);
    if (stdout.includes(`Loaded image: ${cacheTag(sha)}`)) {
      await execute("docker", ["tag", cacheTag(sha), image]);
      await execute("docker", ["rmi", cacheTag(sha)]);
    }
    if ((await imageCommit(image)) === sha) return `loaded from ${file}`;
  }
  const context = await mkdtemp(join(tmpdir(), "edgeweir-e2e-node-"));
  try {
    await sh('git -C "$1" archive "$2" | tar -x -C "$3"', nodeContext, sha, context);
    // Refresh download transport only; legacy code, source locks and signing keys stay pinned.
    const fetchScript = join(context, "packaging/openresty/fetch.sh");
    if (await exists(fetchScript))
      await copyFile(join(nodeContext, "packaging/openresty/fetch.sh"), fetchScript);
    const dockerfile = join(context, "Dockerfile");
    await writeFile(
      dockerfile,
      (await readFile(dockerfile, "utf8")).replace(
        `wget -q -O /cosign "https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-\${TARGETARCH}"`,
        `case "$TARGETARCH" in amd64) asset=503286005 ;; arm64) asset=503286299 ;; *) exit 1 ;; esac; wget -q --header='Accept: application/octet-stream' -O /cosign "https://api.github.com/repos/sigstore/cosign/releases/assets/$asset"`,
      ),
    );
    await execute(
      "docker",
      ["build", "-q", "--label", `${COMMIT_LABEL}=${sha}`, "-t", image, context],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  await saveImage(image, sha, file);
  return `built from ${sha.slice(0, 12)}, cached in ${file}`;
}

/** Every OLD_NODE_IMAGES archive in the cache: kept when cached, otherwise built (or saved) and cached. */
export async function cacheNodeImages(nodeContext) {
  const arch = await dockerArch();
  const done = [];
  for (const { image, commit } of Object.values(OLD_NODE_IMAGES)) {
    const sha = await commitOf(nodeContext, commit);
    const file = imageFile(sha, arch);
    if (await exists(file)) {
      done.push(`${image}: cached in ${file}`);
      continue;
    }
    const result = await ensureNodeImage(image, commit, nodeContext);
    if (!(await exists(file))) await saveImage(image, sha, file);
    done.push(`${image}: ${result}, cached in ${file}`);
  }
  return done;
}

/** The cache directory of the OpenResty packages for `nodeContext`, or null for a modified tree. */
async function openrestyDir(nodeContext, arch) {
  const dirty = await git(nodeContext, "status", "--porcelain", "--", "packaging/openresty");
  if (dirty) return null;
  const tree = await git(nodeContext, "rev-parse", "HEAD:packaging/openresty");
  return join(CACHE, "openresty", `${tree.slice(0, 12)}-${arch}`);
}

export async function openrestyRestore(nodeContext, arch, files) {
  const dir = await openrestyDir(nodeContext, arch);
  if (!dir) return false;
  for (const file of files) if (!(await exists(join(dir, file)))) return false;
  const out = join(nodeContext, "out", "openresty");
  await mkdir(out, { recursive: true });
  for (const file of files) await copyFile(join(dir, file), join(out, file));
  return dir;
}

export async function openrestySave(nodeContext, arch, files) {
  const dir = await openrestyDir(nodeContext, arch);
  if (!dir) return false;
  const partial = `${dir}.${process.pid}.partial`;
  await mkdir(partial, { recursive: true });
  try {
    for (const file of files)
      await copyFile(join(nodeContext, "out", "openresty", file), join(partial, file));
    await rm(dir, { recursive: true, force: true });
    await rename(partial, dir);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  return dir;
}

/** The cache directory of the goreleaser snapshot of `nodeContext`, or null for a modified checkout. */
async function distDir(nodeContext, arch, goreleaser) {
  if (!/^v?[0-9][0-9A-Za-z.+-]*$/.test(goreleaser))
    throw new Error(`bad goreleaser version: ${goreleaser}`);
  if (await git(nodeContext, "status", "--porcelain")) return null;
  const commit = await git(nodeContext, "rev-parse", "HEAD");
  return join(
    CACHE,
    "dist",
    `${commit.slice(0, 12)}-goreleaser-${goreleaser.replace(/^v/, "")}-${arch}`,
  );
}

export async function distRestore(nodeContext, arch, goreleaser) {
  const dir = await distDir(nodeContext, arch, goreleaser);
  if (!dir || !(await exists(join(dir, "metadata.json")))) return false;
  const dist = join(nodeContext, "dist");
  await rm(dist, { recursive: true, force: true });
  await cp(dir, dist, { recursive: true, preserveTimestamps: true });
  return dir;
}

export async function distSave(nodeContext, arch, goreleaser) {
  const dir = await distDir(nodeContext, arch, goreleaser);
  if (!dir) return false;
  const partial = `${dir}.${process.pid}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(CACHE, "dist"), { recursive: true });
  try {
    await cp(join(nodeContext, "dist"), partial, { recursive: true, preserveTimestamps: true });
    await rm(dir, { recursive: true, force: true });
    await rename(partial, dir);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  return dir;
}

/** Removes every cached build that the clean checkout `nodeContext` does not use; returns what it removed. */
export async function prune(nodeContext, arch, goreleaser) {
  const keep = new Set();
  for (const { commit } of Object.values(OLD_NODE_IMAGES))
    keep.add(imageFile(await commitOf(nodeContext, commit), arch));
  const openresty = await openrestyDir(nodeContext, arch);
  const dist = await distDir(nodeContext, arch, goreleaser);
  if (!openresty || !dist)
    throw new Error(`${nodeContext} has uncommitted changes; nothing pruned`);
  keep.add(openresty);
  keep.add(dist);
  const removed = [];
  for (const kind of ["images", "openresty", "dist"]) {
    const entries = await readdir(join(CACHE, kind)).catch(() => []);
    for (const entry of entries) {
      const path = join(CACHE, kind, entry);
      if (keep.has(path)) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "image" && args.length >= 2) {
    console.log(
      `${args[0]}: ${await ensureNodeImage(args[0], args[1], args[2] ?? "../edgeweir-node")}`,
    );
  } else if (command === "openresty" && ["restore", "save"].includes(args[0]) && args.length >= 4) {
    const [action, context, arch, ...files] = args;
    const dir = await (action === "restore" ? openrestyRestore : openrestySave)(
      context,
      arch,
      files,
    );
    if (!dir) process.exit(1);
    console.log(`${action === "restore" ? "restored from" : "saved to"} ${dir}`);
  } else if (command === "dist" && ["restore", "save"].includes(args[0]) && args.length === 4) {
    const [action, context, arch, goreleaser] = args;
    const dir = await (action === "restore" ? distRestore : distSave)(context, arch, goreleaser);
    if (!dir) process.exit(1);
    console.log(`${action === "restore" ? "restored from" : "saved to"} ${dir}`);
  } else if (command === "images" && args.length === 1) {
    for (const line of await cacheNodeImages(args[0])) console.log(line);
  } else if (command === "prune" && args.length === 3) {
    const removed = await prune(...args);
    console.log(removed.length ? `pruned ${removed.join(" ")}` : "nothing to prune");
  } else {
    console.error(
      "usage: e2e-cache.mjs image IMAGE COMMIT [NODE_CONTEXT] | openresty restore|save NODE_CONTEXT ARCH FILE... | dist restore|save NODE_CONTEXT ARCH GORELEASER_VERSION | images NODE_CONTEXT | prune NODE_CONTEXT ARCH GORELEASER_VERSION",
    );
    process.exit(2);
  }
}
