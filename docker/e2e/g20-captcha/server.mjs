// G20 mock CAPTCHA provider (scripts/e2e-g20.mjs): Cloudflare Turnstile's
// siteverify, which the nodes of the default cluster ask instead of
// Cloudflare (EDGEWEIR_CHALLENGE_VERIFY_ENDPOINTS in compose.e2e.yml).
//   POST /siteverify  form secret, response, remoteip -> JSON
//                     {success, hostname, error-codes}:
//                     another secret      invalid-input-secret
//                     response good       success on HOSTNAME
//                     response other-host success on another host name
//                     anything else       invalid-input-response
//   POST /_mode       {mode: "ok" | "500"}: "500" answers every siteverify
//                     with 500 until "ok"
//   GET  /_seen       {calls, last}: siteverify requests answered and the
//                     last one's form and content type
//   GET  /health      200
import { createServer } from "node:http";

const SECRET = "fake-turnstile-secret-e2e";
/** The site's host name (scripts/e2e-g20.mjs HOST_PROVIDER). */
const HOSTNAME = "provider.g20.test";

let mode = "ok";
let calls = 0;
let last = null;
createServer(async (req, res) => {
  const respond = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, "http://g20-captcha");
  if (req.method === "GET" && url.pathname === "/health") return respond(200, { ok: true });
  if (req.method === "GET" && url.pathname === "/_seen") return respond(200, { calls, last });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (req.method === "POST" && url.pathname === "/_mode") {
    const next = JSON.parse(raw || "{}").mode;
    if (next !== "ok" && next !== "500") return respond(400, { error: "mode is ok or 500" });
    mode = next;
    return respond(200, { mode });
  }
  if (req.method === "POST" && url.pathname === "/siteverify") {
    calls++;
    const form = Object.fromEntries(new URLSearchParams(raw));
    last = { form, contentType: req.headers["content-type"] ?? "" };
    if (mode === "500") return respond(500, { error: "failing" });
    if (form.secret !== SECRET)
      return respond(200, { success: false, "error-codes": ["invalid-input-secret"] });
    if (form.response === "good")
      return respond(200, { success: true, hostname: HOSTNAME, "error-codes": [] });
    if (form.response === "other-host")
      return respond(200, { success: true, hostname: "elsewhere.g20.test", "error-codes": [] });
    return respond(200, { success: false, "error-codes": ["invalid-input-response"] });
  }
  return respond(404, { error: "not found" });
}).listen(8080);
