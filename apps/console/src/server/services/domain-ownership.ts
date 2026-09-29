import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { DomainOwnership } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { domainRoot } from "../lib/domain-root";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { resolverAddresses } from "./dns-resolvers";
import { type Executor, publishRevision, type Tx } from "./revisions";
import { findSite, type SiteScope } from "./sites";

const TXT_PREFIX = "_edgeweir-verification.";
type Proof = typeof schema.domainOwnership.$inferSelect;
const dto = (domain: string, proof?: Proof): DomainOwnership => ({
  domain,
  verified: !!proof?.verifiedAt,
  method: proof?.method === "admin" ? "admin" : "dns",
  txtName: TXT_PREFIX + domain,
  txtValue: proof ? `edgeweir=${proof.token}` : null,
  verifiedAt: proof?.verifiedAt?.toISOString() ?? null,
});
async function lockRoot(tx: Tx, domain: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.domain.${domain}`}))`);
}
async function assertOwnerAvailable(tx: Executor, organizationId: string, domain: string) {
  const [owner] = await tx
    .select({ id: schema.domainOwnership.id })
    .from(schema.domainOwnership)
    .where(
      and(
        eq(schema.domainOwnership.domain, domain),
        isNotNull(schema.domainOwnership.verifiedAt),
        ne(schema.domainOwnership.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (owner) fail("DOMAIN_IN_USE", "domain belongs to another organization", { domains: domain });
}
export async function actorIsPlatformAdmin(db: Executor, actor: Actor) {
  if (actor.type !== "user") return false;
  const [user] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, actor.id));
  return user?.role === "admin";
}
/** Changes routing rights for this organization's matching root, across all its sites. */
async function markRoot(tx: Tx, organizationId: string, domain: string, verified: boolean) {
  const rows = await tx
    .select({
      id: schema.siteDomain.id,
      name: schema.siteDomain.name,
      verified: schema.siteDomain.verified,
      clusterId: schema.site.clusterId,
    })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(eq(schema.site.organizationId, organizationId));
  const changed = rows.filter(
    (row) => domainRoot(row.name) === domain && row.verified !== verified,
  );
  if (changed.length)
    await tx
      .update(schema.siteDomain)
      .set({ verified })
      .where(
        inArray(
          schema.siteDomain.id,
          changed.map((r) => r.id),
        ),
      );
  return [...new Set(changed.map((r) => r.clusterId))];
}
/** Creating a pending claim never reserves a domain against another pending claimant. */
export async function ensureDomainClaims(
  tx: Tx,
  organizationId: string,
  domains: { name: string }[],
  bypass: boolean,
  actor: Actor,
) {
  const roots = [...new Set(domains.map((d) => domainRoot(d.name)))].sort();
  const proofs: Proof[] = [];
  const changedClusters = new Set<string>();
  for (const domain of roots) {
    await lockRoot(tx, domain);
    await assertOwnerAvailable(tx, organizationId, domain);
    await tx
      .insert(schema.domainOwnership)
      .values({ organizationId, domain, token: randomBytes(32).toString("base64url") })
      .onConflictDoNothing();
    const [proof] = await tx
      .select()
      .from(schema.domainOwnership)
      .where(
        and(
          eq(schema.domainOwnership.organizationId, organizationId),
          eq(schema.domainOwnership.domain, domain),
        ),
      );
    if (!proof) throw new Error("domain claim missing");
    if (bypass && !proof.verifiedAt) {
      proof.verifiedAt = new Date();
      proof.method = "admin";
      await tx
        .update(schema.domainOwnership)
        .set({ verifiedAt: proof.verifiedAt, method: "admin" })
        .where(eq(schema.domainOwnership.id, proof.id));
      for (const cluster of await markRoot(tx, organizationId, domain, true))
        changedClusters.add(cluster);
      await recordAudit(tx, actor, {
        action: "domain.bypass",
        organizationId,
        targetType: "domain",
        targetId: proof.id,
        targetName: domain,
      });
    }
    proofs.push(proof);
  }
  return { proofs, changedClusters: [...changedClusters] };
}
async function rootsForSite(db: Executor, id: string, scope: SiteScope) {
  const site = await findSite(db, id, scope);
  const domains = await db
    .select({ name: schema.siteDomain.name })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, id));
  return { site, domains, roots: [...new Set(domains.map((d) => domainRoot(d.name)))].sort() };
}
export async function getDomainOwnership(app: AppContext, siteId: string, scope: SiteScope) {
  const { site, roots } = await rootsForSite(app.db, siteId, scope);
  const proofs = await app.db
    .select()
    .from(schema.domainOwnership)
    .where(eq(schema.domainOwnership.organizationId, site.organizationId));
  return roots.map((root) =>
    dto(
      root,
      proofs.find((p) => p.domain === root),
    ),
  );
}
export async function prepareDomainOwnership(
  app: AppContext,
  siteId: string,
  scope: SiteScope,
  actor: Actor,
  approvedDomain?: string,
) {
  await app.db.transaction(async (tx) => {
    const { site, domains, roots } = await rootsForSite(tx, siteId, scope);
    if (approvedDomain && !roots.includes(approvedDomain))
      fail("DOMAIN_PROOF_NOT_FOUND", "domain is outside this site");
    const { changedClusters } = await ensureDomainClaims(
      tx,
      site.organizationId,
      approvedDomain ? domains.filter((d) => domainRoot(d.name) === approvedDomain) : domains,
      !!approvedDomain && scope.all,
      actor,
    );
    for (const clusterId of changedClusters.sort())
      await publishRevision(tx, {
        clusterId,
        reason: { code: "domain_verified", params: {} },
        userId: actor.id,
      });
    await recordAudit(tx, actor, {
      action: "domain.prepare",
      organizationId: site.organizationId,
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
    });
  });
  return getDomainOwnership(app, siteId, scope);
}
let activeLookups = 0;
export async function verifyDomainOwnership(
  app: AppContext,
  siteId: string,
  domain: string,
  scope: SiteScope,
  actor: Actor,
) {
  const { site, roots } = await rootsForSite(app.db, siteId, scope);
  if (!roots.includes(domain)) fail("DOMAIN_PROOF_NOT_FOUND", "domain is outside this site");
  const [proof] = await app.db
    .select()
    .from(schema.domainOwnership)
    .where(
      and(
        eq(schema.domainOwnership.organizationId, site.organizationId),
        eq(schema.domainOwnership.domain, domain),
      ),
    );
  if (!proof) fail("DOMAIN_PROOF_NOT_FOUND", "prepare a domain challenge first");
  if (proof.verifiedAt) return dto(domain, proof);
  if (activeLookups >= 16) fail("DOMAIN_VERIFY_BUSY", "verification lookup limit reached");
  const checked = await app.db
    .update(schema.domainOwnership)
    .set({ lastCheckedAt: new Date() })
    .where(
      and(
        eq(schema.domainOwnership.id, proof.id),
        or(
          isNull(schema.domainOwnership.lastCheckedAt),
          lt(schema.domainOwnership.lastCheckedAt, new Date(Date.now() - 5000)),
        ),
      ),
    )
    .returning({ id: schema.domainOwnership.id });
  if (!checked.length) fail("DOMAIN_VERIFY_BUSY", "verification is rate limited");
  activeLookups++;
  let found = false;
  try {
    const resolver = new Resolver({ timeout: 2500, tries: 2 });
    const servers = await resolverAddresses(app);
    if (servers.length) resolver.setServers(servers);
    const records = await resolver.resolveTxt(TXT_PREFIX + domain);
    found = records.some((chunks) => chunks.join("") === `edgeweir=${proof.token}`);
  } catch {
  } finally {
    activeLookups--;
  }
  if (!found) fail("DOMAIN_VERIFY_FAILED", "TXT challenge not found");
  return app.db.transaction(async (tx) => {
    await lockRoot(tx, domain);
    await findSite(tx, siteId, scope);
    const [current] = await tx
      .select()
      .from(schema.domainOwnership)
      .where(eq(schema.domainOwnership.id, proof.id));
    if (!current || current.token !== proof.token)
      fail("DOMAIN_PROOF_NOT_FOUND", "verification challenge changed");
    await assertOwnerAvailable(tx, site.organizationId, domain);
    const [updated] = await tx
      .update(schema.domainOwnership)
      .set({ verifiedAt: new Date(), method: "dns" })
      .where(eq(schema.domainOwnership.id, proof.id))
      .returning();
    const clusters = await markRoot(tx, site.organizationId, domain, true);
    for (const clusterId of clusters.sort())
      await publishRevision(tx, {
        clusterId,
        reason: { code: "domain_verified", params: {} },
        userId: actor.id,
      });
    await recordAudit(tx, actor, {
      action: "domain.verify",
      organizationId: site.organizationId,
      targetType: "domain",
      targetId: proof.id,
      targetName: domain,
    });
    return dto(domain, updated);
  });
}
export async function revokeDomainOwnership(
  app: AppContext,
  siteId: string,
  domain: string,
  scope: SiteScope,
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    const { site, roots } = await rootsForSite(tx, siteId, scope);
    if (!roots.includes(domain)) fail("DOMAIN_PROOF_NOT_FOUND", "domain is outside this site");
    await lockRoot(tx, domain);
    const [proof] = await tx
      .delete(schema.domainOwnership)
      .where(
        and(
          eq(schema.domainOwnership.organizationId, site.organizationId),
          eq(schema.domainOwnership.domain, domain),
        ),
      )
      .returning();
    if (!proof) fail("DOMAIN_PROOF_NOT_FOUND", "domain verification not found");
    const clusters = await markRoot(tx, site.organizationId, domain, false);
    for (const clusterId of clusters.sort())
      await publishRevision(tx, {
        clusterId,
        reason: { code: "domain_revoked", params: {} },
        userId: actor.id,
      });
    await recordAudit(tx, actor, {
      action: "domain.revoke",
      organizationId: site.organizationId,
      targetType: "domain",
      targetId: proof.id,
      targetName: domain,
    });
    return { ok: true as const };
  });
}

