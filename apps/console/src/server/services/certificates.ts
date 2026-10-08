import { createPrivateKey, type KeyObject, randomUUID, X509Certificate } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  type CertificateDto,
  type CertificateRequest,
  type CertificateSettings,
  type CertificateUpload,
  certificateUnloadable,
  type DnsCredentialInput,
  dnsProviderEntry,
  siteCertificateIds,
  type TlsSettings,
  tlsSettings,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  certificateName,
  failUncovered,
  namesCover,
  uncoveredByAll,
} from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { namesHosts } from "../lib/site-domains";
import { customAcmeDirectory, defaultAcmeCa, readPemCertificates } from "./acme-directory";
import { type Actor, recordAudit, systemActor } from "./audit";
import { certdDns, probe, validCredentials } from "./dns-providers";
import { assertHttp01Ready } from "./http01-check";
import { type Executor, getRevision, publishRevision } from "./revisions";
import { publishedRevisions } from "./rollout";
import { assertSitePorts, portsOf } from "./site-ports";

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
    bindSiteId: row.acme.bindSiteId || null,
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

/**
 * Whether the nodes can serve a leaf with this key to every TLS client: RSA
 * of 2048 bits or more, or ECDSA on P-256, P-384 or P-521, the keys public
 * CAs issue (CA/Browser Forum Baseline Requirements 6.1.5). The agent loads
 * the pair with Go's tls.X509KeyPair, whose error fails the revision on
 * every node of the cluster: it refuses other curves (secp256k1, Brainpool,
 * SM2), Ed448, RSA-PSS and DSA keys and RSA exponents above 2³¹ − 1.
 * OpenResty (OpenSSL's default security level 2) refuses RSA keys under 2048
 * bits in every handshake. Go also loads P-224, Ed25519 and ML-DSA keys;
 * they are refused because a site has one certificate and many clients could
 * not connect: P-224 has no TLS 1.3 signature scheme (and OpenSSL clients do
 * not offer it in TLS 1.2), Chromium does not offer Ed25519, and ML-DSA works
 * only over TLS 1.3 with clients that offer it.
 */
function servableKey(key: KeyObject) {
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === "rsa") {
    const exponent = details.publicExponent ?? 0n;
    return (details.modulusLength ?? 0) >= 2048 && exponent % 2n === 1n && exponent < 2n ** 31n;
  }
  return (
    key.asymmetricKeyType === "ec" &&
    ["prime256v1", "secp384r1", "secp521r1"].includes(details.namedCurve ?? "")
  );
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

/** The bounds of the contents of the DER element at `at`. */
function derContents(der: Uint8Array, at: number) {
  let length = der[at + 1] ?? 0;
  let start = at + 2;
  if (length > 0x80) {
    const bytes = length - 0x80;
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + (der[start + i] ?? 0);
    start += bytes;
  }
  return { start, end: start + length };
}

/** The OBJECT IDENTIFIER element id-ecPublicKey (1.2.840.10045.2.1). */
const EC_PUBLIC_KEY = Buffer.from("06072a8648ce3d0201", "hex");

/**
 * Whether the AlgorithmIdentifier at `at` is not an EC key's or names its
 * curve. OpenSSL, and so Node, also reads EC keys that spell out the curve's
 * parameters (and reports them as the named curve), but RFC 5480 and
 * RFC 5915 allow only the curve's OID and Go's crypto/x509 refuses anything
 * else: the nodes cannot load such a key or leaf, and Go TLS clients refuse
 * a chain with such a certificate.
 */
function namesCurve(der: Uint8Array, at: number) {
  const { start, end } = derContents(der, at);
  const parameters = start + EC_PUBLIC_KEY.length;
  if (!EC_PUBLIC_KEY.equals(der.subarray(start, parameters))) return true;
  return parameters < end && der[parameters] === 0x06;
}

