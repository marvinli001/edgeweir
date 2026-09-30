import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { syncTenantRecords } from "../../src/server/services/dns-records";
import { dnsFixture as providers } from "./dns-fixture";
import { dnsFixture as txtAuthority } from "./dns-server";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

/** Credentials match the provider formats of the catalog (DigitalOcean: 64 hex digits). */
const doToken = "0".repeat(64);

describe("automatic records in an organization's own zones", async () => {
  const authority = await txtAuthority();
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
    EDGEWEIR_DNS_RESOLVERS: authority.address,
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient, acme: ApiClient, other: ApiClient;
  let siteId = "",
    acmeOrg = "",
    cloudflareId = "",
    target = "";
  const zone = (token: string, name: string) => providers.records(token, name);
  /** The TXT authority answers what the provider zones hold (as the Internet would). */
  const publish = () => {
    authority.records.clear();
    for (const [token, name] of [
      ["cf-token-0123456789abcdef", "acme.test"],
      [doToken, "acme.net"],
    ] as const)
      for (const r of zone(token, name).filter((r) => r.type === "TXT"))
        authority.records.set(`${r.name}.${name}`, [
          ...(authority.records.get(`${r.name}.${name}`) ?? []),
          r.data,
        ]);
  };
  const records = async () => (await acme.siteDns.records({ siteId })).items;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    providers.reset();
    providers.accounts.set("platform-token", { zones: ["platform.test"] });
    providers.accounts.set("cf-token-0123456789abcdef", { zones: ["acme.test"] });
    providers.accounts.set(doToken, {
      zones: ["acme.net"],
    });
    providers.accounts.set("evil-token-0123456789abcdef", { zones: ["acme.test"] });
    providers.set("cf-token-0123456789abcdef", "acme.test", [
      { name: "shop", type: "A", data: "192.0.2.10", ttl: 300 },
      { name: "_edgeweir-verification", type: "TXT", data: "someone-else", ttl: 300 },
      { name: "keep", type: "TXT", data: "x", ttl: 300 },
    ]);
    const clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const provider = await admin.dns.createProvider({
      name: "Platform",
      provider: "test",
      zone: "platform.test",
      credentials: { api_token: "platform-token" },
    });
    await admin.dns.saveBinding({
      clusterId,
      binding: { mode: "auto", providerId: provider.id, domain: "cdn.platform.test" },
    });
    for (const [name, email] of [
      ["Acme", "owner@acme.test"],
      ["Other", "owner@other.test"],
    ] as const) {
      const org = await admin.organizations.create({ name, defaultClusterId: clusterId });
      if (name === "Acme") acmeOrg = org.id;
      await admin.users.create({
        name,
        email,
        password: PASSWORD,
        organizationId: org.id,
        role: "owner",
      });
    }
    acme = rpcClient(app, origin, await signIn(app, origin, "owner@acme.test"));
    other = rpcClient(app, origin, await signIn(app, origin, "owner@other.test"));
  });
  afterAll(async () => {
    await authority.close();
    await db.close();
  });

  it("links credentials to zones with automatic records, tested before saving", async () => {
    expect(
      await acme.dnsCredentials.zones({
        provider: "cloudflare",
        credentials: { api_token: "cf-token-0123456789abcdef" },
      }),
    ).toEqual({ zones: ["acme.test"] });
    expect(
      await acme.dnsCredentials.test({
        provider: "cloudflare",
        credentials: { api_token: "cf-token-0123456789abcdef" },
        zone: "acme.test",
      }),
    ).toEqual({ ok: true, records: 3 });
    cloudflareId = (
      await acme.dnsCredentials.create({
        name: "Acme Cloudflare",
        provider: "cloudflare",
        zone: "acme.test",
        credentials: { api_token: "cf-token-0123456789abcdef" },
        autoRecords: true,
      })
    ).id;
    await acme.dnsCredentials.create({
      name: "Acme DigitalOcean",
      provider: "digitalocean",
      zone: "acme.net",
      credentials: {
        api_token: doToken,
      },
      autoRecords: true,
    });
    // Another organization's credential for the same zone never writes Acme's domains.
    await other.dnsCredentials.create({
      name: "Squatter",
      provider: "cloudflare",
      zone: "acme.test",
      credentials: { api_token: "evil-token-0123456789abcdef" },
      autoRecords: true,
    });
    expect((await acme.dnsCredentials.list()).map((c) => c.name)).toEqual([
      "Acme Cloudflare",
      "Acme DigitalOcean",
    ]);
    expect((await rpcError(other.dnsCredentials.test({ id: cloudflareId }))).code).toBe(
      "DNS_CREDENTIAL_NOT_FOUND",
    );
    expect(
      (
        await rpcError(
          acme.dnsCredentials.create({
            name: "x",
            provider: "cloudflare",
            zone: "acme.test",
            credentials: { api_token: "" },
          }),
        )
      ).code,
    ).toBe("DNS_CREDENTIAL_INVALID");
  });

  it("writes the ownership TXT and CNAMEs when domains are added, without overwriting conflicts", async () => {
    siteId = (
      await acme.sites.create({
        name: "acme",
        domains: ["acme.test", "www.acme.test", "shop.acme.test", "*.img.acme.test", "acme.net"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    target = `${siteId}.cdn.platform.test`;
    expect(await records()).toEqual([]);
    expect((await acme.siteDns.records({ siteId })).managed).toBe(true);
    await syncTenantRecords(ctx);
    const acmeTest = zone("cf-token-0123456789abcdef", "acme.test");
    const proof = (await acme.domainOwnership.get({ siteId })).find(
      (p) => p.domain === "acme.test",
    );
    expect(acmeTest).toEqual(
      expect.arrayContaining([
        { name: "_edgeweir-verification", type: "TXT", data: proof?.txtValue, ttl: 600 },
        { name: "_edgeweir-verification", type: "TXT", data: "someone-else", ttl: 300 },
        { name: "@", type: "CNAME", data: target, ttl: 600 },
        { name: "www", type: "CNAME", data: target, ttl: 600 },
        { name: "*.img", type: "CNAME", data: target, ttl: 600 },
        { name: "shop", type: "A", data: "192.0.2.10", ttl: 300 },
        { name: "keep", type: "TXT", data: "x", ttl: 300 },
      ]),
    );
    expect(acmeTest.some((r) => r.name === "shop" && r.type === "CNAME")).toBe(false);
    // The apex of a provider without CNAME flattening or ALIAS is only shown.
    expect(zone(doToken, "acme.net").map((r) => `${r.name} ${r.type}`)).toEqual([
      "_edgeweir-verification TXT",
    ]);
    const items = await records();
    const status = (name: string, type: string) =>
      items.find((i) => i.name === name && i.type === type)?.status;
    expect(status("shop.acme.test", "CNAME")).toBe("conflict");
    expect(items.find((i) => i.name === "shop.acme.test")?.conflicts).toEqual([
      { type: "A", data: "192.0.2.10" },
    ]);
    expect(status("acme.test", "CNAME")).toBe("written");
    expect(status("acme.net", "CNAME")).toBe("unsupported");
    expect(status("_edgeweir-verification.acme.net", "TXT")).toBe("written");
    // Nothing from the other organization's credential.
    expect(
      providers.calls.filter(
        (c) => c.token === "evil-token-0123456789abcdef" && c.command !== "dns.list",
      ),
    ).toEqual([]);
    const audit = await admin.auditLogs.list({ action: "dns_record.create" });
    expect(audit.items.length).toBeGreaterThanOrEqual(5);
    expect(audit.items.every((e) => e.organizationId === acmeOrg)).toBe(true);
    expect((await admin.auditLogs.list({ action: "dns_record.conflict" })).total).toBe(1);
  });

  it("isolates records by organization", async () => {
    expect((await rpcError(other.siteDns.records({ siteId }))).code).toBe("SITE_NOT_FOUND");
    const shop = (await records()).find((i) => i.name === "shop.acme.test");
    expect((await rpcError(other.siteDns.confirm({ siteId, id: shop?.id ?? "" }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });

  it("replaces a conflict only after an owner or admin confirms it", async () => {
    await syncTenantRecords(ctx);
    expect(
      zone("cf-token-0123456789abcdef", "acme.test").find((r) => r.name === "shop")?.type,
    ).toBe("A");
    const shop = (await records()).find((i) => i.name === "shop.acme.test");
    await admin.users.create({
      name: "Acme member",
      email: "member@acme.test",
      password: PASSWORD,
      organizationId: acmeOrg,
      role: "member",
    });
    const member = rpcClient(app, origin, await signIn(app, origin, "member@acme.test"));
    expect((await rpcError(member.siteDns.confirm({ siteId, id: shop?.id ?? "" }))).code).toBe(
      "ORG_ADMIN_REQUIRED",
    );
    expect((await member.siteDns.records({ siteId })).items.length).toBeGreaterThan(0);
    const after = await acme.siteDns.confirm({ siteId, id: shop?.id ?? "" });
    expect(after.items.find((i) => i.id === shop?.id)?.status).toBe("written");
    expect(zone("cf-token-0123456789abcdef", "acme.test").filter((r) => r.name === "shop")).toEqual(
      [{ name: "shop", type: "CNAME", data: target, ttl: 600 }],
    );
    const [entry] = (await admin.auditLogs.list({ action: "dns_record.overwrite" })).items;
    expect(entry).toMatchObject({ organizationId: acmeOrg });
    expect(entry?.metadata).toMatchObject({ replaced: [{ type: "A", data: "192.0.2.10" }] });
  });

  it("verifies ownership through the written TXT, then removes only its own TXT", async () => {
    publish();
    // Checks of the same domain are at least 5 s apart; the earlier runs just checked.
    await ctx.db.update(schema.domainOwnership).set({ lastCheckedAt: null });
    await syncTenantRecords(ctx);
    const proofs = await acme.domainOwnership.get({ siteId });
    expect(proofs.every((p) => p.verified)).toBe(true);
    await syncTenantRecords(ctx);
    expect(zone("cf-token-0123456789abcdef", "acme.test").filter((r) => r.type === "TXT")).toEqual([
      { name: "_edgeweir-verification", type: "TXT", data: "someone-else", ttl: 300 },
      { name: "keep", type: "TXT", data: "x", ttl: 300 },
    ]);
    expect((await records()).some((i) => i.purpose === "ownership")).toBe(false);
  });

  it("repairs a record deleted outside the console", async () => {
    providers.set(
      "cf-token-0123456789abcdef",
      "acme.test",
      zone("cf-token-0123456789abcdef", "acme.test").filter((r) => r.name !== "www"),
    );
    await acme.siteDns.sync({ siteId });
    expect(zone("cf-token-0123456789abcdef", "acme.test").find((r) => r.name === "www")?.data).toBe(
      target,
    );
  });

  it("adopts identical records without owning them, and holds conflicts of any type", async () => {
    const cf = "cf-token-0123456789abcdef";
    const before = zone(cf, "acme.test");
    providers.set(cf, "acme.test", [
      ...before,
      { name: "adopt", type: "CNAME", data: target, ttl: 300 },
      { name: "txt", type: "TXT", data: "hello", ttl: 300 },
    ]);
    const site = await acme.sites.get({ id: siteId });
    await acme.sites.update({
      id: siteId,
      domains: [...site.domains, "adopt.acme.test", "txt.acme.test"],
    });
    await syncTenantRecords(ctx);
    const status = async (name: string) =>
      (await records()).find((i) => i.name === name && i.type === "CNAME");
    expect((await status("adopt.acme.test"))?.status).toBe("written");
    // A CNAME cannot share its name with any record, a TXT included.
    expect((await status("txt.acme.test"))?.conflicts).toEqual([{ type: "TXT", data: "hello" }]);
    // Consent covers the records shown: a record added afterwards needs a new confirmation.
    await ctx.db
      .update(schema.dnsOwnedRecord)
      .set({ confirmed: true })
      .where(eq(schema.dnsOwnedRecord.domain, "txt.acme.test"));
    providers.set(cf, "acme.test", [
      ...zone(cf, "acme.test"),
      { name: "txt", type: "A", data: "192.0.2.99", ttl: 300 },
    ]);
    await syncTenantRecords(ctx);
    expect((await status("txt.acme.test"))?.status).toBe("conflict");
    expect((await status("txt.acme.test"))?.conflicts).toHaveLength(2);
    expect(zone(cf, "acme.test").filter((r) => r.name === "txt")).toHaveLength(2);
    // The adopted record stays when the domain goes: the console did not create it.
    await acme.sites.update({ id: siteId, domains: site.domains });
    await syncTenantRecords(ctx);
    expect(zone(cf, "acme.test")).toContainEqual({
      name: "adopt",
      type: "CNAME",
      data: target,
      ttl: 300,
    });
    expect(await status("adopt.acme.test")).toBeUndefined();
    providers.set(
      cf,
      "acme.test",
      zone(cf, "acme.test").filter((r) => r.name !== "adopt" && r.name !== "txt"),
    );
    // One credential per organization and zone writes automatic records.
    expect(
      (
        await rpcError(
          acme.dnsCredentials.create({
            name: "Second",
            provider: "cloudflare",
            zone: "acme.test",
            credentials: { api_token: cf },
            autoRecords: true,
          }),
        )
      ).code,
    ).toBe("DNS_AUTO_RECORDS_EXISTS");
  });

  it("removes only its own records when a domain or the site is deleted", async () => {
    const site = await acme.sites.get({ id: siteId });
    await acme.sites.update({
      id: siteId,
      domains: site.domains.filter((d) => d !== "www.acme.test"),
    });
    await syncTenantRecords(ctx);
    expect(zone("cf-token-0123456789abcdef", "acme.test").some((r) => r.name === "www")).toBe(
      false,
    );
    expect((await admin.auditLogs.list({ action: "dns_record.delete" })).total).toBeGreaterThan(0);
    expect((await rpcError(acme.dnsCredentials.delete({ id: cloudflareId }))).code).toBe(
      "DNS_CREDENTIAL_IN_USE",
    );
    await acme.sites.delete({ id: siteId });
    await syncTenantRecords(ctx);
    expect(zone("cf-token-0123456789abcdef", "acme.test")).toEqual([
      { name: "_edgeweir-verification", type: "TXT", data: "someone-else", ttl: 300 },
      { name: "keep", type: "TXT", data: "x", ttl: 300 },
    ]);
    expect(zone(doToken, "acme.net")).toEqual([]);
    const owned = await ctx.db
      .select()
      .from(schema.dnsOwnedRecord)
      .where(eq(schema.dnsOwnedRecord.organizationId, acmeOrg));
    expect(owned).toEqual([]);
    await acme.dnsCredentials.update({ id: cloudflareId, autoRecords: false });
    await acme.dnsCredentials.delete({ id: cloudflareId });
  });
});
