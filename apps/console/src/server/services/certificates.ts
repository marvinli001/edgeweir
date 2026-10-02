import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  type CertificateDto,
  type CertificateRequest,
  type CertificateSettings,
  type CertificateUpload,
  type DnsCredentialInput,
  dnsProviderEntry,
  type TlsSettings,
  tlsSettings,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  certificateName,
  failUncovered,
  namesCover,
  uncoveredDomains,
} from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { certdDns, probe, validCredentials } from "./dns-providers";
import { assertHttp01Ready } from "./http01-check";
import { type Executor, getRevision, publisher, publishRevision } from "./revisions";
import { publishedRevisions } from "./rollout";

export type CertificateContext = { actor: Actor };
export const certificateKeyBinding = (id: string) => ({
  purpose: "certificate.private_key_envelope",
  recordId: id,
});
export const certificateAccountBinding = (id: string) => ({
  purpose: "certificate.account_envelope",
  recordId: id,
});
export const acmeAccountBinding = (id: string) => ({
  purpose: "acme_account.account_envelope",
  recordId: id,
});
export const dnsCredentialBinding = (id: string) => ({
  purpose: "dns_credential.credential_envelope",
  recordId: id,
});

export function certificateDto(row: typeof schema.certificate.$inferSelect): CertificateDto {
  return {
    id: row.id,
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

export async function findCertificate(db: Executor, id: string) {
  const [row] = await db
    .select()
    .from(schema.certificate)
    .where(eq(schema.certificate.id, id))
    .for("update");
  if (!row) fail("CERTIFICATE_NOT_FOUND", "certificate not found");
  return row;
}

const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** Runs a check whose own exceptions (unreadable input) mean the given failure. */
function readOr<T>(read: () => T, fallback: () => T): T {
  try {
    return read();
  } catch {
    return fallback();
  }
}

/**
 * Checks a chain and its key and returns them re-encoded: only the
 * certificates and the key in PKCS #8 are ever stored, whatever else the
 * pasted text held. Any other PEM block in the chain (a combined
 * fullchain-and-key file) is refused, so a key never lands in `chain_pem`.
 * Each problem has its own error code, so the operator learns which one it is.
 */
export function inspectCertificate(chainPem: string, privateKeyPem: string) {
  const labels = [...chainPem.matchAll(/-----BEGIN ([^\r\n]*?)-----/g)].map((m) => m[1]);
  if (labels.some((label) => label !== "CERTIFICATE"))
    fail("CERTIFICATE_CHAIN_FOREIGN_BLOCK", "the chain may contain only certificates");
  const unreadableChain: () => never = () =>
    fail("CERTIFICATE_CHAIN_UNREADABLE", "the chain must hold 1 to 10 readable PEM certificates");
  const blocks = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length || blocks.length > 10 || blocks.length !== labels.length) unreadableChain();
  const chain = readOr(() => blocks.map((block) => new X509Certificate(block)), unreadableChain);
  const key = readOr(
    () => createPrivateKey(privateKeyPem),
    () => fail("CERTIFICATE_KEY_UNREADABLE", "the private key cannot be read (or is encrypted)"),
  );
  const leaf = chain[0] as X509Certificate;
  const wrongOrder: () => never = () =>
    fail("CERTIFICATE_CHAIN_ORDER", "the chain must start with the leaf, each issued by the next");
  if (leaf.ca) wrongOrder();
  if (
    !readOr(
      () => leaf.checkPrivateKey(key),
      () => false,
    )
  )
    fail("CERTIFICATE_KEY_MISMATCH", "the private key does not belong to the certificate");
  for (let i = 0; i + 1 < chain.length; i++) {
    const cert = chain[i] as X509Certificate;
    const issuer = chain[i + 1] as X509Certificate;
    if (
      !issuer.ca ||
      !readOr(
        () => cert.checkIssued(issuer) && cert.verify(issuer.publicKey),
        () => false,
      )
    )
      wrongOrder();
  }
  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (notBefore.getTime() > Date.now() || notAfter.getTime() <= Date.now())
    fail("CERTIFICATE_NOT_CURRENTLY_VALID", "the certificate is not currently valid", {
      notBefore: utc(notBefore),
      notAfter: utc(notAfter),
    });
  const names = [
    ...new Set(
      (leaf.subjectAltName ?? "")
        .split(/,\s*/)
        .filter((part) => part.startsWith("DNS:"))
        .map((part) => part.slice(4).toLowerCase()),
    ),
  ];
  if (!names.length || names.some((name) => !/^(\*\.)?[a-z0-9.-]+$/.test(name)))
    fail("CERTIFICATE_NO_DNS_NAMES", "the certificate needs DNS names (subject alternative names)");
  return {
    leaf,
    names,
    notBefore,
    notAfter,
    fingerprint: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
    chainPem: chain.map((cert) => cert.toString()).join(""),
    privateKeyPem: key.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export async function listCertificates(app: AppContext) {
  return (await app.db.select().from(schema.certificate)).map(certificateDto);
}

export function certificateSettings(app: AppContext): CertificateSettings {
  return { acmeDirectory: app.env.EDGEWEIR_ACME_DIRECTORY || null };
}

export async function uploadCertificate(
  app: AppContext,
  input: CertificateUpload,
  ctx: CertificateContext,
) {
  const inspected = inspectCertificate(input.chainPem, input.privateKeyPem);
  const id = randomUUID();
  return app.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.certificate)
      .values({
        id,
        name: input.name,
        names: inspected.names,
        source: "upload",
        status: "ready",
        chainPem: inspected.chainPem,
        privateKeyEnvelope: JSON.stringify(
          app.masterKey.seal(inspected.privateKeyPem, certificateKeyBinding(id)),
        ),
        fingerprint: inspected.fingerprint,
        notBefore: inspected.notBefore,
        notAfter: inspected.notAfter,
      })
      .returning();
    if (!row) throw new Error("certificate insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "certificate.upload",
      targetType: "certificate",
      targetId: id,
      targetName: input.name,
    });
    return certificateDto(row);
  });
}

