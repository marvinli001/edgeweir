import { randomUUID, X509Certificate } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { decodeNodeConfig, usesOriginCa } from "@edgeweir/config-compiler";
import {
  ORIGIN_CA_YEARS,
  ORIGIN_CLIENT_CA_YEARS,
  ORIGIN_CLIENT_CERTIFICATE_DAYS,
  ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS,
  type OriginCa,
  type OriginCertificateDto,
  type OriginCertificateIssue,
  type OriginCertificateIssued,
  type OriginClientCa,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  type CertificateRef,
  CertificateRefSchema,
  type NodeConfig,
  OriginCaSchema,
} from "@edgeweir/proto";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope, MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { lockOriginAuthority } from "../lib/locks";
import { CsrError, generateCa, OriginAuthority, sha256Fingerprint } from "../pki/ca";
import { caKeyBinding } from "../pki/store";
import { type Actor, recordAudit, systemActor } from "./audit";
import { type Executor, getRevision, latestRevision, publishClusters, type Tx } from "./revisions";
import { publishedRevisions } from "./rollout";

/** pki_authority rows of the two origin authorities. */
const ORIGIN_CLIENT_CA_ID = "origin-client";
export const ORIGIN_CA_ID = "origin-ca";
const AUTHORITY_NAMES = {
  [ORIGIN_CLIENT_CA_ID]: { commonName: "Edgeweir Origin Client CA", years: ORIGIN_CLIENT_CA_YEARS },
  [ORIGIN_CA_ID]: { commonName: "Edgeweir Origin CA", years: ORIGIN_CA_YEARS },
} as const;
type AuthorityId = keyof typeof AUTHORITY_NAMES;

/** Subject organization of the clusters' origin client certificates (CN is the cluster id). */
const ORIGIN_CLIENT_ORGANIZATION = "Edgeweir Origin Client";
/** Envelope binding of an origin client certificate's private key: the column and the row (AAD). */
export const originClientKeyBinding = (id: string) => ({
  purpose: "origin_client_certificate.private_key_envelope",
  recordId: id,
});
const DAY = 24 * 3600 * 1000;
/** Expired origin client certificates are deleted after this long. */
const EXPIRED_CLIENT_CERTIFICATE_RETENTION_MS = 7 * DAY;

type AuthorityRow = typeof schema.pkiAuthority.$inferSelect;
type OriginCertificateRow = typeof schema.originCertificate.$inferSelect;

async function authorityRow(db: Executor, id: AuthorityId): Promise<AuthorityRow | undefined> {
  const [row] = await db.select().from(schema.pkiAuthority).where(eq(schema.pkiAuthority.id, id));
  return row;
}

function openAuthority(row: AuthorityRow, masterKey: MasterKey): Promise<OriginAuthority> {
  return OriginAuthority.load({
    certificatePem: row.certificatePem,
    privateKeyPkcs8Der: masterKey.open(
      JSON.parse(row.privateKeyEnvelope) as Envelope,
      caKeyBinding(row.id),
    ),
  });
}

const authorityDto = (row: AuthorityRow | undefined) =>
  row
    ? {
        certificatePem: row.certificatePem,
        fingerprint: row.fingerprintSha256,
        notBefore: new Date(new X509Certificate(row.certificatePem).validFrom).toISOString(),
        notAfter: row.notAfter.toISOString(),
      }
    : null;

/** Creates an origin authority unless it exists; the second value tells whether it was created. */
async function ensureAuthority(
  tx: Tx,
  masterKey: MasterKey,
  id: AuthorityId,
): Promise<[AuthorityRow, boolean]> {
  await lockOriginAuthority(tx, id);
  const existing = await authorityRow(tx, id);
  if (existing) return [existing, false];
  const { commonName, years } = AUTHORITY_NAMES[id];
  const material = await generateCa(commonName, years);
  const authority = await OriginAuthority.load(material);
  const crlPem = id === ORIGIN_CA_ID ? await authority.crl([]) : "";
  const [row] = await tx
    .insert(schema.pkiAuthority)
    .values({
      id,
      certificatePem: material.certificatePem,
      fingerprintSha256: sha256Fingerprint(authority.certificate),
      privateKeyEnvelope: JSON.stringify(
        masterKey.seal(material.privateKeyPkcs8Der, caKeyBinding(id)),
      ),
      notAfter: authority.certificate.notAfter,
      crlPem,
    })
    .returning();
  if (!row) throw new Error("authority insert failed");
  return [row, true];
}

