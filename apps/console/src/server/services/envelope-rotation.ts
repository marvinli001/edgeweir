import { type Database, schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { AUTH_SECRET_BINDING, AUTH_SECRET_KEY } from "../lib/auth-secret";
import type { Envelope, EnvelopeBinding, MasterKey } from "../lib/envelope";
import { lockEnvelopeUpgrade } from "../lib/locks";
import type { Logger } from "../lib/logger";
import { caKeyBinding } from "../pki/store";
import {
  acmeAccountBinding,
  certificateAccountBinding,
  certificateKeyBinding,
  dnsCredentialBinding,
} from "./certificates";
import { challengeKeyBinding } from "./challenge-keys";
import { providerBinding } from "./dns-providers";
import { channelBinding, SMTP_KEY, smtpBinding } from "./notification-delivery";
import type { Executor } from "./revisions";
import { SETUP_TOKEN_BINDING, SETUP_TOKEN_KEY } from "./setup";
import { s3SecretBinding } from "./sites";

/** A column holding one envelope (JSON text) per row, bound to the row's id. */
export interface EnvelopeColumn {
  table: PgTable;
  id: PgColumn;
  column: PgColumn;
  binding: (id: string) => EnvelopeBinding;
}

/** A system setting whose value keeps an envelope under `envelope`, as an object or as JSON text. */
export interface EnvelopeSetting {
  key: string;
  binding: EnvelopeBinding;
  form: "object" | "json";
}

/** Every column that stores envelopes. A new one has to be added here (a test checks). */
export const ENVELOPE_COLUMNS: EnvelopeColumn[] = [
  {
    table: schema.originCredential,
    id: schema.originCredential.id,
    column: schema.originCredential.secretEnvelope,
    binding: s3SecretBinding,
  },
  {
    table: schema.pkiAuthority,
    id: schema.pkiAuthority.id,
    column: schema.pkiAuthority.privateKeyEnvelope,
    binding: caKeyBinding,
  },
  {
    table: schema.alertChannel,
    id: schema.alertChannel.id,
    column: schema.alertChannel.configEnvelope,
    binding: channelBinding,
  },
  {
    table: schema.platformDnsProvider,
    id: schema.platformDnsProvider.id,
    column: schema.platformDnsProvider.credentialEnvelope,
    binding: providerBinding,
  },
  {
    table: schema.dnsCredential,
    id: schema.dnsCredential.id,
    column: schema.dnsCredential.credentialEnvelope,
    binding: dnsCredentialBinding,
  },
  {
    table: schema.certificate,
    id: schema.certificate.id,
    column: schema.certificate.privateKeyEnvelope,
    binding: certificateKeyBinding,
  },
  {
    table: schema.certificate,
    id: schema.certificate.id,
    column: schema.certificate.accountEnvelope,
    binding: certificateAccountBinding,
  },
  {
    table: schema.acmeAccount,
    id: schema.acmeAccount.id,
    column: schema.acmeAccount.accountEnvelope,
    binding: acmeAccountBinding,
  },
  {
    table: schema.challengeKey,
    id: schema.challengeKey.id,
    column: schema.challengeKey.secret,
    binding: challengeKeyBinding,
  },
];

/** Every system setting that stores an envelope. */
export const ENVELOPE_SETTINGS: EnvelopeSetting[] = [
  { key: SETUP_TOKEN_KEY, binding: SETUP_TOKEN_BINDING, form: "object" },
  { key: SMTP_KEY, binding: smtpBinding, form: "json" },
  { key: AUTH_SECRET_KEY, binding: AUTH_SECRET_BINDING, form: "object" },
];

/**
 * Envelopes the database does not keep: revision receipts live on the nodes.
 * They are minted again with every configuration a node fetches; until then
 * the previous key still verifies them.
 */
export const UNSTORED_ENVELOPE_PURPOSES = ["node.revision_receipt"];

/** One stored envelope, and how to replace it if the stored value is still the one read. */
export interface StoredEnvelope {
  binding: EnvelopeBinding;
  envelope: Envelope;
  replace(next: Envelope): Promise<boolean>;
}

const parse = (value: unknown): Envelope | null => {
  if (typeof value === "object" && value !== null) return value as Envelope;
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value) as Envelope;
  } catch {
    return null;
  }
};