/** A certificate name outside a DNS zone (the zone itself and names below it are inside). */
const outsideZone = (name: string, zone: string) =>
  name.replace(/^\*\./, "") !== zone && !name.endsWith(`.${zone}`);

export async function requestCertificate(
  app: AppContext,
  input: CertificateRequest,
  ctx: CertificateContext,
) {
  const id = randomUUID();
  if (input.challenge === "http01") {
    // An HTTP-01 challenge is answered by the nodes of the clusters that serve the name.
    const served = await app.db
      .selectDistinct({ name: schema.siteDomain.name })
      .from(schema.siteDomain)
      .where(
        and(inArray(schema.siteDomain.name, input.names), eq(schema.siteDomain.wildcard, false)),
      );
    const unserved = input.names.filter((name) => !served.some((d) => d.name === name));
    if (unserved.length)
      fail("CERTIFICATE_DOMAIN_MISMATCH", "add the HTTP-01 names to a site first", {
        domains: unserved.slice(0, 5).join(", "),
      });
    await assertHttp01Ready(app, input.names, { skipDnsCheck: input.skipDnsCheck });
  }
  if (input.dnsCredentialId) {
    const credential = await findDnsCredential(app.db, input.dnsCredentialId);
    const outside = input.names.filter((name) => outsideZone(name, credential.zone));
    if (outside.length)
      fail(
        "CERTIFICATE_DOMAIN_MISMATCH",
        "DNS credential zone does not cover all certificate names",
        {
          domains: outside.slice(0, 5).join(", "),
        },
      );
  }
  return app.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.certificate)
      .values({
        id,
        name: input.name,
        names: input.names,
        source: "acme",
        autoRenew: input.autoRenew,
        acme: {
          ca: input.ca,
          challenge: input.challenge,
          email: input.email,
          dnsCredentialId: input.dnsCredentialId ?? "",
          ...(input.challenge === "http01" && input.skipDnsCheck ? { skipDnsCheck: "true" } : {}),
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
      targetType: "certificate",
      targetId: id,
      targetName: input.name,
    });
    return certificateDto(row);
  });
}

/**
 * Checks that a site's certificate covers the site's new domains. An ACME
 * certificate the console renews takes the domains it does not cover yet:
 * its names grow by them (a name below one of its wildcards needs none)
 * and it is reissued at once; an attempt already running is left alone and
 * reissues when it ends (issueNow). Until the new chain is issued, nodes
 * keep the current one and the new domains wait (loadSiteModels). Any
 * other certificate must cover every domain (CERTIFICATE_DOMAIN_MISMATCH,
 * naming the domains). Returns the certificate when its names grew.
 */