// --- origin client CA ------------------------------------------------------

export async function getOriginClientCa(app: AppContext): Promise<OriginClientCa> {
  const row = await authorityRow(app.db, ORIGIN_CLIENT_CA_ID);
  return {
    authority: authorityDto(row),
    certificates: row ? await currentClientCertificates(app.db) : [],
  };
}

export async function createOriginClientCa(
  app: AppContext,
  ctx: { actor: Actor },
): Promise<OriginClientCa> {
  await app.db.transaction(async (tx) => {
    const [row, created] = await ensureAuthority(tx, app.masterKey, ORIGIN_CLIENT_CA_ID);
    if (!created) return;
    await recordAudit(tx, ctx.actor, {
      action: "origin_client_ca.create",
      targetType: "certificate_authority",
      targetId: ORIGIN_CLIENT_CA_ID,
      targetName: AUTHORITY_NAMES[ORIGIN_CLIENT_CA_ID].commonName,
      metadata: { fingerprint: row.fingerprintSha256, notAfter: row.notAfter.toISOString() },
    });
  });
  return getOriginClientCa(app);
}

/** The newest certificate of every cluster that has one, by cluster name. */
async function currentClientCertificates(db: Executor) {
  const rows = await db
    .select({ cert: schema.originClientCertificate, clusterName: schema.cluster.name })
    .from(schema.originClientCertificate)
    .innerJoin(schema.cluster, eq(schema.cluster.id, schema.originClientCertificate.clusterId))
    .orderBy(asc(schema.cluster.name), desc(schema.originClientCertificate.notAfter));
  const seen = new Set<string>();
  return rows
    .filter(({ cert }) => !seen.has(cert.clusterId) && seen.add(cert.clusterId))
    .map(({ cert, clusterName }) => ({
      id: cert.id,
      clusterId: cert.clusterId,
      clusterName,
      serial: cert.serial,
      fingerprint: cert.fingerprint,
      notBefore: cert.notBefore.toISOString(),
      notAfter: cert.notAfter.toISOString(),
    }));
}

/** The cluster's newest origin client certificate, if any. */
async function currentClientCertificate(db: Executor, clusterId: string) {
  const [row] = await db
    .select()
    .from(schema.originClientCertificate)
    .where(eq(schema.originClientCertificate.clusterId, clusterId))
    .orderBy(desc(schema.originClientCertificate.notAfter))
    .limit(1);
  return row;
}

/**
 * Issues the cluster an origin client certificate unless its newest one is
 * valid for more than ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS. Earlier ones
 * stay valid until they expire: nodes still on an earlier revision keep
 * presenting them. Requires the origin client CA (ORIGIN_CLIENT_CA_NOT_FOUND).
 */
export async function ensureOriginClientCertificate(
  tx: Tx,
  masterKey: MasterKey,
  clusterId: string,
  now = new Date(),
): Promise<{ id: string; issued: boolean }> {
  await lockOriginAuthority(tx, `${ORIGIN_CLIENT_CA_ID}/${clusterId}`);
  const current = await currentClientCertificate(tx, clusterId);
  if (
    current &&
    current.notAfter.getTime() - now.getTime() > ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS * DAY
  )
    return { id: current.id, issued: false };
  const row = await authorityRow(tx, ORIGIN_CLIENT_CA_ID);
  if (!row) fail("ORIGIN_CLIENT_CA_NOT_FOUND", "the origin client CA has not been created");
  const authority = await openAuthority(row, masterKey);
  const issued = await authority.issueClientCertificate(
    clusterId,
    ORIGIN_CLIENT_ORGANIZATION,
    ORIGIN_CLIENT_CERTIFICATE_DAYS,
    now,
  );
  const id = randomUUID();
  await tx.insert(schema.originClientCertificate).values({
    id,
    clusterId,
    chainPem: issued.certificatePem,
    privateKeyEnvelope: JSON.stringify(
      masterKey.seal(issued.privateKeyPem, originClientKeyBinding(id)),
    ),
    fingerprint: issued.fingerprintSha256,
    serial: issued.serialNumber,
    notBefore: issued.notBefore,
    notAfter: issued.notAfter,
  });
  return { id, issued: true };
}

/**
 * Replaces the origin client certificates that are due in every cluster
 * whose sites present one, publishing the clusters whose latest revision
 * carries origin client certificates (reason origin_client_certificate_rotated),
 * and deletes certificates that expired a week ago. Returns the clusters
 * that got a new certificate.
 */
