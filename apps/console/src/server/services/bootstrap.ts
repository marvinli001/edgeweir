import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { BootstrapInput, BootstrapResult } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "../lib/auth";
import { resolveAuthSecret } from "../lib/auth-secret";
import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";
import { fail } from "../lib/errors";
import { tryLockSetup, unlockSetup } from "../lib/locks";
import { createAccessKey, findAccessKey } from "./access-keys";
import { recordAudit } from "./audit";
import { createClusterTx } from "./clusters";
import type { Executor } from "./revisions";
import { isInitialized, SETUP_TOKEN_KEY } from "./setup";

export const BOOTSTRAP_KEY = "installer_bootstrap";
export const BOOTSTRAP_BINDING = {
  purpose: "system_setting.installer_bootstrap",
  recordId: BOOTSTRAP_KEY,
};
const RECOVERY_MS = 24 * 3600 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface BootstrapState extends Record<string, unknown> {
  installationId: string;
  requestId: string;
  tokenHash: string;
  userId: string;
  accessKeyId: string;
  expiresAt: string;
  envelope?: Envelope;
  acknowledgedAt?: string;
}

/** A symlink, readable-by-others file or an empty capability must never enable setup. */
export async function readBootstrapToken(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o177) !== 0 || stat.size > 256)
      throw new Error("bootstrap capability must be a private regular file (0600)");
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
      throw new Error("bootstrap capability file has an invalid format");
    return token;
  } finally {
    await handle.close();
  }
}

async function state(db: Executor): Promise<BootstrapState | undefined> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, BOOTSTRAP_KEY));
  return row?.value as BootstrapState | undefined;
}

export async function bootstrapStatus(ctx: AppContext) {
  await expireInstallerRecovery(ctx.db);
  const current = await state(ctx.db);
  return {
    version: 1 as const,
    enabled: !!ctx.env.EDGEWEIR_BOOTSTRAP_TOKEN_FILE,
    phase: current?.acknowledgedAt
      ? ("completed" as const)
      : current
        ? ("pending" as const)
        : ctx.env.EDGEWEIR_BOOTSTRAP_TOKEN_FILE
          ? ("available" as const)
          : ("disabled" as const),
  };
}

export async function expireInstallerRecovery(db: Executor) {
  await db.execute(sql`update ${schema.systemSetting} set value = value - 'envelope'
    where key in ('installer_bootstrap', 'integration_authorization')
    and value ? 'envelope' and (value->>'expiresAt')::timestamptz <= now()`);
}

async function authorize(ctx: AppContext, input: BootstrapInput) {
  if (!ctx.env.EDGEWEIR_BOOTSTRAP_TOKEN_FILE)
    fail("BOOTSTRAP_DISABLED", "installer bootstrap is not enabled");
  const expected = digest(await readBootstrapToken(ctx.env.EDGEWEIR_BOOTSTRAP_TOKEN_FILE));
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest(input.token), "hex")))
    fail("BOOTSTRAP_TOKEN_INVALID", "invalid installer capability");
  return expected;
}

function sameRequest(current: BootstrapState, input: BootstrapInput, tokenHash: string) {
  if (
    current.installationId !== input.installationId ||
    current.requestId !== input.requestId ||
    current.tokenHash !== tokenHash
  )
    fail("BOOTSTRAP_CONFLICT", "bootstrap belongs to another installation or request");
}

export async function withInstallerLock<T>(ctx: Pick<AppContext, "pool">, run: () => Promise<T>) {
  const client = await ctx.pool.connect();
  let acquired = false;
  try {
    acquired = await tryLockSetup(client);
    if (!acquired) fail("SETUP_IN_PROGRESS", "setup is already in progress; retry shortly");
    return await run();
  } finally {
    if (acquired) await unlockSetup(client).catch(() => {});
    client.release();
  }
}

