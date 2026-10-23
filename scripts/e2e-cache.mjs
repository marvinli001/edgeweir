// Build products the e2e run keeps per commit outside Docker, so a new VM or
// a pruned build cache loads them instead of compiling again. The cache is
// $E2E_CACHE_DIR (default ~/.cache/edgeweir-e2e):
//   images/edgeweir-node-<commit>-<arch>.tar.gz   old node images (pre-g3,
//     pre-g8): docker save of the image built from that edgeweir-node commit
//   openresty/<tree>-<arch>/               the edgeweir-openresty packages of
//     `make openresty-packages`, by the git tree of packaging/openresty
//
//   node scripts/e2e-cache.mjs image IMAGE COMMIT [NODE_CONTEXT]
//     IMAGE built from COMMIT in Docker: kept, loaded from the cache or
//     built and cached (scripts/e2e-g3.mjs and e2e-g8.mjs do the same)
//   node scripts/e2e-cache.mjs openresty restore|save NODE_CONTEXT ARCH FILE...
//     restore copies cached FILEs into NODE_CONTEXT/out/openresty (exit 1
//     when they are not cached), save keeps them (scripts/e2e.sh after
//     `make openresty-packages`); both only for a clean packaging/openresty
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./e2e-lib.mjs";

const CACHE = process.env.E2E_CACHE_DIR || join(homedir(), ".cache", "edgeweir-e2e");
const COMMIT_LABEL = "dev.edgeweir.e2e.node-commit";

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
 * `image` built from edgeweir-node `commit` (git archive | docker build) in
 * Docker: an image with that commit's label is kept, one from the cache
 * loaded, otherwise built and saved to the cache. An existing image without
 * the label (built before the cache) is kept too. Returns what it did.
 */
export async function ensureNodeImage(image, commit, nodeContext) {
  const sha = await git(nodeContext, "rev-parse", "--verify", `${commit}^{commit}`);
  const present = await imageCommit(image);
  if (present === sha || present === "unlabelled") return "present";
  const arch = await dockerArch();
  const file = join(CACHE, "images", `edgeweir-node-${sha.slice(0, 12)}-${arch}.tar.gz`);
  // The archive's own tag, so that loading it never moves a tag in use.
  const cacheTag = `edgeweir-e2e-cache/edgeweir-node:${sha.slice(0, 12)}`;
  if (await exists(file)) {
    const { stdout } = await sh('gzip -dc "$1" | docker load', file);
    if (stdout.includes(`Loaded image: ${cacheTag}`)) {
      await execute("docker", ["tag", cacheTag, image]);
      await execute("docker", ["rmi", cacheTag]);
    }
    if ((await imageCommit(image)) === sha) return `loaded from ${file}`;
  }
  await sh(
    'git -C "$1" archive "$2" | docker build -q --label "$3" -t "$4" -',
    nodeContext,
    sha,
    `${COMMIT_LABEL}=${sha}`,
    image,
  );
  await mkdir(join(CACHE, "images"), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  try {
    await execute("docker", ["tag", image, cacheTag]);
    await sh('set -o pipefail 2>/dev/null; docker save "$1" | gzip -1 >"$2"', cacheTag, partial);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
    await execute("docker", ["rmi", cacheTag]).catch(() => {});
  }
  return `built from ${sha.slice(0, 12)}, cached in ${file}`;
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
  } else {
    console.error(
      "usage: e2e-cache.mjs image IMAGE COMMIT [NODE_CONTEXT] | openresty restore|save NODE_CONTEXT ARCH FILE...",
    );
    process.exit(2);
  }
}