export async function rotateOriginClientCertificates(
  app: AppContext,
  now = new Date(),
): Promise<string[]> {
  if (!(await authorityRow(app.db, ORIGIN_CLIENT_CA_ID))) return [];
  const clusters = await app.db
    .selectDistinct({ clusterId: schema.site.clusterId })
    .from(schema.originPool)
    .innerJoin(schema.site, eq(schema.site.id, schema.originPool.siteId))
    .where(eq(schema.originPool.clientCertificate, true))
    .orderBy(schema.site.clusterId);
  const rotated: string[] = [];
  for (const { clusterId } of clusters) {
    try {
      const done = await app.db.transaction(async (tx) => {
        const { id, issued } = await ensureOriginClientCertificate(
          tx,
          app.masterKey,
          clusterId,
          now,
        );
        if (!issued) return false;
        const latest = await latestRevision(tx, clusterId);
        const published =
          latest && decodeNodeConfig(latest.ir).originClientCertificates.length > 0
            ? (
                await publishClusters(tx, [clusterId], {
                  reason: { code: "origin_client_certificate_rotated", params: {} },
                  actor: systemActor,
                })
              ).get(clusterId)
            : undefined;
        await recordAudit(tx, systemActor, {
          action: "origin_client_certificate.rotate",
          targetType: "origin_client_certificate",
          targetId: id,
          targetName: clusterId,
          metadata: {
            clusterId,
            revision: published?.created ? published.row.revision : null,
          },
        });
        return true;
      });
      if (done) rotated.push(clusterId);
    } catch (error) {
      app.log.error("origin client certificate rotation failed", { clusterId, error });
    }
  }
  await app.db
    .delete(schema.originClientCertificate)
    .where(
      lt(
        schema.originClientCertificate.notAfter,
        new Date(now.getTime() - EXPIRED_CLIENT_CERTIFICATE_RETENTION_MS),
      ),
    );
  return rotated;
}

/**
 * Chain and key of the origin client certificates the node's cluster
 * references in a revision its nodes may run (GetCertificates).
 */
export async function nodeOriginClientCertificates(
  app: AppContext,
  clusterId: string,
  ids: string[],
) {
  if (!ids.length) return [];
  const authorized = new Set<string>();
  for (const revision of await publishedRevisions(app.db, clusterId)) {
    const row = await getRevision(app.db, clusterId, revision);
    if (!row) continue;
    for (const cert of decodeNodeConfig(row.ir).originClientCertificates)
      authorized.add(`${cert.id}/${cert.sha256Fingerprint}`);
  }
  if (!authorized.size) return [];
  const rows = await app.db
    .select()
    .from(schema.originClientCertificate)
    .where(
      and(
        eq(schema.originClientCertificate.clusterId, clusterId),
        inArray(schema.originClientCertificate.id, ids),
      ),
    );
  return rows
    .filter((cert) => authorized.has(`${cert.id}/${cert.fingerprint}`))
    .map((cert) => ({
      id: cert.id,
      chainPem: cert.chainPem,
      privateKeyPem: app.masterKey
        .open(JSON.parse(cert.privateKeyEnvelope) as Envelope, originClientKeyBinding(cert.id))
        .toString("utf8"),
      sha256Fingerprint: cert.fingerprint,
    }));
}

// --- Origin CA -------------------------------------------------------------

export async function getOriginCa(app: AppContext): Promise<OriginCa> {
  return { authority: authorityDto(await authorityRow(app.db, ORIGIN_CA_ID)) };
}

export async function createOriginCa(app: AppContext, ctx: { actor: Actor }): Promise<OriginCa> {
  await app.db.transaction(async (tx) => {
    const [row, created] = await ensureAuthority(tx, app.masterKey, ORIGIN_CA_ID);
    if (!created) return;
    await recordAudit(tx, ctx.actor, {
      action: "origin_ca.create",
      targetType: "certificate_authority",
      targetId: ORIGIN_CA_ID,
      targetName: AUTHORITY_NAMES[ORIGIN_CA_ID].commonName,
      metadata: { fingerprint: row.fingerprintSha256, notAfter: row.notAfter.toISOString() },
    });
  });
  return getOriginCa(app);
}

