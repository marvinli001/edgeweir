import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  type CertificateDto,
  type CertificateRequest,
  type CertificateUpload,
  type DnsCredentialInput,
  type TlsSettings,
  tlsSettings,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertCertificateNames } from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { assertOrgLimit } from "./organization-limits";
import { type Executor, getRevision, publishRevision } from "./revisions";
import { publishedRevisions } from "./rollout";
import type { SiteScope } from "./sites";

export type CertificateContext = { scope: SiteScope; actor: Actor; organizationId: string | null };
export const certificateKeyBinding = (id: string) => ({
  purpose: "certificate.private_key_envelope",
  recordId: id,
});
export const certificateAccountBinding = (id: string) => ({
  purpose: "certificate.account_envelope",
  recordId: id,
});
export const dnsCredentialBinding = (id: string) => ({
  purpose: "dns_credential.credential_envelope",
  recordId: id,
});

export function certificateDto(row: typeof schema.certificate.$inferSelect): CertificateDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    names: row.names,
    source: row.source === "acme" ? "acme" : "upload",
    status: row.status as CertificateDto["status"],
    fingerprint: row.fingerprint,
    notBefore: row.notBefore?.toISOString() ?? null,
    notAfter: row.notAfter?.toISOString() ?? null,
    autoRenew: row.autoRenew,
    renewAt: row.renewAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

export async function findCertificate(db: Executor, id: string, scope: SiteScope) {
  const [row] = await db
    .select()
    .from(schema.certificate)
    .where(
      and(
        eq(schema.certificate.id, id),
        scope.all ? undefined : eq(schema.certificate.organizationId, scope.organizationId),
      ),
    )
    .for("update");
  if (!row) fail("CERTIFICATE_NOT_FOUND", "certificate not found");
  return row;
}

export function inspectCertificate(chainPem: string, privateKeyPem: string) {
  try {
    const blocks = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!blocks?.length || blocks.length > 10) throw new Error("invalid chain");
    const chain = blocks.map((block) => new X509Certificate(block));
    const leaf = chain[0];
    if (!leaf || leaf.ca || !leaf.checkPrivateKey(createPrivateKey(privateKeyPem)))
      throw new Error("invalid leaf or key");
    for (let i = 0; i + 1 < chain.length; i++) {
      const cert = chain[i];
      const issuer = chain[i + 1];
      if (!cert || !issuer?.ca || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))
        throw new Error("invalid chain order");
    }
    const notBefore = new Date(leaf.validFrom);
    const notAfter = new Date(leaf.validTo);
    if (notBefore.getTime() > Date.now() || notAfter.getTime() <= Date.now())
      throw new Error("certificate is not currently valid");
    const names = [
      ...new Set(
        (leaf.subjectAltName ?? "")
          .split(/,\s*/)
          .filter((part) => part.startsWith("DNS:"))
          .map((part) => part.slice(4).toLowerCase()),
      ),
    ];
    if (!names.length || names.some((name) => !/^(\*\.)?[a-z0-9.-]+$/.test(name)))
      throw new Error("DNS SAN required");
    return {
      leaf,
      names,
      notBefore,
      notAfter,
      fingerprint: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
    };
  } catch {
    fail("CERTIFICATE_INVALID", "invalid certificate chain, validity or matching private key");
  }
}

function orgFor(ctx: CertificateContext, requested?: string) {
  if (requested && !ctx.scope.all && requested !== ctx.organizationId)
    fail("NOT_A_MEMBER", "organization is outside caller scope");
  const id = requested ?? ctx.organizationId;
  if (!id) fail("NOT_A_MEMBER", "select an organization first");
  return id;
}

export async function listCertificates(app: AppContext, scope: SiteScope) {
  return (
    await app.db
      .select()
      .from(schema.certificate)
      .where(scope.all ? undefined : eq(schema.certificate.organizationId, scope.organizationId))
  ).map(certificateDto);
}

export async function uploadCertificate(
  app: AppContext,
  input: CertificateUpload,
  ctx: CertificateContext,
) {
  const inspected = inspectCertificate(input.chainPem, input.privateKeyPem);
  const id = randomUUID();
  const organizationId = orgFor(ctx, input.organizationId);
  return app.db.transaction(async (tx) => {
    await assertOrgLimit(tx, organizationId, "certificates", 1);
    const [row] = await tx
      .insert(schema.certificate)
      .values({
        id,
        organizationId,
        name: input.name,
        names: inspected.names,
        source: "upload",
        status: "ready",
        chainPem: input.chainPem,
        privateKeyEnvelope: JSON.stringify(
          app.masterKey.seal(input.privateKeyPem, certificateKeyBinding(id)),
        ),
        fingerprint: inspected.fingerprint,
        notBefore: inspected.notBefore,
        notAfter: inspected.notAfter,
      })
      .returning();
    if (!row) throw new Error("certificate insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "certificate.upload",
      organizationId,
      targetType: "certificate",
      targetId: id,
      targetName: input.name,
    });
    return certificateDto(row);
  });
}

