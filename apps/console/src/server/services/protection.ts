import type { PlatformProtectionModel, SiteProtectionModel } from "@edgeweir/config-compiler";
import {
  CC_TEMPLATE_DEFAULTS,
  type CcThresholds,
  CHALLENGE_PROVIDER_SECRETS,
  CHALLENGE_TEXT_DEFAULTS,
  type ChallengeText,
  ccTemplate,
  challengeText,
  FAILURE_BAN_DEFAULTS,
  type FailureBan,
  failureBan,
  type InteractiveProviderChoice,
  PROTECTION_SETTINGS_DEFAULTS,
  type ProtectionSettings,
  type ProtectionSettingsInput,
  type ProtectionSettingsView,
  protectionSettings,
  type SiteCcPolicy,
  type SiteProtection,
  type SiteProtectionUpdateInput,
  siteCcPolicy,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { lockCcTemplate, lockProtectionSettings } from "../lib/locks";
import type { Actor } from "./audit";
import { noteOperatorUnderAttack } from "./auto-mitigation";
import {
  auditedProvider,
  loadInteractiveProviders,
  providerRow,
  providerView,
  saveProvider,
} from "./challenge-providers";
import { type Executor, publishClusters } from "./revisions";
import { defineSetting } from "./settings";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

/** system_setting keys. */
const PROTECTION_SETTINGS_KEY = "protection_settings";
const CC_TEMPLATE_KEY = "cc_template";

type ProtectionRow = typeof schema.siteProtection.$inferSelect;

const protectionSetting = defineSetting({
  key: PROTECTION_SETTINGS_KEY,
  schema: protectionSettings,
  defaults: PROTECTION_SETTINGS_DEFAULTS,
  auditAction: "system.protection_update",
});

const ccTemplateSetting = defineSetting({
  key: CC_TEMPLATE_KEY,
  schema: ccTemplate,
  defaults: CC_TEMPLATE_DEFAULTS,
  auditAction: "system.cc_template_update",
});

export const getProtectionSettings = protectionSetting.read;

export const getCcTemplate = ccTemplateSetting.read;

/** Platform Under Attack as compiled into every cluster's configuration. */
export async function loadPlatformProtection(db: Executor): Promise<PlatformProtectionModel> {
  const settings = await getProtectionSettings(db);
  return {
    underAttack: settings.underAttack,
    underAttackChallenge: settings.underAttackChallenge,
  };
}

/**
 * A site's CC policy: off and following the template until first saved.
 * While it follows the template, its thresholds are the template's.
 */
function savedCc(row: ProtectionRow | undefined, template: CcThresholds): SiteCcPolicy {
  const parsed = siteCcPolicy.safeParse({
    enabled: false,
    followTemplate: true,
    ...template,
    ...(row?.cc ?? {}),
  });
  const cc = parsed.success ? parsed.data : { enabled: false, followTemplate: true, ...template };
  return cc.followTemplate ? { ...cc, ...template } : cc;
}

/** The thresholds nodes use: null while off, the template while following it. */
function effectiveCc(cc: SiteCcPolicy, template: CcThresholds): CcThresholds | null {
  if (!cc.enabled) return null;
  if (cc.followTemplate) return { ...template };
  const { enabled: _enabled, followTemplate: _follow, ...thresholds } = cc;
  return thresholds;
}

/** A site's challenge page texts (empty: the built-in text). */
function savedText(row: ProtectionRow | undefined): ChallengeText {
  const parsed = challengeText.safeParse({
    ...CHALLENGE_TEXT_DEFAULTS,
    ...(row?.challengeText ?? {}),
  });
  return parsed.success ? parsed.data : { ...CHALLENGE_TEXT_DEFAULTS };
}

/** A site's challenge failure ban as saved (off with the defaults until set). */
function savedFailureBan(row: ProtectionRow | undefined): FailureBan {
  const parsed = failureBan.safeParse({
    enabled: row?.failureBanEnabled ?? false,
    threshold: row?.failureThreshold ?? FAILURE_BAN_DEFAULTS.threshold,
    banSeconds: row?.failureBanSeconds ?? FAILURE_BAN_DEFAULTS.banSeconds,
  });
  return parsed.success ? parsed.data : { enabled: false, ...FAILURE_BAN_DEFAULTS };
}

/** Which interactive provider a site uses (global until chosen). */
function providerChoice(row: ProtectionRow | undefined): InteractiveProviderChoice {
  const choice = row?.interactiveProvider;
  return choice === "builtin" || choice === "site" ? choice : "global";
}

function protectionModel(
  row: ProtectionRow | undefined,
  template: CcThresholds,
): SiteProtectionModel {
  const failure = savedFailureBan(row);
  return {
    underAttack: row?.underAttack ?? false,
    underAttackChallenge: row?.underAttackChallenge ?? "js",
    passTtlSeconds: row?.passTtlSeconds ?? 1800,
    powDifficulty: row?.powDifficulty ?? 16,
    powHighDifficulty: row?.powHighDifficulty ?? 20,
    cc: effectiveCc(savedCc(row, template), template),
    logJa4: row?.logJa4 ?? false,
    allowVerifiedBots: row?.allowVerifiedBots ?? false,
    challengeText: savedText(row),
    failureBan: failure.enabled
      ? { threshold: failure.threshold, banSeconds: failure.banSeconds }
      : null,
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
  const providers = await loadInteractiveProviders(
    db,
    new Map(siteIds.map((id) => [id, providerChoice(rows.find((row) => row.siteId === id))])),
  );
  return new Map(
    siteIds.map((id) => {
      const model = protectionModel(
        rows.find((row) => row.siteId === id),
        template,
      );
      const interactive = providers.get(id);
      return [id, interactive ? { ...model, interactive } : model];
    }),
  );
}

interface ProviderViews {
  provider: SiteProtection["provider"];
  globalProvider: SiteProtection["globalProvider"];
}

async function providerViews(db: Executor, siteId: string): Promise<ProviderViews> {
  return {
    provider: providerView(await providerRow(db, siteId)),
    globalProvider: providerView(await providerRow(db, null)),
  };
}

function toDto(
  siteId: string,
  row: ProtectionRow | undefined,
  template: CcThresholds,
  platform: ProtectionSettings,
  providers: ProviderViews,
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
    ccTemplate: template,
    effectiveCc: effectiveCc(cc, template),
    logJa4: row?.logJa4 ?? false,
    allowVerifiedBots: row?.allowVerifiedBots ?? false,
    challengeText: savedText(row),
    failureBan: savedFailureBan(row),
    interactiveProvider: providerChoice(row),
    ...providers,
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

export async function getSiteProtection(db: Database, siteId: string): Promise<SiteProtection> {
  await findSite(db, siteId);
  return toDto(
    siteId,
    await protectionRow(db, siteId),
    await getCcTemplate(db),
    await getProtectionSettings(db),
    await providerViews(db, siteId),
  );
}

/**
 * Changes the fields given, publishes the site's cluster and audits the
 * change. Turning on a feature the cluster's
 * active nodes lack fails with NODE_CAPABILITY_REQUIRED, like GeoIP fields.
 */
export async function updateSiteProtection(
  db: Database,
  input: SiteProtectionUpdateInput,
  ctx: { actor: Actor; masterKey?: MasterKey },
): Promise<SiteProtection> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    const template = await getCcTemplate(tx);
    const row = await protectionRow(tx, site.id, true);
    const providersBefore = await providerViews(tx, site.id);
    const before = toDto(site.id, row, template, PROTECTION_SETTINGS_DEFAULTS, providersBefore);
    const next = {
      underAttack: input.underAttack ?? before.underAttack,
      underAttackChallenge: input.underAttackChallenge ?? before.underAttackChallenge,
      passTtlSeconds: input.passTtlSeconds ?? before.passTtlSeconds,
      powDifficulty: input.powDifficulty ?? before.powDifficulty,
      powHighDifficulty: input.powHighDifficulty ?? before.powHighDifficulty,
      cc: input.cc || row?.cc ? { ...before.cc, ...(input.cc ?? {}) } : null,
      logJa4: input.logJa4 ?? before.logJa4,
      allowVerifiedBots: input.allowVerifiedBots ?? before.allowVerifiedBots,
      challengeText: input.challengeText ?? before.challengeText,
      failureBanEnabled: (input.failureBan ?? before.failureBan).enabled,
      failureThreshold: (input.failureBan ?? before.failureBan).threshold,
      failureBanSeconds: (input.failureBan ?? before.failureBan).banSeconds,
      interactiveProvider: input.interactiveProvider ?? before.interactiveProvider,
    };
    const provider = input.provider
      ? await saveProvider(tx, ctx.masterKey, site.id, input.provider)
      : providersBefore.provider;
    if (next.interactiveProvider === "site" && provider.kind !== "builtin" && !provider.secretSet)
      fail("CHALLENGE_PROVIDER_SECRET_REQUIRED", "the site's provider has no secret", {
        fields: CHALLENGE_PROVIDER_SECRETS[provider.kind].join(", "),
      });
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
    // The operator saved the switch: an automatic mitigation holding it lets go.
    if (input.underAttack !== undefined)
      await noteOperatorUnderAttack(tx, site.id, next.underAttack);
    const after = toDto(site.id, saved, template, PROTECTION_SETTINGS_DEFAULTS, {
      provider,
      globalProvider: providersBefore.globalProvider,
    });
    const strip = ({
      siteId: _s,
      platformUnderAttack: _p,
      updatedAt: _u,
      ccTemplate: _t,
      globalProvider: _g,
      provider: p,
      ...rest
    }: SiteProtection) => ({ ...rest, provider: auditedProvider(p) });
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_protection_updated",
      action: "site.protection_update",
      metadata: { from: strip(before), to: strip(after) },
    });
    return { ...after, platformUnderAttack: (await getProtectionSettings(tx)).underAttack };
  });
}

