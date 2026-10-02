import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { Envelope, MasterKey } from "../lib/envelope";
import { lockNodeCa } from "../lib/locks";
import { CertificateAuthority, generateCa, sha256Fingerprint } from "./ca";

export const NODE_CA_ID = "node-channel";
/** Envelope binding of a CA private key: the column and the authority row (AAD). */
export const CA_KEY_PURPOSE = "pki_authority.private_key_envelope";
export const caKeyBinding = (id: string) => ({ purpose: CA_KEY_PURPOSE, recordId: id });
/** The purpose version 1 envelopes were sealed with. */
export const legacyCaKeyPurpose = (id: string) => `pki_authority.private_key:${id}`;

/**
 * Loads the node-channel CA, creating it on first boot. Concurrent console
 * instances serialise on an advisory lock so exactly one CA is ever created.
 */
export async function loadOrCreateNodeCa(
  db: Database,
  masterKey: MasterKey,
): Promise<CertificateAuthority> {
  return db.transaction(async (tx) => {
    await lockNodeCa(tx);
    const [existing] = await tx
      .select()
      .from(schema.pkiAuthority)
      .where(eq(schema.pkiAuthority.id, NODE_CA_ID));
    if (existing) {
      const envelope = JSON.parse(existing.privateKeyEnvelope) as Envelope;
      return CertificateAuthority.load({
        certificatePem: existing.certificatePem,
        privateKeyPkcs8Der: masterKey.open(envelope, caKeyBinding(NODE_CA_ID)),
      });
    }
    const material = await generateCa("Edgeweir Node Channel CA");
    const ca = await CertificateAuthority.load(material);
    await tx.insert(schema.pkiAuthority).values({
      id: NODE_CA_ID,
      certificatePem: material.certificatePem,
      fingerprintSha256: sha256Fingerprint(ca.certificate),
      privateKeyEnvelope: JSON.stringify(
        masterKey.seal(material.privateKeyPkcs8Der, caKeyBinding(NODE_CA_ID)),
      ),
      notAfter: ca.certificate.notAfter,
    });
    return ca;
  });
}
