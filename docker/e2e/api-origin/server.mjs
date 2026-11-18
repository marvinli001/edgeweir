import { createHash } from "node:crypto";
import { createServer } from "node:http";

const counts = new Map();
createServer((req, res) => {
  const url = new URL(req.url, "http://api-origin");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/_seen") {
    res.end(JSON.stringify({ count: counts.get(url.searchParams.get("probe")) ?? 0 }));
    return;
  }
  const probe = String(req.headers["x-api-probe"] ?? "").slice(0, 100);
  if (probe && counts.size < 1000) counts.set(probe, (counts.get(probe) ?? 0) + 1);
  const digest = createHash("sha256")
    .update(req.headers.authorization ?? "")
    .digest("hex");
  req.resume();
  req.on("end", () => {
    res.setHeader("cache-control", "public, max-age=3600");
    res.end(JSON.stringify({ origin: "api-origin", probe, credentialDigest: digest }));
  });
}).listen(8080);
