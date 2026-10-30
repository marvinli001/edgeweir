// AI crawl control (ADR-0070) end to end, after the core section: the core
// node (`node`, published on E2E_NODE_PORT) serves the default cluster and
// the whoami origin answers every path, /robots.txt included, with a
// text/plain dump of the request. Requests go from the host, so the node
// sees a Docker gateway address: no crawler's published range holds it.
//   a. the node reports ai-crawlers-v1; detection is on and the catalogue
//      reaches the node without a site policy
//   b. a spoofed GPTBot (GPTBot's User-Agent from the gateway address) is
//      only tagged: 200 from the origin
//   c. the site blocks GPTBot, charges ClaudeBot USD 0.01 and manages
//      robots.txt (ai-train=no): GPTBot gets the 403 page
//      (X-Edgeweir-Error: ai-crawler-blocked); a browser and other crawlers
//      reach the origin; /robots.txt stays readable for GPTBot and starts
//      with the managed text, then the origin's file; ClaudeBot without a
//      price gets 402 with crawler-price, with crawler-max-price 400
//      StrongAuthRequired (it cannot be verified); /robots.txt is free
//   d. impersonators blocked with a 402 and a text: the spoofed
//      PerplexityBot (verified by published ranges only, the gateway address
//      is outside them) gets 402 and the text
//   e. the overview counts the requests: GPTBot as an impersonator with its
//      refusals, ClaudeBot unverifiable, the managed robots.txt reads, the
//      paths; the access log filter by crawler finds GPTBot's lines
// State for apps/console/e2e/ai-crawl.spec.ts: .e2e/ai-crawl-state.json.
// `node scripts/e2e-ai-crawl.mjs --cleanup` deletes the site and resets the
// global settings.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import zlib from "node:zlib";
import { actor, pass, waitFor } from "./e2e-lib.mjs";

const STATE = ".e2e/ai-crawl-state.json";
const HOST = "ai.crawl.e2e.test";
const NODE_PORT = Number(process.env.E2E_NODE_PORT ?? 18080);
const UA = {
  gptbot:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  claudebot: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  perplexitybot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  bytespider:
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider)",
  browser:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};
const DEFAULTS = {
  crawlers: {},
  operators: {},
  impersonators: null,
  challenge: null,
  blockStatus: null,
  blockBody: null,
  robots: { managed: false, search: "unset", aiInput: "unset", aiTrain: "unset" },
  payPerCrawl: { enabled: false, price: "0.01", dynamicPricing: false },
};

/** A body as sent, decoded from the edge's compression. */
function decoded(encoding, body) {
  if (encoding === "gzip") return zlib.gunzipSync(body);
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "zstd") return zlib.zstdDecompressSync(body);
  return body;
}

/** A request to the node with the site's Host header (bodies decoded). */
function request(path, headers = {}, method = "GET") {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "localhost",
        port: NODE_PORT,
        path,
        method,
        headers: { host: HOST, ...headers },
        agent: false,
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: decoded(res.headers["content-encoding"], Buffer.concat(chunks)).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: e.message }));
    req.end();
  });
}
const as = (crawler, path = "/page", headers = {}) =>
  request(path, { "user-agent": UA[crawler], ...headers });
const summary = (r) =>
  `${r.status} error=${r.headers["x-edgeweir-error"] ?? "-"} price=${r.headers["crawler-price"] ?? "-"} crawler-error=${r.headers["crawler-error"] ?? "-"} ${JSON.stringify(r.body.slice(0, 120))}`;

const admin = await actor("admin@e2e.test", "e2e-admin-password-123", "ai-crawl-e2e");

if (process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(STATE, "utf8"));
  await admin.ok("DELETE", `/sites/${state.siteId}`);
  const settings = await admin.ok("GET", "/settings/ai-crawl");
  await admin.ok("PUT", "/settings/ai-crawl", { ...settings, crawlers: {}, operators: {} });
  pass("AI crawl site deleted, global actions cleared");
  process.exit(0);
}

