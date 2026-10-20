import {
  type AutoMitigation,
  type AutoMitigationInput,
  type AutoMitigationSettings,
  autoMitigationLevel,
  type CcLevel,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq, isNotNull, or } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit, systemActor } from "./audit";
import { levelRank, siteCcLevel } from "./cc-level";
import { publishRevision, type Tx } from "./revisions";

type Row = typeof schema.siteAutoMitigation.$inferSelect;
type SiteRow = typeof schema.site.$inferSelect;
type Executor = Database | Tx;

const MINUTE = 60_000;

/**
 * ADR-0051. A site's automatic mitigation turns on its Under Attack when a node's CC level for
 * the site reaches the threshold, keeps it on for the duration after the level was last at the
 * threshold, then turns it off. It only lifts what it turned on itself: Under Attack the
 * operator turned on (before or while it holds) is never touched, and the operator turning it
 * off ends the hold and pauses it until the level is below the threshold again.
 */

/** The level is at or above the threshold (a threshold is never `normal`). */
const atThreshold = (level: CcLevel, threshold: string) =>
  levelRank(threshold) > 0 && levelRank(level) >= levelRank(threshold);

function toSettings(row: Row): AutoMitigationSettings {
  return {
    enabled: row.enabled,
    threshold: autoMitigationLevel.parse(row.threshold),
    durationMinutes: row.durationMinutes,
  };
}

/** The level that started the hold, as the DTO reports it (a stored value this version does not know reads as the threshold). */
const heldLevel = (row: Row): CcLevel =>
  levelRank(row.triggerLevel ?? "") > 0 ? (row.triggerLevel as CcLevel) : "pow";

async function toDto(
  db: Executor,
  site: { id: string; clusterId: string },
  row: Row | undefined,
  now = new Date(),
): Promise<AutoMitigation> {
  const level = await siteCcLevel(db, site, now.getTime());
  return {
    siteId: site.id,
    settings: row ? toSettings(row) : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    level,
    active:
      row?.activeSince && row.expiresAt
        ? {
            since: row.activeSince.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            level: heldLevel(row),
          }
        : null,
    paused: row?.paused ?? false,
    lastError: row?.lastError ?? "",
  };
}

/** A site row, locked FOR UPDATE when `lock`. */
async function findSite(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.site).where(eq(schema.site.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}

async function lockRow(tx: Tx, siteId: string) {
  const [row] = await tx
    .select()
    .from(schema.siteAutoMitigation)
    .where(eq(schema.siteAutoMitigation.siteId, siteId))
    .for("update");
  return row;
}

/** The site's own Under Attack switch, locking its protection row (the order updateSiteProtection takes). */
async function underAttackOf(tx: Tx, siteId: string) {
  const [row] = await tx
    .select({ underAttack: schema.siteProtection.underAttack })
    .from(schema.siteProtection)
    .where(eq(schema.siteProtection.siteId, siteId))
    .for("update");
  return row?.underAttack ?? false;
}

interface ChangeContext {
  actor: Actor;
  audit:
    | "site.auto_mitigation_apply"
    | "site.auto_mitigation_release"
    | "site.auto_mitigation_restore"
    | "site.auto_mitigation_update";
  metadata: Record<string, unknown>;
}

/** Turns the site's Under Attack on or off, publishes its cluster and audits it. */
async function setUnderAttack(tx: Tx, site: SiteRow, on: boolean, ctx: ChangeContext) {
  await tx
    .insert(schema.siteProtection)
    .values({ siteId: site.id, underAttack: on })
    .onConflictDoUpdate({
      target: schema.siteProtection.siteId,
      set: { underAttack: on, updatedAt: new Date() },
    });
  const { row } = await publishRevision(tx, {
    clusterId: site.clusterId,
    reason: {
      code: on ? "auto_mitigation_started" : "auto_mitigation_ended",
      params: { site: site.name },
    },
    actor: ctx.actor,
  });
  await recordAudit(tx, ctx.actor, {
    action: ctx.audit,
    targetType: "site",
    targetId: site.id,
    targetName: site.name,
    metadata: { ...ctx.metadata, revision: row.revision },
  });
}

/** An error's API code, for last_error. */
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "INTERNAL_SERVER_ERROR";
};

const NONE = { activeSince: null, expiresAt: null, triggerLevel: null } as const;

/**
 * Evaluates a site's automatic mitigation (the worker every minute, and when a node reports the
 * site's level going up): one transaction under the site's and the mitigation's row locks, so
 * concurrent or repeated evaluations see each other's result and a restart loses nothing (the
 * expiry is a stored time).
 *
 * - Not holding: starts when enabled, not paused, the site is on, its Under Attack is off and a
 *   node's level is at the threshold. Under Attack already on is left alone.
 * - Holding: Under Attack turned off meanwhile ends the hold and pauses it. A level still at the
 *   threshold moves the expiry to now + duration (no new revision). Past the expiry, or when
 *   disabled, Under Attack is turned off again.
 * - Paused ends when no node's level is at the threshold any more.
 *
 * A change that cannot be published (e.g. NODE_CAPABILITY_REQUIRED) rolls back to a savepoint,
 * is kept as last_error and retried at the next evaluation.
 */