const originCertificateDto = (row: OriginCertificateRow): OriginCertificateDto => ({
  id: row.id,
  hostnames: row.hostnames,
  keyType: row.keyType,
  source: row.source === "csr" ? "csr" : "generated",
  serial: row.serial,
  fingerprint: row.fingerprint,
  certificatePem: row.certificatePem,
  notBefore: row.notBefore.toISOString(),
  notAfter: row.notAfter.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export async function listOriginCertificates(app: AppContext): Promise<OriginCertificateDto[]> {
  const rows = await app.db
    .select()
    .from(schema.originCertificate)
    .orderBy(desc(schema.originCertificate.createdAt));
  return rows.map(originCertificateDto);
}

export async function issueOriginCertificate(
  app: AppContext,
  input: OriginCertificateIssue,
  ctx: { actor: Actor },
): Promise<OriginCertificateIssued> {
  const row = await authorityRow(app.db, ORIGIN_CA_ID);
  if (!row) fail("ORIGIN_CA_NOT_FOUND", "the Origin CA has not been created");
  const authority = await openAuthority(row, app.masterKey);
  let issued: Awaited<ReturnType<OriginAuthority["issueOriginCertificate"]>>;
  try {
    issued = await authority.issueOriginCertificate({
      hostnames: input.hostnames,
      years: input.validityYears,
      keyType: input.keyType,
      ...(input.csrPem ? { csrPem: input.csrPem } : {}),
    });
  } catch (error) {
    if (error instanceof CsrError) fail("ORIGIN_CERTIFICATE_CSR_INVALID", error.message);
    throw error;
  }
  return app.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.originCertificate)
      .values({
        hostnames: input.hostnames,
        keyType: issued.keyType,
        source: input.csrPem ? "csr" : "generated",
        certificatePem: issued.certificatePem,
        serial: issued.serialNumber,
        fingerprint: issued.fingerprintSha256,
        notBefore: issued.notBefore,
        notAfter: issued.notAfter,
      })
      .returning();
    if (!inserted) throw new Error("origin certificate insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "origin_certificate.issue",
      targetType: "origin_certificate",
      targetId: inserted.id,
      targetName: input.hostnames[0] ?? "",
      metadata: {
        hostnames: input.hostnames,
        source: inserted.source,
        keyType: inserted.keyType,
        serial: inserted.serial,
        notAfter: inserted.notAfter.toISOString(),
      },
    });
    return { ...originCertificateDto(inserted), privateKeyPem: issued.privateKeyPem };
  });
}

/**
 * Revokes an Origin CA certificate: the CRL is rebuilt and every cluster
 * whose sites trust the Origin CA gets a new revision (reason
 * origin_certificate_revoked), after which its nodes refuse the certificate.
 */
export async function revokeOriginCertificate(
  app: AppContext,
  input: { id: string },
  ctx: { actor: Actor },
): Promise<OriginCertificateDto> {
  return app.db.transaction(async (tx) => {
    await lockOriginAuthority(tx, ORIGIN_CA_ID);
    const [row] = await tx
      .select()
      .from(schema.originCertificate)
      .where(eq(schema.originCertificate.id, input.id))
      .for("update");
    if (!row) fail("ORIGIN_CERTIFICATE_NOT_FOUND", "origin certificate not found");
    if (row.revokedAt) fail("ORIGIN_CERTIFICATE_REVOKED", "the certificate is revoked already");
    const now = new Date();
    const [revoked] = await tx
      .update(schema.originCertificate)
      .set({ revokedAt: now })
      .where(eq(schema.originCertificate.id, row.id))
      .returning();
    if (!revoked) throw new Error("origin certificate update failed");
    const authority = await authorityRow(tx, ORIGIN_CA_ID);
    if (!authority) fail("ORIGIN_CA_NOT_FOUND", "the Origin CA has not been created");
    // Expired certificates fail verification anyway; the CRL lists the others.
    const listed = await tx
      .select({
        serial: schema.originCertificate.serial,
        revokedAt: schema.originCertificate.revokedAt,
      })
      .from(schema.originCertificate)
      .where(
        and(
          isNotNull(schema.originCertificate.revokedAt),
          gt(schema.originCertificate.notAfter, now),
        ),
      )
      .orderBy(asc(schema.originCertificate.serial));
    const crlPem = await (await openAuthority(authority, app.masterKey)).crl(
      listed.map((r) => ({ serial: r.serial, revokedAt: r.revokedAt ?? now })),
      now,
    );
    await tx
      .update(schema.pkiAuthority)
      .set({ crlPem })
      .where(eq(schema.pkiAuthority.id, ORIGIN_CA_ID));
    await recordAudit(tx, ctx.actor, {
      action: "origin_certificate.revoke",
      targetType: "origin_certificate",
      targetId: row.id,
      targetName: row.hostnames[0] ?? "",
      metadata: { serial: row.serial, hostnames: row.hostnames },
    });
    const clusters = await tx
      .selectDistinct({ clusterId: schema.site.clusterId })
      .from(schema.originPool)
      .innerJoin(schema.site, eq(schema.site.id, schema.originPool.siteId))
      .where(eq(schema.originPool.tlsTrust, "origin_ca"));
    await publishClusters(
      tx,
      clusters.map((c) => c.clusterId),
      { reason: { code: "origin_certificate_revoked", params: {} }, actor: ctx.actor },
    );
    return originCertificateDto(revoked);
  });
}

