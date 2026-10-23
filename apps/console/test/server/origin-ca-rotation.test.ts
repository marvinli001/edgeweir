import "reflect-metadata";
import { X509Certificate } from "node:crypto";
import {
  decodeNodeConfig,
  ORIGIN_CA_FEATURE,
  ORIGIN_CA_ROTATION_FEATURE,
  ORIGIN_MTLS_FEATURE,
} from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import type { NodeConfig, OriginCa } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { Envelope } from "../../src/server/lib/envelope";
import { caKeyBinding } from "../../src/server/pki/store";
import { rotateOriginClientCertificates } from "../../src/server/services/origin-pki";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

/**
 * Whether nodes running `config` accept an origin presenting `pem`: it is
 * signed by the Origin CA or, during a rotation, the previous one, and that
 * authority's CRL (verified with its key) does not list it.
 */
async function trusted(config: NodeConfig, pem: string): Promise<boolean> {
  const cert = new x509.X509Certificate(pem);
  for (const ca of [config.originCa, config.originCaPrevious].filter((c): c is OriginCa => !!c)) {
    const authority = new x509.X509Certificate(ca.certificatePem);
    if (cert.issuer !== authority.subject) continue;
    if (!(await cert.verify({ publicKey: authority.publicKey, signatureOnly: true }))) continue;
    const crl = new x509.X509Crl(ca.crlPem);
    expect(await crl.verify({ publicKey: authority.publicKey })).toBe(true);
    return !crl.entries.some((e) => e.serialNumber.toLowerCase() === cert.serialNumber);
  }
  return false;
}