export async function coverSiteDomains(
  tx: Executor,
  certificateId: string,
  domains: { name: string; wildcard: boolean }[],
  ctx: CertificateContext & { site: { id: string; name: string } },
): Promise<{ id: string; name: string } | undefined> {
  const cert = await findCertificate(tx, certificateId);
  const uncovered = uncoveredDomains(cert.chainPem, domains);
  if (!uncovered.length) return undefined;
  if (cert.source !== "acme" || !cert.autoRenew) failUncovered(uncovered);
  // Names the certificate already grew by wait for its reissue.
  const missing = uncovered.filter((domain) => !namesCover(cert.names, domain));
  if (!missing.length) return undefined;
  // HTTP-01 cannot validate wildcards; DNS-01 only names in its credential's zone.
  const refused =
    cert.acme.challenge === "dns01"
      ? await (async () => {
          if (!cert.acme.dnsCredentialId) return missing;
          const credential = await findDnsCredential(tx, cert.acme.dnsCredentialId);
          return missing.filter((d) => outsideZone(certificateName(d), credential.zone));
        })()
      : missing.filter((d) => d.wildcard);
  if (refused.length) failUncovered(refused);
  const added = missing.map(certificateName);
  const names = [...cert.names, ...added];
  if (names.length > 100) failUncovered(missing);
  await tx
    .update(schema.certificate)
    .set({
      names,
      ...(cert.status === "issuing" ? {} : { status: "pending", lastError: "" }),
      updatedAt: new Date(),
    })
    .where(eq(schema.certificate.id, cert.id));
  await recordAudit(tx, ctx.actor, {
    action: "certificate.names_extended",
    targetType: "certificate",
    targetId: cert.id,
    targetName: cert.name,
    metadata: { siteId: ctx.site.id, site: ctx.site.name, added },
  });
  return { id: cert.id, name: cert.name };
}

export async function renewCertificate(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const cert = await findCertificate(tx, id);
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
      targetType: "certificate",
      targetId: id,
      targetName: cert.name,
    });
    return certificateDto(updated);
  });
}

/**
 * Deletes a certificate no site uses (CERTIFICATE_IN_USE names the sites)
 * and that is not issuing (CERTIFICATE_BUSY). DNS-01 TXT records still to
 * clean up are given up: the audit entry lists them for removal by hand.
 */
export async function deleteCertificate(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const cert = await findCertificate(tx, id);
    const sites = await tx
      .select({ name: schema.site.name })
      .from(schema.site)
      .where(eq(schema.site.certificateId, id))
      .orderBy(schema.site.name)
      .limit(5);
    if (sites.length)
      fail("CERTIFICATE_IN_USE", "certificate is used by sites", {
        sites: sites.map((site) => site.name).join(", "),
      });
    if (cert.status === "issuing") fail("CERTIFICATE_BUSY", "certificate is issuing");
    const leases = await tx
      .delete(schema.dnsChallengeLease)
      .where(eq(schema.dnsChallengeLease.certificateId, id))
      .returning({
        record: schema.dnsChallengeLease.record,
        credentialId: schema.dnsChallengeLease.credentialId,
      });
    const zones = leases.length
      ? await tx
          .select({ id: schema.dnsCredential.id, zone: schema.dnsCredential.zone })
          .from(schema.dnsCredential)
          .where(inArray(schema.dnsCredential.id, [...new Set(leases.map((l) => l.credentialId))]))
      : [];
    const leftDnsRecords = [
      ...new Set(
        leases.map(({ record, credentialId }) => {
          const zone = zones.find((z) => z.id === credentialId)?.zone ?? "";
          return `${record.name}.${zone} TXT ${record.data}`;
        }),
      ),
    ].sort();
    await tx.delete(schema.certificate).where(eq(schema.certificate.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "certificate.delete",
      targetType: "certificate",
      targetId: id,
      targetName: cert.name,
      ...(leftDnsRecords.length ? { metadata: { leftDnsRecords } } : {}),
    });
    return { ok: true as const };
  });
}