/** Where a DER certificate's subjectPublicKeyInfo algorithm starts. */
function publicKeyAlgorithm(der: Uint8Array) {
  let at = derContents(der, derContents(der, 0).start).start;
  if (der[at] === 0xa0) at = derContents(der, at).end; // version
  // serialNumber, signature, issuer, validity, subject
  for (let i = 0; i < 5; i++) at = derContents(der, at).end;
  return derContents(der, at).start;
}

/** Whether every certificate's key names its curve (namesCurve). */
const chainNamesCurves = (chain: readonly X509Certificate[]) =>
  chain.every((cert) => namesCurve(cert.raw, publicKeyAlgorithm(cert.raw)));

/** Whether a private key names its curve (namesCurve). */
function keyNamesCurve(key: KeyObject) {
  const pkcs8 = key.export({ type: "pkcs8", format: "der" });
  // PrivateKeyInfo: version, then privateKeyAlgorithm.
  return namesCurve(pkcs8, derContents(pkcs8, derContents(pkcs8, 0).start).end);
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

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
  const blocks = chainPem.match(PEM_CERTIFICATE);
  if (!blocks?.length || blocks.length > 10 || blocks.length !== labels.length) unreadableChain();
  const chain = readOr(() => blocks.map((block) => new X509Certificate(block)), unreadableChain);
  // Refused rather than re-encoded: a certificate's key cannot be changed
  // without its issuer, and tools that write such keys (LibreSSL's default)
  // usually sign the certificate with that encoding too.
  if (!chainNamesCurves(chain))
    fail("CERTIFICATE_CHAIN_EXPLICIT_CURVE", "an EC certificate key must name its curve");
  const key = readOr(
    () => createPrivateKey(privateKeyPem),
    () => fail("CERTIFICATE_KEY_UNREADABLE", "the private key cannot be read (or is encrypted)"),
  );
  if (!keyNamesCurve(key))
    fail("CERTIFICATE_KEY_EXPLICIT_CURVE", "an EC private key must name its curve");
  const leaf = chain[0] as X509Certificate;
  const wrongOrder: () => never = () =>
    fail("CERTIFICATE_CHAIN_ORDER", "the chain must start with the leaf, each issued by the next");
  if (leaf.ca) wrongOrder();
  if (!servableKey(leaf.publicKey))
    fail(
      "CERTIFICATE_KEY_TYPE_UNSUPPORTED",
      "the leaf key must be RSA (2048+ bits) or ECDSA P-256/384/521",
    );
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

/**
 * A site's client CA bundle (mutual TLS) re-encoded: 1-10 current CA
 * certificates (basicConstraints CA) with keys nodes load (servableKey,
 * named curves), and nothing else (CLIENT_CA_INVALID).
 */
export function inspectClientCa(pem: string): string {
  const certificates = readPemCertificates(pem, { ca: true });
  const now = Date.now();
  if (
    !certificates ||
    !chainNamesCurves(certificates) ||
    certificates.some(
      (cert) =>
        !servableKey(cert.publicKey) ||
        new Date(cert.validFrom).getTime() > now ||
        new Date(cert.validTo).getTime() <= now,
    )
  )
    fail("CLIENT_CA_INVALID", "the client CA must be 1 to 10 current CA certificates in PEM");
  return certificates.map((cert) => cert.toString()).join("");
}

type CertificateRow = typeof schema.certificate.$inferSelect;

/**
 * Why nodes cannot load a stored, issued certificate, or undefined: an EC
 * key of its chain or its private key spells out the curve's parameters.
 * Uploads stored such keys until inspectCertificate refused them; nodes
 * (Go's crypto/tls) refuse the material, and a revision that carries it is
 * applied on no node of its cluster.
 */
export function explicitCurveError(
  app: AppContext,
  cert: Pick<CertificateRow, "id" | "chainPem" | "privateKeyEnvelope">,
) {
  const chain = (cert.chainPem.match(PEM_CERTIFICATE) ?? []).map((pem) => new X509Certificate(pem));
  if (!chainNamesCurves(chain)) return "CERTIFICATE_CHAIN_EXPLICIT_CURVE" as const;
  const key = createPrivateKey(
    app.masterKey
      .open(JSON.parse(cert.privateKeyEnvelope), certificateKeyBinding(cert.id))
      .toString("utf8"),
  );
  if (!keyNamesCurve(key)) return "CERTIFICATE_KEY_EXPLICIT_CURVE" as const;
  return undefined;
}

/**
 * Refuses binding an issued certificate nodes cannot load
 * (explicitCurveError), with the code inspectCertificate refuses its upload
 * with now. Checks the stored material itself, not only the mark
 * markUnloadableCertificates leaves.
 */
export function assertLoadable(
  app: AppContext,
  cert: Pick<CertificateRow, "id" | "chainPem" | "privateKeyEnvelope">,
) {
  const code = explicitCurveError(app, cert);
  if (code === "CERTIFICATE_CHAIN_EXPLICIT_CURVE")
    fail(code, "nodes cannot load the certificate: an EC certificate key must name its curve");
  if (code === "CERTIFICATE_KEY_EXPLICIT_CURVE")
    fail(code, "nodes cannot load the certificate: its EC private key must name its curve");
}

/**
 * Marks the uploaded certificates nodes cannot load (explicitCurveError):
 * status "error" with the reason as `lastError`
 * (certificate_chain_explicit_curve, certificate_key_explicit_curve), each
 * audited as the system with the sites and layer-4 applications bound to it. The list, the HTTPS tab
 * and the launch check show it, and https.check and the HTTPS tab no longer
 * offer it. Sites bound to it keep it until the operator binds another one
 * (or none): nothing they serve changes behind the operator's back. Runs at
 * every worker start (maintenance.check-certificates), as the keys are
 * envelope-encrypted and no SQL migration can read them; marked uploads are
 * skipped, so a later run audits nothing twice. ACME certificates are left
 * alone: certd only ever writes named curves, their status belongs to
 * issuance, and a binding still checks them (assertLoadable). Returns the
 * ids marked now.
 */
export async function markUnloadableCertificates(app: AppContext) {
  const rows = await app.db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.source, "upload"), ne(schema.certificate.chainPem, "")))
    .orderBy(asc(schema.certificate.name));
  const marked: string[] = [];
  for (const row of rows) {
    if (certificateUnloadable(row)) continue;
    let code: ReturnType<typeof explicitCurveError>;
    try {
      code = explicitCurveError(app, row);
    } catch (error) {
      app.log.warn("cannot check a stored certificate", {
        certificateId: row.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
      continue;
    }
    if (!code) continue;
    const lastError = code.toLowerCase();
    await app.db.transaction(async (tx) => {
      // The same material as checked; a mark another process left wins.
      const [updated] = await tx
        .update(schema.certificate)
        .set({ status: "error", lastError, updatedAt: new Date() })
        .where(
          and(
            eq(schema.certificate.id, row.id),
            eq(schema.certificate.fingerprint, row.fingerprint),
            or(ne(schema.certificate.status, "error"), ne(schema.certificate.lastError, lastError)),
          ),
        )
        .returning({ id: schema.certificate.id });
      if (!updated) return;
      const sites = await tx
        .select({ name: schema.site.name })
        .from(schema.site)
        .where(usesCertificate(row.id))
        .orderBy(schema.site.name)
        .limit(20);
      const l4Apps = await tx
        .select({ name: schema.l4App.name })
        .from(schema.l4App)
        .where(eq(schema.l4App.certificateId, row.id))
        .orderBy(schema.l4App.name)
        .limit(20);
      await recordAudit(tx, systemActor, {
        action: "certificate.unloadable",
        targetType: "certificate",
        targetId: row.id,
        targetName: row.name,
        metadata: {
          code: lastError,
          sites: sites.map((site) => site.name),
          // Layer-4 applications that terminate TLS with it, where there are any.
          ...(l4Apps.length ? { l4Apps: l4Apps.map((app) => app.name) } : {}),
        },
      });
      marked.push(row.id);
    });
  }
  if (marked.length)
    app.log.warn("certificates nodes cannot load: bind other certificates to their sites", {
      certificateIds: marked,
    });
  return marked;
}

export async function listCertificates(app: AppContext) {
  return (await app.db.select().from(schema.certificate)).map(certificateDto);
}

export async function certificateSettings(app: AppContext): Promise<CertificateSettings> {
  const custom = await customAcmeDirectory(app);
  return {
    acmeDirectory: custom?.url ?? null,
    acmeDirectoryEab: !!custom?.eab,
    defaultCa: await defaultAcmeCa(app),
  };
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
export const outsideZone = (name: string, zone: string) =>
  name.replace(/^\*\./, "") !== zone && !name.endsWith(`.${zone}`);

export async function requestCertificate(
  app: AppContext,
  input: CertificateRequest,
  ctx: CertificateContext,
) {
  const id = randomUUID();
  const ca = input.ca ?? (await defaultAcmeCa(app));
  if (ca === "custom" && !(await customAcmeDirectory(app)))
    fail("ACME_DIRECTORY_NOT_CONFIGURED", "configure a custom ACME directory first");
  if (input.bindSiteId) await assertBindable(app.db, input.bindSiteId, input.names);
  if (input.challenge === "http01") {
    // An HTTP-01 challenge is answered by the nodes of the clusters that serve the name.
    const served = await app.db
      .selectDistinct({ name: schema.siteDomain.name })
      .from(schema.siteDomain)
      .where(
        and(inArray(schema.siteDomain.name, input.names), eq(schema.siteDomain.kind, "exact")),
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
          ca,
          keyType: input.keyType,
          challenge: input.challenge,
          email: input.email,
          dnsCredentialId: input.dnsCredentialId ?? "",
          ...(input.challenge === "http01" && input.skipDnsCheck ? { skipDnsCheck: "true" } : {}),
          ...(input.bindSiteId ? { bindSiteId: input.bindSiteId } : {}),
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

/** Certificates waiting to be bound to the site once issued (bindSiteId). */
export const boundOnIssue = (siteId: string) =>
  sql`${schema.certificate.acme}->>'bindSiteId' = ${siteId}`;

/**
 * A request bound to a site (bindSiteId) covers every exact and wildcard
 * domain of the site (CERTIFICATE_DOMAIN_MISMATCH names the others; suffix
 * and pattern domains are served where the certificate covers the host)
 * and is the only one waiting for it (CERTIFICATE_BUSY).
 */
async function assertBindable(db: Executor, siteId: string, names: readonly string[]) {
  await tlsSite(db, siteId);
  const domains = await db
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, siteId));
  const uncovered = domains.filter(namesHosts).filter((domain) => !namesCover(names, domain));
  if (uncovered.length) failUncovered(uncovered);
  const [waiting] = await db
    .select({ id: schema.certificate.id })
    .from(schema.certificate)
    .where(boundOnIssue(siteId))
    .limit(1);
  if (waiting) fail("CERTIFICATE_BUSY", "a certificate for this site is being requested");
}

/**
 * Checks that a site's certificates cover the site's new domains (any of
 * them; the further ones as they are). An ACME
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
  domains: { name: string; kind: string }[],
  ctx: CertificateContext & { site: { id: string; name: string } },
): Promise<{ id: string; name: string } | undefined> {
  const cert = await findCertificate(tx, certificateId);
  // Domains the site's other certificates cover need nothing from this one.
  const others = (await additionalCertificateIds(tx, ctx.site.id)).filter(
    (id) => id !== certificateId,
  );
  const otherChains = others.length
    ? (
        await tx
          .select({ chainPem: schema.certificate.chainPem })
          .from(schema.certificate)
          .where(inArray(schema.certificate.id, others))
      )
        .map((row) => row.chainPem)
        .filter(Boolean)
    : [];
  const uncovered = uncoveredByAll([cert.chainPem, ...otherChains], domains);
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
      : missing.filter((d) => d.kind !== "exact");
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

/**
 * Binds a certificate issued for a site's one-click HTTPS (bindSiteId) to
 * the site, inside the issuance's transaction: the certificate (the HTTPS
 * redirect and the other settings stay the site's own), and the site's
 * domains added since the request covered by a reissue (coverSiteDomains);
 * audited as the system. A site deleted
 * meanwhile, one that has another usable certificate by now (issued, not
 * expired, not marked unloadable), or one with domains the certificate
 * cannot take keeps its settings. Returns the
 * site's cluster when bound.
 */
export async function bindIssuedCertificate(
  tx: Executor,
  cert: { id: string; name: string; siteId: string },
): Promise<string | undefined> {
  const [site] = await tx
    .select()
    .from(schema.site)
    .where(eq(schema.site.id, cert.siteId))
    .for("update");
  if (!site) return undefined;
  if (site.certificateId && site.certificateId !== cert.id) {
    const [current] = await tx
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, site.certificateId));
    if (
      current?.chainPem &&
      current.notAfter &&
      current.notAfter.getTime() > Date.now() &&
      !certificateUnloadable(current)
    )
      return undefined;
  }
  const domains = await tx
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, site.id));
  try {
    await coverSiteDomains(tx, cert.id, domains, {
      actor: systemActor,
      site: { id: site.id, name: site.name },
    });
  } catch (error) {
    // Refused before anything was written: the transaction goes on.
    if (error instanceof ORPCError && error.code === "CERTIFICATE_DOMAIN_MISMATCH")
      return undefined;
    throw error;
  }
  const settings = tlsSettings.parse({
    ...site.tlsSettings,
    certificateId: cert.id,
    // A site bound now had no usable first certificate: further ones stay.
    additionalCertificateIds: (await additionalCertificateIds(tx, site.id)).filter(
      (id) => id !== cert.id,
    ),
  });
  await tx
    .update(schema.site)
    .set({ certificateId: settings.certificateId, tlsSettings: storedTlsOptions(settings) })
    .where(eq(schema.site.id, site.id));
  await writeAdditionalCertificates(tx, site.id, settings.additionalCertificateIds);
  await recordAudit(tx, systemActor, {
    action: "site.https_update",
    targetType: "site",
    targetId: site.id,
    targetName: site.name,
    metadata: { certificateId: cert.id, certificate: cert.name },
  });
  return site.clusterId;
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
      .where(usesCertificate(id))
      .orderBy(schema.site.name)
      .limit(5);
    if (sites.length)
      fail("CERTIFICATE_IN_USE", "certificate is used by sites", {
        sites: sites.map((site) => site.name).join(", "),
      });
    const apps = await tx
      .select({ name: schema.l4App.name })
      .from(schema.l4App)
      .where(eq(schema.l4App.certificateId, id))
      .orderBy(schema.l4App.name)
      .limit(5);
    if (apps.length)
      fail("CERTIFICATE_IN_USE_BY_L4", "certificate is used by layer-4 applications", {
        apps: apps.map((app) => app.name).join(", "),
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
/** Sites that use a certificate, first or additional. */
export const usesCertificate = (certificateId: string) =>
  or(
    eq(schema.site.certificateId, certificateId),
    inArray(
      schema.site.id,
      sql`(select ${schema.siteCertificate.siteId} from ${schema.siteCertificate} where ${schema.siteCertificate.certificateId} = ${certificateId})`,
    ),
  );

/** The ids of a site's certificates after the first, in the site's order. */
export async function additionalCertificateIds(db: Executor, siteId: string) {
  return (
    await db
      .select({ id: schema.siteCertificate.certificateId })
      .from(schema.siteCertificate)
      .where(eq(schema.siteCertificate.siteId, siteId))
      .orderBy(asc(schema.siteCertificate.position))
  ).map((row) => row.id);
}

/** A site's stored HTTPS settings with its certificates. */
export async function siteTlsSettings(
  db: Executor,
  site: { id: string; certificateId: string | null; tlsSettings: Record<string, unknown> },
): Promise<TlsSettings> {
  return tlsSettings.parse({
    ...site.tlsSettings,
    certificateId: site.certificateId,
    additionalCertificateIds: site.certificateId ? await additionalCertificateIds(db, site.id) : [],
  });
}

/** What tls_settings stores: the settings without the certificates (site columns and rows). */
export function storedTlsOptions(settings: TlsSettings): Record<string, unknown> {
  const { certificateId: _first, additionalCertificateIds: _more, ...options } = settings;
  return options;
}

/** Replaces a site's additional certificates (positions 1-3, in order). */
async function writeAdditionalCertificates(tx: Executor, siteId: string, ids: readonly string[]) {
  await tx.delete(schema.siteCertificate).where(eq(schema.siteCertificate.siteId, siteId));
  if (ids.length)
    await tx
      .insert(schema.siteCertificate)
      .values(ids.map((certificateId, i) => ({ siteId, certificateId, position: i + 1 })));
}

export async function getHttps(app: AppContext, id: string) {
  const site = await tlsSite(app.db, id);
  return siteTlsSettings(app.db, site);
}
export async function updateHttps(
  app: AppContext,
  id: string,
  input: TlsSettings,
  ctx: CertificateContext,
) {
  // Without a certificate the site has no HTTPS port to redirect to: a port
  // kept from before would name one nodes no longer serve it on; and it has
  // no further certificates and no client certificates.
  const settings: TlsSettings = input.certificateId
    ? input
    : {
        ...input,
        redirectPort: 443,
        additionalCertificateIds: [],
        clientCertificate: { ...input.clientCertificate, mode: "off" },
      };
  if (settings.clientCertificate.mode !== "off") {
    if (settings.http3)
      fail("CLIENT_CERTIFICATE_HTTP3", "client certificates and HTTP/3 cannot be on together");
    settings.clientCertificate = {
      ...settings.clientCertificate,
      caPem: inspectClientCa(settings.clientCertificate.caPem),
    };
  }
  return app.db.transaction(async (tx) => {
    const site = await tlsSite(tx, id, true);
    const ids = siteCertificateIds(settings);
    if (ids.length) {
      const certs = [];
      for (const certificateId of ids) {
        const cert = await findCertificate(tx, certificateId);
        if (!cert.chainPem || !cert.notAfter || cert.notAfter.getTime() <= Date.now())
          fail("CERTIFICATE_UNAVAILABLE", "certificate is not issued yet or expired");
        // Also when the site has it already: no revision nodes cannot apply.
        assertLoadable(app, cert);
        certs.push(cert);
      }
      const domains = await tx
        .select()
        .from(schema.siteDomain)
        .where(eq(schema.siteDomain.siteId, id));
      // The site's own first ACME certificate may be being reissued for
      // domains added since (coverSiteDomains): they wait for it, as before.
      const first = certs[0] as CertificateRow;
      const waiting = (domain: { name: string; kind: string }) =>
        first.id === site.certificateId &&
        first.source === "acme" &&
        namesCover(first.names, domain);
      // Every domain needs one of the site's certificates.
      const uncovered = uncoveredByAll(
        certs.map((cert) => cert.chainPem),
        domains,
      ).filter((d) => !waiting(d));
      if (uncovered.length) failUncovered(uncovered);
    }
    // Ports were checked when saved; without a certificate the site must
    // keep an HTTP port, and the redirect needs one of its HTTPS ports.
    await assertSitePorts(
      tx,
      { id, clusterId: site.clusterId, certificateId: settings.certificateId },
      portsOf(site),
      { checkPorts: false, tls: settings },
    );
    await tx
      .update(schema.site)
      .set({ certificateId: settings.certificateId, tlsSettings: storedTlsOptions(settings) })
      .where(eq(schema.site.id, id));
    await writeAdditionalCertificates(tx, id, settings.additionalCertificateIds);
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "certificate_updated", params: { site: site.name } },
      actor: ctx.actor,
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