// ---------------------------------------------------------------- a
const clusterId = (await admin.ok("GET", "/clusters"))[0].id;
const nodes = await admin.ok("GET", `/nodes?clusterId=${clusterId}`);
const nodeIds = nodes.map((n) => n.id);
assert.ok(nodeIds.length > 0, "no node in the default cluster");
let lastNodes = [];
const synced = async (label) => {
  const latest = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
  await waitFor(
    `${label} (#${latest})`,
    async () => {
      lastNodes = await Promise.all(nodeIds.map((id) => admin.ok("GET", `/nodes/${id}`)));
      return lastNodes.every(
        (n) => !n.online || (n.applyState === "applied" && n.appliedRevision >= latest),
      );
    },
    120,
    1000,
    () =>
      JSON.stringify(
        lastNodes.map((n) => [n.name, n.online, n.appliedRevision, n.applyState, n.applyMessage]),
      ),
  );
  return latest;
};
await waitFor(
  "the node reports ai-crawlers-v1",
  async () =>
    (await admin.ok("GET", `/nodes/${nodeIds[0]}`)).supportedFeatures?.includes("ai-crawlers-v1"),
  60,
);
const global = await admin.ok("GET", "/settings/ai-crawl");
assert.equal(global.detection, true, "detection is on by default");
const catalogue = await admin.ok("GET", "/ai-crawlers");
assert.ok(
  catalogue.crawlers.find((c) => c.id === "gptbot")?.cidrs > 0,
  "GPTBot ships its published ranges",
);
pass(
  `node reports ai-crawlers-v1; catalogue of ${catalogue.crawlers.length} crawlers (ranges ${catalogue.rangesUpdated})`,
);

// ---------------------------------------------------------------- b
const created = await admin.ok("POST", "/sites", {
  name: "ai-crawl",
  clusterId,
  domains: [HOST],
  origins: [{ address: "whoami", port: 80, scheme: "http" }],
});
const siteId = created.site.id;
await writeFile(STATE, JSON.stringify({ siteId, host: HOST }));
await admin.ok("PUT", `/sites/${siteId}/logs/settings`, { sampleRate: 10000, logBlocked: true });
await synced("the site reaches the node");
await waitFor("the site is routed", async () => (await as("browser")).status === 200, 60);
const tagged = await as("gptbot", "/tagged");
assert.equal(tagged.status, 200, `spoofed GPTBot without a policy: ${summary(tagged)}`);
assert.match(tagged.body, /\nGET \/tagged /, "the origin answered");
pass("a spoofed GPTBot without a policy is only tagged: 200 from the origin");

// ---------------------------------------------------------------- c
let site = await admin.ok("GET", `/sites/${siteId}/ai-crawl`);
site = await admin.ok("PUT", `/sites/${siteId}/ai-crawl`, {
  ...DEFAULTS,
  expectedUpdatedAt: site.updatedAt ?? undefined,
  crawlers: { gptbot: "block", claudebot: "charge" },
  robots: { managed: true, search: "unset", aiInput: "unset", aiTrain: "no" },
  payPerCrawl: { enabled: true, price: "0.01", dynamicPricing: false },
});
await synced("the policy reaches the node");
const blocked = await as("gptbot");
assert.equal(blocked.status, 403, `GPTBot blocked: ${summary(blocked)}`);
assert.equal(blocked.headers["x-edgeweir-error"], "ai-crawler-blocked", summary(blocked));
assert.equal((await as("browser")).status, 200, "a browser reaches the origin");
assert.equal(
  (await as("bytespider")).status,
  200,
  "a crawler without an action reaches the origin",
);
pass("GPTBot gets the 403 page (ai-crawler-blocked); browsers and other crawlers reach the origin");

const robots = await as("gptbot", "/robots.txt", {
  "accept-encoding": "gzip, br",
  range: "bytes=0-10",
});
assert.equal(robots.status, 200, `robots.txt for GPTBot: ${summary(robots)}`);
assert.ok(robots.body.startsWith("# BEGIN Edgeweir managed content\n"), summary(robots));
assert.ok(
  robots.body.includes("User-agent: *\nContent-Signal: ai-train=no\nAllow: /\n"),
  summary(robots),
);
assert.ok(robots.body.includes("User-agent: GPTBot\nDisallow: /\n"), summary(robots));
assert.ok(!robots.body.includes("User-agent: ClaudeBot"), "charged crawlers are not disallowed");
const managedEnd = robots.body.indexOf("# END Edgeweir managed content\n");
assert.ok(managedEnd > 0, summary(robots));
assert.match(
  robots.body.slice(managedEnd),
  /\nGET \/robots\.txt /,
  "the origin's file follows, whole (no range)",
);
assert.equal(robots.headers["content-range"], undefined, "not a range");
pass(`robots.txt: ${robots.headers["content-encoding"] ?? "identity"} from the edge`);
pass("robots.txt stays readable for GPTBot: managed text, then the origin's whole file");

