import {
  type LandingPage,
  type LandingSettings,
  type LandingStats,
  landingSettings,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { type Actor, recordAudit } from "./audit";
import { ONLINE_WINDOW_SECONDS } from "./nodes";
import type { Executor } from "./revisions";

const LANDING_KEY = "landing";

export const defaultLandingSettings: LandingSettings = {
  template: "none",
  brandName: "Edgeweir",
  headline: "",
  description: "",
  contactEmail: "",
  signupUrl: "",
  icp: "",
  showStats: false,
};

/** Stored settings over the defaults; a field that no longer validates falls back to its default. */
export async function getLandingSettings(db: Executor): Promise<LandingSettings> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, LANDING_KEY));
  const stored = row?.value ?? {};
  const settings = { ...defaultLandingSettings };
  for (const key of Object.keys(settings) as (keyof LandingSettings)[]) {
    const parsed = landingSettings.shape[key].safeParse(stored[key]);
    if (parsed.success) Object.assign(settings, { [key]: parsed.data });
  }
  return settings;
}

export async function updateLandingSettings(
  db: Executor,
  input: LandingSettings,
  actor: Actor,
): Promise<LandingSettings> {
  const before = await getLandingSettings(db);
  const value = input as unknown as Record<string, unknown>;
  await db
    .insert(schema.systemSetting)
    .values({ key: LANDING_KEY, value })
    .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
  cache.delete(db);
  const changed = (Object.keys(input) as (keyof LandingSettings)[]).filter(
    (key) => input[key] !== before[key],
  );
  await recordAudit(db, actor, {
    action: "system.landing_update",
    targetType: "system_setting",
    targetId: LANDING_KEY,
    targetName: input.brandName,
    metadata: { template: input.template, changed },
  });
  return getLandingSettings(db);
}

/** Platform-wide numbers only; nothing that identifies a tenant or a node. */
export async function landingStats(db: Executor): Promise<LandingStats> {
  const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
  const [regions, [online], [sites], [domains]] = await Promise.all([
    db
      .select({ name: schema.region.name, code: schema.region.code })
      .from(schema.region)
      .orderBy(asc(schema.region.name)),
    db
      .select({ n: count() })
      .from(schema.node)
      .where(and(gt(schema.node.lastSeenAt, since), eq(schema.node.status, "active"))),
    db.select({ n: count() }).from(schema.site).where(eq(schema.site.enabled, true)),
    db
      .select({ n: count() })
      .from(schema.siteDomain)
      .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
      .where(eq(schema.site.enabled, true)),
  ]);
  return {
    regions,
    onlineNodes: online?.n ?? 0,
    sites: sites?.n ?? 0,
    domains: domains?.n ?? 0,
  };
}

const CACHE_MS = 10_000;
const cache = new WeakMap<Executor, { at: number; page: Promise<LandingPage> }>();

/**
 * The public page, cached briefly per database: it is unauthenticated and runs
 * a few counts. Updates through this process clear it; other instances catch
 * up within CACHE_MS.
 */
export function getLandingPage(db: Executor): Promise<LandingPage> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const page = (async () => {
    const settings = await getLandingSettings(db);
    const stats =
      settings.template !== "none" && settings.showStats ? await landingStats(db) : null;
    return { settings, stats };
  })();
  cache.set(db, { at: Date.now(), page });
  page.catch(() => cache.delete(db));
  return page;
}
