import { dnsProviderEntry } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { domainRoot } from "../lib/domain-root";
import { fail } from "../lib/errors";
import { type Actor, recordAudit, systemActor } from "./audit";
import { openDnsCredential } from "./certificates";
import { withLease } from "./dns-lease";
import { certdDns, errorCode, type ProviderRecord } from "./dns-providers";
import { verifyDomainOwnership } from "./domain-ownership";
import type { Executor } from "./revisions";
import { findSite, type SiteScope } from "./sites";

type Credential = typeof schema.dnsCredential.$inferSelect;
type Owned = typeof schema.dnsOwnedRecord.$inferSelect;
type Desired = {
  siteId: string | null;
  domain: string;
  name: string;
  type: "CNAME" | "ALIAS" | "TXT";
  data: string;
  purpose: "ownership" | "target";
  /** The apex cannot point at a host name with this provider: shown, never written. */
  unsupported?: boolean;
};
const TXT_PREFIX = "_edgeweir-verification.";
const TTL = 600;
const key = (r: { name: string; type: string; purpose: string }) =>
  `${r.name}|${r.type}|${r.purpose}`;
const within = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);
const relativeTo = (name: string, zone: string) =>
  name === zone ? "@" : name.slice(0, -zone.length - 1);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const canonical = (type: string, data: string) =>
  type === "CNAME" || type === "ALIAS" ? data.replace(/\.$/, "").toLowerCase() : data;
const sameRecord = (r: ProviderRecord, d: { name: string; type: string; data: string }) =>
  sameName(r.name.replace(/\.$/, ""), d.name) &&
  r.type.toUpperCase() === d.type &&
  canonical(d.type, r.data) === canonical(d.type, d.data);

/**
 * The records an organization's zone should hold: an ownership TXT for each
 * registrable domain in the zone that is not verified yet, and a CNAME (at
 * the apex: CNAME with flattening or ALIAS, where the provider supports it)
 * from each site domain in the zone to the site's CNAME target.
 */
