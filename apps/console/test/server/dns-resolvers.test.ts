import { dnsResolversInput, parseDnsResolver } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { dnsFixture } from "./dns-server";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("DNS server syntax", () => {
  it.each([
    ["1.1.1.1", { host: "1.1.1.1", port: 53 }],
    ["1.1.1.1:5353", { host: "1.1.1.1", port: 5353 }],
    ["2606:4700::1111", { host: "2606:4700::1111", port: 53 }],
    ["[2606:4700::1111]:5353", { host: "2606:4700::1111", port: 5353 }],
    ["dns.example.com", { host: "dns.example.com", port: 53 }],
    [" Dns.Example.com:853 ", { host: "dns.example.com", port: 853 }],
  ])("accepts %j", (text, parsed) => {
    expect(parseDnsResolver(text)).toEqual(parsed);
  });

  it.each([
    "",
    "1.1.1.1:0",
    "1.1.1.1:65536",
    "[1.1.1.1]:53",
    "[2606:4700::1111",
    "dns.example.com/dns-query",
    "https://dns.example.com",
    "user@dns.example.com",
    "127.1",
    "a b",
  ])("refuses %j", (text) => {
    expect(parseDnsResolver(text)).toBeNull();
  });

  it("limits the list", () => {
    const servers = Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`);
    expect(dnsResolversInput.safeParse({ servers: servers.slice(0, 8) }).success).toBe(true);
    expect(dnsResolversInput.safeParse({ servers }).success).toBe(false);
  });
});

describe("DNS servers for ownership checks in system settings", async () => {
  const saved = await dnsFixture();
  const fallback = await dnsFixture();
  const { ctx, client } = await createTestContext({ EDGEWEIR_DNS_RESOLVERS: fallback.address });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let siteId: string;
  const txt = new Map<string, string>();

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const org = await admin.organizations.create({ name: "Tenant", defaultClusterId: clusterId });
    await admin.users.create({
      name: "Tina",
      email: "tina@tenant.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    siteId = (
      await tenant.sites.create({
        name: "Owned",
        domains: ["alpha-owned.test", "bravo-owned.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    for (const proof of await tenant.domainOwnership.get({ siteId }))
      txt.set(proof.domain, proof.txtValue ?? "");
  });
  afterAll(async () => {
    await Promise.all([saved.close(), fallback.close()]);
    await client.close();
  });

  const publish = (fixture: typeof saved, domain: string) =>
    fixture.records.set(`_edgeweir-verification.${domain}`, [txt.get(domain) ?? ""]);
  const verify = async (domain: string) => {
    // One lookup per proof every five seconds; the test does not wait.
    await ctx.db.update(schema.domainOwnership).set({ lastCheckedAt: null });
    return tenant.domainOwnership.verify({ siteId, domain });
  };

  it("falls back to the environment, then to the system resolver", async () => {
    expect(await admin.settings.dnsResolvers()).toEqual({
      servers: [],
      effectiveServers: [fallback.address],
      source: "environment",
    });
    ctx.env.EDGEWEIR_DNS_RESOLVERS = "";
    try {
      expect(await admin.settings.dnsResolvers()).toEqual({
        servers: [],
        effectiveServers: [],
        source: "default",
      });
    } finally {
      ctx.env.EDGEWEIR_DNS_RESOLVERS = fallback.address;
    }
  });

  it("is for platform administrators only", async () => {
    expect((await rpcError(tenant.settings.dnsResolvers())).code).toBe("FORBIDDEN");
    expect((await rpcError(tenant.settings.setDnsResolvers({ servers: ["1.1.1.1"] }))).code).toBe(
      "FORBIDDEN",
    );
  });

  it("refuses malformed servers and special-purpose addresses the operator did not allow", async () => {
    expect(
      (await rpcError(admin.settings.setDnsResolvers({ servers: ["https://dns.example"] }))).code,
    ).toBe("BAD_REQUEST");
    for (const server of [saved.address, "169.254.169.254", "localhost:53"]) {
      expect(
        (await rpcError(admin.settings.setDnsResolvers({ servers: [server] }))).code,
        server,
      ).toBe("DNS_RESOLVER_REFUSED");
    }
    expect((await admin.settings.dnsResolvers()).source).toBe("environment");
  });

  it("checks ownership through a saved server, which wins over the variable", async () => {
    publish(saved, "alpha-owned.test");
    // The operator's resolver has no such record.
    expect((await rpcError(verify("alpha-owned.test"))).code).toBe("DOMAIN_VERIFY_FAILED");

    ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "127.0.0.0/8";
    try {
      expect(await admin.settings.setDnsResolvers({ servers: [saved.address] })).toEqual({
        servers: [saved.address],
        effectiveServers: [saved.address],
        source: "setting",
      });
      expect(await verify("alpha-owned.test")).toMatchObject({ verified: true, method: "dns" });
    } finally {
      ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "";
    }
  });

  it("applies the outbound policy on every check, without falling back", async () => {
    // Without the allow list the saved loopback server is refused at query
    // time, and the variable does not stand in for it.
    publish(saved, "bravo-owned.test");
    publish(fallback, "bravo-owned.test");
    expect((await rpcError(verify("bravo-owned.test"))).code).toBe("DOMAIN_VERIFY_FAILED");
  });

  it("clears back to the variable and audits every change", async () => {
    expect(await admin.settings.setDnsResolvers({ servers: [] })).toMatchObject({
      servers: [],
      source: "environment",
    });
    expect(await verify("bravo-owned.test")).toMatchObject({ verified: true });
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.dns_resolvers_update"));
    expect(audits.map((a) => a.metadata)).toEqual([
      { before: [], after: [saved.address] },
      { before: [saved.address], after: [] },
    ]);
  });
});