export async function requestCertificate(
  app: AppContext,
  input: CertificateRequest,
  ctx: CertificateContext,
) {
  const organizationId = orgFor(ctx);
  const id = randomUUID();
  // Issuance is tied to sites in this organization, even for a platform caller.
  const domains = await app.db
    .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(eq(schema.site.organizationId, organizationId));
  const owned = new Set(domains.map((d) => `${d.wildcard ? "*." : ""}${d.name}`));
  if (input.names.some((name) => !owned.has(name)))
    fail(
      "CERTIFICATE_DOMAIN_MISMATCH",
      "add the certificate domains to this organization's sites first",
    );
  if (input.dnsCredentialId) {
    const credential = await findDnsCredential(app.db, input.dnsCredentialId, {
      all: false,
      organizationId,
    });
    if (
      input.names.some(
        (name) =>
          name.replace(/^\*\./, "") !== credential.zone && !name.endsWith(`.${credential.zone}`),
      )
    ) {
      fail(
        "CERTIFICATE_DOMAIN_MISMATCH",
        "DNS credential zone does not cover all certificate names",
      );
    }
  }
  return app.db.transaction(async (tx) => {
    await assertOrgLimit(tx, organizationId, "certificates", 1);
    const [row] = await tx
      .insert(schema.certificate)
      .values({
        id,
        organizationId,
        name: input.name,
        names: input.names,
        source: "acme",
        autoRenew: input.autoRenew,
        acme: {
          ca: input.ca,
          challenge: input.challenge,
          email: input.email,
          dnsCredentialId: input.dnsCredentialId ?? "",
        },
        accountEnvelope: JSON.stringify(
          app.masterKey.seal(
            JSON.stringify({ eabKid: input.eabKid, eabHmacKey: input.eabHmacKey }),
            certificateAccountBinding(id),
          ),
        ),
      })
      .returning();
    if (!row) throw new Error("certificate insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "certificate.request",
      organizationId,
      targetType: "certificate",
      targetId: id,
      targetName: input.name,
    });
    return certificateDto(row);
  });
}

export async function renewCertificate(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const cert = await findCertificate(tx, id, ctx.scope);
    if (cert.source !== "acme" || cert.status === "issuing")
      fail("CERTIFICATE_BUSY", "certificate cannot be renewed now");
    const [updated] = await tx
      .update(schema.certificate)
      .set({ status: "pending", lastError: "", updatedAt: new Date() })
      .where(eq(schema.certificate.id, id))
      .returning();
    if (!updated) throw new Error("certificate disappeared");
    await recordAudit(tx, ctx.actor, {
      action: "certificate.renew",
      organizationId: cert.organizationId,
      targetType: "certificate",
      targetId: id,
      targetName: cert.name,
    });
    return certificateDto(updated);
  });
}

export async function deleteCertificate(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const cert = await findCertificate(tx, id, ctx.scope);
    const refs = await tx
      .select({ id: schema.site.id })
      .from(schema.site)
      .where(eq(schema.site.certificateId, id))
      .limit(1);
    const leases = await tx
      .select({ id: schema.dnsChallengeLease.id })
      .from(schema.dnsChallengeLease)
      .where(eq(schema.dnsChallengeLease.certificateId, id))
      .limit(1);
    if (refs.length || leases.length || cert.status === "issuing")
      fail("CERTIFICATE_IN_USE", "certificate is in use");
    await tx.delete(schema.certificate).where(eq(schema.certificate.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "certificate.delete",
      organizationId: cert.organizationId,
      targetType: "certificate",
      targetId: id,
      targetName: cert.name,
    });
    return { ok: true as const };
  });
}

async function tlsSite(db: Executor, id: string, scope: SiteScope, lock = false) {
  const query = db
    .select()
    .from(schema.site)
    .where(
      and(
        eq(schema.site.id, id),
        scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId),
      ),
    );
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}
export async function getHttps(app: AppContext, id: string, scope: SiteScope) {
  const site = await tlsSite(app.db, id, scope);
  return tlsSettings.parse({ ...site.tlsSettings, certificateId: site.certificateId });
}
export async function updateHttps(
  app: AppContext,
  id: string,
  settings: TlsSettings,
  ctx: CertificateContext,
) {
  return app.db.transaction(async (tx) => {
    const site = await tlsSite(tx, id, ctx.scope, true);
    if (settings.certificateId) {
      const cert = await findCertificate(tx, settings.certificateId, {
        all: false,
        organizationId: site.organizationId,
      });
      if (!cert.chainPem || !cert.notAfter || cert.notAfter.getTime() <= Date.now())
        fail("CERTIFICATE_INVALID", "certificate is unavailable or expired");
      const domains = await tx
        .select()
        .from(schema.siteDomain)
        .where(eq(schema.siteDomain.siteId, id));
      assertCertificateNames(cert.chainPem, cert.names, domains);
    }
    const { certificateId, ...options } = settings;
    await tx
      .update(schema.site)
      .set({ certificateId, tlsSettings: options })
      .where(eq(schema.site.id, id));
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "certificate_updated", params: { site: site.name } },
      userId: ctx.actor.id,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.https_update",
      organizationId: site.organizationId,
      targetType: "site",
      targetId: id,
      targetName: site.name,
    });
    return settings;
  });
}

