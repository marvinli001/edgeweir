import type { AuditAction } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type * as z from "zod";
import { type Actor, recordAudit } from "./audit";
import type { Executor, Tx } from "./revisions";

/** A system_setting value: one JSON object per key. */
type SettingValue = Record<string, unknown>;

export interface SettingWriteOptions<T> {
  /** The value before, when the caller has read it already (under its lock, say). */
  before?: T;
  /**
   * Runs once the value is stored and before the audit entry (publishing the clusters, say);
   * the fields it returns join the audit metadata.
   */
  afterWrite?: (before: T) => Promise<SettingValue | undefined>;
  /** The audit metadata instead of `{ from, to }`. */
  metadata?: (before: T) => SettingValue;
}

export interface Setting<T extends SettingValue> {
  readonly key: string;
  /** The saved value over the defaults; the defaults when nothing valid is saved. */
  read(db: Executor): Promise<T>;
  /**
   * Validates and stores `value` (null removes it: the defaults apply again) and records the
   * audit entry, in the caller's transaction. Returns the value in effect. Callers pass input
   * the contract has validated already, so a value the schema refuses is a bug and throws.
   */
  write(tx: Tx, actor: Actor, value: T | null, options?: SettingWriteOptions<T>): Promise<T>;
}

/**
 * A platform setting kept in system_setting under `key`: read over its defaults, written with
 * its audit entry (`auditAction` on the target system_setting `key`) in one transaction.
 */
export function defineSetting<S extends z.ZodType<SettingValue>>(definition: {
  key: string;
  schema: S;
  defaults: z.output<S>;
  auditAction: AuditAction;
  /** Recorded as the audit entry's target name. */
  targetName?: string;
}): Setting<z.output<S>> {
  const { key, defaults, auditAction, targetName } = definition;
  // Settings are defined at module load: a key imported through an import cycle is still unset.
  if (!key) throw new Error("defineSetting: no key (imported through a cycle?)");
  const read = async (db: Executor): Promise<z.output<S>> => {
    const [row] = await db
      .select({ value: schema.systemSetting.value })
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, key));
    const parsed = definition.schema.safeParse({ ...defaults, ...row?.value });
    return parsed.success ? parsed.data : defaults;
  };
  return {
    key,
    read,
    async write(tx, actor, value, options = {}) {
      const before = options.before ?? (await read(tx));
      const after = value === null ? defaults : definition.schema.parse(value);
      if (value === null)
        await tx.delete(schema.systemSetting).where(eq(schema.systemSetting.key, key));
      else
        await tx
          .insert(schema.systemSetting)
          .values({ key, value: after })
          .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value: after } });
      const extra = await options.afterWrite?.(before);
      await recordAudit(tx, actor, {
        action: auditAction,
        targetType: "system_setting",
        targetId: key,
        targetName,
        metadata: { ...(options.metadata?.(before) ?? { from: before, to: after }), ...extra },
      });
      return after;
    },
  };
}
