// Serves the static export the way GitHub Pages does: under DOCS_BASE_PATH,
// directories resolve to index.html, unknown paths get 404.html.
//   DOCS_BASE_PATH=/edgeweir pnpm build && DOCS_BASE_PATH=/edgeweir pnpm preview
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../out");
const base = process.env.DOCS_BASE_PATH ?? "";
const port = Number(process.env.PORT ?? 4100);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function file(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat?.isFile()) return path;
  if (stat?.isDirectory()) return file(join(path, "index.html"));
  return undefined;
}

createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!url.startsWith(`${base}/`) && url !== base) {
    res.writeHead(302, { location: `${base}/` }).end();
    return;
  }
  const path = normalize(join(root, url.slice(base.length)));
  const found = path.startsWith(root) ? (file(path) ?? file(`${path}.html`)) : undefined;
  const status = found ? 200 : 404;
  const target = found ?? join(root, "404.html");
  res.writeHead(status, { "content-type": types[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}).listen(port, () => console.log(`docs preview: http://localhost:${port}${base}/`));
