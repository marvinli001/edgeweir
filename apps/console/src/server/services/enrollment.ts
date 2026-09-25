import { createHash, randomBytes } from "node:crypto";
import type { EnrollmentTokenResult } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { findNodeGroup } from "./node-groups";
import type { Tx } from "./revisions";

export const TOKEN_PREFIX = "ewt_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Shell-quotes a value for the generated install command. */
function sh(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildInstallCommand(opts: {
  consoleUrl: string;
  serverUrl: string;
  token: string;
  caSha256: string;
}): string {
  const script = `${opts.consoleUrl.replace(/\/$/, "")}/install.sh`;
  return [
    `curl -fsSL ${sh(script)} | sudo bash -s --`,
    `--server ${sh(opts.serverUrl)}`,
    `--token ${sh(opts.token)}`,
    `--ca-sha256 ${sh(opts.caSha256)}`,
  ].join(" ");
}

export async function createEnrollmentToken(
  db: Database,
  input: { clusterId: string; nodeGroupId?: string; nodeName: string; ttlMinutes: number },
  ctx: { actor: Actor; consoleUrl: string; serverUrl: string; caSha256: string },
): Promise<EnrollmentTokenResult> {
  const [clusterRow] = await db
    .select()
    .from(schema.cluster)
    .where(eq(schema.cluster.id, input.clusterId));
  if (!clusterRow) fail("CLUSTER_NOT_FOUND", "cluster not found");
  let nodeGroupId: string | null = null;
  if (input.nodeGroupId) {
    const group = await findNodeGroup(db, input.nodeGroupId);
    if (group.clusterId !== input.clusterId) {
      fail("NODE_GROUP_CLUSTER_MISMATCH", "the node group belongs to another cluster");
    }
    nodeGroupId = group.id;
  } else {
    const [group] = await db
      .select({ id: schema.nodeGroup.id })
      .from(schema.nodeGroup)
      .where(
        and(eq(schema.nodeGroup.clusterId, input.clusterId), eq(schema.nodeGroup.isDefault, true)),
      );
    nodeGroupId = group?.id ?? null;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  const [row] = await db
    .insert(schema.enrollmentToken)
    .values({
      clusterId: input.clusterId,
      nodeGroupId,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
      nodeName: input.nodeName,
      expiresAt,
      createdByUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .returning();
  if (!row) throw new Error("token insert failed");
  await recordAudit(db, ctx.actor, {
    action: "enrollment_token.create",
    targetType: "cluster",
    targetId: input.clusterId,
    targetName: clusterRow.name,
    metadata: {
      tokenId: row.id,
      expiresAt: expiresAt.toISOString(),
      nodeName: input.nodeName,
      nodeGroupId,
    },
  });
  return {
    tokenId: row.id,
    token,
    expiresAt: expiresAt.toISOString(),
    serverUrl: ctx.serverUrl,
    caSha256: ctx.caSha256,
    installCommand: buildInstallCommand({
      consoleUrl: ctx.consoleUrl,
      serverUrl: ctx.serverUrl,
      token,
      caSha256: ctx.caSha256,
    }),
  };
}

/**
 * Atomically claims a token: it must exist, be unused and unexpired. The row
 * is locked so two concurrent enrollments cannot both succeed.
 */
export async function claimEnrollmentToken(tx: Tx, token: string) {
  const [row] = await tx
    .select()
    .from(schema.enrollmentToken)
    .where(
      and(
        eq(schema.enrollmentToken.tokenHash, hashToken(token)),
        isNull(schema.enrollmentToken.usedAt),
        gt(schema.enrollmentToken.expiresAt, new Date()),
      ),
    )
    .for("update");
  return row;
}
