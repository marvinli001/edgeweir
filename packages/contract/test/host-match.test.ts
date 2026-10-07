import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hostMatcher, matchHost, parseSiteDomain } from "../src/domains";

// Same vectors as edgeweir-node/test/lua/host-match-vectors.json (byte-identical).
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "host_match_vectors.json"), "utf8"),
) as {
  sites: { id: string; created: number; domains: string[] }[];
  cases: { host: string; site: string | null }[];
};

describe("site lookup by host (shared with the node's Lua)", () => {
  it("matches every vector by precedence", () => {
    // Patterns by (site creation time, the site's order, site id), as the console compiles them.
    const entries = vectors.sites.flatMap((site) => {
      let index = 0;
      return site.domains.map((domain) => {
        const parsed = parseSiteDomain(domain);
        if (!parsed) throw new Error(`invalid vector domain ${domain}`);
        const order = parsed.kind === "regex" ? site.created * 16 + index++ : 0;
        return { ...parsed, value: site.id, order, site: site.id };
      });
    });
    entries.sort((a, b) => a.order - b.order || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
    const matcher = hostMatcher(entries);
    for (const c of vectors.cases) expect(matchHost(matcher, c.host) ?? null, c.host).toBe(c.site);
    expect(vectors.cases.length).toBeGreaterThan(25);
  });
});
