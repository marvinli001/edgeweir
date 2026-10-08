import "reflect-metadata";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@edgeweir/db";
import { eq, getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { AUTH_SECRET_BINDING, AUTH_SECRET_KEY } from "../../src/server/lib/auth-secret";
import { type EnvelopeBinding, MasterKey } from "../../src/server/lib/envelope";
import type { Logger } from "../../src/server/lib/logger";
import { assertMasterKey, MASTER_KEY_MISMATCH } from "../../src/server/lib/master-key";
import { siteSecretBinding } from "../../src/server/lib/site-secrets";
import { generateCa } from "../../src/server/pki/ca";
import { caKeyBinding, loadOrCreateNodeCa, NODE_CA_ID } from "../../src/server/pki/store";
import { ACME_DIRECTORY_KEY, acmeDirectoryBinding } from "../../src/server/services/acme-directory";
import {
  acmeAccountBinding,
  certificateAccountBinding,
  certificateKeyBinding,
  dnsCredentialBinding,
} from "../../src/server/services/certificates";
import { challengeKeyBinding } from "../../src/server/services/challenge-keys";
import { providerBinding } from "../../src/server/services/dns-providers";
import {
  ENVELOPE_COLUMNS,
  ENVELOPE_SETTINGS,
  resealEnvelopes,
  storedEnvelopes,
  UNSTORED_ENVELOPE_PURPOSES,
} from "../../src/server/services/envelope-rotation";
import {
  channelBinding,
  SMTP_KEY,
  smtpBinding,
} from "../../src/server/services/notification-delivery";
import { sessionTicketKeyBinding } from "../../src/server/services/session-ticket-keys";
import {
  ensureSetupToken,
  SETUP_TOKEN_BINDING,
  SETUP_TOKEN_KEY,
} from "../../src/server/services/setup";
import { s3SecretBinding } from "../../src/server/services/sites";
import { createTestDatabase, TEST_MASTER_KEY } from "./helpers";

const server = resolve(import.meta.dirname, "../../src/server");
const OLD = TEST_MASTER_KEY;
const NEW = Buffer.alloc(32, 4).toString("base64");
const FOREIGN = Buffer.alloc(32, 2).toString("base64");

const registered = () => [
  ...ENVELOPE_COLUMNS.map((c) => c.binding("id").purpose),
  ...ENVELOPE_SETTINGS.map((s) => s.binding.purpose),
];

function testLogger() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log satisfies Logger;
}

describe("the re-seal pass knows every envelope", () => {
  it("covers every purpose the server seals with, except receipts the nodes keep", () => {
    const sealed = new Set<string>();
    for (const file of globSync("**/*.ts", { cwd: server })) {
      const text = readFileSync(resolve(server, file), "utf8");
      for (const m of text.matchAll(/\bpurpose:\s*"([^"]+)"/g)) sealed.add(m[1] ?? "");
      // Named purposes; the LEGACY_ ones are only opened by the v1 upgrade.
      for (const m of text.matchAll(/\bconst (?!LEGACY_)\w*_PURPOSE = "([^"]+)"/g))
        sealed.add(m[1] ?? "");
    }
    expect(sealed).toContain("node.revision_receipt");
    expect([...sealed].sort()).toEqual([...registered(), ...UNSTORED_ENVELOPE_PURPOSES].sort());
  });

  it("covers every envelope column of the schema", () => {
    const columns = Object.values(schema)
      .filter((value) => is(value, Table))
      .flatMap((table) =>
        Object.values(getTableColumns(table))
          .filter(
            (column) =>
              column.name.includes("envelope") ||
              // Named "secret", like better-auth's two_factor.secret, which is not ours.
              (["challenge_key", "session_ticket_key"].includes(getTableName(table)) &&
                column.name === "secret"),
          )
          .map((column) => `${getTableName(table)}.${column.name}`),
      );
    expect(columns).toContain("pki_authority.private_key_envelope");
    expect(ENVELOPE_COLUMNS.map((c) => `${getTableName(c.table)}.${c.column.name}`).sort()).toEqual(
      columns.sort(),
    );
  });

  it("names each purpose after the table and column, or setting, that stores it", () => {
    for (const { table, column, binding } of ENVELOPE_COLUMNS) {
      expect(binding("id")).toEqual({
        purpose: `${getTableName(table)}.${column.name}`,
        recordId: "id",
      });
    }
    for (const { key, binding } of ENVELOPE_SETTINGS) {
      expect(binding).toEqual({ purpose: `system_setting.${key}`, recordId: key });
    }
  });
});

