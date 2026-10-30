// Writes src/ai-crawler-ranges.json: the IP ranges AI crawler operators
// publish, merged per crawler of src/ai-crawlers.ts that has `ranges: true`.
// Run before a release (`pnpm --filter @edgeweir/contract ai-crawlers:ranges`);
// the console ships the file and nodes never download these lists.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCidr, parseCidr } from "../src/addresses.ts";
import { AI_CRAWLERS } from "../src/ai-crawlers.ts";

/** Where each operator publishes its crawler's ranges (JSON with prefixes[].ipv4Prefix / ipv6Prefix). */
const SOURCES = {
  gptbot: ["https://openai.com/gptbot.json"],
  "oai-searchbot": ["https://openai.com/searchbot.json"],
  "chatgpt-user": ["https://openai.com/chatgpt-user.json"],
  googlebot: ["https://developers.google.com/static/crawling/ipranges/common-crawlers.json"],
  bingbot: ["https://www.bing.com/toolbox/bingbot.json"],
  applebot: ["https://search.developer.apple.com/applebot.json"],
  perplexitybot: ["https://www.perplexity.ai/perplexitybot.json"],
  "perplexity-user": ["https://www.perplexity.ai/perplexity-user.json"],
  ccbot: ["https://index.commoncrawl.org/ccbot.json"],
  duckassistbot: ["https://duckduckgo.com/duckassistbot.json"],
  "mistralai-user": ["https://mistral.ai/mistralai-user-ips.json"],
};

async function fetchPrefixes(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.json();
  const out = [];
  for (const p of body.prefixes ?? []) {
    const text = p.ipv4Prefix ?? p.ipv6Prefix;
    const cidr = typeof text === "string" ? parseCidr(text) : null;
    if (!cidr) throw new Error(`${url}: bad prefix ${JSON.stringify(p)}`);
    out.push(cidr);
  }
  if (out.length === 0) throw new Error(`${url}: no prefixes`);
  return out;
}

const toBig = (bytes) => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);

/** Drops prefixes inside others and joins sibling halves, then formats and sorts them. */
function mergeCidrs(cidrs) {
  const out = [];
  for (const version of [4, 6]) {
    const bits = version === 4 ? 32 : 128;
    let list = cidrs
      .filter((c) => c.version === version)
      .map((c) => ({ start: toBig(c.bytes), prefix: c.prefix }));
    let changed = true;
    while (changed) {
      changed = false;
      list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.prefix - b.prefix));
      const next = [];
      for (const c of list) {
        const last = next[next.length - 1];
        if (last) {
          const size = 1n << BigInt(bits - last.prefix);
          if (c.start >= last.start && c.start < last.start + size) {
            changed = true;
            continue;
          }
          if (
            last.prefix === c.prefix &&
            last.prefix > 0 &&
            last.start + size === c.start &&
            last.start % (size * 2n) === 0n
          ) {
            next[next.length - 1] = { start: last.start, prefix: last.prefix - 1 };
            changed = true;
            continue;
          }
        }
        next.push(c);
      }
      list = next;
    }
    for (const c of list) {
      const bytes = [];
      for (let i = bits / 8 - 1; i >= 0; i--)
        bytes.push(Number((c.start >> BigInt(i * 8)) & 0xffn));
      out.push(formatCidr({ version, bytes, prefix: c.prefix }));
    }
  }
  return out.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const crawlers = {};
  for (const c of AI_CRAWLERS) {
    if (!c.ranges) continue;
    const urls = SOURCES[c.id];
    if (!urls) throw new Error(`no source for ${c.id}`);
    const all = [];
    for (const url of urls) all.push(...(await fetchPrefixes(url)));
    crawlers[c.id] = mergeCidrs(all);
    console.log(`${c.id}: ${all.length} prefixes -> ${crawlers[c.id].length}`);
  }
  const target = resolve(dirname(fileURLToPath(import.meta.url)), "../src/ai-crawler-ranges.json");
  const updated = new Date().toISOString().slice(0, 10);
  writeFileSync(target, `${JSON.stringify({ updated, crawlers }, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", target], { stdio: "inherit" });
  console.log(`wrote ${target}`);
}