export async function runBootstrap(
  ctx: AppContext,
  input: BootstrapInput,
  meta: { ip: string; userAgent: string },
): Promise<BootstrapResult> {
  const tokenHash = await authorize(ctx, input);
  return withInstallerLock(ctx, () =>
    ctx.db.transaction(async (tx) => {
      const current = await state(tx);
      if (current) {
        sameRequest(current, input, tokenHash);
        if (current.acknowledgedAt)
          fail("BOOTSTRAP_ACKNOWLEDGED", "bootstrap result was acknowledged and erased");
        if (Date.parse(current.expiresAt) <= Date.now())
          fail(
            "BOOTSTRAP_RECOVERY_EXPIRED",
            "bootstrap recovery expired; authorize the existing service",
          );
        if (!current.envelope)
          fail("BOOTSTRAP_RECOVERY_EXPIRED", "bootstrap recovery result is no longer available");
        return JSON.parse(
          ctx.masterKey.open(current.envelope, BOOTSTRAP_BINDING).toString("utf8"),
        ) as BootstrapResult;
      }
      if (await isInitialized(tx))
        fail("SETUP_DONE", "an existing instance requires operator authorization");
      // Both better-auth operations use this transaction, so a crash cannot leave an orphan identity or key.
      const db = tx as unknown as Database;
      const auth = createAuth({
        db,
        secret: resolveAuthSecret(ctx.env).value,
        publicUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        rateLimit: false,
      });
      const user = await auth.api.createUser({
        body: {
          name: "Managed control operator",
          email: `controller-${input.installationId}@managed.invalid`,
          role: "admin",
        },
      });
      const actor = { type: "user" as const, id: user.user.id, name: user.user.name, ...meta };
      const [existing] = await tx.select({ id: schema.cluster.id }).from(schema.cluster).limit(1);
      const cluster =
        existing ??
        (await createClusterTx(tx, { name: "default", description: "Default cluster" }, actor));
      const key = await createAccessKey(
        { ...ctx, db, auth },
        user.user.id,
        { name: "Managed control service", scope: "write", requestsPerMinute: 600 },
        actor,
      );
      const result: BootstrapResult = {
        installationId: input.installationId,
        userId: user.user.id,
        clusterId: cluster.id,
        accessKeyId: key.id,
        accessKey: key.key,
        caSha256: ctx.nodeCa.fingerprintSha256,
        recoveryExpiresAt: new Date(Date.now() + RECOVERY_MS).toISOString(),
      };
      const value: BootstrapState = {
        installationId: input.installationId,
        requestId: input.requestId,
        tokenHash,
        userId: result.userId,
        accessKeyId: result.accessKeyId,
        expiresAt: result.recoveryExpiresAt,
        envelope: ctx.masterKey.seal(JSON.stringify(result), BOOTSTRAP_BINDING),
      };
      await tx.insert(schema.systemSetting).values({ key: BOOTSTRAP_KEY, value });
      await tx
        .insert(schema.systemSetting)
        .values({
          key: SETUP_TOKEN_KEY,
          value: { usedAt: new Date().toISOString(), usedBy: result.userId },
        })
        .onConflictDoUpdate({
          target: schema.systemSetting.key,
          set: { value: { usedAt: new Date().toISOString(), usedBy: result.userId } },
        });
      await recordAudit(
        tx,
        { type: "system", id: input.installationId, name: "installer", ...meta },
        {
          action: "system.bootstrap",
          targetType: "user",
          targetId: result.userId,
          metadata: {
            installationId: input.installationId,
            requestId: input.requestId,
            accessKeyId: result.accessKeyId,
          },
        },
      );
      return result;
    }),
  );
}

export async function acknowledgeBootstrap(
  ctx: AppContext,
  input: BootstrapInput,
  meta: { ip: string; userAgent: string },
  apiKey: string | null,
) {
  const tokenHash = await authorize(ctx, input);
  return withInstallerLock(ctx, () =>
    ctx.db.transaction(async (tx) => {
      const current = await state(tx);
      if (!current) fail("BOOTSTRAP_CONFLICT", "no bootstrap belongs to this request");
      sameRequest(current, input, tokenHash);
      const principal = apiKey
        ? await findAccessKey(tx as unknown as Database, apiKey, new Date())
        : null;
      if (principal?.key.id !== current.accessKeyId)
        fail("BOOTSTRAP_CONFLICT", "acknowledgement requires the issued credential");
      if (!current.acknowledgedAt) {
        const { envelope: _envelope, ...retained } = current;
        await tx
          .update(schema.systemSetting)
          .set({ value: { ...retained, acknowledgedAt: new Date().toISOString() } })
          .where(eq(schema.systemSetting.key, BOOTSTRAP_KEY));
        await recordAudit(
          tx,
          { type: "system", id: input.installationId, name: "installer", ...meta },
          {
            action: "system.bootstrap_acknowledged",
            metadata: { installationId: input.installationId, requestId: input.requestId },
          },
        );
      }
      return { ok: true as const };
    }),
  );
}
