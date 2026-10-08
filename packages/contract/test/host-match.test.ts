import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hostMatcher, inPatternOrder, matchHost, parseSiteDomain } from "../src/domains";

// Same vectors as edgeweir-node/test/lua/host-match-vectors.json (byte-identical).
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "host_match_vectors.json"), "utf8"),
) as {
  sites: { id: string; created: number; domains: string[] }[];
  cases: { host: string; site: string | null }[];
};

describe("site lookup by host (shared with the node's Lua)", () => {
  it("matches every vector by precedence", () => {
    // Patterns by (site creation time, the site's order, site id): the
    // helper the console's purge resolution and compiler use.
    const entries = inPatternOrder(
      vectors.sites.flatMap((site) =>
        site.domains.map((domain) => {
          const parsed = parseSiteDomain(domain);
          if (!parsed) throw new Error(`invalid vector domain ${domain}`);
          return { ...parsed, value: site.id, siteId: site.id, siteCreatedMs: site.created };
        }),
      ),
    );
    const matcher = hostMatcher(entries);
    for (const c of vectors.cases) expect(matchHost(matcher, c.host) ?? null, c.host).toBe(c.site);
    expect(vectors.cases.length).toBeGreaterThan(25);
  });
});
