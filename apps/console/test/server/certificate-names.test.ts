import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { namesCover, uncoveredDomains } from "../../src/server/lib/certificate-names";
import { issueCertificate } from "../../src/server/services/certificate-worker";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Which names a certificate may be requested for, and which names a renewal
// asks the CA for after a domain left its site (audit 2026-10-01 P0-5).

/** A stand-in for edgeweir-certd that records its request and fails. */
function fakeCertd(dir: string) {
  const requests = join(dir, "requests.jsonl");
  const bin = join(dir, "certd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const line = input.split("\\n")[0];
  if (input.includes("\\n")) {
    fs.appendFileSync(${JSON.stringify(requests)}, line + "\\n");
    process.stdout.write(JSON.stringify({ ok: false }) + "\\n");
    process.exit(1);
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    requests: () =>
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; params: { domains: string[] } }),
  };
}

describe("certificate names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-certd-"));
  const certd = fakeCertd(dir);
  const { ctx, client } = await createTestContext({ EDGEWEIR_CERTD_BIN: certd.bin });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let api: ApiClient;
  let siteId: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    siteId = (
      await api.sites.create({
        name: "shop",
        domains: ["shop.test", "www.shop.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (names: string[], extra: Record<string, unknown> = {}) =>
    api.certificates.request({
      name: names[0] ?? "",
      names,
      email: "ops@example.com",
      autoRenew: true,
      ...extra,
    });

  it("covers a domain with the same name or a wildcard one label up", async () => {
    const plain = (name: string) => ({ name, wildcard: false });
    const wild = (name: string) => ({ name, wildcard: true });
    expect(namesCover(["shop.test"], plain("shop.test"))).toBe(true);
    expect(namesCover(["*.shop.test"], plain("www.shop.test"))).toBe(true);
    expect(namesCover(["*.shop.test"], plain("a.www.shop.test"))).toBe(false);
    expect(namesCover(["*.shop.test"], plain("shop.test"))).toBe(false);
    expect(namesCover(["*.shop.test"], wild("shop.test"))).toBe(true);
    expect(namesCover(["www.shop.test"], wild("shop.test"))).toBe(false);
    // The chain decides what nodes serve.
    const material = await ctx.nodeCa.issueServerCertificate(["shop.test", "*.shop.test"]);
    expect(
      uncoveredDomains(material.certificatePem, [
        plain("shop.test"),
        plain("www.shop.test"),
        wild("shop.test"),
        plain("other.test"),
        wild("www.shop.test"),
      ]),
    ).toEqual([plain("other.test"), wild("www.shop.test")]);
  });

  it("asks HTTP-01 names to be domains of a site, since only their clusters answer the challenge", async () => {
    expect((await request(["shop.test", "www.shop.test"])).status).toBe("pending");
    expect(await rpcError(request(["shop.test", "elsewhere.test"]))).toMatchObject({
      code: "CERTIFICATE_DOMAIN_MISMATCH",
      data: { domains: "elsewhere.test" },
    });
  });

  it("lets DNS-01 names be any names inside the credential's zone", async () => {
    const credential = await api.dnsCredentials.create({
      name: "DNS",
      provider: "cloudflare",
      zone: "next.test",
      credentials: { api_token: "unit-test-token-0123456789" },
    });
    const dns01 = { challenge: "dns01", dnsCredentialId: credential.id };
    // Not on any site yet: the certificate can exist before the domain is added.
    expect((await request(["next.test", "*.next.test"], dns01)).status).toBe("pending");
    expect((await rpcError(request(["shop.test"], dns01))).code).toBe(
      "CERTIFICATE_DOMAIN_MISMATCH",
    );
  });

  it("renews by HTTP-01 without names no site has any more, and fails no earlier than the CA", async () => {
    const { id } = await request(["shop.test", "www.shop.test"]);
    // Issued before: a renewal (the chain only marks it as such here).
    await ctx.db
      .update(schema.certificate)
      .set({ chainPem: "issued", status: "ready", renewAt: new Date(0) })
      .where(eq(schema.certificate.id, id));
    await api.sites.update({ id: siteId, domains: ["shop.test"] });

    await issueCertificate(ctx, id);
    const renewal = certd.requests().at(-1);
    expect(renewal).toMatchObject({ command: "renew", params: { domains: ["shop.test"] } });
    const [row] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, id));
    // The fake helper refused; the names stay until a renewal succeeds.
    expect(row).toMatchObject({
      status: "error",
      names: ["shop.test", "www.shop.test"],
      lastError: "certd_failed",
    });

    // With no name left on a site, the renewal asks for all of them (and fails at the CA).
    await api.sites.update({ id: siteId, domains: ["other.test"] });
    await ctx.db
      .update(schema.certificate)
      .set({ renewAt: new Date(0) })
      .where(eq(schema.certificate.id, id));
    await issueCertificate(ctx, id);
    expect(certd.requests().at(-1)?.params.domains).toEqual(["shop.test", "www.shop.test"]);
  });
});