describe("master key rotation", () => {
  const before = new MasterKey(OLD);
  const ring = new MasterKey(NEW, OLD);
  const after = new MasterKey(NEW);

  /** A database with one envelope of the old key in every place that stores them. */
  async function seeded() {
    const { db, client } = await createTestDatabase();
    const plaintexts = new Map<string, string>();
    const seal = (binding: EnvelopeBinding, key = before) => {
      const plaintext = `${binding.purpose}/${binding.recordId}`;
      plaintexts.set(`${binding.purpose}/${binding.recordId}`, plaintext);
      return JSON.stringify(key.seal(plaintext, binding));
    };
    const [cluster] = await db.insert(schema.cluster).values({ name: "default" }).returning();
    const clusterId = cluster?.id ?? "";
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId, name: "assets", cnamePrefix: "assets" })
      .returning();
    const ids = {
      credential: crypto.randomUUID(),
      channel: crypto.randomUUID(),
      provider: crypto.randomUUID(),
      dns: crypto.randomUUID(),
      certificate: crypto.randomUUID(),
      empty: crypto.randomUUID(),
      account: crypto.randomUUID(),
      key: crypto.randomUUID(),
      pending: crypto.randomUUID(),
      siteSecret: crypto.randomUUID(),
      ticketKey: crypto.randomUUID(),
      ticketPending: crypto.randomUUID(),
    };
    await db.insert(schema.originCredential).values({
      id: ids.credential,
      siteId: site?.id ?? "",
      accessKeyId: "AKID",
      secretEnvelope: seal(s3SecretBinding(ids.credential)),
    });
    await db.insert(schema.siteSecret).values({
      id: ids.siteSecret,
      siteId: site?.id ?? "",
      kind: "purge_key",
      secretEnvelope: seal(siteSecretBinding(ids.siteSecret)),
    });
    const ca = await generateCa("Rotation CA");
    await db.insert(schema.pkiAuthority).values({
      id: NODE_CA_ID,
      certificatePem: ca.certificatePem,
      fingerprintSha256: "00",
      privateKeyEnvelope: JSON.stringify(
        before.seal(ca.privateKeyPkcs8Der, caKeyBinding(NODE_CA_ID)),
      ),
      notAfter: new Date(Date.now() + 86_400_000),
    });
    await db.insert(schema.alertChannel).values({
      id: ids.channel,
      name: "ops",
      kind: "webhook",
      configEnvelope: seal(channelBinding(ids.channel)),
    });
    await db.insert(schema.platformDnsProvider).values({
      id: ids.provider,
      name: "dns",
      provider: "cloudflare",
      zone: "example.com",
      credentialEnvelope: seal(providerBinding(ids.provider)),
    });
    await db.insert(schema.dnsCredential).values({
      id: ids.dns,
      name: "acme dns",
      provider: "cloudflare",
      zone: "example.com",
      credentialEnvelope: seal(dnsCredentialBinding(ids.dns)),
    });
    await db.insert(schema.certificate).values([
      {
        id: ids.certificate,
        name: "www",
        source: "acme",
        privateKeyEnvelope: seal(certificateKeyBinding(ids.certificate)),
        accountEnvelope: seal(certificateAccountBinding(ids.certificate)),
      },
      // Not issued yet: no envelopes, nothing to do.
      { id: ids.empty, name: "pending", source: "acme" },
    ]);
    await db.insert(schema.acmeAccount).values({
      id: ids.account,
      directoryUrl: "https://acme.example/directory",
      email: "ops@example.com",
      accountEnvelope: seal(acmeAccountBinding(ids.account)),
    });
    await db.insert(schema.challengeKey).values([
      { id: ids.key, clusterId, role: "current", secret: seal(challengeKeyBinding(ids.key)) },
      { id: ids.pending, clusterId, role: "next", secret: null },
    ]);
    await db.insert(schema.sessionTicketKey).values([
      {
        id: ids.ticketKey,
        clusterId,
        role: "current",
        secret: seal(sessionTicketKeyBinding(ids.ticketKey)),
      },
      { id: ids.ticketPending, clusterId, role: "next", secret: null },
    ]);
    await db.insert(schema.systemSetting).values([
      {
        key: SETUP_TOKEN_KEY,
        value: {
          envelope: before.seal("ews_token", SETUP_TOKEN_BINDING),
          hash: "h",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      },
      { key: SMTP_KEY, value: { envelope: seal(smtpBinding) } },
      { key: AUTH_SECRET_KEY, value: { envelope: before.seal("session", AUTH_SECRET_BINDING) } },
      {
        key: ACME_DIRECTORY_KEY,
        value: {
          url: "https://acme.example/directory",
          eabKid: "kid",
          envelope: seal(acmeDirectoryBinding),
          caPem: "",
          caaIdentities: [],
        },
      },
    ]);
    plaintexts.set(`${SETUP_TOKEN_BINDING.purpose}/${SETUP_TOKEN_KEY}`, "ews_token");
    plaintexts.set(`${AUTH_SECRET_BINDING.purpose}/${AUTH_SECRET_KEY}`, "session");
    return { db, client, ids, plaintexts, caKey: ca.privateKeyPkcs8Der, clusterId };
  }

  it("re-seals every stored envelope of the previous key with the current one, bound to its row", async () => {
    const { db, client, plaintexts, caKey } = await seeded();
    // The seed holds an envelope in every place the pass knows.
    const found = await storedEnvelopes(db);
    expect([...new Set(found.map((e) => e.binding.purpose))].sort()).toEqual(registered().sort());
    expect(found.every((e) => e.envelope.kid === before.kid)).toBe(true);

    const log = testLogger();
    const result = await resealEnvelopes(db, ring, log);
    expect(result).toEqual({ resealed: found.length, failed: 0, previous: 0, unknown: 0 });

    // The current key alone opens every one of them, with the same contents.
    const now = await storedEnvelopes(db);
    expect(now).toHaveLength(found.length);
    for (const { binding, envelope } of now) {
      expect(envelope.kid, binding.purpose).toBe(after.kid);
      const opened = after.open(envelope, binding);
      if (binding.purpose === caKeyBinding(NODE_CA_ID).purpose) {
        expect(opened.equals(Buffer.from(caKey))).toBe(true);
      } else {
        expect(opened.toString(), binding.purpose).toBe(
          plaintexts.get(`${binding.purpose}/${binding.recordId}`),
        );
      }
    }
    // The other fields of a setting stay, and the SMTP envelope stays JSON text.
    const [setup] = await db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
    expect(setup?.value).toMatchObject({ hash: "h", createdAt: "2026-10-01T00:00:00.000Z" });
    const [smtp] = await db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, SMTP_KEY));
    expect(typeof smtp?.value.envelope).toBe("string");

    expect(log.info).toHaveBeenCalledWith(
      "no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console",
    );
    expect(log.warn).not.toHaveBeenCalled();
    // Idempotent.
    expect(await resealEnvelopes(db, ring, testLogger())).toEqual({
      resealed: 0,
      failed: 0,
      previous: 0,
      unknown: 0,
    });
    await client.close();
  });

  it("reports what it cannot re-seal and keeps the previous key needed", async () => {
    const { db, client, ids } = await seeded();
    // Row A holds row B's envelope (moved), and a third key sealed another.
    const moved = before.seal("moved", dnsCredentialBinding(crypto.randomUUID()));
    await db
      .update(schema.dnsCredential)
      .set({ credentialEnvelope: JSON.stringify(moved) })
      .where(eq(schema.dnsCredential.id, ids.dns));
    const foreign = new MasterKey(FOREIGN).seal("foreign", providerBinding(ids.provider));
    await db
      .update(schema.platformDnsProvider)
      .set({ credentialEnvelope: JSON.stringify(foreign) })
      .where(eq(schema.platformDnsProvider.id, ids.provider));

    const log = testLogger();
    const result = await resealEnvelopes(db, ring, log);
    expect(result).toMatchObject({ failed: 1, previous: 1, unknown: 1 });
    expect(log.error).toHaveBeenCalledWith(
      "cannot re-seal an envelope of the previous master key",
      expect.objectContaining({
        purpose: "dns_credential.credential_envelope",
        recordId: ids.dns,
      }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      "envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set",
      {
        previous: 1,
      },
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/^no envelope uses/));
    // Left as they were.
    const [dns] = await db
      .select()
      .from(schema.dnsCredential)
      .where(eq(schema.dnsCredential.id, ids.dns));
    expect(JSON.parse(dns?.credentialEnvelope ?? "{}")).toEqual(moved);
    await client.close();
  });

  it("does not overwrite an envelope written after it was read", async () => {
    const { db, client, ids } = await seeded();
    const [item] = (await storedEnvelopes(db)).filter(
      (e) => e.binding.purpose === "alert_channel.config_envelope",
    );
    if (!item) throw new Error("no channel envelope");
    const saved = JSON.stringify(ring.seal("saved meanwhile", channelBinding(ids.channel)));
    await db
      .update(schema.alertChannel)
      .set({ configEnvelope: saved })
      .where(eq(schema.alertChannel.id, ids.channel));
    expect(await item.replace(ring.seal("stale", item.binding))).toBe(false);
    const [channel] = await db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, ids.channel));
    expect(channel?.configEnvelope).toBe(saved);
    await client.close();
  });

  it("does nothing without EDGEWEIR_MASTER_KEY_PREVIOUS", async () => {
    const { db, client } = await seeded();
    const log = testLogger();
    expect(await resealEnvelopes(db, before, log)).toBeNull();
    expect(log.info).not.toHaveBeenCalled();
    expect((await storedEnvelopes(db)).every((e) => e.envelope.kid === before.kid)).toBe(true);
    await client.close();
  });

  it("starts with the previous key, and without it once the pass is done", async () => {
    const { db, client } = await seeded();
    const ca = await loadOrCreateNodeCa(db, before);
    const token = await ensureSetupToken({ db, masterKey: before });
    expect(token).toBe("ews_token");

    // The new key alone does not open this database.
    await expect(assertMasterKey(db, after)).rejects.toThrow(
      new RegExp(`${MASTER_KEY_MISMATCH}.*EDGEWEIR_MASTER_KEY_PREVIOUS`),
    );
    // With the old one as EDGEWEIR_MASTER_KEY_PREVIOUS it does, before the pass too.
    await assertMasterKey(db, ring);
    expect((await loadOrCreateNodeCa(db, ring)).fingerprintSha256).toBe(ca.fingerprintSha256);
    expect(await ensureSetupToken({ db, masterKey: ring })).toBe(token);

    await resealEnvelopes(db, ring, testLogger());
    await assertMasterKey(db, after);
    expect((await loadOrCreateNodeCa(db, after)).fingerprintSha256).toBe(ca.fingerprintSha256);
    expect(await ensureSetupToken({ db, masterKey: after })).toBe(token);
    // A wrong previous key names both configured ids.
    const wrong = new MasterKey(FOREIGN, Buffer.alloc(32, 3).toString("base64"));
    const error = await assertMasterKey(db, wrong).catch((e: Error) => e.message);
    expect(error).toContain(wrong.kid);
    expect(error).toContain(wrong.previousKid);
    await client.close();
  });
});