const unpaid = await as("claudebot");
assert.equal(unpaid.status, 402, `ClaudeBot without a price: ${summary(unpaid)}`);
assert.equal(unpaid.headers["crawler-price"], "USD 0.01", summary(unpaid));
assert.equal(unpaid.headers["crawler-error"], "MissingCrawlerPrice", summary(unpaid));
const offered = await as("claudebot", "/page", { "crawler-max-price": "USD 1.00" });
assert.equal(offered.status, 400, `unverifiable ClaudeBot offering a price: ${summary(offered)}`);
assert.equal(offered.headers["crawler-error"], "StrongAuthRequired", summary(offered));
const conflicting = await as("claudebot", "/page", {
  "crawler-max-price": "USD 1",
  "crawler-exact-price": "USD 0.01",
});
assert.equal(conflicting.headers["crawler-error"], "ConflictingPriceHeaders", summary(conflicting));
const free = await as("claudebot", "/robots.txt");
assert.equal(free.status, 200, `robots.txt is free: ${summary(free)}`);
assert.equal(free.headers["crawler-price"], undefined, "no price on a free path");
pass(
  "ClaudeBot gets 402 crawler-price: USD 0.01 (MissingCrawlerPrice), 400 StrongAuthRequired with a price; robots.txt free",
);

// ---------------------------------------------------------------- d
site = await admin.ok("PUT", `/sites/${siteId}/ai-crawl`, {
  ...site,
  id: undefined,
  updatedAt: undefined,
  expectedUpdatedAt: site.updatedAt,
  impersonators: "block",
  blockStatus: 402,
  blockBody: "No crawling without a licence.\n",
});
await synced("impersonators blocked");
const fake = await waitFor(
  "the spoofed PerplexityBot refused as an impersonator",
  async () => {
    const r = await as("perplexitybot");
    return r.status === 402 ? r : null;
  },
  30,
);
assert.equal(fake.body, "No crawling without a licence.\n", summary(fake));
const gptText = await as("gptbot");
assert.equal(gptText.status, 402, `GPTBot gets the site's block response: ${summary(gptText)}`);
pass(
  "the spoofed PerplexityBot (outside its published ranges) is an impersonator: 402 with the site's text",
);

// ---------------------------------------------------------------- e
const overview = await waitFor(
  "the overview counts the requests",
  async () => {
    const o = await admin.ok("GET", `/sites/${siteId}/ai-crawl/overview?range=1h`);
    const gpt = o.crawlers.find((c) => c.crawler === "gptbot");
    const claude = o.crawlers.find((c) => c.crawler === "claudebot");
    return gpt &&
      gpt.requests >= 4 &&
      gpt.unverified >= 4 &&
      claude &&
      claude.unverifiable >= 4 &&
      o.totals.robots >= 2
      ? o
      : null;
  },
  240,
  5000,
);
const gpt = overview.crawlers.find((c) => c.crawler === "gptbot");
assert.ok(gpt.blocked >= 2, `GPTBot refusals: ${JSON.stringify(gpt)}`);
assert.equal(gpt.verified, 0, "a spoofed GPTBot never verifies");
assert.ok(overview.totals.blocked >= 5, JSON.stringify(overview.totals));
assert.ok(
  overview.paths.some((p) => p.crawler === "gptbot" && p.path === "/robots.txt"),
  JSON.stringify(overview.paths),
);
assert.equal(overview.unsupportedNodes, 0);
const logs = await waitFor(
  "access log lines of GPTBot",
  async () => {
    const r = await admin.ok("GET", `/sites/${siteId}/logs?crawler=gptbot&limit=20`);
    return r.entries.length > 0 ? { items: r.entries } : null;
  },
  120,
  5000,
);
assert.ok(
  logs.items.every((l) => l.crawler === "gptbot" && l.crawlerVerification === "failed"),
  JSON.stringify(logs.items.slice(0, 2)),
);
const any = await admin.ok("GET", `/sites/${siteId}/logs?crawler=any&limit=200`);
assert.ok(
  any.entries.some((l) => l.crawler === "claudebot"),
  "crawler=any finds every claim",
);
assert.ok(
  any.entries.every((l) => l.crawler !== ""),
  "crawler=any leaves out browsers",
);
await writeFile(STATE, JSON.stringify({ siteId, host: HOST, requests: overview.totals.requests }));
pass(
  `overview: ${overview.totals.requests} crawler requests, ${overview.totals.blocked} refused; GPTBot ${gpt.requests} (impersonator ${gpt.unverified}); robots.txt ${overview.totals.robots}; ${logs.items.length} log lines by crawler`,
);
