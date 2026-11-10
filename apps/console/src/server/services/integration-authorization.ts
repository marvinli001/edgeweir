import { createHash, timingSafeEqual } from "node:crypto";
import type { BootstrapInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { createAuth } from "../lib/auth";
import { resolveAuthSecret } from "../lib/auth-secret";
import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";
import { fail } from "../lib/errors";
import { createIntegrationAccessKey, findAccessKey } from "./access-keys";
import { recordAudit } from "./audit";
import { BOOTSTRAP_KEY, expireInstallerRecovery, withInstallerLock } from "./bootstrap";
import { notDemoUser } from "./demo";
import type { Executor } from "./revisions";

export const INTEGRATION_GRANT_KEY = "integration_authorization";
export const INTEGRATION_GRANT_BINDING = {
  purpose: "system_setting.integration_authorization",
  recordId: INTEGRATION_GRANT_KEY,
};
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
interface Grant extends Record<string, unknown> {
  installationId: string;
  requestId: string;
  tokenHash: string;
  userId: string;
  expiresAt: string;
  envelope?: Envelope;
  accessKeyId?: string;
  acknowledgedAt?: string;
}
async function grant(db: Executor) {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY));
  return row?.value as Grant | undefined;
}
export async function integrationAuthorizationStatus(ctx: AppContext) {
  const current = await grant(ctx.db);
  return {
    version: 1 as const,
    phase: current?.acknowledgedAt
      ? ("completed" as const)
      : current
        ? ("pending" as const)
        : ("available" as const),
  };
}
function match(current: Grant | undefined, input: BootstrapInput): Grant {
  if (
    !current ||
    !timingSafeEqual(Buffer.from(current.tokenHash, "hex"), Buffer.from(hash(input.token), "hex"))
  )
    fail("BOOTSTRAP_TOKEN_INVALID", "invalid integration authorization");
  if (current.installationId !== input.installationId || current.requestId !== input.requestId)
    fail("BOOTSTRAP_CONFLICT", "authorization belongs to another installation or request");
  return current;
}

/** No HTTP route exposes this operation. It requires access to the Core deployment's own tool. */
export async function grantIntegrationAuthorization(
  pool: pg.Pool,
  db: Database,
  input: BootstrapInput,
  renew = false,
) {
  return withInstallerLock({ pool }, () =>
    db.transaction(async (tx) => {
      const current = await grant(tx);
      let revokedKeyId: string | undefined;
      if (current) {
        if (current.installationId !== input.installationId)
          fail("BOOTSTRAP_CONFLICT", "another installation owns this integration grant");
        if (current.requestId === input.requestId && current.tokenHash === hash(input.token))
          return;
        if (!renew)
          fail(
            "BOOTSTRAP_CONFLICT",
            "use an explicit local renewal to replace the previous authorization",
          );
        if (current.accessKeyId) revokedKeyId = current.accessKeyId;
      } else if (renew) {
        const [bootstrap] = await tx
          .select()
          .from(schema.systemSetting)
          .where(eq(schema.systemSetting.key, BOOTSTRAP_KEY));
        if (bootstrap) {
          if (bootstrap.value.installationId !== input.installationId)
            fail("BOOTSTRAP_CONFLICT", "another installation owns the bootstrap identity");
          if (typeof bootstrap.value.accessKeyId === "string")
            revokedKeyId = bootstrap.value.accessKeyId;
        }
      }
      if (revokedKeyId)
        await tx
          .update(schema.apikey)
          .set({ enabled: false })
          .where(eq(schema.apikey.id, revokedKeyId));
      const owners = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(notDemoUser)
        .limit(2);
      if (owners.length !== 1)
        fail("BOOTSTRAP_CONFLICT", "an existing instance must have exactly one operator");
      const owner = owners[0];
      if (!owner) fail("BOOTSTRAP_CONFLICT", "no operator exists");
      const value: Grant = {
        installationId: input.installationId,
        requestId: input.requestId,
        tokenHash: hash(input.token),
        userId: owner.id,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      };
      await tx
        .insert(schema.systemSetting)
        .values({ key: INTEGRATION_GRANT_KEY, value })
        .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
      await recordAudit(
        tx,
        { type: "system", id: input.installationId, name: "local deployment operator" },
        {
          action: "system.integration_granted",
          metadata: {
            installationId: input.installationId,
            requestId: input.requestId,
            renewed: renew,
            revokedKeyId,
          },
        },
      );
    }),
  );
}