export async function evaluateAutoMitigation(
  db: Database,
  siteId: string,
  now = new Date(),
  log?: AppContext["log"],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(schema.site)
      .where(eq(schema.site.id, siteId))
      .for("update");
    if (!found) return;
    let site: SiteRow = found;
    const underAttack = await underAttackOf(tx, siteId);
    const row = await lockRow(tx, siteId);
    if (!row) return;
    const level = await siteCcLevel(tx, site, now.getTime());
    const hit = atThreshold(level, row.threshold);
    const duration = row.durationMinutes * MINUTE;
    let { activeSince, expiresAt, triggerLevel, paused, lastError } = row;
    let holding = activeSince !== null;
    let on = underAttack;

    // The operator (or a rollback) turned Under Attack off while it was held: theirs now.
    if (holding && !on) {
      holding = false;
      ({ activeSince, expiresAt, triggerLevel } = NONE);
      paused = true;
    }

    const attempt = async (change: (sp: Tx) => Promise<void>) => {
      try {
        await tx.transaction(change);
        const [fresh] = await tx.select().from(schema.site).where(eq(schema.site.id, siteId));
        if (fresh) site = fresh;
        lastError = "";
        return true;
      } catch (error) {
        lastError = errorCode(error);
        log?.warn("automatic mitigation change failed", { siteId, error: lastError });
        return false;
      }
    };
    const metadata = (extra: Record<string, unknown>) => ({
      level,
      threshold: row.threshold,
      durationMinutes: row.durationMinutes,
      ...extra,
    });

    const canStart = row.enabled && hit && !paused && site.enabled && !on;
    if (holding) {
      if (!row.enabled || (!hit && expiresAt && now >= expiresAt)) {
        const reason = row.enabled ? "expired" : "disabled";
        const since = activeSince;
        if (
          await attempt((sp) =>
            setUnderAttack(sp, site, false, {
              actor: systemActor,
              audit: "site.auto_mitigation_release",
              metadata: metadata({ reason, since: since?.toISOString() }),
            }),
          )
        ) {
          holding = false;
          on = false;
          ({ activeSince, expiresAt, triggerLevel } = NONE);
        }
      } else if (hit) {
        const next = new Date(now.getTime() + duration);
        if (!expiresAt || next > expiresAt) expiresAt = next;
        lastError = "";
      } else {
        lastError = "";
      }
    } else if (canStart) {
      if (
        await attempt((sp) =>
          setUnderAttack(sp, site, true, {
            actor: systemActor,
            audit: "site.auto_mitigation_apply",
            metadata: metadata({}),
          }),
        )
      ) {
        holding = true;
        on = true;
        activeSince = now;
        expiresAt = new Date(now.getTime() + duration);
        triggerLevel = level;
      }
    } else {
      lastError = "";
    }

    // The escalation is over: a new one may start the mitigation again.
    if (paused && !hit) paused = false;

    await tx
      .update(schema.siteAutoMitigation)
      .set({ activeSince, expiresAt, triggerLevel, paused, lastError, evaluatedAt: now })
      .where(eq(schema.siteAutoMitigation.siteId, siteId));
  });
}

/**
 * Worker: evaluates every site with an enabled mitigation or state to settle. One site's failure
 * does not stop the others.
 */
