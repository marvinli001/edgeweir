import { randomUUID, X509Certificate } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  decodeNodeConfig,
  ORIGIN_CA_ROTATION_FEATURE,
  usesOriginCa,
} from "@edgeweir/config-compiler";
import {
  type AuditAction,
  ORIGIN_CA_YEARS,
  ORIGIN_CLIENT_CA_YEARS,
  ORIGIN_CLIENT_CERTIFICATE_DAYS,
  ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS,
  type OriginCa,
  type OriginCertificateDto,
  type OriginCertificateIssue,
  type OriginCertificateIssued,
  type OriginClientCa,
  type RevisionReasonCode,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  type CertificateRef,
  CertificateRefSchema,
  type NodeConfig,
  OriginCaSchema,
} from "@edgeweir/proto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope, MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { lockOriginAuthority } from "../lib/locks";
import { assertNodeFeatures } from "../lib/node-features";
import { CsrError, generateCa, OriginAuthority, sha256Fingerprint } from "../pki/ca";
import { caKeyBinding } from "../pki/store";
import { type Actor, recordAudit, systemActor } from "./audit";
import { type Executor, getRevision, latestRevision, publishClusters, type Tx } from "./revisions";
import { publishedRevisions } from "./rollout";

/** Kinds of the two origin authorities (pki_authority.kind). */
const ORIGIN_CLIENT_CA_KIND = "origin-client";
export const ORIGIN_CA_KIND = "origin-ca";
const AUTHORITY_NAMES = {
  [ORIGIN_CLIENT_CA_KIND]: {
    commonName: "Edgeweir Origin Client CA",
    years: ORIGIN_CLIENT_CA_YEARS,
  },
  [ORIGIN_CA_KIND]: { commonName: "Edgeweir Origin CA", years: ORIGIN_CA_YEARS },
} as const;
type AuthorityKind = keyof typeof AUTHORITY_NAMES;
/** active signs; next is trusted before it signs (origin client CA); previous is trusted until retired. */
type AuthorityStatus = "active" | "next" | "previous";

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
type Authorities = Partial<Record<AuthorityStatus, AuthorityRow>>;
type AuditEntry = Parameters<typeof recordAudit>[2];

/**
 * The authorities of a kind by status. `lock` takes their rows FOR SHARE:
 * a certificate is issued by the authority that is still active when the
 * transaction commits (activating or retiring updates the rows).
 */
async function authorities(
  db: Executor,
  kind: AuthorityKind,
  opts: { lock?: boolean } = {},
): Promise<Authorities> {
  const query = db.select().from(schema.pkiAuthority).where(eq(schema.pkiAuthority.kind, kind));
  const rows = opts.lock ? await query.for("share") : await query;
  return Object.fromEntries(rows.map((row) => [row.status, row]));
}

