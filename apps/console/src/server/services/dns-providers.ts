import { randomUUID } from "node:crypto";
import {
  checkDnsCredentials,
  type DnsProviderInput,
  dnsProviderEntry,
  normalizeCidr,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { CertdError, runCertd } from "./certificate-worker";
import type { Executor } from "./revisions";

type Provider = typeof schema.platformDnsProvider.$inferSelect;
export type ProviderRecord = { name: string; type: string; data: string; ttl: number };

export const providerBinding = (id: string) => ({
  purpose: "platform_dns_provider.credential_envelope",
  recordId: id,
});
export const providerDto = (p: Provider) => ({
  id: p.id,
  name: p.name,
  zone: p.zone,
  provider: p.provider as DnsProviderInput["provider"],
});

/** The operator's outbound allow list, passed to certd for user-configured endpoints. */
export function outboundAllowCidrs(app: AppContext): string[] {
  return app.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS.split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => {
      const cidr = normalizeCidr(value);
      if (!cidr) throw new Error("invalid outbound allow list");
      return cidr;
    });
}

/**
 * Validates credentials against the catalog (and the test fixture switch);
 * returns the normalized fields. `code` is the error used for invalid input.
 */
export function validCredentials(
  app: AppContext,
  provider: string,
  credentials: Record<string, string>,
  code: "DNS_POLICY_INVALID" | "DNS_CREDENTIAL_INVALID",
) {
  const entry = dnsProviderEntry(provider);
  if (entry?.hidden && !app.env.EDGEWEIR_DNS_TEST_ENDPOINT)
    fail("DNS_TEST_DISABLED", "DNS test provider is disabled");
  const checked = checkDnsCredentials(provider, credentials);
  if (!checked.ok) fail(code, `DNS credentials: ${checked.problem}`, {});
  return checked.value;
}

const certdCodes: Record<string, Parameters<typeof fail>[0]> = {
  dns_auth_failed: "DNS_PROVIDER_AUTH_FAILED",
  dns_zone_not_found: "DNS_PROVIDER_ZONE_NOT_FOUND",
  dns_address_refused: "DNS_ADDRESS_REFUSED",
  dns_provider_unreachable: "DNS_PROVIDER_UNREACHABLE",
  dns_rate_limited: "DNS_PROVIDER_RATE_LIMITED",
  dns_unsupported: "DNS_ZONES_UNSUPPORTED",
};
/** Maps a certd DNS failure to an API error (provider text is never passed on). */
export function failFromCertd(error: unknown): never {
  if (error instanceof CertdError)
    fail(certdCodes[error.code] ?? "DNS_PROVIDER_FAILED", "DNS provider request failed");
  throw error;
}
/** The error code stored on a failed DNS revision or record. */
export function errorCode(error: unknown, fallback = "dns_reconcile_failed") {
  if (error instanceof CertdError && error.code.startsWith("dns_")) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (code === "DNS_RECORD_CONFLICT") return "dns_record_conflict";
  if (code === "DNS_BINDING_CONFLICT") return "dns_binding_conflict";
  if (code === "DNS_ZONE_MISMATCH") return "dns_zone_mismatch";
  return fallback;
}

/** Runs a DNS command in certd with the operator's outbound policy. */
export function certdDns<T>(
  app: AppContext,
  command: "dns.list" | "dns.set" | "dns.present" | "dns.cleanup" | "dns.zones" | "dns.test",
  params: {
    provider: string;
    zone?: string;
    credentials: Record<string, string>;
    records?: ProviderRecord[];
  },
) {
  return runCertd<T>(app, command, {
    ...params,
    outbound: { allowCidrs: outboundAllowCidrs(app) },
  });
}

export async function findProvider(db: Executor, id: string) {
  const [p] = await db
    .select()
    .from(schema.platformDnsProvider)
    .where(eq(schema.platformDnsProvider.id, id));
  if (!p) fail("DNS_PROVIDER_NOT_FOUND", "DNS provider not found");
  return p;
}
export function openProvider(app: AppContext, p: Provider): Record<string, string> {
  return JSON.parse(
    app.masterKey.open(JSON.parse(p.credentialEnvelope), providerBinding(p.id)).toString("utf8"),
  );
}

