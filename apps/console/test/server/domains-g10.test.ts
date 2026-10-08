import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { domainPatternError, patternBranches } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { DomainMatch } from "@edgeweir/proto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { banChanges, reportAutoBans } from "../../src/server/services/bans";
import { expireCnamePrefixes } from "../../src/server/services/cname-prefixes";
import { bindingPolicy, compileBindingPlan, loadBinding } from "../../src/server/services/dns";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const origins = [{ address: "origin.example.com" }];
const missing = "00000000-0000-4000-8000-000000000000";
const RANDOM_PREFIX = /^[a-z][a-z0-9]{7}$/;

describe("domain forms, unknown hosts and CNAME prefixes (G10)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let nodeId = "";
  const material = await ctx.nodeCa.issueServerCertificate(["*.g10.test", "g10.test"]);

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async (cluster = clusterId) => {
    const row = await latestRevision(ctx.db, cluster);
    if (!row) throw new Error("no revision");
    return { row, config: decodeNodeConfig(row.ir) };
  };
  const createSite = async (name: string, domains: string[], cluster = clusterId) =>
    (await admin.sites.create({ name, domains, origins, clusterId: cluster })).site;
  const plan = async (now = Date.now(), cluster = clusterId) =>
    compileBindingPlan(ctx.db, cluster, bindingPolicy(await loadBinding(ctx.db, cluster)), now);
  const cnames = (records: { name: string; type: string }[]) =>
    records
      .filter((r) => r.type === "CNAME")
      .map((r) => r.name)
      .sort();

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g10",
        supportedFeatures: ["tls-v1", "purge-tag-v1", "domains-v2", "unknown-host-v1"],
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("saves the four domain forms and Unicode hosts as Punycode, unique per form", async () => {
    const site = await createSite("forms", [
      "G10.test",
      "*.g10.test",
      ".deep.g10.test",
      "~(api|cdn)\\d+\\.g10\\.test",
      "Bücher.g10.test",
      ".中国.g10.test",
    ]);
    expect(site.domains).toEqual([
      "g10.test",
      "*.g10.test",
      ".deep.g10.test",
      "~(api|cdn)\\d+\\.g10\\.test",
      "xn--bcher-kva.g10.test",
      ".xn--fiqs8s.g10.test",
    ]);
    const stored = await ctx.db
      .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
      .from(schema.siteDomain)
      .where(eq(schema.siteDomain.siteId, site.id));
    expect(stored.map((d) => `${d.kind}:${d.name}`).sort()).toEqual(
      [
        "exact:g10.test",
        "wildcard:g10.test",
        "suffix:deep.g10.test",
        "regex:(api|cdn)\\d+\\.g10\\.test",
        "exact:xn--bcher-kva.g10.test",
        "suffix:xn--fiqs8s.g10.test",
      ].sort(),
    );
    // Another form of the same name belongs to another site; the same form does not.
    const other = await createSite("other", [".g10.test", "~g10\\.test"]);
    expect(other.domains).toEqual([".g10.test", "~g10\\.test"]);
    const taken = await rpcError(createSite("taken", ["~(api|cdn)\\d+\\.g10\\.test"]));
    expect([taken.code, taken.data]).toEqual([
      "DOMAIN_IN_USE",
      { domains: "~(api|cdn)\\d+\\.g10\\.test" },
    ]);
    // UTS #46 refuses what the contract cannot check.
    const invalid = await rpcError(createSite("bidi", ["0à.א.g10.test"]));
    expect([invalid.code, invalid.data]).toEqual(["DOMAIN_INVALID", { domain: "0à.א.g10.test" }]);
    expect((await rpcError(createSite("x", ["xn--a.g10.test"]))).code).toBe("DOMAIN_INVALID");
    // Patterns: the subset, lowercase, at most 10 per site.
    for (const bad of ["~(?:a)", "~[A-Z]\\.g10\\.test", "~a b", `~${"a".repeat(257)}`])
      expect((await rpcError(createSite("bad", [bad]))).code, bad).toBe("BAD_REQUEST");
    const eleven = Array.from({ length: 11 }, (_, i) => `~p${i}\\.g10\\.test`);
    expect((await rpcError(createSite("many", eleven))).code).toBe("BAD_REQUEST");
    await admin.sites.delete({ id: other.id });
  });

  it("finds sites by either form of a Unicode domain", async () => {
    const names = async (search: string) =>
      (await admin.sites.list({ search })).items.map((s) => s.name);
    expect(await names("bücher")).toEqual(["forms"]);
    expect(await names("xn--bcher")).toEqual(["forms"]);
    expect(await names("中国")).toEqual(["forms"]);
    // Part of a Unicode label too (Punycode encodes whole labels).
    expect(await names("büch")).toEqual(["forms"]);
    expect(await names("ÜCHER.G10")).toEqual(["forms"]);
    expect(await names("国")).toEqual(["forms"]);
    expect(await names(".deep.")).toEqual(["forms"]);
    expect(await names("~(api")).toEqual(["forms"]);
  });

  it("accepts the branch example of the pattern rules in the guide, with the product it states", () => {
    for (const file of ["domains.md", "domains.en.md"]) {
      const text = readFileSync(
        resolve(import.meta.dirname, "../../../../docs/guide", file),
        "utf8",
      );
      const row = text.split("\n").find((line) => /^\| (Branches|分支) \|/.test(line)) ?? "";
      const example = /`([^`]*\([^`]*)` \S+ ([\d × ]+) = (\d+)/.exec(row);
      expect(example, file).not.toBeNull();
      const [, quoted = "", factors = "", product = ""] = example ?? [];
      // The table escapes "|" as "\|".
      const pattern = quoted.replaceAll("\\|", "|");
      expect(domainPatternError(pattern), `${file}: ${pattern}`).toBeNull();
      expect(patternBranches(pattern), `${file}: ${pattern}`).toBe(Number(product));
      expect(factors.split("×").reduce((n, f) => n * Number(f), 1)).toBe(Number(product));
    }
  });

  it("compiles suffix and pattern domains with the order of the site's patterns (domains-v2)", async () => {
    const site = (await admin.sites.list({ search: "forms" })).items[0];
    if (!site) throw new Error("site missing");
    const { config: compiled } = await config();
    const domains = compiled.sites.find((s) => s.id === site.id)?.domains ?? [];
    const created = new Date(site.createdAt).getTime();
    expect(
      domains
        .filter((d) => d.match !== DomainMatch.UNSPECIFIED)
        .map((d) => [d.name, d.match, d.order]),
    ).toEqual([
      ["(api|cdn)\\d+\\.g10\\.test", DomainMatch.REGEX, BigInt(created) * 16n],
      ["deep.g10.test", DomainMatch.SUFFIX, 0n],
      ["xn--fiqs8s.g10.test", DomainMatch.SUFFIX, 0n],
    ]);
    expect(compiled.requiredFeatures).toContain("domains-v2");
    // A disabled site's forms become offline hosts.
    await admin.sites.setEnabled({ id: site.id, enabled: false });
    const offline = (await config()).config.offlineHosts;
    expect(offline.map((h) => [h.name, h.match])).toEqual(
      expect.arrayContaining([
        ["deep.g10.test", DomainMatch.SUFFIX],
        ["(api|cdn)\\d+\\.g10\\.test", DomainMatch.REGEX],
      ]),
    );
    await admin.sites.setEnabled({ id: site.id, enabled: true });
  });

  it("resolves purges by the nodes' precedence: exact, *., the longest ., then patterns", async () => {
    const deeper = await createSite("deeper", [".x.deep.g10.test"]);
    const task = async (host: string) =>
      (await admin.cacheTasks.create({ type: "host", hosts: [host] })).sites.map((s) => s.id);
    const forms = (await admin.sites.list({ search: "forms" })).items[0]?.id;
    expect(await task("g10.test")).toEqual([forms]);
    expect(await task("a.b.deep.g10.test")).toEqual([forms]);
    expect(await task("y.x.deep.g10.test")).toEqual([deeper.id]);
    expect(await task("cdn7.g10.test")).toEqual([forms]);
    await admin.sites.delete({ id: deeper.id });
  });

  it("resolves purges as nodes route: enabled sites per cluster, disabled ones last, patterns in node order", async () => {
    const task = async (host: string) =>
      (await admin.cacheTasks.create({ type: "host", hosts: [host] })).sites
        .map((s) => s.id)
        .sort();
    // A disabled site's exact domain under an enabled suffix: nodes serve the suffix site.
    const off = await createSite("off", ["api.p.g10.test", "only-off.p2.g10.test"]);
    const on = await createSite("on", [".p.g10.test"]);
    await admin.sites.setEnabled({ id: off.id, enabled: false });
    expect(await task("api.p.g10.test")).toEqual([on.id]);
    // Only the disabled site names it: refused as disabled.
    expect(
      (await rpcError(admin.cacheTasks.create({ type: "host", hosts: ["only-off.p2.g10.test"] })))
        .code,
    ).toBe("SITE_DISABLED");
    // Another cluster serving the host too: each cluster's site is purged.
    const other = await admin.clusters.create({ name: "g10-purge" });
    const elsewhere = await createSite("elsewhere", ["~api\\.p\\.g10\\.test"], other.id);
    expect(await task("api.p.g10.test")).toEqual([on.id, elsewhere.id].sort());
    for (const id of [off.id, on.id, elsewhere.id]) await admin.sites.delete({ id });
    await admin.clusters.delete({ id: other.id });
  });

  /**
   * Sets sites' created_at in PostgreSQL's microseconds (a JavaScript Date
   * holds whole milliseconds): `micros` within 2026-01-01T00:00:00.000Z.
   */
  const createdAtMicros = async (siteId: string, micros: number) => {
    const stamp = `2026-01-01 00:00:00.${String(micros).padStart(6, "0")}+00`;
    await ctx.db.execute(
      sql`update site set created_at = ${stamp}::timestamptz where id = ${siteId}`,
    );
  };
  const NEW_YEAR_MS = Date.parse("2026-01-01T00:00:00.000Z");
  const hostTask = async (host: string) =>
    (await admin.cacheTasks.create({ type: "host", hosts: [host] })).sites.map((s) => s.id);
  /** The sites' ids by PostgreSQL's created_at, and their creation times in milliseconds. */
  const creation = async (ids: string[]) => {
    const rows = await ctx.db
      .select({ id: schema.site.id, createdAt: schema.site.createdAt })
      .from(schema.site)
      .where(inArray(schema.site.id, ids))
      .orderBy(asc(schema.site.createdAt));
    return { order: rows.map((r) => r.id), ms: rows.map((r) => r.createdAt.getTime()) };
  };

  it("orders patterns of sites created in one millisecond by site id, as nodes do, not by microseconds", async () => {
    const a = await createSite("same-ms-a", ["~.*\\.q\\.g10\\.test"]);
    const b = await createSite("same-ms-b", ["~shop\\.q\\.g10\\.test"]);
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    // The site with the larger id was created earlier within the millisecond.
    await createdAtMicros(high.id, 100);
    await createdAtMicros(low.id, 700);
    const created = await creation([a.id, b.id]);
    expect(created.order).toEqual([high.id, low.id]);
    expect(created.ms).toEqual([NEW_YEAR_MS, NEW_YEAR_MS]);
    // Equal orders (creation millisecond × 16 + index 0): the smaller site id.
    expect(await hostTask("shop.q.g10.test")).toEqual([low.id]);
    for (const site of [a, b]) await admin.sites.delete({ id: site.id });
  });

  it("orders patterns of sites created in one millisecond by their index first, as nodes do", async () => {
    // "early" (created first) names the host with its second pattern, "late" with its first.
    const early = await createSite("same-ms-early", [
      "~aaa\\.r2\\.g10\\.test",
      "~sh.*\\.r2\\.g10\\.test",
    ]);
    const late = await createSite("same-ms-late", ["~shop\\.r2\\.g10\\.test"]);
    await createdAtMicros(early.id, 100);
    await createdAtMicros(late.id, 700);
    const created = await creation([early.id, late.id]);
    expect(created.order).toEqual([early.id, late.id]);
    expect(created.ms).toEqual([NEW_YEAR_MS, NEW_YEAR_MS]);
    // The first pattern of "late" (order ms × 16) before the second of "early" (ms × 16 + 1).
    expect(await hostTask("shop.r2.g10.test")).toEqual([late.id]);
    for (const site of [early, late]) await admin.sites.delete({ id: site.id });
  });

  it("purges every cluster that serves a host but prefetches from one site only", async () => {
    // Cluster "pf" runs prefetch-v2; the main cluster's node does not.
    const pf = await admin.clusters.create({ name: "g10-prefetch" });
    const [pfNode] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: pf.id,
        name: "edge-pf",
        supportedFeatures: ["tls-v1", "purge-tag-v1", "domains-v2", "prefetch-v2"],
      })
      .returning();
    if (!pfNode) throw new Error("node missing");
    const exact = await createSite(
      "pf-exact",
      ["pf.r3.g10.test", "~p\\d\\.r3\\.g10\\.test"],
      pf.id,
    );
    const broad = await createSite("pf-broad", [".r3.g10.test"]);
    const create = async (input: Parameters<typeof admin.cacheTasks.create>[0]) => {
      const task = await admin.cacheTasks.create(input);
      return {
        sites: task.sites.map((s) => s.id).sort(),
        nodes: task.nodes.map((n) => n.nodeName).sort(),
      };
    };
    const both = [exact.id, broad.id].sort();
    // Purges: each cluster's site that serves the host (too much purged is harmless).
    expect((await create({ type: "host", hosts: ["pf.r3.g10.test"] })).sites).toEqual(both);
    expect((await create({ type: "url", urls: ["http://pf.r3.g10.test/a"] })).sites).toEqual(both);
    expect((await create({ type: "prefix", urls: ["http://p7.r3.g10.test/a/"] })).sites).toEqual(
      both,
    );
    // Prefetches: the exact domain wins over the other cluster's suffix; only
    // its cluster's nodes fetch, and only they need prefetch-v2.
    const only = { sites: [exact.id], nodes: ["edge-pf"] };
    expect(await create({ type: "prefetch", urls: ["http://pf.r3.g10.test/a"] })).toEqual(only);
    expect(
      await create({ type: "prefetch", urls: ["http://pf.r3.g10.test/b"], variants: ["mobile"] }),
    ).toEqual(only);
    expect(await create({ type: "sitemap", urls: ["http://pf.r3.g10.test/sitemap.xml"] })).toEqual(
      only,
    );
    // The same precedence over every cluster: a suffix before a pattern.
    expect(await create({ type: "prefetch", urls: ["http://p7.r3.g10.test/a"] })).toEqual({
      sites: [broad.id],
      nodes: ["edge-g10"],
    });
    // A sitemap the main cluster's site serves still needs prefetch-v2 there.
    expect(
      (
        await rpcError(
          admin.cacheTasks.create({ type: "sitemap", urls: ["http://p7.r3.g10.test/sitemap.xml"] }),
        )
      ).code,
    ).toBe("NODE_CAPABILITY_REQUIRED");
    for (const site of [exact, broad]) await admin.sites.delete({ id: site.id });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, pfNode.id));
    await admin.clusters.delete({ id: pf.id });
  });

  it("keeps a prefetch in the cluster of the host's own site while that site is disabled", async () => {
    // Another cluster serves the broad suffix; the main cluster the exact domain.
    const elsewhere = await admin.clusters.create({ name: "g10-prefetch-off" });
    const [elsewhereNode] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: elsewhere.id,
        name: "edge-s4",
        supportedFeatures: ["tls-v1", "purge-tag-v1", "domains-v2", "prefetch-v2"],
      })
      .returning();
    if (!elsewhereNode) throw new Error("node missing");
    const own = await createSite("s4-own", ["www.s4.g10.test"]);
    const broad = await createSite("s4-broad", [".s4.g10.test"], elsewhere.id);
    const create = async (input: Parameters<typeof admin.cacheTasks.create>[0]) => {
      const task = await admin.cacheTasks.create(input);
      return { sites: task.sites.map((s) => s.id), nodes: task.nodes.map((n) => n.nodeName) };
    };
    const refused = async (input: Parameters<typeof admin.cacheTasks.create>[0]) =>
      (await rpcError(admin.cacheTasks.create(input))).code;
    const url = "http://www.s4.g10.test/a";
    expect(await create({ type: "prefetch", urls: [url] })).toEqual({
      sites: [own.id],
      nodes: ["edge-g10"],
    });
    // Disabled, its exact domain still keeps the other cluster's nodes off the host.
    await admin.sites.setEnabled({ id: own.id, enabled: false });
    expect(await refused({ type: "prefetch", urls: [url] })).toBe("SITE_DISABLED");
    expect(await refused({ type: "sitemap", urls: ["http://www.s4.g10.test/sitemap.xml"] })).toBe(
      "SITE_DISABLED",
    );
    // Purges still go to every cluster that serves the host.
    expect(await create({ type: "host", hosts: ["www.s4.g10.test"] })).toEqual({
      sites: [broad.id],
      nodes: ["edge-s4"],
    });
    // An enabled site of its own cluster that the nodes route the host to
    // there takes the prefetch, although the other cluster's suffix comes first.
    const same = await createSite("s4-same", ["~www\\.s4\\.g10\\.test"]);
    expect(await create({ type: "prefetch", urls: [url] })).toEqual({
      sites: [same.id],
      nodes: ["edge-g10"],
    });
    for (const site of [own, broad, same]) await admin.sites.delete({ id: site.id });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, elsewhereNode.id));
    await admin.clusters.delete({ id: elsewhere.id });
  });

  it("does not check suffix or pattern domains for DNS, certificates, HTTP-01 or redirect sources", async () => {
    const site = (await admin.sites.list({ search: "forms" })).items[0];
    if (!site) throw new Error("site missing");
    ctx.resolver = {
      resolve4: async () => ["203.0.113.9"],
      resolve6: async () => {
        throw Object.assign(new Error("no data"), { code: "ENODATA" });
      },
    };
    const launch = await admin.sites.launch({ id: site.id });
    expect(
      launch.domains
        .filter((d) => d.pointing === "unchecked")
        .map((d) => [d.name, d.probe])
        .sort(),
    ).toEqual(
      [
        [".deep.g10.test", ""],
        [".xn--fiqs8s.g10.test", ""],
        ["~(api|cdn)\\d+\\.g10\\.test", ""],
      ].sort(),
    );
    // One-click HTTPS asks for *.x for .x by DNS-01 and leaves patterns out.
    const check = await admin.https.check({ id: site.id });
    expect(check.request.challenge).toBe("dns01");
    expect(check.request.names.sort()).toEqual(
      [
        "*.deep.g10.test",
        "*.g10.test",
        "*.xn--fiqs8s.g10.test",
        "g10.test",
        "xn--bcher-kva.g10.test",
      ].sort(),
    );
    const patterns = await createSite("patterns", ["~only\\d\\.g10\\.test"]);
    expect((await admin.https.check({ id: patterns.id })).blockers).toEqual([
      { code: "no_certificate_names" },
    ]);
    // HTTP-01 is only for exact domains.
    const http01 = await rpcError(
      admin.certificates.request({
        name: "deep",
        names: ["a.deep.g10.test"],
        email: "ops@g10.test",
        challenge: "http01",
        skipDnsCheck: true,
      }),
    );
    expect(http01.code).toBe("CERTIFICATE_DOMAIN_MISMATCH");
    // A bulk redirect source must be an exact domain or one label under *.
    const unknown = await rpcError(
      admin.bulkRedirects.save({
        id: site.id,
        redirects: [{ source: "a.deep.g10.test/old", target: "/new" }],
      }),
    );
    expect([unknown.code, unknown.data]).toEqual([
      "BULK_REDIRECT_HOST_UNKNOWN",
      { hosts: "a.deep.g10.test" },
    ]);
    await admin.bulkRedirects.save({
      id: site.id,
      redirects: [{ source: "x.g10.test/old", target: "/new" }],
    });
    await admin.bulkRedirects.save({ id: site.id, redirects: [] });
    await admin.sites.delete({ id: patterns.id });
  });

  it("serves suffix and pattern hosts only where the bound certificate covers them", async () => {
    const certificate = await admin.certificates.upload({
      name: "g10",
      chainPem: material.certificatePem,
      privateKeyPem: material.privateKeyPem,
    });
    const site = await createSite("covered", [
      "cover.g10.test",
      ".cover.g10.test",
      "~c\\d\\.g10\\.test",
    ]);
    // Suffix and pattern domains do not block binding a certificate.
    await admin.https.update({ id: site.id, settings: { certificateId: certificate.id } });
    const launch = await admin.sites.launch({ id: site.id });
    expect(launch.certificate).toMatchObject({ state: "covered", uncovered: [] });
    const compiled = (await config()).config.sites.find((s) => s.id === site.id);
    expect(compiled?.domains.every((d) => !d.tlsPending)).toBe(true);
    await admin.https.update({ id: site.id, settings: { certificateId: null } });
    await admin.sites.delete({ id: site.id });
  });

  it("hands unknown hosts and node IP access to a default site, closes them or shows the page", async () => {
    const before = await admin.clusters.unknownHosts({ clusterId });
    expect(before).toMatchObject({
      settings: {
        unknownHost: "page",
        ipAccess: "page",
        defaultSiteId: null,
        defaultCertificate: false,
        scan: { enabled: false, threshold: 100, banSeconds: 3600 },
      },
      defaultSite: null,
      nodesWithout: [],
    });
    expect((await config()).config.unknownHosts).toBeUndefined();
    const fallback = await createSite("fallback", ["fallback.g10.test"]);
    const saved = await admin.clusters.setUnknownHosts({
      clusterId,
      settings: {
        unknownHost: "close",
        ipAccess: "site",
        defaultSiteId: fallback.id,
        scan: { enabled: true, threshold: 50, banSeconds: 600 },
      },
    });
    expect(saved).toMatchObject({
      settings: { unknownHost: "close", ipAccess: "site", defaultSiteId: fallback.id },
      defaultSite: { id: fallback.id, name: "fallback", enabled: true, certificate: false },
    });
    const { row, config: compiled } = await config();
    expect(row.reasonCode).toBe("unknown_hosts_updated");
    expect(compiled.unknownHosts).toMatchObject({
      unknownHost: "close",
      ipAccess: "site",
      defaultSiteId: fallback.id,
      defaultCertificate: false,
      scanThreshold: 50,
      scanBanSeconds: 600,
    });
    expect(compiled.requiredFeatures).toContain("unknown-host-v1");
    const [entry] = (await admin.auditLogs.list({ action: "cluster.unknown_hosts_update" })).items;
    expect(entry?.metadata).toMatchObject({
      from: { unknownHost: "page" },
      to: { unknownHost: "close", ipAccess: "site" },
    });
    // The default site must be an enabled site of the cluster, with a certificate for unknown SNI.
    const elsewhere = await admin.clusters.create({ name: "g10-other" });
    const foreign = await createSite("foreign", ["foreign.g10.test"], elsewhere.id);
    for (const defaultSiteId of [foreign.id, missing])
      expect(
        (
          await rpcError(
            admin.clusters.setUnknownHosts({
              clusterId,
              settings: { unknownHost: "site", defaultSiteId },
            }),
          )
        ).code,
      ).toBe("DEFAULT_SITE_INVALID");
    expect(
      (
        await rpcError(
          admin.clusters.setUnknownHosts({
            clusterId,
            settings: { unknownHost: "site", defaultSiteId: fallback.id, defaultCertificate: true },
          }),
        )
      ).code,
    ).toBe("DEFAULT_SITE_CERTIFICATE_REQUIRED");
    expect(
      (
        await rpcError(
          admin.clusters.setUnknownHosts({ clusterId, settings: { unknownHost: "site" } }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    // A disabled default site hands nothing over until it is enabled again.
    await admin.sites.setEnabled({ id: fallback.id, enabled: false });
    expect((await config()).config.unknownHosts).toMatchObject({
      unknownHost: "close",
      ipAccess: "page",
      defaultSiteId: "",
    });
    expect((await admin.clusters.unknownHosts({ clusterId })).defaultSite?.enabled).toBe(false);
    await admin.sites.setEnabled({ id: fallback.id, enabled: true });
    // Deleting it clears the reference.
    await admin.sites.delete({ id: fallback.id });
    expect((await admin.clusters.unknownHosts({ clusterId })).settings.defaultSiteId).toBeNull();
    // The defaults are stored as nothing and compile to nothing.
    await admin.clusters.setUnknownHosts({ clusterId, settings: {} });
    const [cluster] = await ctx.db
      .select({ unknownHosts: schema.cluster.unknownHosts })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    expect(cluster?.unknownHosts).toBeNull();
    expect((await config()).config.unknownHosts).toBeUndefined();
    await admin.sites.delete({ id: foreign.id });
    await admin.clusters.delete({ id: elsewhere.id });
  });

  it("saves unknown host settings once and keeps a default site only while it is handed requests", async () => {
    const site = await createSite("idle-default", ["idle-default.g10.test"]);
    const settings = {
      unknownHost: "close" as const,
      ipAccess: "page" as const,
      defaultSiteId: site.id,
      defaultCertificate: false,
      scan: { enabled: true, threshold: 50, banSeconds: 600 },
    };
    const saved = await admin.clusters.setUnknownHosts({ clusterId, settings });
    // No handling hands requests to it: no default site is kept.
    expect(saved.settings.defaultSiteId).toBeNull();
    const revision = (await latestRevision(ctx.db, clusterId))?.revision;
    const audits = (await admin.auditLogs.list({ action: "cluster.unknown_hosts_update" })).items
      .length;
    // The same settings again change nothing: no revision, no audit entry.
    await admin.clusters.setUnknownHosts({ clusterId, settings });
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(revision);
    expect(
      (await admin.auditLogs.list({ action: "cluster.unknown_hosts_update" })).items.length,
    ).toBe(audits);
    await admin.clusters.setUnknownHosts({ clusterId, settings: {} });
    await admin.sites.delete({ id: site.id });
  });

  it("lists nodes without unknown-host-v1", async () => {
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1"], status: "active" })
      .where(eq(schema.node.id, nodeId));
    expect((await admin.clusters.unknownHosts({ clusterId })).nodesWithout).toEqual([
      { id: nodeId, name: "edge-g10" },
    ]);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1", "purge-tag-v1", "domains-v2", "unknown-host-v1"] })
      .where(eq(schema.node.id, nodeId));
  });

  it("stores scan protection bans at platform scope, keyed by address", async () => {
    const node = { id: nodeId, clusterId };
    const ban = (cidr: string, extra: Record<string, unknown> = {}) => ({
      scope: "platform" as const,
      siteId: "",
      cidr,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      reason: "unknown_host_scan",
      metric: "unknown_host_requests",
      observed: 101,
      threshold: 100,
      windowSeconds: 60,
      ...extra,
    });
    expect(
      await reportAutoBans(ctx.db, node, [
        ban("198.51.100.7/32"),
        // Scan bans are platform-wide, CC bans per site: the other pairings are refused.
        ban("198.51.100.8/32", { scope: "site" }),
        ban("198.51.100.9/32", { reason: "cc_ip_rate" }),
        ban("198.51.100.10/32", { siteId: missing }),
      ]),
    ).toBe(1);
    const rows = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.cidr, "198.51.100.7/32"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "platform",
      siteId: null,
      clusterId: null,
      source: "auto",
      nodeId,
      reason: "unknown_host_scan",
      trigger: {
        metric: "unknown_host_requests",
        observed: 101,
        threshold: 100,
        windowSeconds: 60,
      },
    });
    // A later report extends it; another node's report of the same address does not duplicate it.
    const later = new Date(Date.now() + 1_200_000);
    expect(await reportAutoBans(ctx.db, node, [ban("198.51.100.7/32", { expiresAt: later })])).toBe(
      1,
    );
    const [extended] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.cidr, "198.51.100.7/32"));
    expect(extended?.expiresAt.getTime()).toBe(later.getTime());
    // The list shows it with its reason.
    const listed = await admin.bans.list({ scope: "platform" });
    expect(listed.items.find((b) => b.cidr === "198.51.100.7/32")).toMatchObject({
      reason: "unknown_host_scan",
      siteId: null,
      node: { id: nodeId, name: "edge-g10" },
    });
  });

  it("lifts an unshared platform scan ban on every node and never shares a cluster's trusted proxies", async () => {
    const settings = await admin.settings.bans();
    await admin.settings.setBans({ ...settings, shareAutoBans: false });
    const other = await admin.clusters.create({ name: "g10-other" });
    await admin.clusters.setClientIp({
      clusterId: other.id,
      settings: { mode: "header", trustedCidrs: ["192.0.2.0/24"], header: "x-forwarded-for" },
    });
    // Its nodes ban scanners only with scan protection on.
    await admin.clusters.setUnknownHosts({
      clusterId: other.id,
      settings: { scan: { enabled: true, threshold: 10, banSeconds: 600 } },
    });
    const [peer] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: other.id,
        name: "edge-g10-other",
        supportedFeatures: ["unknown-host-v1"],
      })
      .returning();
    if (!peer) throw new Error("node missing");
    const scan = (cidr: string) => ({
      scope: "platform" as const,
      siteId: "",
      cidr,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      reason: "unknown_host_scan",
      metric: "unknown_host_requests",
      observed: 11,
      threshold: 10,
      windowSeconds: 60,
    });
    // Another cluster's trusted proxy is kept to the node that banned it, never shared
    // (scan-bans.test.ts covers sharing on).
    expect(await reportAutoBans(ctx.db, { id: nodeId, clusterId }, [scan("192.0.2.9/32")])).toBe(1);
    const [proxy] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.cidr, "192.0.2.9/32"));
    expect(proxy).toMatchObject({ distributed: false, removedAt: null, nodeId });
    // Both nodes banned the same scanner on their own (sharing off).
    expect(await reportAutoBans(ctx.db, { id: nodeId, clusterId }, [scan("203.0.113.99/32")])).toBe(
      1,
    );
    expect(
      await reportAutoBans(ctx.db, { id: peer.id, clusterId: other.id }, [scan("203.0.113.99/32")]),
    ).toBe(1);
    const before = (await banChanges(ctx.db, { id: peer.id, clusterId: other.id }, 0n, 100))
      .sequence;
    const [row] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.cidr, "203.0.113.99/32"));
    expect(row).toMatchObject({ distributed: false, nodeId });
    await admin.bans.delete({ id: row?.id ?? "" });
    // The release reaches the node the row names and the other one alike.
    for (const node of [
      { id: nodeId, clusterId },
      { id: peer.id, clusterId: other.id },
    ]) {
      const page = await banChanges(ctx.db, node, before, 100);
      expect(page.liftedOwn.map((b) => b.cidr)).toContain("203.0.113.99/32");
    }
    await admin.settings.setBans(settings);
  });

  it("gives new sites and applications a random prefix and keeps a replaced one for 24 hours", async () => {
    await admin.clusters.setPortPools({
      clusterId,
      pools: [{ protocol: "tcp", from: 21000, to: 21010 }],
    });
    const site = await createSite("cname", ["cname.g10.test"]);
    const { app: l4 } = await admin.l4Apps.create({
      clusterId,
      name: "ssh",
      protocol: "tcp",
      port: 21000,
      origins: [{ address: "origin.example.com", port: 22 }],
    });
    expect(site.cnamePrefix).toMatch(RANDOM_PREFIX);
    expect(l4.cnamePrefix).toMatch(RANDOM_PREFIX);
    expect(site.cnamePrefix).not.toBe(l4.cnamePrefix);
    // An older site keeps its id as prefix (migration 0056).
    const legacy = await createSite("legacy", ["legacy.g10.test"]);
    await ctx.db
      .update(schema.site)
      .set({ cnamePrefix: legacy.id })
      .where(eq(schema.site.id, legacy.id));
    await admin.dns.saveBinding({
      clusterId,
      binding: { mode: "manual", providerId: null, domain: "edge.g10.test", ttl: 60, lines: [] },
    });
    // Without an account the zone is the cluster domain: names are relative to it.
    const t0 = Date.now();
    const initial = cnames((await plan(t0)).records);
    expect(initial).toEqual(expect.arrayContaining([site.cnamePrefix, l4.cnamePrefix, legacy.id]));
    expect(await admin.dns.siteTarget({ siteId: site.id })).toMatchObject({
      target: `${site.cnamePrefix}.edge.g10.test`,
      retired: [],
    });

    // Regenerate: a new random prefix, the old name kept in the plan.
    const regenerated = await admin.sites.setCnamePrefix({ id: site.id });
    expect(regenerated.prefix).toMatch(RANDOM_PREFIX);
    expect(regenerated.prefix).not.toBe(site.cnamePrefix);
    expect(regenerated.retired).toEqual([
      { prefix: site.cnamePrefix, expiresAt: expect.any(String) },
    ]);
    const expiresAt = new Date(regenerated.retired[0]?.expiresAt ?? "").getTime();
    expect(Math.abs(expiresAt - (Date.now() + 24 * 3600_000))).toBeLessThan(60_000);
    const during = cnames((await plan(Date.now())).records);
    expect(during).toEqual(expect.arrayContaining([site.cnamePrefix, regenerated.prefix]));
    expect(await admin.dns.siteTarget({ siteId: site.id })).toMatchObject({
      target: `${regenerated.prefix}.edge.g10.test`,
      retired: [{ name: `${site.cnamePrefix}.edge.g10.test`, expiresAt: expect.any(String) }],
    });
    // After 24 hours the old name leaves the plan (injected clock).
    const after = cnames((await plan(expiresAt + 1)).records);
    expect(after).not.toContain(site.cnamePrefix);
    expect(after).toContain(regenerated.prefix);
    const [audit] = (await admin.auditLogs.list({ action: "site.cname_update" })).items;
    expect(audit).toMatchObject({
      targetId: site.id,
      metadata: { from: site.cnamePrefix, to: regenerated.prefix, generated: true },
    });

    // Custom: 1-30 of [a-z0-9-], not taken, not a record name of a binding.
    const custom = await admin.sites.setCnamePrefix({ id: site.id, prefix: "My-Shop" });
    expect(custom.prefix).toBe("my-shop");
    expect(custom.retired.map((r) => r.prefix).sort()).toEqual(
      [site.cnamePrefix, regenerated.prefix].sort(),
    );
    for (const prefix of ["-a", "a-", "a.b", "a_b", "x".repeat(31), ""])
      expect(
        (await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix }))).code,
        prefix,
      ).toBe("BAD_REQUEST");
    // A UUID is only an object's own prefix from before CNAME prefixes.
    const foreign = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix: legacy.id }));
    expect([foreign.code, foreign.data]).toEqual(["CNAME_PREFIX_INVALID", { prefix: legacy.id }]);
    // The older site takes its id back while it still resolves.
    const legacyNew = await admin.sites.setCnamePrefix({ id: legacy.id });
    expect(legacyNew.retired.map((r) => r.prefix)).toEqual([legacy.id]);
    const legacyBack = await admin.sites.setCnamePrefix({
      id: legacy.id,
      prefix: legacy.id.toUpperCase(),
    });
    expect(legacyBack).toEqual({
      prefix: legacy.id,
      retired: [{ prefix: legacyNew.prefix, expiresAt: expect.any(String) }],
    });
    // Another object's prefix and the all-lines names are taken.
    for (const prefix of [l4.cnamePrefix, "all", "all-2"]) {
      const error = await rpcError(admin.sites.setCnamePrefix({ id: site.id, prefix }));
      expect([error.code, error.data], prefix).toEqual(["CNAME_PREFIX_CONFLICT", { prefix }]);
    }
    // A prefix another object gave up stays reserved while it resolves.
    const retiredTaken = await rpcError(
      admin.l4Apps.setCnamePrefix({ id: l4.id, prefix: regenerated.prefix }),
    );
    expect(retiredTaken.code).toBe("CNAME_PREFIX_CONFLICT");
    // The owner takes it back.
    const back = await admin.sites.setCnamePrefix({ id: site.id, prefix: regenerated.prefix });
    expect(back.prefix).toBe(regenerated.prefix);
    expect(back.retired.map((r) => r.prefix).sort()).toEqual([site.cnamePrefix, "my-shop"].sort());
    // Line names and prefixes never meet.
    const groupId = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    const line = await rpcError(
      admin.dns.saveBinding({
        clusterId,
        binding: {
          mode: "manual",
          providerId: null,
          domain: "edge.g10.test",
          ttl: 60,
          lines: [{ name: "my-shop", nodeGroupId: groupId }],
        },
      }),
    );
    expect([line.code, line.data]).toEqual([
      "DNS_BINDING_CONFLICT",
      { name: "my-shop.edge.g10.test" },
    ]);
    await admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "manual",
        providerId: null,
        domain: "edge.g10.test",
        ttl: 60,
        lines: [{ name: "east", nodeGroupId: groupId }],
        lineAliases: true,
      },
    });
    const lineConflict = await rpcError(
      admin.sites.setCnamePrefix({ id: site.id, prefix: "east" }),
    );
    expect(lineConflict.code).toBe("CNAME_PREFIX_CONFLICT");
    // Line aliases cover retired names too.
    const aliases = cnames((await plan(Date.now())).records);
    expect(aliases).toEqual(
      expect.arrayContaining([`east.${site.cnamePrefix}`, `east.${regenerated.prefix}`]),
    );

    // The application: the same rules, its own audit action and DTO.
    const appPrefix = await admin.l4Apps.setCnamePrefix({ id: l4.id, prefix: "game-1" });
    expect(appPrefix).toEqual({
      prefix: "game-1",
      retired: [{ prefix: l4.cnamePrefix, expiresAt: expect.any(String) }],
    });
    const dto = await admin.l4Apps.get({ id: l4.id });
    expect(dto).toMatchObject({
      cnamePrefix: "game-1",
      dnsTarget: "game-1.edge.g10.test",
      dnsRetired: [{ name: `${l4.cnamePrefix}.edge.g10.test`, expiresAt: expect.any(String) }],
    });
    expect((await admin.auditLogs.list({ action: "l4.cname_update" })).items[0]).toMatchObject({
      targetId: l4.id,
      metadata: { from: l4.cnamePrefix, to: "game-1" },
    });

    // The job drops expired names (and republishes DNS of automatic bindings).
    await ctx.db
      .update(schema.cnameRetired)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.cnameRetired.prefix, site.cnamePrefix));
    expect(await expireCnamePrefixes(ctx)).toEqual([clusterId]);
    expect(cnames((await plan(t0)).records)).not.toContain(site.cnamePrefix);
    expect((await admin.dns.siteTarget({ siteId: site.id })).retired.map((r) => r.name)).toEqual([
      "my-shop.edge.g10.test",
    ]);
    // Deleting the site drops its retired names too.
    await admin.sites.delete({ id: site.id });
    const left = await ctx.db.select().from(schema.cnameRetired);
    expect(left.every((row) => row.siteId !== site.id)).toBe(true);
    await admin.dns.saveBinding({ clusterId, binding: { mode: "off" } });
    await admin.l4Apps.delete({ id: l4.id });
    await admin.sites.delete({ id: legacy.id });
  });

  it("keeps a replaced prefix only where the automatic DNS published it", async () => {
    const site = await createSite("unpublished", ["unpublished.g10.test"]);
    const [provider] = await ctx.db
      .insert(schema.platformDnsProvider)
      .values({ name: "Zone", provider: "test", zone: "g10.test", credentialEnvelope: "unused" })
      .returning();
    if (!provider) throw new Error("provider missing");
    await ctx.db
      .insert(schema.dnsBinding)
      .values({ clusterId, mode: "auto", providerId: provider.id, domain: "edge.g10.test" })
      .onConflictDoUpdate({
        target: schema.dnsBinding.clusterId,
        set: { mode: "auto", providerId: provider.id, domain: "edge.g10.test" },
      });
    // Never claimed at the provider (say it collided with a record): gone at once.
    const first = await admin.sites.setCnamePrefix({ id: site.id, prefix: "www" });
    expect(first.retired).toEqual([]);
    // Claimed (published): it keeps resolving for 24 hours.
    await ctx.db.insert(schema.dnsManagedName).values({
      providerId: provider.id,
      clusterId,
      name: "www.edge",
      type: "CNAME",
    });
    const second = await admin.sites.setCnamePrefix({ id: site.id });
    expect(second.retired.map((r) => r.prefix)).toEqual(["www"]);
    await ctx.db
      .delete(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.providerId, provider.id));
    await ctx.db.delete(schema.cnameRetired).where(eq(schema.cnameRetired.siteId, site.id));
    await ctx.db
      .update(schema.dnsBinding)
      .set({ mode: "off", providerId: null, domain: "" })
      .where(eq(schema.dnsBinding.clusterId, clusterId));
    await ctx.db.delete(schema.dnsRevision).where(eq(schema.dnsRevision.clusterId, clusterId));
    await ctx.db
      .delete(schema.platformDnsProvider)
      .where(eq(schema.platformDnsProvider.id, provider.id));
    await admin.sites.delete({ id: site.id });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const site = await createSite("matrix", ["matrix.g10.test"]);
    const reads: [string, string][] = [["GET", `/clusters/${clusterId}/unknown-hosts`]];
    const writes: [string, string, unknown][] = [
      ["PUT", `/clusters/${clusterId}/unknown-hosts`, { settings: { unknownHost: "close" } }],
      ["PUT", `/sites/${site.id}/cname-prefix`, {}],
      ["PUT", `/l4-apps/${missing}/cname-prefix`, { prefix: "abc" }],
    ];
    for (const [method, path] of reads) {
      expect((await api(reader, method, path)).status, `${method} ${path}`).toBe(200);
      const refused = await api(key, method, path);
      expect([refused.status, refused.json.code], `${method} ${path}`).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect([readOnly.status, readOnly.json.code], `${method} ${path}`).toEqual([
        403,
        "ACCESS_KEY_READ_ONLY",
      ]);
      const refused = await api(key, method, path, body);
      expect([refused.status, refused.json.code], `${method} ${path}`).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    // Nothing changed; a write key reaches them.
    expect((await admin.clusters.unknownHosts({ clusterId })).settings.unknownHost).toBe("page");
    expect((await admin.sites.get({ id: site.id })).cnamePrefix).toBe(site.cnamePrefix);
    const written = await api(writer, "PUT", `/sites/${site.id}/cname-prefix`, {
      prefix: "matrix",
    });
    expect([written.status, written.json.prefix]).toEqual([200, "matrix"]);
    expect((await api(writer, "PUT", `/l4-apps/${missing}/cname-prefix`, {})).json.code).toBe(
      "L4_APP_NOT_FOUND",
    );
    expect((await api(writer, "GET", `/clusters/${missing}/unknown-hosts`)).json.code).toBe(
      "CLUSTER_NOT_FOUND",
    );
    // Domains change through sites.update, which service accounts cannot call.
    const domains = await api(key, "PATCH", `/sites/${site.id}`, { domains: [".matrix.g10.test"] });
    expect([domains.status, domains.json.code]).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    await admin.sites.delete({ id: site.id });
  });
});
