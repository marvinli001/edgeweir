import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { AddressResolver } from "../../src/server/lib/dns-check";
import { WILDCARD_PROBE_LABEL } from "../../src/server/services/site-launch";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

// The site overview's launch check and the domains tab's DNS card (audit S-1, S-4).

/** A resolver answering from a table; "timeout" fails like a lookup that timed out. */
function fakeResolver(table: Record<string, { v4?: string[]; v6?: string[] } | "timeout">) {
  const lookup = (family: "v4" | "v6") => async (name: string) => {
    const entry = table[name];
    if (entry === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const answer = entry?.[family];
    if (!answer?.length)
      throw Object.assign(new Error("no data"), { code: entry ? "ENODATA" : "ENOTFOUND" });
    return answer;
  };
  return { resolve4: lookup("v4"), resolve6: lookup("v6") } satisfies AddressResolver;
}

describe("site launch check", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let secureId: string;
  const origins = [{ address: "origin.example.com" }];
  ctx.resolver = fakeResolver({
    "shop.test": { v4: ["45.76.1.10"], v6: ["2a05:d014::10"] },
    // A wildcard is looked up by a fixed label under it; the backup and the offline node count.
    [`${WILDCARD_PROBE_LABEL}.shop.test`]: { v4: ["45.76.1.11", "45.76.1.20"] },
    "old.shop.test": { v4: ["45.76.1.10", "198.51.100.7"] },
    "slow.shop.test": "timeout",
  });

  const api = async (key: string, path: string) => {
    const res = await app.request(`${origin}/api/v1${path}`, { headers: { "x-api-key": key } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const certificate = async (values: Partial<typeof schema.certificate.$inferInsert>) => {
    const [row] = await ctx.db
      .insert(schema.certificate)
      .values({ name: "secure", source: "acme", ...values })
      .returning();
    await ctx.db
      .update(schema.site)
      .set({ certificateId: row?.id ?? null })
      .where(eq(schema.site.id, secureId));
    return row?.id ?? "";
  };
  const coverage = async () => (await admin.sites.launch({ id: secureId })).certificate;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.test", "*.shop.test", "old.shop.test", "new.shop.test", "slow.shop.test"],
        origins,
      })
    ).site.id;
    secureId = (
      await admin.sites.create({
        name: "secure",
        domains: ["secure.test", "www.secure.test"],
        origins,
      })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("knows no edge address before the cluster's nodes have one", async () => {
    const launch = await admin.sites.launch({ id: siteId });
    expect(launch.addresses).toEqual([]);
    expect(launch.domains.map((d) => d.pointing)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(launch.delivery).toMatchObject({ state: "pending", totalNodes: 0 });
  });

  it("lists the online nodes' addresses and where each domain points", async () => {
    const now = new Date();
    const [a, b, offline] = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, name: "edge-a", lastSeenAt: now },
        { clusterId, name: "edge-b", lastSeenAt: now },
        { clusterId, name: "edge-old", lastSeenAt: new Date(now.getTime() - 3_600_000) },
      ])
      .returning({ id: schema.node.id });
    await ctx.db.insert(schema.nodeIp).values([
      // Reported addresses: public ones are the node's scheduling addresses, private ones never.
      { nodeId: a?.id ?? "", address: "45.76.1.10" },
      { nodeId: a?.id ?? "", address: "2a05:d014::10" },
      { nodeId: a?.id ?? "", address: "10.0.0.5" },
      // Configured addresses replace the reported ones; a backup is not a record to create.
      { nodeId: b?.id ?? "", address: "45.76.9.200" },
      { nodeId: b?.id ?? "", address: "45.76.1.11", source: "configured" },
      { nodeId: b?.id ?? "", address: "45.76.1.12", source: "configured", level: 1 },
      { nodeId: offline?.id ?? "", address: "45.76.1.20" },
    ]);
    const launch = await admin.sites.launch({ id: siteId });
    expect(launch.addresses).toEqual(["45.76.1.10", "45.76.1.11", "2a05:d014::10"]);
    expect(launch.domains).toEqual([
      { name: "shop.test", probe: "shop.test", pointing: "ok" },
      {
        name: "*.shop.test",
        probe: `${WILDCARD_PROBE_LABEL}.shop.test`,
        pointing: "ok",
      },
      { name: "old.shop.test", probe: "old.shop.test", pointing: "elsewhere" },
      { name: "new.shop.test", probe: "new.shop.test", pointing: "unresolved" },
      { name: "slow.shop.test", probe: "slow.shop.test", pointing: "unknown" },
    ]);
    expect(launch.certificate).toEqual({
      state: "none",
      id: null,
      name: "",
      uncovered: [],
      error: "",
    });
    expect(launch.delivery).toMatchObject({ state: "pending", totalNodes: 2, canary: null });
  });

  it("tells whether the site's certificate covers its domains", async () => {
    expect((await coverage()).state).toBe("none");
    const pending = await certificate({ status: "pending" });
    expect(await coverage()).toEqual({
      state: "issuing",
      id: pending,
      name: "secure",
      uncovered: ["secure.test", "www.secure.test"],
      error: "",
    });
    await certificate({ status: "error", lastError: "acme_caa" });
    expect(await coverage()).toMatchObject({ state: "failed", error: "acme_caa" });

    const all = await ctx.nodeCa.issueServerCertificate(["secure.test", "*.secure.test"]);
    const year = new Date(Date.now() + 365 * 86_400_000);
    await certificate({ status: "ready", chainPem: all.certificatePem, notAfter: year });
    expect(await coverage()).toMatchObject({ state: "covered", uncovered: [] });
    // A renewal that failed keeps a valid chain in place.
    await certificate({
      status: "error",
      lastError: "acme_rate_limited",
      chainPem: all.certificatePem,
      notAfter: year,
    });
    expect((await coverage()).state).toBe("covered");
    // An upload nodes cannot load (markUnloadableCertificates).
    await certificate({
      source: "upload",
      status: "error",
      lastError: "certificate_chain_explicit_curve",
      chainPem: all.certificatePem,
      notAfter: year,
    });
    expect(await coverage()).toMatchObject({
      state: "failed",
      error: "certificate_chain_explicit_curve",
      uncovered: [],
    });
    await certificate({
      status: "ready",
      chainPem: all.certificatePem,
      notAfter: new Date(Date.now() - 1000),
    });
    expect((await coverage()).state).toBe("expired");

    const one = await ctx.nodeCa.issueServerCertificate(["secure.test"]);
    await certificate({ status: "ready", chainPem: one.certificatePem, notAfter: year });
    expect(await coverage()).toMatchObject({ state: "uncovered", uncovered: ["www.secure.test"] });
    // Reissued for the new domain: the nodes keep the current chain meanwhile.
    await certificate({ status: "issuing", chainPem: one.certificatePem, notAfter: year });
    expect(await coverage()).toMatchObject({ state: "issuing", uncovered: ["www.secure.test"] });
  });

  it("answers service accounts with sites:read", async () => {
    const reader = await admin.serviceAccounts.create({ name: "reader", scopes: ["sites:read"] });
    const other = await admin.serviceAccounts.create({ name: "other", scopes: ["usage:read"] });
    const readerKey = (await admin.serviceAccounts.createKey({ id: reader.id })).secret;
    const otherKey = (await admin.serviceAccounts.createKey({ id: other.id })).secret;
    const read = await api(readerKey, `/sites/${siteId}/launch`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ addresses: ["45.76.1.10", "45.76.1.11", "2a05:d014::10"] });
    const refused = await api(otherKey, `/sites/${siteId}/launch`);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "SCOPE_REQUIRED", data: { scope: "sites:read" } });
  });
});

describe("new sites", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
  });
  afterAll(() => pglite.close());

  it("are named after their first domain unless named", async () => {
    const created = await admin.sites.create({
      domains: ["*.Wild.test", "wild.test"],
      origins: [{ address: "origin.example.com" }],
    });
    expect(created.site.name).toBe("*.wild.test");
    expect(created.revision.reasonParams).toEqual({ site: "*.wild.test" });
    const [entry] = (await admin.auditLogs.list({ action: "site.create" })).items;
    expect(entry).toMatchObject({ targetName: "*.wild.test", metadata: { name: "*.wild.test" } });
  });
});