async function tlsSite(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.site).where(eq(schema.site.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}
export async function getHttps(app: AppContext, id: string) {
  const site = await tlsSite(app.db, id);
  return tlsSettings.parse({ ...site.tlsSettings, certificateId: site.certificateId });
}
export async function updateHttps(
  app: AppContext,
  id: string,
  settings: TlsSettings,
  ctx: CertificateContext,
) {
  return app.db.transaction(async (tx) => {
    const site = await tlsSite(tx, id, true);
    if (settings.certificateId) {
      const cert = await findCertificate(tx, settings.certificateId);
      if (!cert.chainPem || !cert.notAfter || cert.notAfter.getTime() <= Date.now())
        fail("CERTIFICATE_UNAVAILABLE", "certificate is not issued yet or expired");
      const domains = await tx
        .select()
        .from(schema.siteDomain)
        .where(eq(schema.siteDomain.siteId, id));
      // The site's own ACME certificate may be being reissued for domains
      // added since (coverSiteDomains): they wait for it, as before.
      const waiting = (domain: { name: string; wildcard: boolean }) =>
        cert.id === site.certificateId && cert.source === "acme" && namesCover(cert.names, domain);
      const uncovered = uncoveredDomains(cert.chainPem, domains).filter((d) => !waiting(d));
      if (uncovered.length) failUncovered(uncovered);
    }
    const { certificateId, ...options } = settings;
    await tx
      .update(schema.site)
      .set({ certificateId, tlsSettings: options })
      .where(eq(schema.site.id, id));
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "certificate_updated", params: { site: site.name } },
      userId: publisher(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.https_update",
      targetType: "site",
      targetId: id,
      targetName: site.name,
    });
    return settings;
  });
}

export async function findDnsCredential(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.dnsCredential).where(eq(schema.dnsCredential.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) fail("DNS_CREDENTIAL_NOT_FOUND", "DNS credential not found");
  return row;
}
export async function listDnsCredentials(app: AppContext) {
  return app.db
    .select({
      id: schema.dnsCredential.id,
      name: schema.dnsCredential.name,
      provider: schema.dnsCredential.provider,
      zone: schema.dnsCredential.zone,
    })
    .from(schema.dnsCredential)
    .orderBy(schema.dnsCredential.name);
}
const credentialDto = (row: typeof schema.dnsCredential.$inferSelect) => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  zone: row.zone,
});
const sealCredential = (app: AppContext, id: string, credentials: Record<string, string>) =>
  JSON.stringify(app.masterKey.seal(JSON.stringify(credentials), dnsCredentialBinding(id)));
export const openDnsCredential = (
  app: AppContext,
  row: typeof schema.dnsCredential.$inferSelect,
): Record<string, string> =>
  JSON.parse(
    app.masterKey
      .open(JSON.parse(row.credentialEnvelope), dnsCredentialBinding(row.id))
      .toString("utf8"),
  );