/** The platform protection with the global interactive provider. */
export async function getProtectionSettingsView(db: Executor): Promise<ProtectionSettingsView> {
  return {
    ...(await getProtectionSettings(db)),
    provider: providerView(await providerRow(db, null)),
  };
}

/**
 * Saves the platform protection. A change of Under Attack publishes every
 * cluster and may require challenge-v1 across clusters (the capability gate
 * of platform rules); a new global interactive provider publishes the clusters
 * with sites that use it.
 */
export async function setProtectionSettings(
  db: Database,
  input: ProtectionSettingsInput,
  actor: Actor,
  masterKey?: MasterKey,
): Promise<ProtectionSettingsView> {
  return db.transaction(async (tx) => {
    await lockProtectionSettings(tx);
    const before = await getProtectionSettings(tx);
    const { provider: providerInput, ...settings } = input;
    const providerBefore = providerView(await providerRow(tx, null, true));
    const provider = providerInput
      ? await saveProvider(tx, masterKey, null, providerInput)
      : providerBefore;
    const providerChanged =
      JSON.stringify(auditedProvider(provider)) !==
        JSON.stringify(auditedProvider(providerBefore)) ||
      provider.updatedAt !== providerBefore.updatedAt;
    const saved = await protectionSetting.write(tx, actor, settings as ProtectionSettings, {
      before,
      afterWrite: async () => {
        const all =
          before.underAttack !== settings.underAttack ||
          (settings.underAttack && before.underAttackChallenge !== settings.underAttackChallenge);
        const clusters = all
          ? await tx.select({ id: schema.cluster.id }).from(schema.cluster)
          : providerChanged
            ? await tx
                .selectDistinct({ id: schema.site.clusterId })
                .from(schema.site)
                .leftJoin(schema.siteProtection, eq(schema.siteProtection.siteId, schema.site.id))
                .where(
                  sql`coalesce(${schema.siteProtection.interactiveProvider}, 'global') = 'global'`,
                )
            : [];
        if (clusters.length)
          await publishClusters(
            tx,
            clusters.map((c) => c.id),
            {
              reason: { code: "platform_protection_updated", params: {} },
              actor,
            },
          );
        return providerChanged
          ? { provider: { from: auditedProvider(providerBefore), to: auditedProvider(provider) } }
          : {};
      },
    });
    return { ...saved, provider };
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
    await lockCcTemplate(tx);
    const before = await getCcTemplate(tx);
    return ccTemplateSetting.write(tx, actor, input, {
      before,
      afterWrite: async () => {
        const clusters = await tx
          .selectDistinct({ id: schema.site.clusterId })
          .from(schema.siteProtection)
          .innerJoin(schema.site, eq(schema.site.id, schema.siteProtection.siteId))
          .where(
            and(
              sql`(${schema.siteProtection.cc} ->> 'enabled')::boolean`,
              sql`coalesce((${schema.siteProtection.cc} ->> 'followTemplate')::boolean, true)`,
            ),
          );
        await publishClusters(
          tx,
          clusters.map((c) => c.id),
          { reason: { code: "cc_template_updated", params: {} }, actor },
        );
      },
    });
  });
}