export async function listDnsProviders(app: AppContext) {
  return {
    items: (
      await app.db
        .select()
        .from(schema.platformDnsProvider)
        .orderBy(schema.platformDnsProvider.name)
    ).map(providerDto),
    testEnabled: !!app.env.EDGEWEIR_DNS_TEST_ENDPOINT,
  };
}
export async function createDnsProvider(app: AppContext, input: DnsProviderInput, actor: Actor) {
  const credentials = validCredentials(
    app,
    input.provider,
    input.credentials,
    "DNS_POLICY_INVALID",
  );
  const id = randomUUID();
  const credentialEnvelope = JSON.stringify(
    app.masterKey.seal(JSON.stringify(credentials), providerBinding(id)),
  );
  return app.db.transaction(async (tx) => {
    const [p] = await tx
      .insert(schema.platformDnsProvider)
      .values({
        id,
        name: input.name,
        provider: input.provider,
        zone: input.zone,
        credentialEnvelope,
      })
      .returning();
    if (!p) throw new Error("DNS provider insert failed");
    await recordAudit(tx, actor, {
      action: "dns.provider_create",
      targetType: "dns_provider",
      targetId: id,
      targetName: p.name,
      metadata: { provider: p.provider, zone: p.zone },
    });
    return providerDto(p);
  });
}
/** Rotate secrets without retargeting an existing credential to another provider or zone. */
export async function updateDnsProvider(
  app: AppContext,
  input: { id: string; name?: string; credentials?: Record<string, string> },
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(schema.platformDnsProvider)
      .where(eq(schema.platformDnsProvider.id, input.id))
      .for("update");
    if (!p) fail("DNS_PROVIDER_NOT_FOUND", "DNS provider not found");
    const credentials = input.credentials
      ? validCredentials(app, p.provider, input.credentials, "DNS_POLICY_INVALID")
      : undefined;
    const [updated] = await tx
      .update(schema.platformDnsProvider)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(credentials
          ? {
              credentialEnvelope: JSON.stringify(
                app.masterKey.seal(JSON.stringify(credentials), providerBinding(p.id)),
              ),
            }
          : {}),
      })
      .where(eq(schema.platformDnsProvider.id, p.id))
      .returning();
    if (!updated) throw new Error("DNS provider disappeared");
    await recordAudit(tx, actor, {
      action: "dns.provider_update",
      targetType: "dns_provider",
      targetId: p.id,
      targetName: updated.name,
      metadata: { credentialsRotated: !!credentials },
    });
    return providerDto(updated);
  });
}
/** Refused while a cluster binding selects the account or it still holds managed records. */
export async function deleteDnsProvider(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(schema.platformDnsProvider)
      .where(eq(schema.platformDnsProvider.id, id))
      .for("update");
    if (!p) fail("DNS_PROVIDER_NOT_FOUND", "DNS provider not found");
    const [binding] = await tx
      .select({ clusterId: schema.dnsBinding.clusterId })
      .from(schema.dnsBinding)
      .where(eq(schema.dnsBinding.providerId, id))
      .limit(1);
    if (binding) fail("DNS_PROVIDER_IN_USE", "provider is selected by a cluster DNS binding");
    const managed = await tx
      .select({ name: schema.dnsManagedName.name })
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.providerId, id))
      .limit(1);
    if (managed.length)
      fail("DNS_PROVIDER_IN_USE", "provider still owns DNS records; reconcile first");
    await tx.delete(schema.platformDnsProvider).where(eq(schema.platformDnsProvider.id, id));
    await recordAudit(tx, actor, {
      action: "dns.provider_delete",
      targetType: "dns_provider",
      targetId: id,
      targetName: p.name,
    });
    return { ok: true as const };
  });
}

/** Credentials of a request: a saved account (by id) or unsaved fields. */
async function source(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string> },
) {
  if ("id" in input) {
    const p = await findProvider(app.db, input.id);
    return { provider: p.provider, zone: p.zone, credentials: openProvider(app, p) };
  }
  return {
    provider: input.provider,
    zone: undefined,
    credentials: validCredentials(app, input.provider, input.credentials, "DNS_POLICY_INVALID"),
  };
}

let running = 0;
/** At most four provider probes at a time per console process. */
export async function probe<T>(run: () => Promise<T>): Promise<T> {
  if (running >= 4) fail("DNS_PROVIDER_RATE_LIMITED", "too many DNS provider checks at once");
  running++;
  try {
    return await run();
  } catch (error) {
    failFromCertd(error);
  } finally {
    running--;
  }
}

/** Zones the credentials can manage (only providers that can list zones). */
export async function listProviderZones(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string> },
) {
  const { provider, credentials } = await source(app, input);
  if (!dnsProviderEntry(provider)?.capabilities.listZones)
    fail("DNS_ZONES_UNSUPPORTED", "this provider cannot list zones");
  const zones = await probe(() => certdDns<string[]>(app, "dns.zones", { provider, credentials }));
  return {
    zones: [...new Set(zones.map((z) => z.replace(/\.$/, "").toLowerCase()))].sort().slice(0, 1000),
  };
}

/** Reads the zone's records (connection test). */
export async function testProvider(
  app: AppContext,
  input: { id: string } | { provider: string; credentials: Record<string, string>; zone: string },
) {
  const resolved = await source(app, input);
  const zone = "zone" in input ? input.zone : resolved.zone;
  const result = await probe(() =>
    certdDns<{ records: number }>(app, "dns.test", { ...resolved, zone }),
  );
  return { ok: true as const, records: result.records };
}
