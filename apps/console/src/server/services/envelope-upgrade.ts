import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { type Envelope, MasterKey } from "../lib/envelope";
import { lockEnvelopeUpgrade } from "../lib/locks";
import type { Logger } from "../lib/logger";
import { caKeyBinding, legacyCaKeyPurpose } from "../pki/store";
import {
  LEGACY_SETUP_TOKEN_PURPOSE,
  SETUP_TOKEN_BINDING,
  SETUP_TOKEN_KEY,
  type SetupTokenState,
} from "./setup";
import { LEGACY_S3_SECRET_PURPOSE, s3SecretBinding } from "./sites";

export interface EnvelopeUpgradeResult {
  upgraded: number;
  /** Legacy envelopes that could not be opened (e.g. sealed with another master key). */
  failed: number;
}

const parse = (text: string): Envelope | null => {
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return null;
  }
};

/**
 * One-time upgrade of version 1 envelopes (purpose-only AAD) to version 2,
 * which also binds the record id. Runs at startup, before anything reads a
 * secret; idempotent, and serialised across console instances by an advisory
 * lock. The normal read path refuses version 1, so an old ciphertext copied
 * into another row cannot be replayed after the upgrade.
 */
export async function upgradeLegacyEnvelopes(
  db: Database,
  masterKey: MasterKey,
  log: Logger,
): Promise<EnvelopeUpgradeResult> {
  const result: EnvelopeUpgradeResult = { upgraded: 0, failed: 0 };
  await db.transaction(async (tx) => {
    await lockEnvelopeUpgrade(tx);
    const reseal = (
      envelope: Envelope,
      legacyPurpose: string,
      binding: { purpose: string; recordId: string },
    ): Envelope | null => {
      try {
        return masterKey.seal(masterKey.openLegacy(envelope, legacyPurpose), binding);
      } catch (error) {
        result.failed++;
        log.error("cannot upgrade a legacy envelope", {
          purpose: binding.purpose,
          recordId: binding.recordId,
          error: (error as Error).message,
        });
        return null;
      }
    };

    for (const row of await tx.select().from(schema.originCredential)) {
      const envelope = parse(row.secretEnvelope);
      if (!envelope || !MasterKey.isLegacy(envelope)) continue;
      const next = reseal(envelope, LEGACY_S3_SECRET_PURPOSE, s3SecretBinding(row.id));
      if (!next) continue;
      await tx
        .update(schema.originCredential)
        .set({ secretEnvelope: JSON.stringify(next) })
        .where(eq(schema.originCredential.id, row.id));
      result.upgraded++;
    }

    for (const row of await tx.select().from(schema.pkiAuthority)) {
      const envelope = parse(row.privateKeyEnvelope);
      if (!envelope || !MasterKey.isLegacy(envelope)) continue;
      const next = reseal(envelope, legacyCaKeyPurpose(row.id), caKeyBinding(row.id));
      if (!next) continue;
      await tx
        .update(schema.pkiAuthority)
        .set({ privateKeyEnvelope: JSON.stringify(next) })
        .where(eq(schema.pkiAuthority.id, row.id));
      result.upgraded++;
    }

    const [setting] = await tx
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
    const state = (setting?.value ?? {}) as SetupTokenState;
    if (state.envelope && MasterKey.isLegacy(state.envelope)) {
      // An unreadable token is left alone: ensureSetupToken replaces it.
      const next = reseal(state.envelope, LEGACY_SETUP_TOKEN_PURPOSE, SETUP_TOKEN_BINDING);
      if (next) {
        const value = { ...state, envelope: next } as Record<string, unknown>;
        await tx
          .update(schema.systemSetting)
          .set({ value })
          .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
        result.upgraded++;
      }
    }
  });
  if (result.upgraded || result.failed) log.info("legacy envelopes upgraded", { ...result });
  return result;
}