/** Every envelope the database stores (empty columns skipped). */
export async function storedEnvelopes(tx: Executor): Promise<StoredEnvelope[]> {
  const found: StoredEnvelope[] = [];
  for (const { table, id, column, binding } of ENVELOPE_COLUMNS) {
    const result = await tx.execute<{ id: string; text: string | null }>(
      sql`select ${id}::text as id, ${column} as text from ${table}`,
    );
    for (const row of result.rows) {
      const envelope = parse(row.text);
      if (!envelope) continue;
      found.push({
        binding: binding(row.id),
        envelope,
        // Compare and set: a value written since it was read stays.
        replace: async (next) =>
          (
            await tx.execute(
              sql`update ${table} set ${sql.identifier(column.name)} = ${JSON.stringify(next)}
                where ${id} = ${row.id} and ${column} = ${row.text} returning 1`,
            )
          ).rows.length > 0,
      });
    }
  }
  for (const { key, binding, form } of ENVELOPE_SETTINGS) {
    const [row] = await tx
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, key));
    const envelope = parse(row?.value.envelope);
    if (!row || !envelope) continue;
    found.push({
      binding,
      envelope,
      replace: async (next) => {
        const value = { ...row.value, envelope: form === "json" ? JSON.stringify(next) : next };
        return (
          (
            await tx.execute(
              sql`update ${schema.systemSetting} set value = ${JSON.stringify(value)}::jsonb
                where key = ${key} and value = ${JSON.stringify(row.value)}::jsonb returning 1`,
            )
          ).rows.length > 0
        );
      },
    });
  }
  return found;
}

export interface EnvelopeRotationResult {
  /** Re-sealed with EDGEWEIR_MASTER_KEY. */
  resealed: number;
  /** Sealed with the previous key, but could not be opened (damaged or moved to another row). */
  failed: number;
  /** Still sealed with EDGEWEIR_MASTER_KEY_PREVIOUS after the pass. */
  previous: number;
  /** Sealed with a key that is neither of the two: unreadable either way. */
  unknown: number;
}

/**
 * After a master key rotation (EDGEWEIR_MASTER_KEY_PREVIOUS set), re-seals
 * every stored envelope of the previous key with the current one, bound to
 * the same row. Runs at startup; idempotent, serialised with the legacy
 * upgrade by its advisory lock. Logs what still uses the previous key, and
 * a line saying it can be removed once nothing does.
 */
export async function resealEnvelopes(
  db: Database,
  masterKey: MasterKey,
  log: Logger,
): Promise<EnvelopeRotationResult | null> {
  const previousKid = masterKey.previousKid;
  if (!previousKid) return null;
  const result: EnvelopeRotationResult = { resealed: 0, failed: 0, previous: 0, unknown: 0 };
  await db.transaction(async (tx) => {
    await lockEnvelopeUpgrade(tx);
    for (const { binding, envelope, replace } of await storedEnvelopes(tx)) {
      if (envelope.kid !== previousKid) continue;
      let next: Envelope;
      try {
        next = masterKey.seal(masterKey.open(envelope, binding), binding);
      } catch (error) {
        result.failed++;
        log.error("cannot re-seal an envelope of the previous master key", {
          purpose: binding.purpose,
          recordId: binding.recordId,
          error: (error as Error).message,
        });
        continue;
      }
      if (await replace(next)) result.resealed++;
    }
    for (const { envelope } of await storedEnvelopes(tx)) {
      if (envelope.kid === previousKid) result.previous++;
      else if (envelope.kid !== masterKey.kid) result.unknown++;
    }
  });
  log.info("master key rotation", { ...result, kid: masterKey.kid, previousKid });
  if (result.previous === 0) {
    log.info(
      "no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console",
    );
  } else {
    log.warn("envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set", {
      previous: result.previous,
    });
  }
  if (result.unknown > 0) {
    log.warn("envelopes sealed with neither master key cannot be opened", {
      unknown: result.unknown,
    });
  }
  return result;
}
