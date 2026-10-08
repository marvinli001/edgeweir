import type { AcmeAccountDto } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { ACME_CA_DIRECTORIES, customAcmeDirectory, directoryCa } from "./acme-directory";
import { type Actor, recordAudit } from "./audit";
import { certificateAccountBinding } from "./certificates";

/** The console's ACME accounts, newest first, with the certificates issued with each. */
export async function listAcmeAccounts(app: AppContext): Promise<AcmeAccountDto[]> {
  const custom = (await customAcmeDirectory(app))?.url;
  const rows = await app.db
    .select({
      id: schema.acmeAccount.id,
      directoryUrl: schema.acmeAccount.directoryUrl,
      email: schema.acmeAccount.email,
      eabKid: schema.acmeAccount.eabKid,
      createdAt: schema.acmeAccount.createdAt,
      certificates: count(schema.certificate.id),
    })
    .from(schema.acmeAccount)
    .leftJoin(schema.certificate, eq(schema.certificate.acmeAccountId, schema.acmeAccount.id))
    .groupBy(schema.acmeAccount.id)
    .orderBy(sql`${schema.acmeAccount.createdAt} desc`, asc(schema.acmeAccount.id));
  return rows.map((row) => ({
    id: row.id,
    directoryUrl: row.directoryUrl,
    ca: directoryCa(row.directoryUrl, custom),
    email: row.email,
    eabKid: row.eabKid,
    createdAt: row.createdAt.toISOString(),
    certificates: row.certificates,
  }));
}

/**
 * Deletes an account no certificate uses (ACME_ACCOUNT_IN_USE names them).
 * Only the console's copy goes: the account stays registered with the CA,
 * and a later request with the same directory, EAB key id and email
 * registers a new one.
 */
export async function deleteAcmeAccount(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(schema.acmeAccount)
      .where(eq(schema.acmeAccount.id, id))
      .for("update");
    if (!account) fail("ACME_ACCOUNT_NOT_FOUND", "ACME account not found");
    const users = await tx
      .select({ name: schema.certificate.name })
      .from(schema.certificate)
      .where(eq(schema.certificate.acmeAccountId, id))
      .orderBy(asc(schema.certificate.name))
      .limit(5);
    if (users.length)
      fail("ACME_ACCOUNT_IN_USE", "certificates use the ACME account", {
        certificates: users.map((user) => user.name).join(", "),
      });
    await tx.delete(schema.acmeAccount).where(eq(schema.acmeAccount.id, id));
    await recordAudit(tx, actor, {
      action: "acme_account.delete",
      targetType: "acme_account",
      targetId: id,
      targetName: account.email,
      metadata: { directoryUrl: account.directoryUrl, eabKid: account.eabKid },
    });
    return { ok: true as const };
  });
}

/**
 * Brings ACME certificates issued before G11 in line, at every worker start
 * (maintenance.link-acme-accounts):
 * - one whose last attempt used a directory other than its built-in CA's
 *   was issued while EDGEWEIR_ACME_DIRECTORY replaced every CA: its CA
 *   becomes "custom", so renewals keep using that directory;
 * - one without an account gets the account of its directory, EAB key id
 *   (in its sealed request) and email, when the console has one.
 * Returns how many certificates changed.
 */
export async function reconcileAcmeCertificates(app: AppContext) {
  let changed = 0;
  const builtIn = new Set<string>(Object.values(ACME_CA_DIRECTORIES));
  const legacy = await app.db
    .select({ id: schema.certificate.id, acme: schema.certificate.acme })
    .from(schema.certificate)
    .where(
      and(
        eq(schema.certificate.source, "acme"),
        sql`${schema.certificate.acme}->>'ca' in ('letsencrypt', 'zerossl')`,
        sql`coalesce(${schema.certificate.acme}->>'directoryUrl', '') <> ''`,
      ),
    );
  for (const row of legacy) {
    if (builtIn.has(row.acme.directoryUrl ?? "")) continue;
    const updated = await app.db
      .update(schema.certificate)
      .set({ acme: sql`${schema.certificate.acme} || '{"ca":"custom"}'::jsonb` })
      .where(
        and(
          eq(schema.certificate.id, row.id),
          sql`${schema.certificate.acme}->>'directoryUrl' = ${row.acme.directoryUrl ?? ""}`,
        ),
      )
      .returning({ id: schema.certificate.id });
    changed += updated.length;
  }
  const unlinked = await app.db
    .select()
    .from(schema.certificate)
    .where(
      and(
        eq(schema.certificate.source, "acme"),
        isNull(schema.certificate.acmeAccountId),
        sql`coalesce(${schema.certificate.acme}->>'directoryUrl', '') <> ''`,
        ne(schema.certificate.accountEnvelope, ""),
      ),
    );
  for (const row of unlinked) {
    let eabKid = "";
    try {
      const request = JSON.parse(
        app.masterKey
          .open(JSON.parse(row.accountEnvelope), certificateAccountBinding(row.id))
          .toString("utf8"),
      ) as { eabKid?: string; registration?: { uri?: string } };
      eabKid = request.eabKid ?? "";
    } catch (error) {
      app.log.warn("cannot read a certificate's ACME request", {
        certificateId: row.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
      continue;
    }
    const [account] = await app.db
      .select({ id: schema.acmeAccount.id })
      .from(schema.acmeAccount)
      .where(
        and(
          eq(schema.acmeAccount.directoryUrl, row.acme.directoryUrl ?? ""),
          eq(schema.acmeAccount.eabKid, eabKid),
          eq(schema.acmeAccount.email, row.acme.email ?? ""),
        ),
      );
    if (!account) continue;
    const updated = await app.db
      .update(schema.certificate)
      .set({ acmeAccountId: account.id })
      .where(and(eq(schema.certificate.id, row.id), isNull(schema.certificate.acmeAccountId)))
      .returning({ id: schema.certificate.id });
    changed += updated.length;
  }
  return changed;
}
