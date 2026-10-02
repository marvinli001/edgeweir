import type { CaaRecord } from "node:dns";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { type AddressResolver, CAA_ISSUERS, caaPermits } from "../../src/server/lib/dns-check";
import { dnsFixture } from "./dns-fixture";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// One-click HTTPS asks https.check what it would request and lists every
// blocker at once: nodes, DNS, the DNS-01 credential and CAA (audit S-2).

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

type Entry = { v4?: string[]; caa?: CaaRecord[] } | "timeout";

/** A resolver answering A and CAA lookups from a table; "timeout" fails like a slow server. */
function fakeResolver(table: Record<string, Entry>) {
  const fail = (name: string) => {
    const entry = table[name];
    if (entry === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    throw Object.assign(new Error("no data"), { code: entry ? "ENODATA" : "ENOTFOUND" });
  };
  return {
    resolve4: async (name: string) => {
      const entry = table[name];
      if (entry !== "timeout" && entry?.v4?.length) return entry.v4;
      return fail(name);
    },
    resolve6: async (name: string) => fail(name),
    resolveCaa: async (name: string) => {
      const entry = table[name];
      if (entry !== "timeout" && entry?.caa?.length) return entry.caa;
      return fail(name);
    },
  } satisfies AddressResolver;
}

describe("CAA (RFC 8659)", () => {
  const le = CAA_ISSUERS.letsencrypt;
  const check = (table: Record<string, Entry>, name: string, method = "http-01") =>
    caaPermits(fakeResolver(table), name, le, method);

  it("reads the closest CAA record set up the tree", async () => {
    const parent = { "example.test": { caa: [{ critical: 0, issue: "sectigo.com" }] } };
    expect(await check(parent, "a.b.example.test")).toBe("forbidden");
    expect(await check({}, "a.b.example.test")).toBe("allowed");
    // The name's own set wins over its parent's.
    expect(
      await check(
        { ...parent, "b.example.test": { caa: [{ critical: 0, issue: "letsencrypt.org" }] } },
        "a.b.example.test",
      ),
    ).toBe("allowed");
    expect(await check({ "example.test": "timeout" }, "a.example.test")).toBe("unknown");
    expect(
      await caaPermits(fakeResolver(parent), "a.example.test", CAA_ISSUERS.zerossl, "http-01"),
    ).toBe("allowed");
  });

  it("applies issuewild to wildcards only, empty values, parameters and critical tags", async () => {
    const wild = {
      "example.test": {
        caa: [
          { critical: 0, issue: "letsencrypt.org" },
          { critical: 0, issuewild: ";" },
        ],
      },
    };
    expect(await check(wild, "*.example.test")).toBe("forbidden");
    expect(await check(wild, "example.test")).toBe("allowed");
    expect(
      await check({ "example.test": { caa: [{ critical: 0, issue: ";" }] } }, "example.test"),
    ).toBe("forbidden");
    expect(
      await check({ "example.test": { caa: [{ critical: 0, iodef: "mailto:a@b.test" }] } }, "x"),
    ).toBe("allowed");
    const methods = {
      "example.test": {
        caa: [{ critical: 0, issue: "LetsEncrypt.org; validationmethods=dns-01" }],
      },
    };
    expect(await check(methods, "example.test", "http-01")).toBe("forbidden");
    expect(await check(methods, "example.test", "dns-01")).toBe("allowed");
    const critical = {
      "example.test": {
        caa: [
          { critical: 0, issue: "letsencrypt.org" },
          { critical: 128, tbs: "unknown" } as unknown as CaaRecord,
        ],
      },
    };
    expect(await check(critical, "example.test")).toBe("forbidden");
  });

  it("checks nothing without CAA lookups", async () => {
    const { resolve4, resolve6 } = fakeResolver({});
    expect(await caaPermits({ resolve4, resolve6 }, "example.test", le, "http-01")).toBe("unknown");
  });
});

describe("https.check", async () => {
  const { ctx, client } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const table: Record<string, Entry> = {};
  ctx.resolver = fakeResolver(table);
  let api: ApiClient;
  let siteId = "";
  let wildId = "";
  let nodeId = "";
  const node = (set: Partial<typeof schema.node.$inferInsert>) =>
    ctx.db.update(schema.node).set(set).where(eq(schema.node.id, nodeId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const clusterId = (await api.clusters.list())[0]?.id ?? "";
    siteId = (
      await api.sites.create({
        name: "plain",
        domains: ["b.check.test", "a.check.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    wildId = (
      await api.sites.create({
        name: "wild",
        domains: ["wild.test", "*.wild.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        nodeGroupId: (await api.nodeGroups.list({ clusterId }))[0]?.id ?? "",
        name: "edge-1",
        supportedFeatures: ["tls-v1"],
      })
      .returning();
    nodeId = row?.id ?? "";
    await ctx.db
      .insert(schema.nodeIp)
      .values({ nodeId, address: "203.0.113.10", source: "configured" });
  });
  beforeEach(() => dnsFixture.reset());
  afterAll(() => client.close());

  it("lists every blocker of an HTTP-01 site at once", async () => {
    table["a.check.test"] = { v4: ["198.51.100.7"] };
    table["check.test"] = { caa: [{ critical: 0, issue: "sectigo.com" }] };
    const check = await api.https.check({ id: siteId });
    expect(check.request).toEqual({
      name: "plain",
      names: ["a.check.test", "b.check.test"],
      email: "admin@example.com",
      challenge: "http01",
      dnsCredentialId: null,
    });
    expect(check.blockers).toEqual([
      { code: "nodes_offline", cluster: "default" },
      { code: "dns_not_pointing", name: "a.check.test", pointing: "elsewhere" },
      { code: "dns_not_pointing", name: "b.check.test", pointing: "unresolved" },
      { code: "caa_forbidden", name: "a.check.test" },
      { code: "caa_forbidden", name: "b.check.test" },
    ]);
    // ZeroSSL issues through Sectigo.
    expect(
      (await api.https.check({ id: siteId, ca: "zerossl" })).blockers.map((b) => b.code),
    ).not.toContain("caa_forbidden");

    await node({ lastSeenAt: new Date() });
    expect((await api.https.check({ id: siteId })).blockers[0]).toEqual({
      code: "nodes_lack_http01",
      nodes: ["edge-1"],
    });

    await node({ lastSeenAt: new Date(), supportedFeatures: ["tls-v1", "http01-v1"] });
    table["a.check.test"] = { v4: ["203.0.113.10"] };
    table["b.check.test"] = "timeout";
    delete table["check.test"];
    expect((await api.https.check({ id: siteId })).blockers).toEqual([]);
  });

  it("uses DNS-01 with a credential covering every name of a wildcard site and tests it", async () => {
    const missing = await api.https.check({ id: wildId });
    expect(missing.request).toMatchObject({
      names: ["wild.test", "*.wild.test"],
      challenge: "dns01",
      dnsCredentialId: null,
    });
    expect(missing.blockers).toEqual([
      { code: "dns_credential_missing", names: ["wild.test", "*.wild.test"] },
    ]);
    await api.dnsCredentials.create({
      name: "Other zone",
      provider: "cloudflare",
      zone: "other.test",
      credentials: { api_token: "other-token-0123456789" },
    });
    const credential = await api.dnsCredentials.create({
      name: "Wild zone",
      provider: "cloudflare",
      zone: "wild.test",
      credentials: { api_token: "wild-token-0123456789" },
    });
    const refused = await api.https.check({ id: wildId });
    expect(refused.request.dnsCredentialId).toBe(credential.id);
    expect(refused.blockers).toEqual([
      { code: "dns_credential_failed", credential: "Wild zone", error: "DNS_PROVIDER_AUTH_FAILED" },
    ]);
    dnsFixture.accounts.set("wild-token-0123456789", { zones: ["wild.test"] });
    table["wild.test"] = {
      caa: [
        { critical: 0, issue: "letsencrypt.org" },
        { critical: 0, issuewild: "sectigo.com" },
      ],
    };
    expect((await api.https.check({ id: wildId })).blockers).toEqual([
      { code: "caa_forbidden", name: "*.wild.test" },
    ]);
    delete table["wild.test"];
    expect((await api.https.check({ id: wildId })).blockers).toEqual([]);
    expect(dnsFixture.calls.some((c) => c.command === "dns.test")).toBe(true);
  });

  it("binds a request to the site only when it covers the site and is the only one", async () => {
    const { request } = await api.https.check({ id: wildId });
    const ask = (names: string[]) =>
      api.certificates.request({
        name: request.name,
        names,
        email: request.email,
        challenge: "dns01",
        dnsCredentialId: request.dnsCredentialId ?? undefined,
        bindSiteId: wildId,
      });
    expect(await rpcError(ask(["wild.test"]))).toMatchObject({
      code: "CERTIFICATE_DOMAIN_MISMATCH",
      data: { domains: "*.wild.test" },
    });
    const cert = await ask(request.names);
    expect(cert).toMatchObject({ status: "pending", bindSiteId: wildId });
    expect((await rpcError(ask(request.names))).code).toBe("CERTIFICATE_BUSY");
    // Its email becomes the default of the next request.
    const [row] = await ctx.db
      .select({ acme: schema.certificate.acme })
      .from(schema.certificate)
      .where(eq(schema.certificate.id, cert.id));
    expect(row?.acme.email).toBe("admin@example.com");
    await ctx.db
      .update(schema.certificate)
      .set({ acme: { ...row?.acme, email: "certs@example.com" } })
      .where(eq(schema.certificate.id, cert.id));
    expect((await api.https.check({ id: siteId })).request.email).toBe("certs@example.com");
    await ctx.db.insert(schema.acmeAccount).values({
      directoryUrl: "https://acme.test/directory",
      email: "account@example.com",
      accountEnvelope: "{}",
    });
    expect((await api.https.check({ id: siteId })).request.email).toBe("account@example.com");
    await api.certificates.delete({ id: cert.id });
  });

  it("lists the issued certificates that cover every domain of the site", async () => {
    const material = await ctx.nodeCa.issueServerCertificate(["*.check.test"]);
    const partial = await ctx.nodeCa.issueServerCertificate(["a.check.test"]);
    const upload = (name: string, m: typeof material) =>
      api.certificates.upload({
        name,
        chainPem: m.certificatePem,
        privateKeyPem: m.privateKeyPem,
      });
    const covering = await upload("Wildcard", material);
    await upload("Partial", partial);
    expect((await api.https.check({ id: siteId })).certificates).toEqual([
      { id: covering.id, name: "Wildcard" },
    ]);
  });
});
