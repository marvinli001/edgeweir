import type { PlatformProtectionModel, SiteProtectionModel } from "@edgeweir/config-compiler";
import {
  CC_TEMPLATE_DEFAULTS,
  type CcThresholds,
  ccTemplate,
  PROTECTION_SETTINGS_DEFAULTS,
  type ProtectionSettings,
  protectionSettings,
  type SiteCcPolicy,
  type SiteProtection,
  type SiteProtectionUpdateInput,
  siteCcPolicy,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { type Executor, publishRevision } from "./revisions";
import { findSite, type SiteScope } from "./sites";

/** system_setting keys. */
export const PROTECTION_SETTINGS_KEY = "protection_settings";
export const CC_TEMPLATE_KEY = "cc_template";

type ProtectionRow = typeof schema.siteProtection.$inferSelect;

/** The user whose role decides the capability gate of a publish (see insertRevision). */
const publisher = (actor: Actor) =>
  actor.type === "user" || actor.type === "api_key" ? actor.id : null;

async function readSetting(db: Executor, key: string) {
  const [row] = await db
    .select({ value: schema.systemSetting.value })
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, key));
  return row?.value;
}

async function writeSetting(db: Executor, key: string, value: Record<string, unknown>) {
  await db
    .insert(schema.systemSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
}

export async function getProtectionSettings(db: Executor): Promise<ProtectionSettings> {
  const parsed = protectionSettings.safeParse({
    ...PROTECTION_SETTINGS_DEFAULTS,
    ...((await readSetting(db, PROTECTION_SETTINGS_KEY)) ?? {}),
  });
  return parsed.success ? parsed.data : PROTECTION_SETTINGS_DEFAULTS;
}

export async function getCcTemplate(db: Executor): Promise<CcThresholds> {
  const parsed = ccTemplate.safeParse({
    ...CC_TEMPLATE_DEFAULTS,
    ...((await readSetting(db, CC_TEMPLATE_KEY)) ?? {}),
  });
  return parsed.success ? parsed.data : CC_TEMPLATE_DEFAULTS;
}

/** Platform Under Attack as compiled into every cluster's configuration. */
export async function loadPlatformProtection(db: Executor): Promise<PlatformProtectionModel> {
  const settings = await getProtectionSettings(db);
  return {
    underAttack: settings.underAttack,
    underAttackChallenge: settings.underAttackChallenge,
  };
}

/** A site's saved CC policy: off and following the template until first saved. */
function savedCc(row: ProtectionRow | undefined, template: CcThresholds): SiteCcPolicy {
  const parsed = siteCcPolicy.safeParse({
    enabled: false,
    followTemplate: true,
    ...template,
    ...(row?.cc ?? {}),
  });
  return parsed.success ? parsed.data : { enabled: false, followTemplate: true, ...template };
}

/** The thresholds nodes use: null while off, the template while following it. */
export function effectiveCc(cc: SiteCcPolicy, template: CcThresholds): CcThresholds | null {
  if (!cc.enabled) return null;
  if (cc.followTemplate) return { ...template };
  const { enabled: _enabled, followTemplate: _follow, ...thresholds } = cc;
  return thresholds;
}

function protectionModel(
  row: ProtectionRow | undefined,
  template: CcThresholds,
): SiteProtectionModel {
  return {
    underAttack: row?.underAttack ?? false,
    underAttackChallenge: row?.underAttackChallenge ?? "js",
    passTtlSeconds: row?.passTtlSeconds ?? 1800,
    powDifficulty: row?.powDifficulty ?? 16,
    powHighDifficulty: row?.powHighDifficulty ?? 20,
    cc: effectiveCc(savedCc(row, template), template),
    logJa4: row?.logJa4 ?? false,
  };
}

/** Compiler models of the sites' protection (defaults for sites without a row). */
export async function loadSiteProtectionModels(
  db: Executor,
  siteIds: string[],
): Promise<Map<string, SiteProtectionModel>> {
  const rows = siteIds.length
    ? await db
        .select()
        .from(schema.siteProtection)
        .where(inArray(schema.siteProtection.siteId, siteIds))
    : [];
  const template = rows.some((row) => row.cc?.enabled)
    ? await getCcTemplate(db)
    : CC_TEMPLATE_DEFAULTS;
  return new Map(
    siteIds.map((id) => [
      id,
      protectionModel(
        rows.find((row) => row.siteId === id),
        template,
      ),
    ]),
  );
}

function toDto(
  siteId: string,
  row: ProtectionRow | undefined,
  template: CcThresholds,
  platform: ProtectionSettings,
): SiteProtection {
  const cc = savedCc(row, template);
  return {
    siteId,
    underAttack: row?.underAttack ?? false,
    underAttackChallenge: (row?.underAttackChallenge ??
      "js") as SiteProtection["underAttackChallenge"],
    passTtlSeconds: row?.passTtlSeconds ?? 1800,
    powDifficulty: row?.powDifficulty ?? 16,
    powHighDifficulty: row?.powHighDifficulty ?? 20,
    cc,
    effectiveCc: effectiveCc(cc, template),
    logJa4: row?.logJa4 ?? false,
    platformUnderAttack: platform.underAttack,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

async function protectionRow(db: Executor, siteId: string, lock = false) {
  const query = db
    .select()
    .from(schema.siteProtection)
    .where(eq(schema.siteProtection.siteId, siteId));
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

export async function getSiteProtection(
  db: Database,
  siteId: string,
  scope: SiteScope,
): Promise<SiteProtection> {
  await findSite(db, siteId, scope);
  return toDto(
    siteId,
    await protectionRow(db, siteId),
    await getCcTemplate(db),
    await getProtectionSettings(db),
  );
}

/**
 * Changes the fields given (organization owners and admins), publishes the
 * site's cluster and audits the change. Turning on a feature the cluster's
 * active nodes lack fails with NODE_CAPABILITY_REQUIRED, like GeoIP fields.
 */
export async function updateSiteProtection(
  db: Database,
  input: SiteProtectionUpdateInput,
  ctx: { scope: SiteScope; actor: Actor },
): Promise<SiteProtection> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, ctx.scope, true);
    const template = await getCcTemplate(tx);
    const row = await protectionRow(tx, site.id, true);
    const before = toDto(site.id, row, template, PROTECTION_SETTINGS_DEFAULTS);
    const next = {
      underAttack: input.underAttack ?? before.underAttack,
      underAttackChallenge: input.underAttackChallenge ?? before.underAttackChallenge,
      passTtlSeconds: input.passTtlSeconds ?? before.passTtlSeconds,
      powDifficulty: input.powDifficulty ?? before.powDifficulty,
      powHighDifficulty: input.powHighDifficulty ?? before.powHighDifficulty,
      cc: input.cc || row?.cc ? { ...before.cc, ...(input.cc ?? {}) } : null,
      logJa4: input.logJa4 ?? before.logJa4,
    };
    if (next.powHighDifficulty < next.powDifficulty)
      fail(
        "PROTECTION_POW_DIFFICULTY",
        `the high proof-of-work difficulty must be at least ${next.powDifficulty}`,
        { min: next.powDifficulty },
      );
    const [saved] = await tx
      .insert(schema.siteProtection)
      .values({ siteId: site.id, ...next })
      .onConflictDoUpdate({
        target: schema.siteProtection.siteId,
        set: { ...next, updatedAt: new Date() },
      })
      .returning();
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_protection_updated", params: { site: site.name } },
      userId: publisher(ctx.actor),
    });
    const after = toDto(site.id, saved, template, PROTECTION_SETTINGS_DEFAULTS);
    const strip = ({
      siteId: _s,
      platformUnderAttack: _p,
      updatedAt: _u,
      ...rest
    }: SiteProtection) => rest;
    await recordAudit(tx, ctx.actor, {
      action: "site.protection_update",
      organizationId: site.organizationId,
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { from: strip(before), to: strip(after) },
    });
    return { ...after, platformUnderAttack: (await getProtectionSettings(tx)).underAttack };
  });
}