describe("rotating the origin authorities", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let nodeId: string;
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const audits = (action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action as never))
      .orderBy(desc(schema.auditLog.id));
  const code = async (promise: Promise<unknown>) => (await rpcError(promise)).code;
  const setFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1", ORIGIN_MTLS_FEATURE, ORIGIN_CA_FEATURE, ...features] })
      .where(eq(schema.node.id, nodeId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-rotate",
        status: "active",
        supportedFeatures: [],
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    nodeId = node?.id ?? "";
    await setFeatures([]);
    await admin.originCa.create();
    await admin.originClientCa.create();
    const site = await admin.sites.create({
      name: "rotating",
      domains: ["rotating.example.test"],
      origins: [{ address: "origin.internal.test", scheme: "https", port: 443 }],
    });
    await admin.sites.update({
      id: site.site.id,
      originSettings: {
        ...site.site.originSettings,
        tlsTrust: "originCa",
        clientCertificate: true,
      },
    });
  });
  afterAll(() => pglite.close());

  describe("the Origin CA", () => {
    let first: { certificatePem: string; fingerprint: string };
    let revokedLater: { id: string; certificatePem: string; serial: string };
    let kept: { id: string; certificatePem: string; privateKeyPem: string };
    let issuedNew: { id: string; certificatePem: string };
    let beforeRotation = 0;
    let duringOverlap = 0;

    it("refuses the later steps without a rotation", async () => {
      expect(await code(admin.originCa.retire())).toBe("CA_ROTATION_STEP_UNAVAILABLE");
      expect(await code(admin.originCa.cancel())).toBe("CA_ROTATION_STEP_UNAVAILABLE");
      const ca = await admin.originCa.get();
      expect(ca).toMatchObject({ previous: null, previousCertificates: 0 });
      first = ca.authority ?? { certificatePem: "", fingerprint: "" };
      revokedLater = await admin.originCertificates.issue({ hostnames: ["old-a.example.com"] });
      kept = await admin.originCertificates.issue({ hostnames: ["old-b.example.com"] });
      beforeRotation = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    });

    it("needs nodes that can trust two Origin CAs", async () => {
      const error = await rpcError(admin.originCa.rotate());
      expect(error.code).toBe("NODE_CAPABILITY_REQUIRED");
      expect(error.data).toMatchObject({
        features: ORIGIN_CA_ROTATION_FEATURE,
        nodes: "edge-rotate",
      });
      expect((await admin.originCa.get()).previous).toBeNull();
      expect(await audits("origin_ca.rotation_start")).toHaveLength(0);
      expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(beforeRotation);
    });

    it("starts: a new authority issues, nodes trust both", async () => {
      await setFeatures([ORIGIN_CA_ROTATION_FEATURE]);
      const ca = await admin.originCa.rotate();
      expect(ca.previous?.fingerprint).toBe(first.fingerprint);
      expect(ca.authority?.fingerprint).not.toBe(first.fingerprint);
      expect(ca.previousCertificates).toBe(2);
      const next = new X509Certificate(ca.authority?.certificatePem ?? "");
      expect(next.subject).toContain("CN=Edgeweir Origin CA G2");
      expect(next.ca).toBe(true);
      // Its key is sealed to its own row.
      const [row] = await ctx.db
        .select()
        .from(schema.pkiAuthority)
        .where(eq(schema.pkiAuthority.id, "origin-ca-g2"));
      expect(row).toMatchObject({ kind: "origin-ca", status: "active", generation: 2 });
      expect(() =>
        ctx.masterKey.open(
          JSON.parse(row?.privateKeyEnvelope ?? "") as Envelope,
          caKeyBinding("origin-ca-g2"),
        ),
      ).not.toThrow();
      expect(() =>
        ctx.masterKey.open(
          JSON.parse(row?.privateKeyEnvelope ?? "") as Envelope,
          caKeyBinding("origin-ca"),
        ),
      ).toThrow();

      const latest = await latestRevision(ctx.db, clusterId);
      expect(latest?.revision).toBe(beforeRotation + 1);
      expect(latest?.reasonCode).toBe("origin_ca_rotation_started");
      const compiled = await config();
      expect(compiled.originCa?.certificatePem).toBe(ca.authority?.certificatePem);
      expect(compiled.originCaPrevious?.certificatePem).toBe(first.certificatePem);
      expect(compiled.requiredFeatures).toContain(ORIGIN_CA_ROTATION_FEATURE);
      expect(await trusted(compiled, kept.certificatePem)).toBe(true);
      const [audit] = await audits("origin_ca.rotation_start");
      expect(audit).toMatchObject({
        targetId: "origin-ca-g2",
        targetName: "Edgeweir Origin CA G2",
      });
      expect(audit?.metadata).toMatchObject({ replaces: first.fingerprint, generation: 2 });
      expect(await code(admin.originCa.rotate())).toBe("CA_ROTATION_IN_PROGRESS");
      expect(
        (await admin.sites.features({ id: (await admin.sites.list({})).items[0]?.id ?? "" }))
          .originCa.available,
      ).toBe(true);
    });

    it("issues from the new authority and accepts both during the overlap", async () => {
      issuedNew = await admin.originCertificates.issue({ hostnames: ["new.example.com"] });
      const active = (await admin.originCa.get()).authority?.certificatePem ?? "";
      expect(
        new X509Certificate(issuedNew.certificatePem).checkIssued(new X509Certificate(active)),
      ).toBe(true);
      const listed = await admin.originCertificates.list();
      expect(listed.find((c) => c.id === issuedNew.id)?.authority).toBe("active");
      expect(listed.find((c) => c.id === kept.id)?.authority).toBe("previous");
      const compiled = await config();
      expect(await trusted(compiled, issuedNew.certificatePem)).toBe(true);
      expect(await trusted(compiled, kept.certificatePem)).toBe(true);
      // Neither authority's certificates serve visitors.
      expect(
        await code(
          admin.certificates.upload({
            name: "old",
            chainPem: kept.certificatePem,
            privateKeyPem: kept.privateKeyPem,
          }),
        ),
      ).toBe("CERTIFICATE_ORIGIN_CA");
      duringOverlap = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    });

    it("revokes a previous authority's certificate into that authority's CRL", async () => {
      await admin.originCertificates.revoke({ id: revokedLater.id });
      const compiled = await config();
      expect(await trusted(compiled, revokedLater.certificatePem)).toBe(false);
      expect(await trusted(compiled, kept.certificatePem)).toBe(true);
      expect(new x509.X509Crl(compiled.originCa?.crlPem ?? "").entries).toHaveLength(0);
      expect((await admin.originCa.get()).previousCertificates).toBe(1);
    });

    it("keeps both on a rollback during the overlap", async () => {
      await admin.clusters.rollback({ id: clusterId, revision: beforeRotation });
      const compiled = await config();
      expect(compiled.originCaPrevious?.certificatePem).toBe(first.certificatePem);
      expect(await trusted(compiled, issuedNew.certificatePem)).toBe(true);
      expect(await trusted(compiled, revokedLater.certificatePem)).toBe(false);
    });

    it("cannot be cancelled once the new authority's certificates are in use", async () => {
      const error = await rpcError(admin.originCa.cancel());
      expect(error.code).toBe("CA_ROTATION_IN_USE");
      expect(error.data).toMatchObject({ count: 1 });
    });

    it("retires the previous authority: its certificates stop working", async () => {
      const ca = await admin.originCa.retire();
      expect(ca).toMatchObject({ previous: null, previousCertificates: 0 });
      expect(
        await ctx.db
          .select()
          .from(schema.pkiAuthority)
          .where(eq(schema.pkiAuthority.id, "origin-ca")),
      ).toEqual([]);
      const latest = await latestRevision(ctx.db, clusterId);
      expect(latest?.reasonCode).toBe("origin_ca_retired");
      const compiled = await config();
      expect(compiled.originCaPrevious).toBeUndefined();
      expect(compiled.requiredFeatures).not.toContain(ORIGIN_CA_ROTATION_FEATURE);
      expect(await trusted(compiled, kept.certificatePem)).toBe(false);
      expect(await trusted(compiled, issuedNew.certificatePem)).toBe(true);
      const [audit] = await audits("origin_ca.retire");
      expect(audit).toMatchObject({ targetId: "origin-ca" });
      expect(audit?.metadata).toMatchObject({
        fingerprint: first.fingerprint,
        validCertificates: 1,
      });
      expect((await admin.originCertificates.list()).find((c) => c.id === kept.id)?.authority).toBe(
        "retired",
      );
      expect(await code(admin.originCa.retire())).toBe("CA_ROTATION_STEP_UNAVAILABLE");

      // Revoking one of the retired authority's certificates only marks it.
      const revoked = await admin.originCertificates.revoke({ id: kept.id });
      expect(revoked.revokedAt).not.toBeNull();
      expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(latest?.revision);
    });

    it("never trusts a retired authority again on a rollback", async () => {
      await admin.clusters.rollback({ id: clusterId, revision: duringOverlap });
      const compiled = await config();
      expect(compiled.originCaPrevious).toBeUndefined();
      expect(await trusted(compiled, issuedNew.certificatePem)).toBe(true);
    });

    it("cancels a rotation whose new authority issued nothing", async () => {
      const active = (await admin.originCa.get()).authority;
      const started = await admin.originCa.rotate();
      expect(new X509Certificate(started.authority?.certificatePem ?? "").subject).toContain(
        "CN=Edgeweir Origin CA G3",
      );
      // Revoked: no longer in use, so the rotation can still be cancelled.
      const mistake = await admin.originCertificates.issue({ hostnames: ["g3.example.com"] });
      expect(await code(admin.originCa.cancel())).toBe("CA_ROTATION_IN_USE");
      await admin.originCertificates.revoke({ id: mistake.id });
      const ca = await admin.originCa.cancel();
      // It goes with its authority: the next rotation's G3 starts without it.
      expect((await admin.originCertificates.list()).map((c) => c.id)).not.toContain(mistake.id);
      expect(ca.authority?.fingerprint).toBe(active?.fingerprint);
      expect(ca.previous).toBeNull();
      expect((await latestRevision(ctx.db, clusterId))?.reasonCode).toBe(
        "origin_ca_rotation_cancelled",
      );
      const compiled = await config();
      expect(compiled.originCa?.certificatePem).toBe(active?.certificatePem);
      expect(compiled.originCaPrevious).toBeUndefined();
      expect(await audits("origin_ca.rotation_cancel")).toHaveLength(1);
      expect(
        (
          await ctx.db
            .select()
            .from(schema.pkiAuthority)
            .where(eq(schema.pkiAuthority.kind, "origin-ca"))
        ).map((r) => [r.id, r.status]),
      ).toEqual([["origin-ca-g2", "active"]]);
    });
  });

  describe("the origin client CA", () => {
    let first: { certificatePem: string; fingerprint: string };
    let next: { certificatePem: string; fingerprint: string };
    const certificates = () =>
      ctx.db
        .select()
        .from(schema.originClientCertificate)
        .where(eq(schema.originClientCertificate.clusterId, clusterId))
        .orderBy(
          desc(schema.originClientCertificate.notAfter),
          desc(schema.originClientCertificate.createdAt),
        );

    it("refuses the later steps without a rotation", async () => {
      for (const step of [
        admin.originClientCa.activate,
        admin.originClientCa.retire,
        admin.originClientCa.cancel,
      ])
        expect(await code(step())).toBe("CA_ROTATION_STEP_UNAVAILABLE");
      const ca = await admin.originClientCa.get();
      first = ca.authority ?? { certificatePem: "", fingerprint: "" };
      expect(ca.trustBundlePem).toBe(first.certificatePem);
      expect(ca.certificates).toMatchObject([{ clusterId, authority: "active" }]);
    });

    it("starts: origins are given the next authority to trust, nothing is published", async () => {
      const before = (await latestRevision(ctx.db, clusterId))?.revision;
      const ca = await admin.originClientCa.rotate();
      next = ca.next ?? { certificatePem: "", fingerprint: "" };
      expect(ca.authority?.fingerprint).toBe(first.fingerprint);
      expect(new X509Certificate(next.certificatePem).subject).toContain(
        "CN=Edgeweir Origin Client CA G2",
      );
      expect(ca.trustBundlePem).toBe(first.certificatePem + next.certificatePem);
      expect(ca.certificates).toMatchObject([{ authority: "active" }]);
      expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before);
      expect(await audits("origin_client_ca.rotation_start")).toHaveLength(1);
      expect(await code(admin.originClientCa.rotate())).toBe("CA_ROTATION_IN_PROGRESS");
      expect(await code(admin.originClientCa.retire())).toBe("CA_ROTATION_STEP_UNAVAILABLE");
      // Nothing is issued by it before it is active.
      expect(await rotateOriginClientCertificates(ctx)).toEqual([]);
    });

    it("cancels before activation", async () => {
      const ca = await admin.originClientCa.cancel();
      expect(ca.next).toBeNull();
      expect(ca.trustBundlePem).toBe(first.certificatePem);
      expect(await audits("origin_client_ca.rotation_cancel")).toHaveLength(1);
      next = (await admin.originClientCa.rotate()).next ?? next;
    });

    it("activates: clusters present a certificate of the new authority", async () => {
      const [old] = await certificates();
      const ca = await admin.originClientCa.activate();
      expect(ca).toMatchObject({ next: null, pendingClusters: [] });
      expect(ca.authority?.fingerprint).toBe(next.fingerprint);
      expect(ca.previous?.fingerprint).toBe(first.fingerprint);
      expect(ca.trustBundlePem).toBe(next.certificatePem + first.certificatePem);
      const [current, earlier] = await certificates();
      expect(earlier?.id).toBe(old?.id);
      expect(
        new X509Certificate(current?.chainPem ?? "").checkIssued(
          new X509Certificate(next.certificatePem),
        ),
      ).toBe(true);
      expect(ca.certificates).toMatchObject([{ id: current?.id, authority: "active" }]);
      const latest = await latestRevision(ctx.db, clusterId);
      expect(latest?.reasonCode).toBe("origin_client_certificate_rotated");
      expect((await config()).originClientCertificates.map((c) => c.id)).toEqual([current?.id]);
      expect(await audits("origin_client_ca.activate")).toHaveLength(1);
      const [rotated] = await audits("origin_client_certificate.rotate");
      expect(rotated).toMatchObject({ actorType: "user", targetId: current?.id });
      // Certificate times have whole seconds: issued within the same second
      // as the previous one, the new certificate is still the current one.
      await ctx.db
        .update(schema.originClientCertificate)
        .set({ notAfter: current?.notAfter ?? new Date() })
        .where(eq(schema.originClientCertificate.id, old?.id ?? ""));
      const tied = await admin.originClientCa.get();
      expect(tied.certificates).toMatchObject([{ id: current?.id, authority: "active" }]);
      expect(tied.pendingClusters).toEqual([]);
      expect(await rotateOriginClientCertificates(ctx)).toEqual([]);
    });

    it("retires only once no cluster presents the previous authority's certificates", async () => {
      // A cluster whose certificate could not be replaced yet.
      const [current] = await certificates();
      await ctx.db
        .delete(schema.originClientCertificate)
        .where(eq(schema.originClientCertificate.id, current?.id ?? ""));
      const pending = await admin.originClientCa.get();
      expect(pending.pendingClusters).toEqual([{ clusterId, clusterName: expect.any(String) }]);
      expect(pending.certificates).toMatchObject([{ authority: "previous" }]);
      const error = await rpcError(admin.originClientCa.retire());
      expect(error.code).toBe("CA_ROTATION_INCOMPLETE");
      expect(error.data).toMatchObject({ clusters: pending.pendingClusters[0]?.clusterName });
      expect((await admin.originClientCa.get()).previous?.fingerprint).toBe(first.fingerprint);
      // The hourly rotation replaces it.
      expect(await rotateOriginClientCertificates(ctx)).toEqual([clusterId]);
      expect((await admin.originClientCa.get()).pendingClusters).toEqual([]);

      const ca = await admin.originClientCa.retire();
      expect(ca).toMatchObject({ previous: null, next: null });
      expect(ca.trustBundlePem).toBe(next.certificatePem);
      const [audit] = await audits("origin_client_ca.retire");
      expect(audit).toMatchObject({ targetId: "origin-client" });
      expect(audit?.metadata).toMatchObject({ fingerprint: first.fingerprint });
      expect(
        (
          await ctx.db
            .select()
            .from(schema.pkiAuthority)
            .where(eq(schema.pkiAuthority.kind, "origin-client"))
        ).map((r) => [r.id, r.status]),
      ).toEqual([["origin-client-g2", "active"]]);
      // A new rotation can start again.
      expect(
        new X509Certificate((await admin.originClientCa.rotate()).next?.certificatePem ?? "")
          .subject,
      ).toContain("G3");
    });
  });
});
