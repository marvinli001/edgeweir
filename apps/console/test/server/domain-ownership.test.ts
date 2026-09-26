import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { domainRoot } from "../../src/server/lib/domain-root";
import { latestRevision } from "../../src/server/services/revisions";
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

describe("M5 TXT ownership gates and competing claims", async () => {
  const dns = await dnsFixture();
  const { ctx, client: db } = await createTestContext({ EDGEWEIR_DNS_RESOLVERS: dns.address });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient,
    a: ApiClient,
    b: ApiClient,
    clusterId: string,
    siteA: string,
    siteB: string,
    tokenA: string,
    tokenB: string;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const clients: ApiClient[] = [];
    for (const name of ["alpha", "bravo"]) {
      const org = await admin.organizations.create({ name, defaultClusterId: clusterId });
      await admin.users.create({
        name,
        email: `${name}@ownership.test`,
        password: PASSWORD,
        organizationId: org.id,
      });
      clients.push(rpcClient(app, origin, await signIn(app, origin, `${name}@ownership.test`)));
    }
    [a, b] = clients as [ApiClient, ApiClient];
  });
  afterAll(async () => {
    await dns.close();
    await db.close();
  });
  const snapshot = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  it("uses the public suffix list including private registries", () => {
    expect(domainRoot("www.example.co.uk")).toBe("example.co.uk");
    expect(domainRoot("*.alice.github.io")).toBe("alice.github.io");
    expect(() => domainRoot("co.uk")).toThrow();
  });
  it("does not publish pending domains and permits competing pending claims", async () => {
    siteA = (
      await a.sites.create({
        name: "A",
        domains: ["customer.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    siteB = (
      await b.sites.create({
        name: "B",
        domains: ["customer.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    expect((await snapshot()).sites).toHaveLength(0);
    const pa = (await a.domainOwnership.get({ siteId: siteA }))[0],
      pb = (await b.domainOwnership.get({ siteId: siteB }))[0];
    expect(pa?.verified).toBe(false);
    expect(pa?.txtName).toBe("_edgeweir-verification.customer.test");
    tokenA = pa?.txtValue ?? "";
    tokenB = pb?.txtValue ?? "";
    expect(tokenA).not.toBe(tokenB);
    expect((await rpcError(b.domainOwnership.get({ siteId: siteA }))).code).toBe("SITE_NOT_FOUND");
    expect((await rpcError(b.domainOwnership.prepare({ siteId: siteA }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });
  it("checks the exact organization's TXT proof and blocks wildcard shadowing", async () => {
    dns.records.set("_edgeweir-verification.customer.test", [tokenA]);
    expect(
      (await rpcError(b.domainOwnership.verify({ siteId: siteB, domain: "customer.test" }))).code,
    ).toBe("DOMAIN_VERIFY_FAILED");
    expect(
      (await rpcError(b.domainOwnership.verify({ siteId: siteB, domain: "customer.test" }))).code,
    ).toBe("DOMAIN_VERIFY_BUSY");
    expect(
      (await a.domainOwnership.verify({ siteId: siteA, domain: "customer.test" })).verified,
    ).toBe(true);
    expect((await snapshot()).sites.map((s) => s.id)).toEqual([siteA]);
    expect((await rpcError(b.sites.update({ id: siteB, domains: ["*.customer.test"] }))).code).toBe(
      "DOMAIN_IN_USE",
    );
    dns.records.set("_edgeweir-verification.customer.test", [tokenB]);
    await ctx.db.update(schema.domainOwnership).set({ lastCheckedAt: null });
    expect(
      (await rpcError(b.domainOwnership.verify({ siteId: siteB, domain: "customer.test" }))).code,
    ).toBe("DOMAIN_IN_USE");
  });
  it("revokes all matching routes and refuses a rollback that would restore them", async () => {
    const before = Number((await snapshot()).revision);
    expect(
      (await rpcError(b.domainOwnership.revoke({ siteId: siteA, domain: "customer.test" }))).code,
    ).toBe("SITE_NOT_FOUND");
    await a.domainOwnership.revoke({ siteId: siteA, domain: "customer.test" });
    expect((await snapshot()).sites).toHaveLength(0);
    expect(
      (await rpcError(admin.clusters.rollback({ id: clusterId, revision: before }))).code,
    ).toBe("ROLLBACK_RESOURCE_UNAVAILABLE");
    const prepared = await a.domainOwnership.prepare({ siteId: siteA });
    expect(prepared[0]?.verified).toBe(false);
  });
  it("records administrator exemptions and releases a root after its last site is deleted", async () => {
    const approved = await admin.domainOwnership.approve({
      siteId: siteA,
      domain: "customer.test",
    });
    expect(approved[0]).toMatchObject({ verified: true, method: "admin" });
    expect(
      (
        await ctx.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, "domain.bypass"))
      ).length,
    ).toBeGreaterThan(0);
    await a.sites.delete({ id: siteA });
    await ctx.db.update(schema.domainOwnership).set({ lastCheckedAt: null });
    expect(
      (await b.domainOwnership.verify({ siteId: siteB, domain: "customer.test" })).verified,
    ).toBe(true);
    expect((await snapshot()).sites.map((s) => s.id)).toEqual([siteB]);
  });
});
