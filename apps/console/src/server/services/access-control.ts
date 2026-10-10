import {
  ACCESS_CONTROL_PARTS,
  type AccessControlPart,
  type AccessControlSettings,
  type Cidr,
  cidrContains,
  formatIp,
  type IpAddress,
  type IpCheckInput,
  type IpCheckResult,
  parseCidr,
  parseIp,
  type SiteAccessControl,
  type SiteAccessControlUpdate,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq } from "drizzle-orm";
import { readAccessControl } from "../lib/access-control";
import { fail } from "../lib/errors";
import { lockIpLists } from "../lib/locks";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { listBans } from "./bans";
import { clientIpOf } from "./edge";
import { clusterEdgeAddresses } from "./node-addresses";
import { type Executor, publishRevision } from "./revisions";
import { findSite } from "./sites";

type SiteRow = typeof schema.site.$inferSelect;

function toDto(site: SiteRow): SiteAccessControl {
  return {
    siteId: site.id,
    ...readAccessControl(site),
    updatedAt: site.accessControlUpdatedAt?.toISOString() ?? null,
  };
}

export async function getAccessControl(db: Database, siteId: string): Promise<SiteAccessControl> {
  return toDto(await findSite(db, siteId));
}

/** What the audit log keeps of a part: switches and counts, never the lists themselves. */
function summary(part: AccessControlPart, s: AccessControlSettings) {
  switch (part) {
    case "siteLists":
      return {
        blockLists: s.siteLists.blockListIds.length,
        allowLists: s.siteLists.allowListIds.length,
      };
    case "hotlink":
      return {
        enabled: s.hotlink.enabled,
        allowEmpty: s.hotlink.allowEmpty,
        allowSiteDomains: s.hotlink.allowSiteDomains,
        allowed: s.hotlink.allowed.length,
        denied: s.hotlink.denied.length,
        action: s.hotlink.action,
      };
    case "userAgents":
      return {
        allow: s.userAgents.rules.filter((r) => r.action === "allow").length,
        deny: s.userAgents.rules.filter((r) => r.action === "deny").length,
      };
    case "cors":
      return {
        enabled: s.cors.enabled,
        origins: s.cors.allowedOrigins.length,
        allowCredentials: s.cors.allowCredentials,
        preflightToOrigin: s.cors.preflightToOrigin,
      };
    case "geo":
      return {
        enabled: s.geo.enabled,
        mode: s.geo.mode,
        countries: s.geo.countries.length,
        subdivisions: s.geo.subdivisions.length,
        asns: s.geo.asns.length,
      };
    case "websocket":
      return {
        allowAllOrigins: s.websocket.allowAllOrigins,
        origins: s.websocket.origins.length,
        idleTimeoutSeconds: s.websocket.idleTimeoutSeconds,
      };
    case "securityHeaders":
      return {
        ...s.securityHeaders,
        permissionsPolicy: s.securityHeaders.permissionsPolicy !== "",
      };
  }
}

/**
 * Saves the parts of a site's access control present in the input (the
 * others stay), publishes its cluster (a hot update; access-control-v1 when
 * any part is on) and audits which parts changed. The site lists must be
 * existing IP lists, none on both sides (SITE_LIST_CONFLICT); CORS with
 * credentials cannot allow "*" (CORS_CREDENTIALS_WILDCARD).
 */
export async function updateAccessControl(
  db: Database,
  input: SiteAccessControlUpdate,
  ctx: { actor: Actor },
): Promise<SiteAccessControl> {
  if (input.cors?.allowCredentials && input.cors.allowedOrigins.includes("*"))
    fail("CORS_CREDENTIALS_WILDCARD", "CORS with credentials cannot allow every origin");
  return db.transaction(async (tx) => {
    // Before the site row, like IP list writers (deleting a list reads its users).
    await lockIpLists(tx);
    const site = await findSite(tx, input.id, true);
    if (input.expectedUpdatedAt !== undefined) {
      if (!site.accessControlUpdatedAt)
        fail("UPDATED_AT_MISMATCH", "the access control changed since it was read", {
          updatedAt: "",
        });
      assertUpdatedAt(site.accessControlUpdatedAt, input.expectedUpdatedAt);
    }
    const before = readAccessControl(site);
    const after: AccessControlSettings = { ...before };
    const changed: AccessControlPart[] = [];
    for (const part of ACCESS_CONTROL_PARTS) {
      const value = input[part];
      if (value === undefined) continue;
      (after as Record<AccessControlPart, unknown>)[part] = value;
      if (JSON.stringify(value) !== JSON.stringify(before[part])) changed.push(part);
    }
    if (input.siteLists) await checkSiteLists(tx, input.siteLists);
    const updatedAt = new Date(
      Math.max(Date.now(), (site.accessControlUpdatedAt?.getTime() ?? 0) + 1),
    );
    const { siteLists, ...stored } = after;
    const [updated] = await tx
      .update(schema.site)
      .set({
        accessControl: stored,
        blockListIds: siteLists.blockListIds,
        allowListIds: siteLists.allowListIds,
        accessControlUpdatedAt: updatedAt,
      })
      .where(eq(schema.site.id, site.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_access_control_updated", params: { site: site.name } },
      actor: ctx.actor,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.access_control_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: {
        parts: changed,
        from: Object.fromEntries(changed.map((p) => [p, summary(p, before)])),
        to: Object.fromEntries(changed.map((p) => [p, summary(p, after)])),
        revision: revision.revision,
      },
    });
    return toDto(updated);
  });
}

