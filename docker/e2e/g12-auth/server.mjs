// G12 forward authentication service (scripts/e2e-g12.mjs). Every request
// is counted and its headers kept (GET /_seen answers both):
//   /check  200 with X-Auth-User: alice (and X-Auth-Groups) for the cookie
//           sid=good, else 401 with a Bearer challenge and a JSON body
//   /login  302 to https://login.g12.test/?rd=<X-Original-URI>
//   /slow   answers after 3 s
//   /fail   500
import { createServer } from "node:http";

let calls = 0;
let seen = {};
createServer((req, res) => {
  const url = new URL(req.url, "http://g12-auth");
  if (url.pathname === "/_seen") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ calls, seen }));
    return;
  }
  calls++;
  seen = { method: req.method, uri: req.url, headers: req.headers };
  if (url.pathname === "/check") {
    if (/(?:^|;\s*)sid=good(?:;|$)/.test(req.headers.cookie ?? "")) {
      res.writeHead(200, {
        "x-auth-user": "alice",
        "x-auth-groups": "ops",
        "x-auth-other": "not copied",
      });
      res.end();
      return;
    }
    res.writeHead(401, {
      "www-authenticate": 'Bearer realm="g12"',
      "content-type": "application/json",
    });
    res.end('{"error":"login required"}');
  } else if (url.pathname === "/login") {
    res.writeHead(302, {
      location: `https://login.g12.test/?rd=${req.headers["x-original-uri"] ?? ""}`,
    });
    res.end();
  } else if (url.pathname === "/slow") {
    setTimeout(() => res.writeHead(200).end(), 3000);
  } else {
    res.writeHead(500).end("failing");
  }
}).listen(8080);