export async function authorizeIntegration(
  ctx: AppContext,
  input: BootstrapInput,
  meta: { ip: string; userAgent: string },
) {
  await expireInstallerRecovery(ctx.db);
  return withInstallerLock(ctx, () =>
    ctx.db.transaction(async (tx) => {
      const current = match(await grant(tx), input);
      if (current.acknowledgedAt)
        fail("BOOTSTRAP_ACKNOWLEDGED", "integration result was acknowledged and erased");
      if (Date.parse(current.expiresAt) <= Date.now())
        fail("BOOTSTRAP_RECOVERY_EXPIRED", "integration authorization expired");
      if (current.envelope)
        return JSON.parse(
          ctx.masterKey.open(current.envelope, INTEGRATION_GRANT_BINDING).toString("utf8"),
        );
      const db = tx as unknown as Database;
      const auth = createAuth({
        db,
        secret: resolveAuthSecret(ctx.env).value,
        publicUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        rateLimit: false,
      });
      const actor = {
        type: "system" as const,
        id: input.installationId,
        name: "authorized integration",
        ...meta,
      };
      const key = await createIntegrationAccessKey({ ...ctx, db, auth }, current.userId, actor);
      const clusters = await tx.select({ id: schema.cluster.id }).from(schema.cluster).limit(2);
      const result = {
        installationId: input.installationId,
        userId: current.userId,
        clusterId: clusters.length === 1 ? (clusters[0]?.id ?? null) : null,
        accessKeyId: key.id,
        accessKey: key.key,
        caSha256: ctx.nodeCa.fingerprintSha256,
        recoveryExpiresAt: current.expiresAt,
      };
      await tx
        .update(schema.systemSetting)
        .set({
          value: {
            ...current,
            accessKeyId: key.id,
            envelope: ctx.masterKey.seal(JSON.stringify(result), INTEGRATION_GRANT_BINDING),
          },
        })
        .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY));
      await recordAudit(tx, actor, {
        action: "system.integration_authorized",
        metadata: {
          installationId: input.installationId,
          requestId: input.requestId,
          accessKeyId: key.id,
        },
      });
      return result;
    }),
  );
}

export async function acknowledgeIntegration(
  ctx: AppContext,
  input: BootstrapInput,
  meta: { ip: string; userAgent: string },
  apiKey: string | null,
) {
  return withInstallerLock(ctx, () =>
    ctx.db.transaction(async (tx) => {
      const current = match(await grant(tx), input);
      const principal = apiKey
        ? await findAccessKey(tx as unknown as Database, apiKey, new Date())
        : null;
      if (!current.accessKeyId || principal?.key.id !== current.accessKeyId)
        fail("BOOTSTRAP_CONFLICT", "acknowledgement requires the issued credential");
      if (!current.accessKeyId && !current.acknowledgedAt)
        fail("BOOTSTRAP_CONFLICT", "no integration credential has been issued");
      if (!current.acknowledgedAt) {
        const { envelope: _envelope, ...retained } = current;
        await tx
          .update(schema.systemSetting)
          .set({ value: { ...retained, acknowledgedAt: new Date().toISOString() } })
          .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY));
        await recordAudit(
          tx,
          { type: "system", id: input.installationId, name: "authorized integration", ...meta },
          {
            action: "system.integration_acknowledged",
            metadata: { installationId: input.installationId, requestId: input.requestId },
          },
        );
      }
      return { ok: true as const };
    }),
  );
}
