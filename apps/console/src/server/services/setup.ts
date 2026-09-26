import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Database, schema } from "@edgeweir/db";
import { count, eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope, MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { recordAudit } from "./audit";
import { createClusterTx } from "./clusters";
import type { Executor } from "./revisions";

export async function isInitialized(db: Executor): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.user);
  return (row?.n ?? 0) > 0;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "org";
}

export const SETUP_TOKEN_KEY = "setup_token";
/** Envelope binding of the setup token: the setting and its key (AAD). */
export const SETUP_TOKEN_BINDING = {
  purpose: "system_setting.setup_token",
  recordId: SETUP_TOKEN_KEY,
} as const;
/** The purpose version 1 envelopes were sealed with. */
export const LEGACY_SETUP_TOKEN_PURPOSE = "system/setup-token";
export const SETUP_TOKEN_PREFIX = "ews_";

export interface SetupTokenState {
  /** The token, sealed with the master key so every instance prints the same one. */
  envelope?: Envelope;
  hash?: string;
  createdAt?: string;
  usedAt?: string;
  usedBy?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function readSetupToken(db: Executor): Promise<SetupTokenState> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
  return (row?.value ?? {}) as SetupTokenState;
}

/**
 * Makes sure an uninitialized console has a one-time setup token and returns
 * it (null once setup is done). The first run wizard refuses to create the
 * administrator without it, which closes the window in which anyone who can
 * reach the console could claim it.
 */
export async function ensureSetupToken(ctx: {
  db: Database;
  masterKey: MasterKey;
}): Promise<string | null> {
  if (await isInitialized(ctx.db)) return null;
  const open = (state: SetupTokenState) => {
    if (!state.envelope) return null;
    try {
      return ctx.masterKey.open(state.envelope, SETUP_TOKEN_BINDING).toString("utf8");
    } catch {
      return null; // sealed with a previous master key (or never upgraded)
    }
  };
  const state = await readSetupToken(ctx.db);
  if (state.usedAt) return null;
  const existing = open(state);
  if (existing) return existing;
  const token = `${SETUP_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const value = {
    envelope: ctx.masterKey.seal(token, SETUP_TOKEN_BINDING),
    hash: sha256(token),
    createdAt: new Date().toISOString(),
  } satisfies SetupTokenState as Record<string, unknown>;
  if (state.envelope) {
    // Unreadable (master key changed): replace it.
    await ctx.db
      .update(schema.systemSetting)
      .set({ value })
      .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
  } else {
    // Several instances may start at once: the first stored token wins, all print it.
    await ctx.db
      .insert(schema.systemSetting)
      .values({ key: SETUP_TOKEN_KEY, value })
      .onConflictDoNothing();
  }
  return open(await readSetupToken(ctx.db));
}

/** Prints the setup token to the log, where the operator reads it (`docker compose logs`). */
export function announceSetupToken(log: Logger, token: string, publicUrl: string) {
  log.warn("first-run setup: open the console and enter this setup token", {
    setupToken: token,
    url: `${publicUrl.replace(/\/$/, "")}/setup`,
  });
}

export async function setupCompletedAt(db: Executor): Promise<string | null> {
  return (await readSetupToken(db)).usedAt ?? null;
}

function tokenMatches(state: SetupTokenState, candidate: string): boolean {
  if (!state.hash || state.usedAt) return false;
  const a = Buffer.from(state.hash, "hex");
  const b = Buffer.from(sha256(candidate.trim()), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * First-run setup: creates the platform administrator, the first tenant
 * organization and the default cluster. Only allowed while no user exists,
 * and only with the setup token printed at startup.
 */
export async function runSetup(
  ctx: AppContext,
  input: {
    setupToken: string;
    name: string;
    email: string;
    password: string;
    organizationName: string;
  },
  meta: { ip: string; userAgent: string },
): Promise<{ userId: string; organizationId: string }> {
  const client = await ctx.pool.connect();
  let locked = false;
  try {
    // Never queue pool connections behind this lock: the winning request
    // still needs the pool for better-auth and its transaction.
    const result = await client.query(
      "select pg_try_advisory_lock(hashtext('edgeweir.setup')) as locked",
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) fail("SETUP_IN_PROGRESS", "setup is already in progress; retry shortly");
    if (await isInitialized(ctx.db)) fail("SETUP_DONE", "setup has already been completed");
    if (!tokenMatches(await readSetupToken(ctx.db), input.setupToken)) {
      await recordAudit(
        ctx.db,
        { type: "system", id: "", name: "setup", ...meta },
        { action: "system.setup_rejected", metadata: { email: input.email } },
      );
      fail("SETUP_TOKEN_INVALID", "invalid setup token");
    }
    const created = await ctx.auth.api.createUser({
      body: { email: input.email, password: input.password, name: input.name, role: "admin" },
    });
    const userId = created.user.id;
    let organizationId: string | undefined;
    try {
      // better-auth writes the administrator and the organization in its own
      // statements; everything else (cluster, spent token, audit entry)
      // commits in one transaction. If any step fails, both are deleted again
      // so the console stays uninitialized and the token stays usable.
      const org = await ctx.auth.api.createOrganization({
        body: { name: input.organizationName, slug: slugify(input.organizationName), userId },
      });
      if (!org) throw new Error("organization creation failed");
      organizationId = org.id;
      const actor = { type: "user" as const, id: userId, name: input.name, ...meta };
      await ctx.db.transaction(async (tx) => {
        const [clusters] = await tx.select({ n: count() }).from(schema.cluster);
        if ((clusters?.n ?? 0) === 0) {
          await createClusterTx(tx, { name: "default", description: "Default cluster" }, actor);
        }
        await tx
          .insert(schema.organizationSettings)
          .values({ organizationId: org.id })
          .onConflictDoNothing();
        const used: SetupTokenState = { usedAt: new Date().toISOString(), usedBy: userId };
        await tx
          .update(schema.systemSetting)
          .set({ value: used as Record<string, unknown> })
          .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
        await recordAudit(tx, actor, {
          action: "system.setup",
          organizationId: org.id,
          targetType: "user",
          targetId: userId,
          targetName: input.name,
          metadata: { email: input.email, organization: org.name },
        });
      });
      return { userId, organizationId: org.id };
    } catch (error) {
      if (organizationId) {
        await ctx.db.delete(schema.organization).where(eq(schema.organization.id, organizationId));
      }
      await ctx.db.delete(schema.user).where(eq(schema.user.id, userId));
      throw error;
    }
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext('edgeweir.setup'))").catch(() => {});
    }
    client.release();
  }
}