export async function createDnsCredential(
  app: AppContext,
  input: DnsCredentialInput,
  ctx: CertificateContext,
) {
  const id = randomUUID();
  const credentials = validCredentials(
    app,
    input.provider,
    input.credentials,
    "DNS_CREDENTIAL_INVALID",
  );
  return app.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.dnsCredential)
      .values({
        id,
        name: input.name,
        provider: input.provider,
        zone: input.zone,
        credentialEnvelope: sealCredential(app, id, credentials),
      })
      .returning();
    if (!row) throw new Error("DNS credential insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "dns_credential.create",
      targetType: "dns_credential",
      targetId: id,
      targetName: input.name,
      metadata: { provider: input.provider, zone: input.zone },
    });
    return credentialDto(row);
  });
}
/** Renames or rotates the credentials (every field again). */
export async function updateDnsCredential(
  app: AppContext,
  input: { id: string; name?: string; credentials?: Record<string, string> },
  ctx: CertificateContext,
) {
  return app.db.transaction(async (tx) => {
    const row = await findDnsCredential(tx, input.id, true);
    const credentials = input.credentials
      ? validCredentials(app, row.provider, input.credentials, "DNS_CREDENTIAL_INVALID")
      : undefined;
    const [updated] = await tx
      .update(schema.dnsCredential)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(credentials ? { credentialEnvelope: sealCredential(app, row.id, credentials) } : {}),
      })
      .where(eq(schema.dnsCredential.id, row.id))
      .returning();
    if (!updated) throw new Error("DNS credential disappeared");
    // New credentials are tried at once: by certificates whose issuance
    // failed, and by TXT records whose cleanup failed.
    const retried = credentials
      ? await tx
          .update(schema.certificate)
          .set({ renewAt: new Date() })
          .where(
            and(
              eq(schema.certificate.status, "error"),
              sql`${schema.certificate.acme}->>'dnsCredentialId' = ${row.id}`,
            ),
          )
          .returning({ id: schema.certificate.id })
      : [];
    if (credentials)
      await tx
        .update(schema.dnsChallengeLease)
        .set({ expiresAt: new Date() })
        .where(
          and(
            eq(schema.dnsChallengeLease.credentialId, row.id),
            gt(schema.dnsChallengeLease.attempts, 0),
          ),
        );
    await recordAudit(tx, ctx.actor, {
      action: "dns_credential.update",
      targetType: "dns_credential",
      targetId: row.id,
      targetName: updated.name,
      metadata: {
        credentialsRotated: !!credentials,
        ...(retried.length ? { retriedCertificates: retried.length } : {}),
      },
    });
    return credentialDto(updated);
  });
}
async function credentialSource(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string> },
) {
  if ("id" in input) {
    const row = await findDnsCredential(app.db, input.id);
    return { provider: row.provider, zone: row.zone, credentials: openDnsCredential(app, row) };
  }
  return {
    provider: input.provider,
    zone: undefined,
    credentials: validCredentials(app, input.provider, input.credentials, "DNS_CREDENTIAL_INVALID"),
  };
}
/** Zones the credentials can manage (providers that can list zones). */
export async function dnsCredentialZones(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string> },
) {
  const { provider, credentials } = await credentialSource(app, input);
  if (!dnsProviderEntry(provider)?.capabilities.listZones)
    fail("DNS_ZONES_UNSUPPORTED", "this provider cannot list zones");
  const zones = await probe(() => certdDns<string[]>(app, "dns.zones", { provider, credentials }));
  return {
    zones: [...new Set(zones.map((z) => z.replace(/\.$/, "").toLowerCase()))].sort().slice(0, 1000),
  };
}
/** Reads the zone's records with the credentials (connection test). */
export async function testDnsCredential(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string>; zone: string },
) {
  const resolved = await credentialSource(app, input);
  const zone = "zone" in input ? input.zone : resolved.zone;
  const result = await probe(() =>
    certdDns<{ records: number }>(app, "dns.test", { ...resolved, zone }),
  );
  return { ok: true as const, records: result.records };
}
export async function deleteDnsCredential(app: AppContext, id: string, ctx: CertificateContext) {
  return app.db.transaction(async (tx) => {
    const row = await findDnsCredential(tx, id, true);
    const refs = await tx
      .select({ name: schema.certificate.name })
      .from(schema.certificate)
      .where(sql`${schema.certificate.acme}->>'dnsCredentialId' = ${id}`)
      .orderBy(schema.certificate.name)
      .limit(5);
    if (refs.length)
      fail("DNS_CREDENTIAL_IN_USE", "DNS credential is used by certificates", {
        certificates: refs.map((ref) => ref.name).join(", "),
      });
    await tx.delete(schema.dnsCredential).where(eq(schema.dnsCredential.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "dns_credential.delete",
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
  // Certificates of every revision the cluster's nodes may run (stable, candidate, latest):
  // a certificate renewed in place has a different fingerprint in each of them.
  const authorized = new Set<string>();
  for (const revision of await publishedRevisions(app.db, clusterId)) {
    const row = await getRevision(app.db, clusterId, revision);
    if (!row) continue;
    for (const cert of decodeNodeConfig(row.ir).certificates)
      authorized.add(`${cert.id}/${cert.sha256Fingerprint}`);
  }
  if (!authorized.size) return [];
  const rows = await app.db
    .selectDistinct({ certificate: schema.certificate })
    .from(schema.certificate)
    .where(inArray(schema.certificate.id, valid));
  return rows
    .filter(({ certificate: cert }) => authorized.has(`${cert.id}/${cert.fingerprint}`))
    .map(({ certificate: cert }) => ({
      id: cert.id,
      chainPem: cert.chainPem,
      privateKeyPem: app.masterKey
        .open(JSON.parse(cert.privateKeyEnvelope), certificateKeyBinding(cert.id))
        .toString("utf8"),
      sha256Fingerprint: cert.fingerprint,
    }));
}
