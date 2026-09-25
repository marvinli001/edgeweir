import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

/**
 * The release mirror behind `/downloads/*` (EDGEWEIR_DOWNLOADS_DIR): nodes
 * that reach GitHub slowly fetch the release files from their console
 * instead. It is only a transport: install.sh verifies the cosign signature
 * and SHA-256 of everything it downloads, whatever the source.
 *
 * Layout, per project (edgeweir-node, and cosign for install.sh):
 *
 *   <dir>/<project>/latest               the latest version, e.g. "0.2.0"
 *   <dir>/<project>/v<semver>/<file>     release files of that version
 *
 * Anything else, and anything not on disk, is 404, never the SPA shell.
 */
export const MIRRORED_PROJECTS = ["edgeweir-node", "cosign"] as const;

const SEMVER =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

/** The mirrored file a request path names, or null (without touching the disk). */
export function mirrorPath(pathname: string): string[] | null {
  if (!pathname.startsWith("/downloads/")) return null;
  let segments: string[];
  try {
    segments = pathname.slice("/downloads/".length).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  const [project, version, file, ...rest] = segments;
  if (!project || !(MIRRORED_PROJECTS as readonly string[]).includes(project)) return null;
  if (version === "latest" && file === undefined) return [project, "latest"];
  if (!version || !SEMVER.test(version) || !file || !FILE.test(file) || rest.length) return null;
  return [project, version, file];
}

function contentType(file: string): string {
  if (file === "latest" || file.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** Serves a mirrored release file, or answers 404. */
export async function serveDownload(dir: string | undefined, request: Request): Promise<Response> {
  const notFound = () =>
    new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!dir) return notFound();
  const segments = mirrorPath(new URL(request.url).pathname);
  if (!segments) return notFound();
  let path: string;
  let size: number;
  try {
    const root = await realpath(resolve(dir));
    // Symlinks may not lead out of the mirror.
    path = await realpath(join(root, ...segments));
    if (!path.startsWith(root + sep)) return notFound();
    const info = await stat(path);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }
  const file = segments.at(-1) ?? "";
  const headers = {
    "content-type": contentType(file),
    "content-length": String(size),
    // `latest` moves; released files never change.
    "cache-control": file === "latest" ? "no-cache" : "public, max-age=86400, immutable",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}
