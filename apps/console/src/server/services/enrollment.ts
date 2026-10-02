import { createHash, randomBytes } from "node:crypto";
import {
  consoleUrlWarnings,
  type EnrollmentTokenResult,
  type EnrollmentTokenStatus,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { findNodeGroup } from "./node-groups";
import { getNode } from "./nodes";
import { publisher, type Tx } from "./revisions";

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

/**
 * The command the console shows for a new node. The token travels in the
 * EDGEWEIR_TOKEN environment variable (exported by the shell, passed through
 * sudo, read by install.sh and `edgeweir-node enroll`), never as an argument
 * that the process list would show.
 */
export function buildInstallCommand(opts: {
  consoleUrl: string;
  serverUrl: string;
  token: string;
  caSha256: string;
}): string {
  const script = `${opts.consoleUrl.replace(/\/$/, "")}/install.sh`;
  return [
    `export EDGEWEIR_TOKEN='${opts.token.replace(/'/g, `'"'"'`)}'`,
    [
      `curl -fsSL ${sh(script)} | sudo --preserve-env=EDGEWEIR_TOKEN bash -s --`,
      `--server ${sh(opts.serverUrl)}`,
      `--ca-sha256 ${sh(opts.caSha256)}`,
    ].join(" "),
  ].join("\n");
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
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.enrollmentToken)
      .values({
        clusterId: input.clusterId,
        nodeGroupId,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
        nodeName: input.nodeName,
        expiresAt,
        createdByUserId: publisher(ctx.actor),
      })
      .returning();
    if (!inserted) throw new Error("token insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "enrollment_token.create",
      targetType: "cluster",
      targetId: input.clusterId,
      targetName: clusterRow.name,
      metadata: {
        tokenId: inserted.id,
        expiresAt: expiresAt.toISOString(),
        nodeName: input.nodeName,
        nodeGroupId,
      },
    });
    return inserted;
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
    warnings: consoleUrlWarnings({ consoleUrl: ctx.consoleUrl, nodeApiUrl: ctx.serverUrl }),
  };
}

/**
 * Whether a token enrolled a node yet, and that node, for the add-node
 * dialog to follow the enrollment. Never returns the token.
 */
export async function getEnrollmentToken(db: Database, id: string): Promise<EnrollmentTokenStatus> {
  const [row] = await db
    .select({
      id: schema.enrollmentToken.id,
      expiresAt: schema.enrollmentToken.expiresAt,
      usedAt: schema.enrollmentToken.usedAt,
      usedByNodeId: schema.enrollmentToken.usedByNodeId,
    })
    .from(schema.enrollmentToken)
    .where(eq(schema.enrollmentToken.id, id));
  if (!row) fail("ENROLLMENT_TOKEN_NOT_FOUND", "enrollment token not found");
  const [node] = row.usedByNodeId
    ? await db
        .select({ id: schema.node.id })
        .from(schema.node)
        .where(eq(schema.node.id, row.usedByNodeId))
    : [];
  return {
    tokenId: row.id,
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    node: node ? await getNode(db, node.id) : null,
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
