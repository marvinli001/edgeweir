import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { cleanupBackoff, sweepCertificates } from "../../src/server/services/certificate-worker";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// DNS-01 TXT records left to clean up, DNS credentials that are replaced,
// and what deleting a certificate or a credential refuses (audit U-3).

/** A stand-in for edgeweir-certd: dns.cleanup answers as planned, everything else fails. */
function fakeCertd(dir: string) {
  const plan = join(dir, "plan.json");
  const requests = join(dir, "requests.jsonl");
  const bin = join(dir, "certd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const request = JSON.parse(input.split("\\n")[0]);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ command: request.command }) + "\\n");
  const cleanup = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8")).cleanup;
  const answer = request.command === "dns.cleanup" && cleanup === "ok"
    ? { ok: true, result: [] }
    : { ok: false, code: request.command === "dns.cleanup" ? cleanup : "acme_unauthorized" };
  process.stdout.write(JSON.stringify(answer) + "\\n");
  process.exit(answer.ok ? 0 : 1);
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    cleanup: (answer: string) => writeFileSync(plan, JSON.stringify({ cleanup: answer })),
    cleanups: () => {
      try {
        return readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .filter((line) => JSON.parse(line).command === "dns.cleanup").length;
      } catch {
        return 0;
      }
    },
  };
}

describe("DNS-01 leases, credentials and deletions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-certd-"));
  const certd = fakeCertd(dir);
  certd.cleanup("dns_auth_failed");
  const { ctx, client } = await createTestContext({ EDGEWEIR_CERTD_BIN: certd.bin });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let api: ApiClient;
  let credentialId = "";
  let certificateId = "";

  const lease = async () => {
    const [row] = await ctx.db
      .select()
      .from(schema.dnsChallengeLease)
      .where(eq(schema.dnsChallengeLease.certificateId, certificateId));
    return row;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    credentialId = (
      await api.dnsCredentials.create({
        name: "DNS",
        provider: "cloudflare",
        zone: "lease.test",
        credentials: { api_token: "unit-test-token-0123456789" },
      })
    ).id;
    // A certificate whose last DNS-01 attempt failed and left its TXT record.
    const [cert] = await ctx.db
      .insert(schema.certificate)
      .values({
        name: "leased",
        names: ["www.lease.test"],
        source: "acme",
        status: "error",
        autoRenew: true,
        renewAt: new Date(Date.now() + 3_600_000),
        acme: { challenge: "dns01", dnsCredentialId: credentialId, email: "ops@example.com" },
      })
      .returning();
    certificateId = cert?.id ?? "";
    await ctx.db.insert(schema.dnsChallengeLease).values({
      certificateId,
      credentialId,
      operationStartedAt: new Date(Date.now() - 60_000),
      token: "token-abcdefghijklmnop",
      record: { name: "_acme-challenge.www", type: "TXT", data: "x".repeat(43), ttl: 60 },
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs off a failing cleanup, up to 6 hours", async () => {
    expect([0, 1, 2, 3, 8, 9, 30].map(cleanupBackoff)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      256 * 60_000,
      6 * 3_600_000,
      6 * 3_600_000,
    ]);
    await sweepCertificates(ctx);
    expect(certd.cleanups()).toBe(1);
    const first = await lease();
    expect(first?.attempts).toBe(1);
    expect((first?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(50_000);
    expect((first?.expiresAt.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);
    // Not again before the backoff has passed.
    await sweepCertificates(ctx);
    expect(certd.cleanups()).toBe(1);
    await ctx.db
      .update(schema.dnsChallengeLease)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.dnsChallengeLease.certificateId, certificateId));
    await sweepCertificates(ctx);
    expect(certd.cleanups()).toBe(2);
    const second = await lease();
    expect(second?.attempts).toBe(2);
    expect((second?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(110_000);
  });

  it("retries failed certificates and cleanups at once with new credentials", async () => {
    // Renaming alone retries nothing.
    await api.dnsCredentials.update({ id: credentialId, name: "DNS renamed" });
    expect(((await lease())?.expiresAt.getTime() ?? 0) > Date.now()).toBe(true);
    const before = Date.now();
    await api.dnsCredentials.update({
      id: credentialId,
      credentials: { api_token: "unit-test-token-abcdefghij" },
    });
    expect((await lease())?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const [cert] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, certificateId));
    expect(cert?.renewAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(cert?.renewAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const [entry] = (await api.auditLogs.list({ action: "dns_credential.update" })).items;
    expect(entry?.metadata).toMatchObject({ credentialsRotated: true, retriedCertificates: 1 });
  });

  it("refuses to delete a credential certificates use, naming them", async () => {
    expect(await rpcError(api.dnsCredentials.delete({ id: credentialId }))).toMatchObject({
      code: "DNS_CREDENTIAL_IN_USE",
      data: { certificates: "leased" },
    });
  });

  it("drops a record whose zone the provider no longer has", async () => {
    certd.cleanup("dns_zone_not_found");
    await ctx.db
      .update(schema.dnsChallengeLease)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.dnsChallengeLease.certificateId, certificateId));
    await sweepCertificates(ctx);
    expect(await lease()).toBeUndefined();
  });

  it("deletes a certificate with records left to clean up and lists them in the audit log", async () => {
    await ctx.db.insert(schema.dnsChallengeLease).values({
      certificateId,
      credentialId,
      operationStartedAt: new Date(Date.now() - 60_000),
      token: "token-qrstuvwxyzabcdef",
      record: { name: "_acme-challenge.www", type: "TXT", data: "y".repeat(43), ttl: 60 },
      expiresAt: new Date(Date.now() + 3_600_000),
      attempts: 3,
    });
    // Issuing: busy, not in use.
    await ctx.db
      .update(schema.certificate)
      .set({ status: "issuing", operationStartedAt: new Date() })
      .where(eq(schema.certificate.id, certificateId));
    expect((await rpcError(api.certificates.delete({ id: certificateId }))).code).toBe(
      "CERTIFICATE_BUSY",
    );
    await ctx.db
      .update(schema.certificate)
      .set({ status: "error", operationStartedAt: null })
      .where(eq(schema.certificate.id, certificateId));
    await api.certificates.delete({ id: certificateId });
    expect(await lease()).toBeUndefined();
    const [entry] = (await api.auditLogs.list({ action: "certificate.delete" })).items;
    expect(entry).toMatchObject({
      targetId: certificateId,
      metadata: { leftDnsRecords: [`_acme-challenge.www.lease.test TXT ${"y".repeat(43)}`] },
    });
    // Unused now, the credential can go.
    await api.dnsCredentials.delete({ id: credentialId });
  });
});