async function activeAuthority(
  db: Executor,
  kind: AuthorityKind,
  opts: { lock?: boolean } = {},
): Promise<AuthorityRow | undefined> {
  return (await authorities(db, kind, opts)).active;
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

/** Which authority of the kind issued a certificate (issuingAuthority of the contract). */
const issuer = (found: Authorities, authorityId: string) =>
  found.active?.id === authorityId
    ? ("active" as const)
    : found.previous?.id === authorityId
      ? ("previous" as const)
      : ("retired" as const);

/** The common name of the kind's authority of a generation. */
const authorityName = (kind: AuthorityKind, generation: number) =>
  generation === 1
    ? AUTHORITY_NAMES[kind].commonName
    : `${AUTHORITY_NAMES[kind].commonName} G${generation}`;

/** Audit entry of an authority's rotation step. */
const authorityAudit = (
  row: AuthorityRow,
  action: AuditAction,
  metadata: Record<string, unknown> = {},
) => ({
  action,
  targetType: "certificate_authority" as const,
  targetId: row.id,
  targetName: authorityName(row.kind as AuthorityKind, row.generation),
  metadata: {
    fingerprint: row.fingerprintSha256,
    generation: row.generation,
    notAfter: row.notAfter.toISOString(),
    ...metadata,
  },
});

/**
 * Generates an authority of the kind: the first generation's id and name
 * are the kind's, later ones add " G<n>" to the name (two trusted CAs never
 * share a subject, which is how OpenSSL finds issuers and CRLs) and
 * "-g<n>" to the id. The private key is sealed to the row.
 */
async function insertAuthority(
  tx: Tx,
  masterKey: MasterKey,
  kind: AuthorityKind,
  generation: number,
  status: AuthorityStatus,
): Promise<AuthorityRow> {
  const id = generation === 1 ? kind : `${kind}-g${generation}`;
  const material = await generateCa(authorityName(kind, generation), AUTHORITY_NAMES[kind].years);
  const authority = await OriginAuthority.load(material);
  const crlPem = kind === ORIGIN_CA_KIND ? await authority.crl([]) : "";
  const [row] = await tx
    .insert(schema.pkiAuthority)
    .values({
      id,
      kind,
      status,
      generation,
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
  return row;
}

/** Creates an origin authority unless one of its kind exists; the second value tells whether it was created. */
async function ensureAuthority(
  tx: Tx,
  masterKey: MasterKey,
  kind: AuthorityKind,
): Promise<[AuthorityRow, boolean]> {
  await lockOriginAuthority(tx, kind);
  const existing = await activeAuthority(tx, kind);
  if (existing) return [existing, false];
  return [await insertAuthority(tx, masterKey, kind, 1, "active"), true];
}

const setStatus = (tx: Tx, row: AuthorityRow, status: AuthorityStatus) =>
  tx.update(schema.pkiAuthority).set({ status }).where(eq(schema.pkiAuthority.id, row.id));
const deleteAuthority = (tx: Tx, row: AuthorityRow) =>
  tx.delete(schema.pkiAuthority).where(eq(schema.pkiAuthority.id, row.id));

// --- origin client CA ------------------------------------------------------

export async function getOriginClientCa(app: AppContext): Promise<OriginClientCa> {
  const found = await authorities(app.db, ORIGIN_CLIENT_CA_KIND);
  return {
    authority: authorityDto(found.active),
    next: authorityDto(found.next),
    previous: authorityDto(found.previous),
    trustBundlePem: [found.active, found.next, found.previous]
      .flatMap((row) => (row ? [row.certificatePem] : []))
      .join(""),
    certificates: found.active ? await currentClientCertificates(app.db, found) : [],
    pendingClusters: found.previous ? await pendingClusters(app.db, found.active?.id ?? "") : [],
  };
}

export async function createOriginClientCa(
  app: AppContext,
  ctx: { actor: Actor },
): Promise<OriginClientCa> {
  await app.db.transaction(async (tx) => {
    const [row, created] = await ensureAuthority(tx, app.masterKey, ORIGIN_CLIENT_CA_KIND);
    if (!created) return;
    await recordAudit(tx, ctx.actor, {
      action: "origin_client_ca.create",
      targetType: "certificate_authority",
      targetId: row.id,
      targetName: AUTHORITY_NAMES[ORIGIN_CLIENT_CA_KIND].commonName,
      metadata: { fingerprint: row.fingerprintSha256, notAfter: row.notAfter.toISOString() },
    });
  });
  return getOriginClientCa(app);
}

/**
 * A rotation step of the origin client CA in one transaction, serialized
 * with the other steps: `step` gets the authorities and returns the audit
 * entry (the target is the authority it names).
 */
async function clientCaStep(
  app: AppContext,
  ctx: { actor: Actor },
  step: (
    tx: Tx,
    found: Authorities & { active: AuthorityRow },
  ) => Promise<{ action: AuditAction; target: AuthorityRow; metadata?: Record<string, unknown> }>,
) {
  await app.db.transaction(async (tx) => {
    await lockOriginAuthority(tx, ORIGIN_CLIENT_CA_KIND);
    const found = await authorities(tx, ORIGIN_CLIENT_CA_KIND);
    const { active } = found;
    if (!active) fail("ORIGIN_CLIENT_CA_NOT_FOUND", "the origin client CA has not been created");
    const { action, target, metadata } = await step(tx, { ...found, active });
    await recordAudit(tx, ctx.actor, authorityAudit(target, action, metadata));
  });
}

/** Rotation, step 1: a next authority that origins verifying clients should trust before it signs. */
export async function rotateOriginClientCa(app: AppContext, ctx: { actor: Actor }) {
  await clientCaStep(app, ctx, async (tx, found) => {
    if (found.next || found.previous)
      fail("CA_ROTATION_IN_PROGRESS", "the origin client CA is being rotated");
    const next = await insertAuthority(
      tx,
      app.masterKey,
      ORIGIN_CLIENT_CA_KIND,
      found.active.generation + 1,
      "next",
    );
    return {
      action: "origin_client_ca.rotation_start",
      target: next,
      metadata: { replaces: found.active.fingerprintSha256 },
    };
  });
  return getOriginClientCa(app);
}

/**
 * Rotation, step 2: the next authority becomes the active one and the
 * active one the previous; then every cluster whose sites present a client
 * certificate gets one the new authority signed and a revision presenting
 * it. Those that fail keep the previous authority's certificate (still
 * valid) and are retried by the hourly rotation.
 */
export async function activateOriginClientCa(app: AppContext, ctx: { actor: Actor }) {
  await clientCaStep(app, ctx, async (tx, found) => {
    if (!found.next)
      fail("CA_ROTATION_STEP_UNAVAILABLE", "the origin client CA has no next authority");
    // The unique (kind, status) index: the active one moves out of the way first.
    await setStatus(tx, found.active, "previous");
    await setStatus(tx, found.next, "active");
    return {
      action: "origin_client_ca.activate",
      target: found.next,
      metadata: { replaces: found.active.fingerprintSha256 },
    };
  });
  await rotateOriginClientCertificates(app, new Date(), ctx.actor);
  return getOriginClientCa(app);
}

/** Rotation, step 3: deletes the previous authority once no cluster presents its certificates. */
export async function retireOriginClientCa(app: AppContext, ctx: { actor: Actor }) {
  await clientCaStep(app, ctx, async (tx, found) => {
    const { previous } = found;
    if (!previous)
      fail("CA_ROTATION_STEP_UNAVAILABLE", "the origin client CA has no previous authority");
    // Deleted first: a certificate being issued by it (FOR SHARE) commits
    // before this goes on, and then counts as pending below.
    await deleteAuthority(tx, previous);
    const pending = await pendingClusters(tx, found.active.id);
    if (pending.length) {
      const names = pending.map((c) => c.clusterName);
      const shown = names.slice(0, 5).join(", ");
      fail("CA_ROTATION_INCOMPLETE", "clusters still present the previous CA's certificates", {
        clusters: names.length > 5 ? `${shown} +${names.length - 5}` : shown,
      });
    }
    return { action: "origin_client_ca.retire", target: previous };
  });
  return getOriginClientCa(app);
}

/** Cancels a rotation before activation: deletes the next authority. */
export async function cancelOriginClientCaRotation(app: AppContext, ctx: { actor: Actor }) {
  await clientCaStep(app, ctx, async (tx, found) => {
    if (!found.next)
      fail("CA_ROTATION_STEP_UNAVAILABLE", "the origin client CA has no next authority");
    await deleteAuthority(tx, found.next);
    return { action: "origin_client_ca.rotation_cancel", target: found.next };
  });
  return getOriginClientCa(app);
}

/** Clusters whose sites present a client certificate, by cluster id. */
const presentingClusters = (db: Executor) =>
  db
    .selectDistinct({ clusterId: schema.site.clusterId })
    .from(schema.originPool)
    .innerJoin(schema.site, eq(schema.site.id, schema.originPool.siteId))
    .where(eq(schema.originPool.clientCertificate, true))
    .orderBy(schema.site.clusterId);

/** Presenting clusters whose current certificate the active authority did not sign, by name. */
async function pendingClusters(db: Executor, activeId: string) {
  const out: { clusterId: string; clusterName: string }[] = [];
  for (const { clusterId } of await presentingClusters(db)) {
    const current = await currentClientCertificate(db, clusterId);
    if (current?.authorityId === activeId) continue;
    const [row] = await db
      .select({ name: schema.cluster.name })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    out.push({ clusterId, clusterName: row?.name ?? clusterId });
  }
  return out.sort((x, y) => x.clusterName.localeCompare(y.clusterName));
}

/** The newest certificate of every cluster that has one, by cluster name. */
async function currentClientCertificates(db: Executor, found: Authorities) {
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
      authority: issuer(found, cert.authorityId),
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
 * signed by the active authority and valid for more than
 * ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS. Earlier ones stay valid until they
 * expire: nodes still on an earlier revision keep presenting them.
 * Requires the origin client CA (ORIGIN_CLIENT_CA_NOT_FOUND).
 */
export async function ensureOriginClientCertificate(
  tx: Tx,
  masterKey: MasterKey,
  clusterId: string,
  now = new Date(),
): Promise<{ id: string; issued: boolean }> {
  await lockOriginAuthority(tx, `${ORIGIN_CLIENT_CA_KIND}/${clusterId}`);
  const row = await activeAuthority(tx, ORIGIN_CLIENT_CA_KIND, { lock: true });
  if (!row) fail("ORIGIN_CLIENT_CA_NOT_FOUND", "the origin client CA has not been created");
  const current = await currentClientCertificate(tx, clusterId);
  if (
    current &&
    current.authorityId === row.id &&
    current.notAfter.getTime() - now.getTime() > ORIGIN_CLIENT_CERTIFICATE_RENEW_DAYS * DAY
  )
    return { id: current.id, issued: false };
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
    authorityId: row.id,
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
 * Replaces the origin client certificates that are due (expiring, or not
 * signed by the active authority after a rotation) in every cluster whose
 * sites present one, publishing the clusters whose latest revision carries
 * origin client certificates (reason origin_client_certificate_rotated),
 * and deletes certificates that expired a week ago. Returns the clusters
 * that got a new certificate.
 */
export async function rotateOriginClientCertificates(
  app: AppContext,
  now = new Date(),
  actor: Actor = systemActor,
): Promise<string[]> {
  if (!(await activeAuthority(app.db, ORIGIN_CLIENT_CA_KIND))) return [];
  const rotated: string[] = [];
  for (const { clusterId } of await presentingClusters(app.db)) {
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
                  actor,
                })
              ).get(clusterId)
            : undefined;
        await recordAudit(tx, actor, {
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
  const found = await authorities(app.db, ORIGIN_CA_KIND);
  return {
    authority: authorityDto(found.active),
    previous: authorityDto(found.previous),
    previousCertificates: found.previous
      ? await validCertificateCount(app.db, found.previous.id)
      : 0,
  };
}

/** Certificates of the authority that are neither revoked nor expired. */
async function validCertificateCount(db: Executor, authorityId: string, now = new Date()) {
  const [row] = await db
    .select({ n: count() })
    .from(schema.originCertificate)
    .where(
      and(
        eq(schema.originCertificate.authorityId, authorityId),
        isNull(schema.originCertificate.revokedAt),
        gt(schema.originCertificate.notAfter, now),
      ),
    );
  return row?.n ?? 0;
}

export async function createOriginCa(app: AppContext, ctx: { actor: Actor }): Promise<OriginCa> {
  await app.db.transaction(async (tx) => {
    const [row, created] = await ensureAuthority(tx, app.masterKey, ORIGIN_CA_KIND);
    if (!created) return;
    await recordAudit(tx, ctx.actor, {
      action: "origin_ca.create",
      targetType: "certificate_authority",
      targetId: row.id,
      targetName: AUTHORITY_NAMES[ORIGIN_CA_KIND].commonName,
      metadata: { fingerprint: row.fingerprintSha256, notAfter: row.notAfter.toISOString() },
    });
  });
  return getOriginCa(app);
}

/** Clusters with a site trusting the Origin CA. */
async function trustingClusters(db: Executor) {
  const rows = await db
    .selectDistinct({ clusterId: schema.site.clusterId })
    .from(schema.originPool)
    .innerJoin(schema.site, eq(schema.site.id, schema.originPool.siteId))
    .where(eq(schema.originPool.tlsTrust, "origin_ca"));
  return rows.map((r) => r.clusterId);
}

/**
 * A rotation step of the Origin CA in one transaction, serialized with the
 * other steps and revocations: `step` changes the authorities and returns
 * the audit entry, then every cluster trusting the Origin CA gets a
 * revision with the new trust (reason `reason`).
 */
async function originCaStep(
  app: AppContext,
  ctx: { actor: Actor },
  reason: RevisionReasonCode,
  step: (tx: Tx, found: Authorities & { active: AuthorityRow }) => Promise<AuditEntry>,
) {
  await app.db.transaction(async (tx) => {
    await lockOriginAuthority(tx, ORIGIN_CA_KIND);
    const found = await authorities(tx, ORIGIN_CA_KIND);
    const { active } = found;
    if (!active) fail("ORIGIN_CA_NOT_FOUND", "the Origin CA has not been created");
    await recordAudit(tx, ctx.actor, await step(tx, { ...found, active }));
    await publishClusters(tx, await trustingClusters(tx), {
      reason: { code: reason, params: {} },
      actor: ctx.actor,
    });
  });
  return getOriginCa(app);
}

/**
 * Rotation, step 1: a new authority issues the origin certificates from
 * now on; the active one becomes the previous, which nodes keep trusting
 * (with its CRL) until it is retired. Every active node of a cluster
 * trusting the Origin CA must support origin-ca-rotation-v1
 * (NODE_CAPABILITY_REQUIRED).
 */
export const rotateOriginCa = (app: AppContext, ctx: { actor: Actor }) =>
  originCaStep(app, ctx, "origin_ca_rotation_started", async (tx, found) => {
    if (found.previous) fail("CA_ROTATION_IN_PROGRESS", "the Origin CA is being rotated");
    // Older nodes would refuse every revision until they are upgraded.
    await assertNodeFeatures(
      tx,
      await trustingClusters(tx),
      [ORIGIN_CA_ROTATION_FEATURE],
      "cluster nodes cannot trust two Origin CAs",
    );
    await setStatus(tx, found.active, "previous");
    const next = await insertAuthority(
      tx,
      app.masterKey,
      ORIGIN_CA_KIND,
      found.active.generation + 1,
      "active",
    );
    return authorityAudit(next, "origin_ca.rotation_start", {
      replaces: found.active.fingerprintSha256,
    });
  });

/** Rotation, step 2: deletes the previous authority; nodes stop trusting its certificates. */
export const retireOriginCa = (app: AppContext, ctx: { actor: Actor }) =>
  originCaStep(app, ctx, "origin_ca_retired", async (tx, found) => {
    const { previous } = found;
    if (!previous) fail("CA_ROTATION_STEP_UNAVAILABLE", "the Origin CA has no previous authority");
    const valid = await validCertificateCount(tx, previous.id);
    await deleteAuthority(tx, previous);
    return authorityAudit(previous, "origin_ca.retire", { validCertificates: valid });
  });

/**
 * Cancels a rotation while the new authority has issued no certificate
 * that is still valid (CA_ROTATION_IN_USE): it is deleted with the
 * certificates it issued and the previous one is active again.
 */
export const cancelOriginCaRotation = (app: AppContext, ctx: { actor: Actor }) =>
  originCaStep(app, ctx, "origin_ca_rotation_cancelled", async (tx, found) => {
    const { previous } = found;
    if (!previous) fail("CA_ROTATION_STEP_UNAVAILABLE", "the Origin CA has no previous authority");
    const valid = await validCertificateCount(tx, found.active.id);
    if (valid)
      fail("CA_ROTATION_IN_USE", "the new Origin CA issued certificates", { count: valid });
    // Its certificates are all revoked or expired, and the next rotation
    // reuses its generation and id: they go with it.
    await tx
      .delete(schema.originCertificate)
      .where(eq(schema.originCertificate.authorityId, found.active.id));
    await deleteAuthority(tx, found.active);
    await setStatus(tx, previous, "active");
    return authorityAudit(found.active, "origin_ca.rotation_cancel");
  });

const originCertificateDto = (
  row: OriginCertificateRow,
  found: Authorities,
): OriginCertificateDto => ({
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
  authority: issuer(found, row.authorityId),
});

export async function listOriginCertificates(app: AppContext): Promise<OriginCertificateDto[]> {
  const found = await authorities(app.db, ORIGIN_CA_KIND);
  const rows = await app.db
    .select()
    .from(schema.originCertificate)
    .orderBy(desc(schema.originCertificate.createdAt));
  return rows.map((row) => originCertificateDto(row, found));
}

export async function issueOriginCertificate(
  app: AppContext,
  input: OriginCertificateIssue,
  ctx: { actor: Actor },
): Promise<OriginCertificateIssued> {
  return app.db.transaction(async (tx) => {
    // FOR SHARE: a rotation that starts meanwhile waits, so the certificate
    // never comes from an authority that stopped issuing.
    const found = await authorities(tx, ORIGIN_CA_KIND, { lock: true });
    const row = found.active;
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
    const [inserted] = await tx
      .insert(schema.originCertificate)
      .values({
        authorityId: row.id,
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
        authority: row.id,
      },
    });
    return { ...originCertificateDto(inserted, found), privateKeyPem: issued.privateKeyPem };
  });
}

/**
 * Revokes an Origin CA certificate: the CRL of the authority that issued it
 * is rebuilt and every cluster whose sites trust the Origin CA gets a new
 * revision (reason origin_certificate_revoked), after which its nodes
 * refuse the certificate. A certificate of a retired authority, which no
 * node trusts any more, is only marked.
 */
export async function revokeOriginCertificate(
  app: AppContext,
  input: { id: string },
  ctx: { actor: Actor },
): Promise<OriginCertificateDto> {
  return app.db.transaction(async (tx) => {
    await lockOriginAuthority(tx, ORIGIN_CA_KIND);
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
    const found = await authorities(tx, ORIGIN_CA_KIND);
    await recordAudit(tx, ctx.actor, {
      action: "origin_certificate.revoke",
      targetType: "origin_certificate",
      targetId: row.id,
      targetName: row.hostnames[0] ?? "",
      metadata: { serial: row.serial, hostnames: row.hostnames, authority: row.authorityId },
    });
    const authority = [found.active, found.previous].find((a) => a?.id === row.authorityId);
    if (authority) {
      await rebuildCrl(tx, app.masterKey, authority, now);
      await publishClusters(tx, await trustingClusters(tx), {
        reason: { code: "origin_certificate_revoked", params: {} },
        actor: ctx.actor,
      });
    }
    return originCertificateDto(revoked, found);
  });
}

/** Replaces the authority's CRL with one listing its revoked certificates that have not expired. */
async function rebuildCrl(tx: Tx, masterKey: MasterKey, authority: AuthorityRow, now: Date) {
  // Expired certificates fail verification anyway; the CRL lists the others.
  const listed = await tx
    .select({
      serial: schema.originCertificate.serial,
      revokedAt: schema.originCertificate.revokedAt,
    })
    .from(schema.originCertificate)
    .where(
      and(
        eq(schema.originCertificate.authorityId, authority.id),
        isNotNull(schema.originCertificate.revokedAt),
        gt(schema.originCertificate.notAfter, now),
      ),
    )
    .orderBy(asc(schema.originCertificate.serial));
  const crlPem = await (await openAuthority(authority, masterKey)).crl(
    listed.map((r) => ({ serial: r.serial, revokedAt: r.revokedAt ?? now })),
    now,
  );
  await tx
    .update(schema.pkiAuthority)
    .set({ crlPem })
    .where(eq(schema.pkiAuthority.id, authority.id));
}

// --- configuration ---------------------------------------------------------

/**
 * What the cluster's configuration needs for origin protection: the
 * cluster's newest origin client certificate when a site presents one
 * (ORIGIN_CLIENT_CA_NOT_FOUND without it) and the Origin CA with its CRL
 * when a site trusts it (ORIGIN_CA_NOT_FOUND), during a rotation with the
 * previous Origin CA and its CRL.
 */
export async function loadOriginProtection(
  tx: Executor,
  clusterId: string,
  needs: { clientCertificate: boolean; originCa: boolean },
): Promise<{
  clientCertificateId?: string;
  originClientCertificates: CertificateRef[];
  originCa?: { certificatePem: string; crlPem: string };
  originCaPrevious?: { certificatePem: string; crlPem: string };
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
  let originCaPrevious: { certificatePem: string; crlPem: string } | undefined;
  if (needs.originCa) {
    const { active, previous } = await authorities(tx, ORIGIN_CA_KIND);
    if (!active) fail("ORIGIN_CA_NOT_FOUND", "the Origin CA has not been created");
    originCa = { certificatePem: active.certificatePem, crlPem: active.crlPem };
    if (previous)
      originCaPrevious = { certificatePem: previous.certificatePem, crlPem: previous.crlPem };
  }
  return {
    ...(clientCertificateId ? { clientCertificateId } : {}),
    originClientCertificates,
    ...(originCa ? { originCa } : {}),
    ...(originCaPrevious ? { originCaPrevious } : {}),
  };
}

/**
 * Origin protection of an earlier configuration as it may be published now
 * (rollbacks, the canary's stable revision): sites present the cluster's
 * current client certificate, and the Origin CAs are the current ones with
 * their current CRLs, so a rollback never accepts a certificate revoked
 * since nor trusts an Origin CA retired since. Without a current
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
    const { active, previous } = await authorities(tx, ORIGIN_CA_KIND);
    if (!active && opts.strict)
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback references the Origin CA");
    if (active) {
      config.originCa = create(OriginCaSchema, {
        certificatePem: active.certificatePem,
        crlPem: active.crlPem,
      });
      config.originCaPrevious = previous
        ? create(OriginCaSchema, {
            certificatePem: previous.certificatePem,
            crlPem: previous.crlPem,
          })
        : undefined;
    }
  }
}

/** The certificates (PEM) of the Origin CAs there are: the active one and a rotation's previous one. */
export async function originCaCertificates(db: Executor): Promise<string[]> {
  const { active, previous } = await authorities(db, ORIGIN_CA_KIND);
  return [active, previous].flatMap((row) => (row ? [row.certificatePem] : []));
}

/** Whether the Origin CA is being rotated (nodes then trust the previous one too). */
export async function originCaRotating(db: Executor): Promise<boolean> {
  return !!(await authorities(db, ORIGIN_CA_KIND)).previous;
}

/** Whether the authority exists (sites may present client certificates / trust the Origin CA). */
export async function originAuthorityExists(db: Executor, kind: AuthorityKind): Promise<boolean> {
  return !!(await activeAuthority(db, kind));
}