export async function sweepAutoMitigation(app: AppContext, now = new Date()): Promise<void> {
  const rows = await app.db
    .select({ siteId: schema.siteAutoMitigation.siteId })
    .from(schema.siteAutoMitigation)
    .where(
      or(
        eq(schema.siteAutoMitigation.enabled, true),
        eq(schema.siteAutoMitigation.paused, true),
        // Disabled while holding: this evaluation lifts it.
        isNotNull(schema.siteAutoMitigation.activeSince),
      ),
    );
  for (const { siteId } of rows) {
    try {
      await evaluateAutoMitigation(app.db, siteId, now, app.log);
    } catch (error) {
      app.log.warn("automatic mitigation evaluation failed", {
        siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** After a node reported a site's level going up: evaluates those sites now rather than at the next tick. */
export async function nudgeAutoMitigation(app: AppContext, siteIds: string[]): Promise<void> {
  if (siteIds.length === 0) return;
  try {
    const enabled = await app.db
      .select({ siteId: schema.siteAutoMitigation.siteId })
      .from(schema.siteAutoMitigation)
      .where(eq(schema.siteAutoMitigation.enabled, true));
    const wanted = new Set(siteIds);
    for (const { siteId } of enabled.filter((row) => wanted.has(row.siteId)))
      await evaluateAutoMitigation(app.db, siteId, new Date(), app.log);
  } catch (error) {
    // The minute sweep evaluates it anyway.
    app.log.warn("automatic mitigation evaluation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * After the operator saved the site's Under Attack switch (call with the site row locked, after
 * the change): turning it off ends the hold and pauses the mitigation until the level is below
 * the threshold; turning it on takes it over, so the mitigation never lifts it.
 */
export async function noteOperatorUnderAttack(tx: Tx, siteId: string, underAttack: boolean) {
  const row = await lockRow(tx, siteId);
  if (!row?.activeSince) return;
  await tx
    .update(schema.siteAutoMitigation)
    .set({ ...NONE, paused: underAttack ? row.paused : true, lastError: "" })
    .where(eq(schema.siteAutoMitigation.siteId, siteId));
}

// ---------------------------------------------------------------- procedures

export async function getAutoMitigation(db: Database, siteId: string): Promise<AutoMitigation> {
  const site = await findSite(db, siteId);
  const [row] = await db
    .select()
    .from(schema.siteAutoMitigation)
    .where(eq(schema.siteAutoMitigation.siteId, siteId));
  return toDto(db, site, row);
}

/**
 * Creates or replaces a site's automatic mitigation. Saving ends a pause, and turning it off (or
 * shortening the duration) takes effect on what it holds now: off lifts Under Attack at once.
 */
export async function updateAutoMitigation(
  db: Database,
  input: AutoMitigationInput,
  ctx: { actor: Actor },
): Promise<AutoMitigation> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    const underAttack = await underAttackOf(tx, site.id);
    const before = await lockRow(tx, site.id);
    if (input.expectedUpdatedAt !== undefined) {
      if (!before)
        fail("UPDATED_AT_MISMATCH", "the automatic mitigation changed since it was read", {
          updatedAt: "",
        });
      assertUpdatedAt(before.updatedAt, input.expectedUpdatedAt);
    }
    const settings = {
      enabled: input.enabled,
      threshold: input.threshold,
      durationMinutes: input.durationMinutes,
    };
    const now = new Date();
    const updatedAt = new Date(Math.max(now.getTime(), (before?.updatedAt.getTime() ?? 0) + 1));
    let state: Pick<Row, "activeSince" | "expiresAt" | "triggerLevel"> = {
      activeSince: before?.activeSince ?? null,
      expiresAt: before?.expiresAt ?? null,
      triggerLevel: before?.triggerLevel ?? null,
    };
    if (state.activeSince) {
      if (!underAttack) state = NONE;
      else if (!settings.enabled) {
        await setUnderAttack(tx, site, false, {
          actor: ctx.actor,
          audit: "site.auto_mitigation_release",
          metadata: { reason: "disabled", since: state.activeSince.toISOString() },
        });
        state = NONE;
      } else {
        const cap = new Date(now.getTime() + settings.durationMinutes * MINUTE);
        if (state.expiresAt && cap < state.expiresAt) state = { ...state, expiresAt: cap };
      }
    }
    const [row] = await tx
      .insert(schema.siteAutoMitigation)
      .values({ siteId: site.id, ...settings, ...state, updatedAt })
      .onConflictDoUpdate({
        target: schema.siteAutoMitigation.siteId,
        set: { ...settings, ...state, updatedAt, paused: false, lastError: "" },
      })
      .returning();
    await recordAudit(tx, ctx.actor, {
      action: "site.auto_mitigation_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { from: before ? toSettings(before) : null, to: settings },
    });
    return toDto(tx, site, row, now);
  });
}

/**
 * Ends the mitigation now: Under Attack off, and nothing starts until the level is below the
 * threshold again. AUTO_MITIGATION_NOT_ACTIVE when it holds none.
 */
export async function restoreAutoMitigation(
  db: Database,
  siteId: string,
  ctx: { actor: Actor },
): Promise<AutoMitigation> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, siteId, true);
    const underAttack = await underAttackOf(tx, site.id);
    const row = await lockRow(tx, site.id);
    if (!row?.activeSince)
      fail("AUTO_MITIGATION_NOT_ACTIVE", "the automatic mitigation holds no Under Attack");
    const metadata = {
      level: row.triggerLevel,
      threshold: row.threshold,
      since: row.activeSince.toISOString(),
    };
    // Already off (the next evaluation would have noticed): nothing to publish.
    if (underAttack)
      await setUnderAttack(tx, site, false, {
        actor: ctx.actor,
        audit: "site.auto_mitigation_restore",
        metadata,
      });
    else
      await recordAudit(tx, ctx.actor, {
        action: "site.auto_mitigation_restore",
        targetType: "site",
        targetId: site.id,
        targetName: site.name,
        metadata,
      });
    const [updated] = await tx
      .update(schema.siteAutoMitigation)
      .set({ ...NONE, paused: true, lastError: "" })
      .where(eq(schema.siteAutoMitigation.siteId, site.id))
      .returning();
    return toDto(tx, site, updated);
  });
}
