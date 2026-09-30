import { createHash, randomUUID } from "node:crypto";
import {
  type DnsPolicy,
  type DnsProviderInput,
  type DnsRecord,
  type DnsRevision,
  dnsCredentialInput,
  dnsPolicy,
  forbiddenOriginRange,
  formatIp,
  parseIp,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit, systemActor } from "./audit";
import { runCertd } from "./certificate-worker";
import { isOnline } from "./nodes";
import type { Executor, Tx } from "./revisions";
import { findSite, type SiteScope } from "./sites";

type Provider = typeof schema.platformDnsProvider.$inferSelect;
type Revision = typeof schema.dnsRevision.$inferSelect;
type ManagedName = { name: string; type: string };
const privateNetworks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
const binding = (id: string) => ({
  purpose: "platform_dns_provider.credential_envelope",
  recordId: id,
});
const providerDto = (p: Provider) => ({
  id: p.id,
  name: p.name,
  zone: p.zone,
  provider: p.provider as DnsProviderInput["provider"],
});
const revisionDto = (r: Revision): DnsRevision => ({
  revision: r.revision,
  status: r.status as DnsRevision["status"],
  reason: r.reason,
  recordCount: r.records.length,
  createdAt: r.createdAt.toISOString(),
  appliedAt: r.appliedAt?.toISOString() ?? null,
  lastError: r.lastError,
});
const nameKey = (r: ManagedName) => `${r.name}|${r.type}`;
const recordKey = (r: DnsRecord) => `${nameKey(r)}|${r.data}|${r.ttl}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function relative(name: string, zone: string) {
  if (name === zone) return "@";
  if (!name.endsWith(`.${zone}`))
    fail("DNS_ZONE_MISMATCH", "CNAME suffix is outside the provider zone");
  return name.slice(0, -zone.length - 1);
}
async function state(db: Executor) {
  const [s] = await db.select().from(schema.dnsState).where(eq(schema.dnsState.id, 1));
  if (!s) throw new Error("DNS state missing");
  return s;
}
async function provider(db: Executor, id: string) {
  const [p] = await db
    .select()
    .from(schema.platformDnsProvider)
    .where(eq(schema.platformDnsProvider.id, id));
  if (!p) fail("DNS_PROVIDER_NOT_FOUND", "DNS provider not found");
  return p;
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
  if (input.provider === "test") {
    if (!app.env.EDGEWEIR_DNS_TEST_ENDPOINT)
      fail("DNS_TEST_DISABLED", "DNS test provider is disabled");
  } else dnsCredentialInput.parse(input);
  const id = randomUUID();
  const credentialEnvelope = JSON.stringify(
    app.masterKey.seal(JSON.stringify(input.credentials), binding(id)),
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
    if (input.credentials && p.provider !== "test")
      dnsCredentialInput.parse({
        name: p.name,
        provider: p.provider,
        zone: p.zone,
        credentials: input.credentials,
      });
    const [updated] = await tx
      .update(schema.platformDnsProvider)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.credentials
          ? {
              credentialEnvelope: JSON.stringify(
                app.masterKey.seal(JSON.stringify(input.credentials), binding(p.id)),
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
      metadata: { credentialsRotated: !!input.credentials },
    });
    return providerDto(updated);
  });
}
export async function deleteDnsProvider(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    await tx.select().from(schema.dnsState).where(eq(schema.dnsState.id, 1)).for("update");
    const s = await state(tx);
    if (dnsPolicy.parse(s.policy).providerId === id)
      fail("DNS_PROVIDER_IN_USE", "provider is selected by DNS policy");
    const managed = await tx
      .select({ name: schema.dnsManagedName.name })
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.providerId, id))
      .limit(1);
    if (managed.length)
      fail("DNS_PROVIDER_IN_USE", "provider still owns DNS records; reconcile first");
    const p = await provider(tx, id);
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
async function validatePolicy(db: Executor, policy: DnsPolicy) {
  if (!policy.enabled) return;
  const p = await provider(db, policy.providerId ?? "");
  relative(policy.cnameSuffix, p.zone);
  const groups = await db.select().from(schema.nodeGroup);
  const nodes = await db.select().from(schema.node);
  for (const line of policy.lines) {
    if (!groups.some((g) => g.id === line.nodeGroupId))
      fail("NODE_GROUP_NOT_FOUND", "DNS line references an unknown node group");
    if (new Set(line.overrides.map((o) => o.nodeId)).size !== line.overrides.length)
      fail("DNS_POLICY_INVALID", "duplicate node address override");
    for (const override of line.overrides) {
      if (!nodes.some((n) => n.id === override.nodeId && n.nodeGroupId === line.nodeGroupId))
        fail("DNS_POLICY_INVALID", "node is outside this DNS line");
      if (override.addresses.some((ip) => forbiddenOriginRange(ip, privateNetworks) !== null))
        fail("DNS_POLICY_INVALID", "DNS target must be a unicast address");
    }
  }
}
/** Current routing rights and healthy nodes determine addresses; DNS history never restores a dead node. */
export async function compileDnsPlan(
  db: Executor,
  policy: DnsPolicy,
  now = Date.now(),
): Promise<{ records: DnsRecord[]; managedNames: ManagedName[] }> {
  if (!policy.enabled || !policy.providerId) return { records: [], managedNames: [] };
  const p = await provider(db, policy.providerId);
  relative(policy.cnameSuffix, p.zone);
  const sites = await db
    .selectDistinct({ id: schema.site.id, clusterId: schema.site.clusterId })
    .from(schema.site)
    .innerJoin(schema.siteDomain, eq(schema.siteDomain.siteId, schema.site.id))
    // Disabled and suspended sites keep their records; nodes answer 404 for them.
    .where(eq(schema.siteDomain.verified, true));
  const nodes = await db.select().from(schema.node);
  const receipts = await db.select().from(schema.nodeConfigStatus);
  const addresses = await db.select().from(schema.nodeIp);
  const groups = await db.select().from(schema.nodeGroup);
  const revisions = await db
    .selectDistinctOn([schema.configRevision.clusterId])
    .from(schema.configRevision)
    .orderBy(schema.configRevision.clusterId, desc(schema.configRevision.revision));
  const records: DnsRecord[] = [];
  const names = new Map<string, ManagedName>();
  const declare = (name: string, type: DnsRecord["type"]) => {
    const relativeName = relative(name, p.zone);
    const row = { name: relativeName, type };
    names.set(nameKey(row), row);
    return relativeName;
  };
  const add = (name: string, type: DnsRecord["type"], data: string) =>
    records.push({ name: declare(name, type), type, data, ttl: policy.ttl });
  for (const site of sites) {
    const target = `${site.id}.${policy.cnameSuffix}`,
      allTarget = `all.${target}`;
    add(target, "CNAME", allTarget);
    declare(allTarget, "A");
    declare(allTarget, "AAAA");
    const all = new Set<string>();
    for (const line of policy.lines) {
      if (!groups.some((g) => g.id === line.nodeGroupId && g.clusterId === site.clusterId))
        continue;
      const lineTarget = `${line.name}.${target}`;
      declare(lineTarget, "A");
      declare(lineTarget, "AAAA");
      const ips = new Set<string>();
      for (const node of nodes.filter(
        (n) =>
          n.nodeGroupId === line.nodeGroupId &&
          n.status === "active" &&
          isOnline(n.lastSeenAt, now),
      )) {
        const receipt = receipts.find((r) => r.nodeId === node.id),
          revision = revisions.find((r) => r.clusterId === node.clusterId);
        if (
          !receipt?.dataPlaneHealthy ||
          receipt.state !== "applied" ||
          !revision ||
          receipt.appliedRevision !== revision.revision ||
          receipt.appliedContentHash !== revision.contentHash
        )
          continue;
        const override = line.overrides.find((o) => o.nodeId === node.id);
        const candidates =
          override?.addresses ??
          addresses
            .filter((a) => a.nodeId === node.id && forbiddenOriginRange(a.address, []) === null)
            .map((a) => a.address);
        for (const address of candidates) {
          const parsed = parseIp(address);
          if (!parsed || forbiddenOriginRange(address, override ? privateNetworks : []) !== null)
            continue;
          const ip = formatIp(parsed);
          ips.add(ip);
          all.add(ip);
        }
      }
      for (const ip of ips) add(lineTarget, ip.includes(":") ? "AAAA" : "A", ip);
    }
    for (const ip of all) add(allTarget, ip.includes(":") ? "AAAA" : "A", ip);
  }
  if (names.size > 10000 || records.length > 10000)
    fail("DNS_POLICY_INVALID", "DNS managed record limit exceeded");
  return {
    records: records.sort((a, b) => compare(recordKey(a), recordKey(b))),
    managedNames: [...names.values()].sort((a, b) => compare(nameKey(a), nameKey(b))),
  };
}
async function publish(tx: Tx, policy: DnsPolicy, reason: string) {
  await tx.select().from(schema.dnsState).where(eq(schema.dnsState.id, 1)).for("update");
  const plan = await compileDnsPlan(tx, policy);
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ policy, ...plan }))
    .digest("hex");
  const s = await state(tx),
    [previous] = s.desiredRevision
      ? await tx
          .select()
          .from(schema.dnsRevision)
          .where(eq(schema.dnsRevision.revision, s.desiredRevision))
      : [];
  if (previous?.contentHash === contentHash) return previous;
  const [row] = await tx
    .insert(schema.dnsRevision)
    .values({ providerId: policy.providerId, policy, ...plan, contentHash, reason })
    .returning();
  if (!row) throw new Error("DNS revision insert failed");
  await tx
    .update(schema.dnsRevision)
    .set({ status: "superseded" })
    .where(
      and(eq(schema.dnsRevision.status, "pending"), ne(schema.dnsRevision.revision, row.revision)),
    );
  await tx
    .update(schema.dnsState)
    .set({ policy, desiredRevision: row.revision })
    .where(eq(schema.dnsState.id, 1));
  return row;
}
export async function getDnsConfig(app: AppContext) {
  const s = await state(app.db);
  const [revision] = s.desiredRevision
    ? await app.db
        .select()
        .from(schema.dnsRevision)
        .where(eq(schema.dnsRevision.revision, s.desiredRevision))
    : [];
  return {
    policy: dnsPolicy.parse(s.policy),
    revision: revision ? revisionDto(revision) : null,
    records: revision?.records ?? [],
  };
}
export async function saveDnsConfig(app: AppContext, input: DnsPolicy, actor: Actor) {
  await validatePolicy(app.db, input);
  return app.db.transaction(async (tx) => {
    const revision = await publish(tx, input, "manual");
    await recordAudit(tx, actor, {
      action: "dns.publish",
      targetType: "dns_revision",
      targetId: String(revision.revision),
      metadata: { enabled: input.enabled, recordCount: revision.records.length },
    });
    return revisionDto(revision);
  });
}
export async function listDnsRevisions(app: AppContext) {
  return (
    await app.db
      .select()
      .from(schema.dnsRevision)
      .orderBy(desc(schema.dnsRevision.revision))
      .limit(200)
  ).map(revisionDto);
}
export async function rollbackDnsConfig(app: AppContext, revision: number, actor: Actor) {
  const [row] = await app.db
    .select()
    .from(schema.dnsRevision)
    .where(eq(schema.dnsRevision.revision, revision));
  if (!row) fail("DNS_REVISION_NOT_FOUND", "DNS revision not found");
  const policy = dnsPolicy.parse(row.policy);
  await validatePolicy(app.db, policy);
  return app.db.transaction(async (tx) => {
    const result = await publish(tx, policy, "rollback");
    await recordAudit(tx, actor, {
      action: "dns.rollback",
      targetType: "dns_revision",
      targetId: String(result.revision),
      metadata: { fromRevision: revision },
    });
    return revisionDto(result);
  });
}

class Superseded extends Error {}
async function assertCurrent(app: AppContext, revision: number) {
  if ((await state(app.db)).desiredRevision !== revision) throw new Superseded();
}
type ProviderRecord = { name: string; type: string; data: string; ttl: number };
function normalizeRecord(record: ProviderRecord): ProviderRecord {
  const type = record.type.toUpperCase(),
    ip = type === "A" || type === "AAAA" ? parseIp(record.data) : null;
  return {
    ...record,
    type,
    name: record.name.replace(/\.$/, "").toLowerCase(),
    data: ip
      ? formatIp(ip)
      : type === "CNAME"
        ? record.data.replace(/\.$/, "").toLowerCase()
        : record.data,
  };
}
async function reconcileProvider(
  app: AppContext,
  p: Provider,
  revision: Revision,
  desired: DnsRecord[],
  desiredNames: ManagedName[],
) {
  const credentials = JSON.parse(
    app.masterKey.open(JSON.parse(p.credentialEnvelope), binding(p.id)).toString("utf8"),
  );
  const call = async (command: string, records?: ProviderRecord[]) =>
    runCertd<ProviderRecord[]>(app, command, {
      provider: p.provider,
      zone: p.zone,
      credentials,
      records,
    });
  const actual = (await call("dns.list")).map(normalizeRecord);
  const stored = await app.db
    .select()
    .from(schema.dnsManagedName)
    .where(eq(schema.dnsManagedName.providerId, p.id));
  const existingNames = new Set(stored.map((r) => r.name));
  for (const name of desiredNames)
    if (!existingNames.has(name.name) && actual.some((r) => r.name === name.name))
      fail("DNS_RECORD_CONFLICT", "DNS name contains an unmanaged record");
  await assertCurrent(app, revision.revision);
  if (desiredNames.length)
    await app.db
      .insert(schema.dnsManagedName)
      .values(desiredNames.map((r) => ({ ...r, providerId: p.id })))
      .onConflictDoNothing();
  const managed = new Map([...stored, ...desiredNames].map((r) => [nameKey(r), r]));
  const wanted = new Set(desired.map(recordKey));
  const present = new Set(actual.map((r) => recordKey(r as DnsRecord)));
  const remove = actual.filter(
    (r) => managed.has(nameKey(r)) && !wanted.has(recordKey(r as DnsRecord)),
  );
  const add = desired.filter((r) => !present.has(recordKey(r)));
  for (const [command, records] of [
    ["dns.cleanup", remove],
    ["dns.present", add],
  ] as const) {
    for (let index = 0; index < records.length; index += 100) {
      await assertCurrent(app, revision.revision);
      await call(command, records.slice(index, index + 100));
    }
  }
  const after = (await call("dns.list"))
    .map(normalizeRecord)
    .filter((r) => managed.has(nameKey(r)));
  if (after.length !== desired.length || after.some((r) => !wanted.has(recordKey(r as DnsRecord))))
    throw new Error("DNS readback mismatch");
  const keep = new Set(desiredNames.map(nameKey));
  const retired = stored.filter((name) => !keep.has(nameKey(name))).map(nameKey);
  if (retired.length)
    await app.db.execute(
      sql`delete from dns_managed_name where provider_id=${p.id}::uuid and (name || '|' || type) in (select jsonb_array_elements_text(${JSON.stringify(retired)}::jsonb))`,
    );
}
/** One worker at a time, with a non-blocking session lock; API policy updates remain responsive. */
export async function reconcileDns(app: AppContext, actor: Actor = systemActor) {
  const connection = await app.pool.connect();
  let locked = false;
  try {
    const lock = await connection.query("select pg_try_advisory_lock(550075, 5) as locked");
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ok: true as const };
    const revision = await app.db.transaction(async (tx) => {
      await tx.select().from(schema.dnsState).where(eq(schema.dnsState.id, 1)).for("update");
      const current = await state(tx);
      return publish(tx, dnsPolicy.parse(current.policy), "health");
    });
    try {
      const providers = await app.db.select().from(schema.platformDnsProvider);
      const names = await app.db.select().from(schema.dnsManagedName);
      for (const p of providers) {
        if (p.id !== revision.providerId && !names.some((r) => r.providerId === p.id)) continue;
        await reconcileProvider(
          app,
          p,
          revision,
          p.id === revision.providerId ? revision.records : [],
          p.id === revision.providerId ? revision.managedNames : [],
        );
      }
      await assertCurrent(app, revision.revision);
      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.dnsRevision)
          .set({ status: "applied", lastError: "", appliedAt: new Date() })
          .where(eq(schema.dnsRevision.revision, revision.revision));
        await tx
          .update(schema.dnsState)
          .set({ appliedRevision: revision.revision })
          .where(
            and(eq(schema.dnsState.id, 1), eq(schema.dnsState.desiredRevision, revision.revision)),
          );
        if (revision.status !== "applied")
          await recordAudit(tx, actor, {
            action: "dns.applied",
            targetType: "dns_revision",
            targetId: String(revision.revision),
            metadata: { records: revision.records.length },
          });
      });
    } catch (error) {
      if (error instanceof Superseded) {
        await app.db
          .update(schema.dnsRevision)
          .set({ status: "superseded" })
          .where(eq(schema.dnsRevision.revision, revision.revision));
        return { ok: true as const };
      }
      await app.db
        .update(schema.dnsRevision)
        .set({ status: "failed", lastError: "dns_reconcile_failed" })
        .where(eq(schema.dnsRevision.revision, revision.revision));
      app.log.warn("DNS reconciliation failed", { revision: revision.revision });
      throw error;
    }
    return { ok: true as const };
  } finally {
    if (locked) await connection.query("select pg_advisory_unlock(550075, 5)");
    connection.release();
  }
}
export async function siteDnsTarget(app: AppContext, siteId: string, scope: SiteScope) {
  const site = await findSite(app.db, siteId, scope),
    s = await state(app.db),
    policy = dnsPolicy.parse(s.policy);
  if (!policy.enabled || !policy.providerId)
    return { target: null, published: false, healthy: false, lines: [] };
  const p = await provider(app.db, policy.providerId);
  const target = `${site.id}.${policy.cnameSuffix}`;
  const [revision] = s.desiredRevision
    ? await app.db
        .select()
        .from(schema.dnsRevision)
        .where(eq(schema.dnsRevision.revision, s.desiredRevision))
    : [];
  const groups = await app.db
    .select()
    .from(schema.nodeGroup)
    .where(eq(schema.nodeGroup.clusterId, site.clusterId));
  return {
    target,
    published: s.appliedRevision === s.desiredRevision && revision?.status === "applied",
    healthy: !!revision?.records.some(
      (r) => r.name === relative(`all.${target}`, p.zone) && (r.type === "A" || r.type === "AAAA"),
    ),
    lines: policy.lines
      .filter((l) => groups.some((g) => g.id === l.nodeGroupId))
      .map((l) => ({ name: l.name, target: `${l.name}.${target}` })),
  };
}