export async function findDnsCredential(db: Executor, id: string, scope: SiteScope) {
  const [row] = await db
    .select()
    .from(schema.dnsCredential)
    .where(
      and(
        eq(schema.dnsCredential.id, id),
        scope.all ? undefined : eq(schema.dnsCredential.organizationId, scope.organizationId),
      ),
    );
  if (!row) fail("DNS_CREDENTIAL_NOT_FOUND", "DNS credential not found");
  return row;
}
export async function listDnsCredentials(app: AppContext, scope: SiteScope) {
  return app.db
    .select({
      id: schema.dnsCredential.id,
      name: schema.dnsCredential.name,
      provider: schema.dnsCredential.provider,
      zone: schema.dnsCredential.zone,
    })
    .from(schema.dnsCredential)
    .where(scope.all ? undefined : eq(schema.dnsCredential.organizationId, scope.organizationId));
}
export async function createDnsCredential(
  app: AppContext,
  input: DnsCredentialInput,
  ctx: CertificateContext,
) {
  const id = randomUUID();
  const organizationId = orgFor(ctx);
  const allowed: Record<string, string[]> = {
    cloudflare: ["api_token", "zone_token"],
    alidns: ["access_key_id", "access_key_secret", "region_id", "security_token"],
    huaweicloud: ["access_key_id", "secret_access_key", "region_id"],
    dnspod: ["auth_token"],
  };
  if (Object.keys(input.credentials).some((key) => !allowed[input.provider]?.includes(key)))
    fail("DNS_CREDENTIAL_INVALID", "unknown DNS credential field");
  const required: Record<string, string[]> = {
    cloudflare: ["api_token"],
    alidns: ["access_key_id", "access_key_secret"],
    huaweicloud: ["access_key_id", "secret_access_key"],
    dnspod: ["auth_token"],
  };
  if (
    required[input.provider]?.some((key) => !input.credentials[key]) ||
    Object.values(input.credentials).some((value) =>
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    )
  ) {
    fail("DNS_CREDENTIAL_INVALID", "missing or malformed DNS credential");
  }
  if (input.credentials.region_id && !/^[a-z0-9-]{1,32}$/.test(input.credentials.region_id)) {
    fail("DNS_CREDENTIAL_INVALID", "invalid DNS provider region");
  }
  return app.db.transaction(async (tx) => {
    await tx.insert(schema.dnsCredential).values({
      id,
      organizationId,
      name: input.name,
      provider: input.provider,
      zone: input.zone,
      credentialEnvelope: JSON.stringify(
        app.masterKey.seal(JSON.stringify(input.credentials), dnsCredentialBinding(id)),
      ),
    });
    await recordAudit(tx, ctx.actor, {
      action: "dns_credential.create",
      organizationId,
      targetType: "dns_credential",
      targetId: id,
      targetName: input.name,
    });
    return { id, name: input.name, provider: input.provider, zone: input.zone };
  });
}
export async function deleteDnsCredential(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const row = await findDnsCredential(tx, id, ctx.scope);
    const refs = await tx
      .select({ id: schema.certificate.id })
      .from(schema.certificate)
      .where(sql`${schema.certificate.acme}->>'dnsCredentialId' = ${id}`)
      .limit(1);
    if (refs.length) fail("CERTIFICATE_IN_USE", "DNS credential is referenced by a certificate");
    await tx.delete(schema.dnsCredential).where(eq(schema.dnsCredential.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "dns_credential.delete",
      organizationId: row.organizationId,
      targetType: "dns_credential",
      targetId: id,
      targetName: row.name,
    });
    return { ok: true as const };
  });
}

export async function nodeCertificates(app: AppContext, clusterId: string, ids: string[]) {
  const valid = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  if (!valid.length) return [];
  // Certificates of every revision the cluster's nodes may run (stable, candidate, latest).
  const authorized = new Map<string, string>();
  for (const revision of await publishedRevisions(app.db, clusterId)) {
    const row = await getRevision(app.db, clusterId, revision);
    if (!row) continue;
    for (const cert of decodeNodeConfig(row.ir).certificates)
      authorized.set(cert.id, cert.sha256Fingerprint);
  }
  if (!authorized.size) return [];
  const rows = await app.db
    .selectDistinct({ certificate: schema.certificate })
    .from(schema.certificate)
    .where(inArray(schema.certificate.id, valid));
  return rows
    .filter(({ certificate: cert }) => authorized.get(cert.id) === cert.fingerprint)
    .map(({ certificate: cert }) => ({
      id: cert.id,
      chainPem: cert.chainPem,
      privateKeyPem: app.masterKey
        .open(JSON.parse(cert.privateKeyEnvelope), certificateKeyBinding(cert.id))
        .toString("utf8"),
      sha256Fingerprint: cert.fingerprint,
    }));
}