/** Every cluster, in id order (publishing order is the lock order). */
async function allClusters(tx: Executor) {
  return tx.select({ id: schema.cluster.id }).from(schema.cluster).orderBy(schema.cluster.id);
}

/**
 * Saves the platform protection. A change of Under Attack publishes every
 * cluster; administrators may require challenge-v1 across clusters (the
 * capability gate of platform rules).
 */
export async function setProtectionSettings(
  db: Database,
  input: ProtectionSettings,
  actor: Actor,
): Promise<ProtectionSettings> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.protection-settings'))`);
    const before = await getProtectionSettings(tx);
    await writeSetting(tx, PROTECTION_SETTINGS_KEY, input);
    if (
      before.underAttack !== input.underAttack ||
      (input.underAttack && before.underAttackChallenge !== input.underAttackChallenge)
    )
      for (const cluster of await allClusters(tx))
        await publishRevision(tx, {
          clusterId: cluster.id,
          reason: { code: "platform_protection_updated", params: {} },
          userId: publisher(actor),
        });
    await recordAudit(tx, actor, {
      action: "system.protection_update",
      targetType: "system_setting",
      targetId: PROTECTION_SETTINGS_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
}

/**
 * Saves the CC template and publishes the clusters with sites whose enabled
 * CC policy follows it.
 */
export async function setCcTemplate(
  db: Database,
  input: CcThresholds,
  actor: Actor,
): Promise<CcThresholds> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.cc-template'))`);
    const before = await getCcTemplate(tx);
    await writeSetting(tx, CC_TEMPLATE_KEY, input);
    const clusters = await tx
      .selectDistinct({ id: schema.site.clusterId })
      .from(schema.siteProtection)
      .innerJoin(schema.site, eq(schema.site.id, schema.siteProtection.siteId))
      .where(
        and(
          sql`(${schema.siteProtection.cc} ->> 'enabled')::boolean`,
          sql`coalesce((${schema.siteProtection.cc} ->> 'followTemplate')::boolean, true)`,
        ),
      )
      .orderBy(schema.site.clusterId);
    for (const cluster of clusters)
      await publishRevision(tx, {
        clusterId: cluster.id,
        reason: { code: "cc_template_updated", params: {} },
        userId: publisher(actor),
      });
    await recordAudit(tx, actor, {
      action: "system.cc_template_update",
      targetType: "system_setting",
      targetId: CC_TEMPLATE_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
}