export async function checkSiteLists(tx: Executor, lists: AccessControlSettings["siteLists"]) {
  const ids = [...lists.blockListIds, ...lists.allowListIds];
  if (!ids.length) return;
  const rows = await tx
    .select({ id: schema.ipList.id, name: schema.ipList.name })
    .from(schema.ipList);
  const names = new Map(rows.map((row) => [row.id, row.name]));
  if (ids.some((id) => !names.has(id))) fail("IP_LIST_NOT_FOUND", "IP list not found");
  const both = lists.blockListIds.filter((id) => lists.allowListIds.includes(id));
  if (both.length) {
    const listNames = both.map((id) => names.get(id) ?? id).join(", ");
    fail("SITE_LIST_CONFLICT", `IP lists on both sides: ${listNames}`, { lists: listNames });
  }
}

const MAPPED_V4 = parseCidr("::ffff:0:0/96") as Cidr;

/** The address as nodes read it: an IPv4-mapped IPv6 address is the IPv4 address. */
function nodeAddress(ip: IpAddress): IpAddress {
  return ip.version === 6 && cidrContains(MAPPED_V4, ip)
    ? { version: 4, bytes: ip.bytes.slice(12) }
    : ip;
}

const contains = (entry: string, ip: IpAddress) => {
  const cidr = parseCidr(entry);
  return cidr !== null && cidrContains(cidr, ip);
};

/**
 * What the console knows about an address: the IP lists containing it, the
 * active bans covering it, each cluster's client address view of it, and
 * for a site the first list or ban step of the edge that decides
 * (ADR-0039 section 10). No GeoIP.
 */
export async function ipCheck(db: Database, input: IpCheckInput): Promise<IpCheckResult> {
  const parsed = input.ip.includes("/") ? null : parseIp(input.ip);
  if (!parsed) fail("IP_ADDRESS_INVALID", "not an IP address");
  const ip = nodeAddress(parsed);
  const text = formatIp(ip);
  const site = input.siteId ? await findSite(db, input.siteId) : null;
  const settings = site ? readAccessControl(site) : null;
  const lists = (await db.select().from(schema.ipList).orderBy(asc(schema.ipList.name)))
    .map((list) => ({
      id: list.id,
      name: list.name,
      kind: list.kind as "collection" | "allow" | "block",
      entries: list.entries.filter((entry) => contains(entry, ip)),
      siteRole: settings?.siteLists.blockListIds.includes(list.id)
        ? ("block" as const)
        : settings?.siteLists.allowListIds.includes(list.id)
          ? ("allow" as const)
          : null,
    }))
    .filter((list) => list.entries.length > 0);
  const bans = (await listBans(db, { address: text, page: 1, pageSize: 100 })).items.filter(
    (ban) => !site || ban.scope === "platform" || ban.siteId === site.id,
  );
  const clusterRows = await db
    .select()
    .from(schema.cluster)
    .where(site ? eq(schema.cluster.id, site.clusterId) : undefined)
    .orderBy(asc(schema.cluster.name));
  const clusters = await Promise.all(
    clusterRows.map(async (cluster) => {
      const clientIp = clientIpOf(cluster);
      return {
        id: cluster.id,
        name: cluster.name,
        clientIp: clientIp.mode,
        trustedProxy:
          clientIp.mode === "header" && clientIp.trustedCidrs.some((cidr) => contains(cidr, ip)),
        nodeAddress: (await clusterEdgeAddresses(db, cluster.id)).known.has(text),
      };
    }),
  );
  let verdict: IpCheckResult["verdict"] = null;
  if (site) {
    const platformAllowed = lists.some((list) => list.kind === "allow");
    const siteAllowed = lists.some((list) => list.siteRole === "allow");
    const trusted = clusters.some((c) => c.trustedProxy);
    const banExempt = platformAllowed || trusted;
    const outcome =
      !banExempt && bans.some((ban) => ban.scope === "platform")
        ? "platform_banned"
        : !banExempt && !siteAllowed && bans.some((ban) => ban.scope === "site")
          ? "site_banned"
          : !platformAllowed && lists.some((list) => list.kind === "block")
            ? "platform_blocked"
            : !platformAllowed && !siteAllowed && lists.some((list) => list.siteRole === "block")
              ? "site_blocked"
              : platformAllowed || siteAllowed
                ? "allowed"
                : "none";
    verdict = { outcome, platformAllowed, siteAllowed };
  }
  return {
    ip: text,
    site: site ? { id: site.id, name: site.name } : null,
    lists,
    bans,
    clusters,
    verdict,
  };
}