// --- configuration ---------------------------------------------------------

/**
 * What the cluster's configuration needs for origin protection: the
 * cluster's newest origin client certificate when a site presents one
 * (ORIGIN_CLIENT_CA_NOT_FOUND without it) and the Origin CA with its CRL
 * when a site trusts it (ORIGIN_CA_NOT_FOUND).
 */
export async function loadOriginProtection(
  tx: Executor,
  clusterId: string,
  needs: { clientCertificate: boolean; originCa: boolean },
): Promise<{
  clientCertificateId?: string;
  originClientCertificates: CertificateRef[];
  originCa?: { certificatePem: string; crlPem: string };
}> {
  let clientCertificateId: string | undefined;
  const originClientCertificates: CertificateRef[] = [];
  if (needs.clientCertificate) {
    const current = await currentClientCertificate(tx, clusterId);
    if (!current)
      fail("ORIGIN_CLIENT_CA_NOT_FOUND", "the cluster has no origin client certificate");
    clientCertificateId = current.id;
    originClientCertificates.push(
      create(CertificateRefSchema, {
        id: current.id,
        sha256Fingerprint: current.fingerprint,
        notAfter: timestampFromDate(current.notAfter),
      }),
    );
  }
  let originCa: { certificatePem: string; crlPem: string } | undefined;
  if (needs.originCa) {
    const row = await authorityRow(tx, ORIGIN_CA_ID);
    if (!row) fail("ORIGIN_CA_NOT_FOUND", "the Origin CA has not been created");
    originCa = { certificatePem: row.certificatePem, crlPem: row.crlPem };
  }
  return {
    ...(clientCertificateId ? { clientCertificateId } : {}),
    originClientCertificates,
    ...(originCa ? { originCa } : {}),
  };
}

/**
 * Origin protection of an earlier configuration as it may be published now
 * (rollbacks, the canary's stable revision): sites present the cluster's
 * current client certificate, and the Origin CA comes with its current CRL,
 * so a rollback never accepts a certificate revoked since. Without a current
 * client certificate or the Origin CA, `strict` refuses with
 * ROLLBACK_RESOURCE_UNAVAILABLE; otherwise those sites stop presenting a
 * certificate (their origins refuse them) or keep the configuration's CRL.
 */
export async function restoreOriginProtection(
  tx: Executor,
  clusterId: string,
  config: NodeConfig,
  opts: { strict: boolean },
) {
  const presenting = config.sites.filter((site) => site.originPool?.clientCertificateId);
  if (presenting.length) {
    const current = await currentClientCertificate(tx, clusterId);
    if (!current && opts.strict)
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback origin client certificate is unavailable");
    for (const site of presenting)
      if (site.originPool) site.originPool.clientCertificateId = current?.id ?? "";
    config.originClientCertificates = current
      ? [
          create(CertificateRefSchema, {
            id: current.id,
            sha256Fingerprint: current.fingerprint,
            notAfter: timestampFromDate(current.notAfter),
          }),
        ]
      : [];
  }
  if (usesOriginCa(config.sites)) {
    const row = await authorityRow(tx, ORIGIN_CA_ID);
    if (!row && opts.strict)
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback references the Origin CA");
    if (row)
      config.originCa = create(OriginCaSchema, {
        certificatePem: row.certificatePem,
        crlPem: row.crlPem,
      });
  }
}

/** The Origin CA's certificate (PEM), if it has been created. */
export async function originCaCertificate(db: Executor): Promise<string | undefined> {
  return (await authorityRow(db, ORIGIN_CA_ID))?.certificatePem;
}

/** Whether the authority exists (sites may present client certificates / trust the Origin CA). */
export async function originAuthorityExists(db: Executor, id: AuthorityId): Promise<boolean> {
  return !!(await authorityRow(db, id));
}
