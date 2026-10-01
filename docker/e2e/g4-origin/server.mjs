// G4 test origin (scripts/e2e-g4.mjs): two instances, g4-origin-a and
// g4-origin-b (the name is the first argument), that tell which one
// answered, count what they served and can be broken and repaired from the
// e2e network:
//   GET  /health                  status set by POST /control/health {status}
//   POST /control/down {down}     while down, every other request is reset
//   GET  /control/hits            requests served: "<host> <path> <d|m>" -> count
//   POST /control/reset           forgets the counters
//   ?tags=<value> on any path     Cache-Tag: <value> (as given)
//   /tag/<name>                   a tagged page (the tags also in the body)
//   /page/<name>                  a page (prefetch and sitemaps)
//   /sitemap.xml                  urlset: /page/1../page/7 of the request host
//                                 and two pages of another host
//   /sitemap-index.xml            sitemapindex: /sitemap-a.xml,
//                                 /sitemap-b.xml.gz (gzip) and a sitemap of
//                                 another host
//   /status/<code>                that status with the origin's own body
//   /slow?ms=<n>                  answers after n ms
//   /big?tags=<value>             3 MiB with Range support (counted per Range)
// Every body is JSON with the origin name and a per-origin version number,
// so a response from the cache is told apart from a new one.
import http from "node:http";
import { gzipSync } from "node:zlib";

const NAME = process.argv[2] ?? "origin";
const MOBILE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Opera Mini|webOS/;
let version = 0;
let health = 200;
let down = false;
let hits = new Map();

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
const urlset = (urls) =>
  xml(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${u}</loc><changefreq>daily</changefreq></url>`)
      .join("\n")}\n</urlset>`,
  );
const sitemapindex = (urls) =>
  xml(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <sitemap><loc>${u}</loc></sitemap>`)
      .join("\n")}\n</sitemapindex>`,
  );

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://origin");
  const path = url.pathname;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const tags = url.searchParams.get("tags");
  const tagged = tags === null ? {} : { "cache-tag": tags };
  const json = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...tagged, ...headers });
    res.end(`${JSON.stringify(data)}\n`);
  };
  if (path.startsWith("/control/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (path === "/control/health" && req.method === "POST") health = Number(body.status) || 200;
    else if (path === "/control/down" && req.method === "POST") down = !!body.down;
    else if (path === "/control/reset" && req.method === "POST") hits = new Map();
    else if (path !== "/control/hits") return json(404, { error: "not found" });
    return json(200, { origin: NAME, health, down, hits: Object.fromEntries(hits) });
  }
  if (path === "/health") return json(health, { origin: NAME, health });
  if (down) {
    req.socket.destroy();
    return;
  }
  const device = MOBILE.test(req.headers["user-agent"] ?? "") ? "m" : "d";
  const range = path === "/big" ? (req.headers.range ?? "full") : "";
  const key = range ? `${host} ${path} ${range}` : `${host} ${path} ${device}`;
  hits.set(key, (hits.get(key) ?? 0) + 1);
  version += 1;
  const page = {
    origin: NAME,
    host,
    path,
    version,
    device,
    requestId: req.headers["x-request-id"] ?? "",
  };
  if (path.startsWith("/tag/")) return json(200, { ...page, tags });
  if (path.startsWith("/page/")) return json(200, page);
  if (path === "/sitemap.xml") {
    const urls = [1, 2, 3, 4, 5, 6, 7].map((n) => `http://${host}/page/${n}`);
    urls.splice(2, 0, "http://elsewhere.g4.test/page/x", `ftp://${host}/page/ftp`);
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(urlset(urls));
  }
  if (path === "/sitemap-index.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(
      sitemapindex([
        `http://${host}/sitemap-a.xml`,
        "http://elsewhere.g4.test/sitemap.xml",
        `http://${host}/sitemap-b.xml.gz`,
      ]),
    );
  }
  if (path === "/sitemap-a.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(urlset([`http://${host}/page/a1`, `http://${host}/page/a2`]));
  }
  if (path === "/sitemap-b.xml.gz") {
    res.writeHead(200, { "content-type": "application/gzip" });
    return res.end(
      gzipSync(
        urlset([`http://${host}/page/b1`, `http://${host}/page/b2`, `http://${host}/page/b3`]),
      ),
    );
  }
  if (path === "/big") {
    // 3 MiB with Range support (sliced caching), tagged by ?tags=.
    const size = 3 * 1024 * 1024;
    const headers = {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      ...tagged,
    };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    const body = Buffer.alloc(end - start + 1);
    for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
    if (m) {
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}` });
    } else res.writeHead(200, headers);
    return res.end(body);
  }
  const status = /^\/status\/([1-5]\d\d)$/.exec(path);
  if (status) {
    res.writeHead(Number(status[1]), { "content-type": "text/plain" });
    return res.end(`origin ${status[1]} page from ${NAME}\n`);
  }
  if (path === "/slow") {
    await new Promise((r) => setTimeout(r, Number(url.searchParams.get("ms") ?? 1000)));
    return json(200, page);
  }
  return json(200, page);
});
server.keepAliveTimeout = 65_000;
server.listen(8080, "0.0.0.0");
