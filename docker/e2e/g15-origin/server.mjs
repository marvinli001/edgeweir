// Site parity G15 test origin (scripts/e2e-g15.mjs): `node server.mjs <name>`
// on :8080.
//   /account/...   Set-Cookie: sid=<name>-<n> (n counts these responses) and
//                  a second line with a comma; text/plain
//   /status/<code> that status with a short text body
//   /text/<n>      n bytes of "a", text/plain (compression)
//   /img           a few bytes as image/png (no charset added)
//   /fail-a        502 on origin "a", 200 on the others (retries)
//   /powered/...   X-Powered-By, X-Frame-Options and Access-Control-* headers
//                  the edge removes or replaces (G13)
//   POST /upload/..., POST /form   "received <bytes> bytes"
//   anything else  "<name> <method> <path>", text/plain; charset=utf-8
import http from "node:http";

const name = process.argv[2] ?? "a";
let accounts = 0;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://origin");
    const path = url.pathname;
    res.setHeader("x-origin", name);
    if (req.method === "POST" && (path.startsWith("/upload/") || path === "/form")) {
      let bytes = 0;
      req.on("data", (chunk) => (bytes += chunk.length));
      req.on("end", () => {
        res.setHeader("content-type", "text/plain");
        res.end(`received ${bytes} bytes\n`);
      });
      return;
    }
    if (path.startsWith("/account/")) {
      accounts += 1;
      res.setHeader("set-cookie", [
        `sid=${name}-${accounts}; Path=/; HttpOnly`,
        "pref=a,b; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      ]);
      res.setHeader("content-type", "text/plain");
      res.end(`account ${name}-${accounts}\n`);
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(path);
    if (status) {
      res.statusCode = Number(status[1]);
      res.setHeader("content-type", "text/plain");
      res.end(`origin status ${status[1]}\n`);
      return;
    }
    const text = /^\/text\/(\d+)$/.exec(path);
    if (text) {
      res.setHeader("content-type", "text/plain");
      res.end("a".repeat(Math.min(Number(text[1]), 1 << 20)));
      return;
    }
    if (path === "/img") {
      res.setHeader("content-type", "image/png");
      res.end("png");
      return;
    }
    // G13 (scripts/e2e-g13.mjs): headers the edge removes or replaces.
    if (path.startsWith("/powered/")) {
      res.setHeader("x-powered-by", "Express");
      res.setHeader("x-frame-options", "ALLOWALL");
      res.setHeader("access-control-allow-origin", "https://origin-set.example");
      res.setHeader("access-control-allow-methods", "TRACE");
      res.setHeader("content-type", "text/plain");
      res.end(`${name} powered\n`);
      return;
    }
    if (path === "/fail-a" && name === "a") {
      res.statusCode = 502;
      res.end("a fails\n");
      return;
    }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`${name} ${req.method} ${path}\n`);
  })
  .listen(8080);
