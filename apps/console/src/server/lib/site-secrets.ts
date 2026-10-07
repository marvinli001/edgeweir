import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import type { Executor } from "../services/revisions";
import type { MasterKey } from "./envelope";

/** Envelope binding of a site secret: the column and the row (AAD). */
export const SITE_SECRET_PURPOSE = "site_secret.secret_envelope";
export const siteSecretBinding = (secretId: string) => ({
  purpose: SITE_SECRET_PURPOSE,
  recordId: secretId,
});

/** Kinds of site secrets. */
export const PURGE_KEY = "purge_key";

/** The site's secret of kind, without its value. */
export async function siteSecret(db: Executor, siteId: string, kind: string) {
  const [row] = await db
    .select({ id: schema.siteSecret.id, version: schema.siteSecret.version })
    .from(schema.siteSecret)
    .where(and(eq(schema.siteSecret.siteId, siteId), eq(schema.siteSecret.kind, kind)));
  return row ?? null;
}

/**
 * Stores a site secret sealed with the master key (bound to its row); a
 * replaced secret gets the next version, so that nodes fetch it again.
 */
export async function storeSiteSecret(
  db: Executor,
  masterKey: MasterKey,
  siteId: string,
  kind: string,
  value: string,
): Promise<void> {
  const current = await siteSecret(db, siteId, kind);
  // The id is part of the envelope's AAD, so a new row gets its id first.
  const id = current?.id ?? randomUUID();
  const secretEnvelope = JSON.stringify(masterKey.seal(value, siteSecretBinding(id)));
  if (current) {
    await db
      .update(schema.siteSecret)
      .set({ secretEnvelope, version: current.version + 1, updatedAt: new Date() })
      .where(eq(schema.siteSecret.id, current.id));
  } else {
    await db.insert(schema.siteSecret).values({ id, siteId, kind, secretEnvelope });
  }
}