export async function lockDomainRoots(tx: Tx, names: string[]) {
  for (const root of [...new Set(names.map(domainRoot))].sort()) await lockRoot(tx, root);
}
/** Release a root only after its final site reference is removed. Caller holds root locks. */
export async function releaseUnusedDomainClaims(tx: Tx, organizationId: string, names: string[]) {
  const rows = await tx
    .select({ name: schema.siteDomain.name })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(eq(schema.site.organizationId, organizationId));
  const used = new Set(rows.map((r) => domainRoot(r.name)));
  const unused = [...new Set(names.map(domainRoot))].filter((root) => !used.has(root));
  if (unused.length)
    await tx
      .delete(schema.domainOwnership)
      .where(
        and(
          eq(schema.domainOwnership.organizationId, organizationId),
          inArray(schema.domainOwnership.domain, unused),
        ),
      );
}

/** One-time migration gate: legacy, unproven routes must not remain live forever. */
export async function enforceDomainOwnershipOnce(app: AppContext) {
  return app.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('edgeweir.domain-policy-migration'))`,
    );
    const [done] = await tx
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, "domain_ownership_v1"));
    if (done) return;
    const clusters = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .orderBy(schema.cluster.id);
    for (const cluster of clusters)
      await publishRevision(tx, {
        clusterId: cluster.id,
        reason: { code: "domain_revoked", params: {} },
      });
    await tx
      .insert(schema.systemSetting)
      .values({ key: "domain_ownership_v1", value: { enabled: true } });
    await recordAudit(
      tx,
      { type: "system", id: "", name: "system" },
      {
        action: "domain.policy_enable",
        targetType: "system",
        metadata: { clusters: clusters.length },
      },
    );
  });
}