async function desiredRecords(db: Executor, credential: Credential): Promise<Desired[]> {
  if (!credential.autoRecords) return [];
  const zone = credential.zone;
  const apex = dnsProviderEntry(credential.provider)?.capabilities.apex ?? null;
  const domains = await db
    .select({
      siteId: schema.site.id,
      clusterId: schema.site.clusterId,
      name: schema.siteDomain.name,
      wildcard: schema.siteDomain.wildcard,
    })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(eq(schema.site.organizationId, credential.organizationId))
    .orderBy(schema.site.id, schema.siteDomain.name);
  const inZone = domains.filter((d) => within(d.name, zone));
  const clusters = [...new Set(inZone.map((d) => d.clusterId))];
  const bindings = clusters.length
    ? await db
        .select()
        .from(schema.dnsBinding)
        .where(inArray(schema.dnsBinding.clusterId, clusters))
    : [];
  const out: Desired[] = [];
  for (const d of inZone) {
    const binding = bindings.find((b) => b.clusterId === d.clusterId);
    if (!binding || binding.mode === "off" || !binding.domain) continue;
    const host = d.wildcard ? `*.${d.name}` : d.name;
    const name = relativeTo(host, zone);
    const target = `${d.siteId}.${binding.domain}`;
    if (name === "@")
      out.push({
        siteId: d.siteId,
        domain: host,
        name,
        type: apex === "alias" ? "ALIAS" : "CNAME",
        data: target,
        purpose: "target",
        unsupported: apex === null,
      });
    else
      out.push({
        siteId: d.siteId,
        domain: host,
        name,
        type: "CNAME",
        data: target,
        purpose: "target",
      });
  }
  const roots = [...new Set(domains.map((d) => domainRoot(d.name)))].filter((r) => within(r, zone));
  const proofs = roots.length
    ? await db
        .select()
        .from(schema.domainOwnership)
        .where(
          and(
            eq(schema.domainOwnership.organizationId, credential.organizationId),
            inArray(schema.domainOwnership.domain, roots),
          ),
        )
    : [];
  for (const proof of proofs)
    if (!proof.verifiedAt)
      out.push({
        siteId: domains.find((d) => domainRoot(d.name) === proof.domain)?.siteId ?? null,
        domain: proof.domain,
        name: relativeTo(`${TXT_PREFIX}${proof.domain}`, zone),
        type: "TXT",
        data: `edgeweir=${proof.token}`,
        purpose: "ownership",
      });
  // One CNAME per name: a wildcard and an exact domain never collide, duplicates across sites do.
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = key(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function audit(
  app: AppContext,
  actor: Actor,
  credential: Credential,
  action: string,
  record: { name: string; type: string; data: string; domain: string },
  extra: Record<string, unknown> = {},
) {
  await recordAudit(app.db, actor, {
    action,
    organizationId: credential.organizationId,
    targetType: "dns_credential",
    targetId: credential.id,
    targetName: `${record.name === "@" ? credential.zone : `${record.name}.${credential.zone}`} ${record.type}`,
    metadata: { domain: record.domain, data: record.data, ...extra },
  });
}

type Change = { row: Owned; want: Desired; created: boolean };
const sameConflicts = (
  a: { type: string; data: string }[],
  b: { type: string; data: string }[],
) => {
  const key = (r: { type: string; data: string }) => `${r.type}|${canonical(r.type, r.data)}`;
  const left = a.map(key).sort(),
    right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
};

/**
 * Brings one credential's zone in line with three batched provider calls
 * (delete, set, add): writes missing records, reports conflicts (any other
 * record at a CNAME's name) without touching them until a member confirms
 * exactly the records they were shown, replaces confirmed conflicts,
 * rewrites drifted records and removes records that are no longer wanted.
 * Only records the console created are ever deleted; an identical record
 * that was already there is tracked but left in place. A provider failure
 * stops this credential's run and marks its pending changes.
 */
async function syncCredential(app: AppContext, credential: Credential, actor: Actor) {
  const desired = await desiredRecords(app.db, credential);
  const owned = await app.db
    .select()
    .from(schema.dnsOwnedRecord)
    .where(eq(schema.dnsOwnedRecord.credentialId, credential.id));
  if (!desired.length && !owned.length) return;
  const params = {
    provider: credential.provider,
    zone: credential.zone,
    credentials: openDnsCredential(app, credential),
  };
  const call = (
    command: "dns.list" | "dns.set" | "dns.present" | "dns.cleanup",
    records?: ProviderRecord[],
  ) => certdDns<ProviderRecord[]>(app, command, { ...params, records });
  const update = (row: Owned, set: Partial<Owned>) =>
    app.db
      .update(schema.dnsOwnedRecord)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(schema.dnsOwnedRecord.id, row.id));
  const record = (d: { name: string; type: string; data: string }): ProviderRecord => ({
    name: d.name,
    type: d.type,
    data: d.data,
    ttl: TTL,
  });
  let actual: ProviderRecord[];
  try {
    actual = (await call("dns.list")).map((r) => ({ ...r, type: r.type.toUpperCase() }));
  } catch (error) {
    for (const row of owned)
      if (row.status !== "unsupported") await update(row, { lastError: errorCode(error) });
    throw error;
  }
  const byKey = new Map(owned.map((row) => [key(row), row]));
  const cleanup: ProviderRecord[] = [];
  const toSet: Change[] = [],
    toAdd: Change[] = [],
    removed: Owned[] = [],
    overwrites: { want: Desired; replaced: { type: string; data: string }[] }[] = [];
  // Records no longer wanted: remove exactly what the console created.
  for (const row of owned) {
    const want = desired.find((d) => key(d) === key(row));
    if (want && !!want.unsupported === (row.status === "unsupported")) continue;
    if (row.created && actual.some((r) => sameRecord(r, row))) cleanup.push(record(row));
    removed.push(row);
    byKey.delete(key(row));
  }
  for (const want of desired) {
    let row = byKey.get(key(want));
    if (!row) {
      const [inserted] = await app.db
        .insert(schema.dnsOwnedRecord)
        .values({
          organizationId: credential.organizationId,
          credentialId: credential.id,
          siteId: want.siteId,
          domain: want.domain,
          name: want.name,
          type: want.type,
          data: want.data,
          purpose: want.purpose,
          status: want.unsupported ? "unsupported" : "pending",
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) continue;
      row = inserted;
    }
    if (want.unsupported) {
      if (row.data !== want.data || row.siteId !== want.siteId)
        await update(row, { data: want.data, siteId: want.siteId, domain: want.domain });
      continue;
    }
    const present = actual.some((r) => sameRecord(r, want));
    const oldValue =
      row.data !== want.data && row.created && actual.some((r) => sameRecord(r, row))
        ? record(row)
        : null;
    if (want.type === "TXT") {
      // TXT sets hold other values too: add ours, remove only our old value.
      if (oldValue) cleanup.push(oldValue);
      if (present) {
        if (row.status !== "written" || row.data !== want.data)
          await update(row, { status: "written", data: want.data, lastError: "" });
      } else toAdd.push({ row, want, created: true });
      continue;
    }
    // A CNAME (or ALIAS) cannot share its name with any other record.
    const others = actual.filter(
      (r) =>
        sameName(r.name.replace(/\.$/, ""), want.name) &&
        !sameRecord(r, want) &&
        !(row.created && sameRecord(r, row)),
    );
    const shown = others.map((r) => ({ type: r.type, data: r.data }));
    if (others.length && !(row.confirmed && sameConflicts(shown, row.conflicts))) {
      // Not confirmed, or the records changed since the member confirmed.
      if (row.status !== "conflict" || !sameConflicts(shown, row.conflicts))
        await audit(app, actor, credential, "dns_record.conflict", want, { conflicts: shown });
      await update(row, {
        status: "conflict",
        conflicts: shown,
        confirmed: false,
        data: want.data,
        lastError: "",
      });
      continue;
    }
    if (others.length) {
      cleanup.push(...others.map((r) => record(r)));
      overwrites.push({ want, replaced: shown });
    }
    if (oldValue && oldValue.type !== want.type) cleanup.push(oldValue);
    if (present) {
      // Identical record already there: tracked, adopted only if the console did not create it.
      if (row.status !== "written" || row.data !== want.data)
        await update(row, { status: "written", data: want.data, conflicts: [], lastError: "" });
    } else toSet.push({ row, want, created: true });
  }
  const run = async (
    command: "dns.cleanup" | "dns.set" | "dns.present",
    records: ProviderRecord[],
    rows: Owned[],
  ) => {
    for (let i = 0; i < records.length; i += 100) {
      try {
        await call(command, records.slice(i, i + 100));
      } catch (error) {
        for (const row of rows)
          await update(row, { status: "failed", lastError: errorCode(error) });
        throw error;
      }
    }
  };
  await run("dns.cleanup", cleanup, removed);
  for (const row of removed) {
    await app.db.delete(schema.dnsOwnedRecord).where(eq(schema.dnsOwnedRecord.id, row.id));
    if (row.created) await audit(app, actor, credential, "dns_record.delete", row);
  }
  for (const { want, replaced } of overwrites)
    await audit(app, actor, credential, "dns_record.overwrite", want, { replaced });
  await run(
    "dns.set",
    toSet.map((c) => record(c.want)),
    toSet.map((c) => c.row),
  );
  await run(
    "dns.present",
    toAdd.map((c) => record(c.want)),
    toAdd.map((c) => c.row),
  );
  for (const { row, want } of [...toSet, ...toAdd]) {
    await update(row, {
      status: "written",
      data: want.data,
      siteId: want.siteId,
      domain: want.domain,
      conflicts: [],
      confirmed: false,
      created: true,
      lastError: "",
    });
    await audit(
      app,
      actor,
      credential,
      row.status === "written" || row.created ? "dns_record.update" : "dns_record.create",
      want,
    );
  }
}

/** Once an ownership TXT is written, checking it may verify the domain right away. */
async function verifyWritten(app: AppContext, organizationId: string, actor: Actor) {
  const rows = await app.db
    .select()
    .from(schema.dnsOwnedRecord)
    .where(
      and(
        eq(schema.dnsOwnedRecord.organizationId, organizationId),
        eq(schema.dnsOwnedRecord.purpose, "ownership"),
        eq(schema.dnsOwnedRecord.status, "written"),
      ),
    );
  for (const row of rows) {
    if (!row.siteId) continue;
    try {
      await verifyDomainOwnership(
        app,
        row.siteId,
        row.domain,
        { all: false, organizationId },
        actor,
      );
    } catch {
      // Not visible yet (propagation) or rate limited: the next run tries again.
    }
  }
}

/**
 * Synchronizes automatic records of every credential (or one organization's)
 * that writes records or still owns some. A failing provider only marks its
 * own records.
 */
export async function syncTenantRecords(
  app: AppContext,
  opts: { organizationId?: string; actor?: Actor } = {},
) {
  const actor = opts.actor ?? systemActor;
  const credentials = await app.db
    .select()
    .from(schema.dnsCredential)
    .where(
      opts.organizationId
        ? eq(schema.dnsCredential.organizationId, opts.organizationId)
        : undefined,
    );
  const owners = new Set(
    (
      await app.db
        .selectDistinct({ id: schema.dnsOwnedRecord.credentialId })
        .from(schema.dnsOwnedRecord)
    ).map((r) => r.id),
  );
  const organizations = new Set<string>();
  const queue = credentials.filter((c) => c.autoRecords || owners.has(c.id));
  // Four credentials at a time: one slow endpoint does not hold up the others.
  const worker = async () => {
    for (let credential = queue.shift(); credential; credential = queue.shift()) {
      try {
        const result = await withLease(app.db, `credential:${credential.id}`, 10 * 60, () =>
          syncCredential(app, credential, actor),
        );
        if (result.ran) organizations.add(credential.organizationId);
      } catch {
        app.log.warn("automatic DNS records failed", { credentialId: credential.id });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  for (const organizationId of organizations) await verifyWritten(app, organizationId, actor);
}

export async function siteDnsRecords(app: AppContext, siteId: string, scope: SiteScope) {
  const site = await findSite(app.db, siteId, scope);
  const domains = await app.db
    .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, site.id));
  const names = new Set([
    ...domains.map((d) => (d.wildcard ? `*.${d.name}` : d.name)),
    ...domains.map((d) => domainRoot(d.name)),
  ]);
  const credentials = await app.db
    .select({ zone: schema.dnsCredential.zone })
    .from(schema.dnsCredential)
    .where(
      and(
        eq(schema.dnsCredential.organizationId, site.organizationId),
        eq(schema.dnsCredential.autoRecords, true),
      ),
    );
  const managed = credentials.some((c) => domains.some((d) => within(d.name, c.zone)));
  const rows = await app.db
    .select({ record: schema.dnsOwnedRecord, credential: schema.dnsCredential })
    .from(schema.dnsOwnedRecord)
    .innerJoin(
      schema.dnsCredential,
      eq(schema.dnsCredential.id, schema.dnsOwnedRecord.credentialId),
    )
    .where(eq(schema.dnsOwnedRecord.organizationId, site.organizationId))
    .orderBy(schema.dnsOwnedRecord.domain, schema.dnsOwnedRecord.type);
  return {
    managed,
    items: rows
      .filter(({ record }) =>
        record.purpose === "target" ? record.siteId === site.id : names.has(record.domain),
      )
      .map(({ record, credential }) => ({
        id: record.id,
        credentialId: credential.id,
        credentialName: credential.name,
        domain: record.domain,
        name: record.name === "@" ? credential.zone : `${record.name}.${credential.zone}`,
        type: record.type,
        data: record.data,
        purpose: record.purpose as "ownership" | "target",
        status: record.status as
          | "pending"
          | "written"
          | "conflict"
          | "failed"
          | "deleting"
          | "unsupported",
        conflicts: record.conflicts,
        lastError: record.lastError,
        updatedAt: record.updatedAt.toISOString(),
      })),
  };
}

/** A member confirms replacing the records that conflict with one of the site's CNAMEs. */
export async function confirmDnsRecord(
  app: AppContext,
  siteId: string,
  recordId: string,
  scope: SiteScope,
  actor: Actor,
) {
  const site = await findSite(app.db, siteId, scope);
  const [row] = await app.db
    .select()
    .from(schema.dnsOwnedRecord)
    .where(
      and(
        eq(schema.dnsOwnedRecord.id, recordId),
        eq(schema.dnsOwnedRecord.organizationId, site.organizationId),
        eq(schema.dnsOwnedRecord.siteId, site.id),
      ),
    );
  if (!row) fail("DNS_RECORD_NOT_FOUND", "DNS record not found");
  if (row.status === "conflict") {
    await app.db
      .update(schema.dnsOwnedRecord)
      .set({ confirmed: true, updatedAt: new Date() })
      .where(eq(schema.dnsOwnedRecord.id, row.id));
    await recordAudit(app.db, actor, {
      action: "dns_record.confirm",
      organizationId: site.organizationId,
      targetType: "dns_credential",
      targetId: row.credentialId,
      targetName: row.domain,
      metadata: { name: row.name, type: row.type, conflicts: row.conflicts },
    });
    await syncTenantRecords(app, { organizationId: site.organizationId, actor });
  }
  return siteDnsRecords(app, siteId, scope);
}

export async function syncSiteDnsRecords(
  app: AppContext,
  siteId: string,
  scope: SiteScope,
  actor: Actor,
) {
  const site = await findSite(app.db, siteId, scope);
  await syncTenantRecords(app, { organizationId: site.organizationId, actor });
  return siteDnsRecords(app, siteId, scope);
}
