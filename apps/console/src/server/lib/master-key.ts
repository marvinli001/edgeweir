import { type Database, schema } from "@edgeweir/db";
import type { Envelope, MasterKey } from "./envelope";

export const MASTER_KEY_MISMATCH = "EDGEWEIR_MASTER_KEY does not match this database";

/**
 * Every envelope names the master key that sealed it (`kid`), and the node
 * channel CA is sealed on the first start. Refuses to start when they differ,
 * before the session secret check: a wrong master key derives a wrong session
 * secret, which that check reports as a missing BETTER_AUTH_SECRET, and
 * setting one there would store a new check value and lock out the right key.
 */
export async function assertMasterKey(db: Database, masterKey: MasterKey): Promise<void> {
  const rows = await db
    .select({ envelope: schema.pkiAuthority.privateKeyEnvelope })
    .from(schema.pkiAuthority);
  for (const { envelope } of rows) {
    let kid: unknown;
    try {
      kid = (JSON.parse(envelope) as Partial<Envelope>).kid;
    } catch {
      continue;
    }
    if (typeof kid === "string" && kid !== masterKey.kid) {
      throw new Error(
        `${MASTER_KEY_MISMATCH}: its secrets were sealed with the master key with id ${kid}, the configured one has id ${masterKey.kid}. Set EDGEWEIR_MASTER_KEY to the key this database was set up with (the original .env or its offline copy); BETTER_AUTH_SECRET does not help`,
      );
    }
  }
}
