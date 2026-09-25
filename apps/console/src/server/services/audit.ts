import { schema } from "@edgeweir/db";
import type { Executor } from "./revisions";

export interface Actor {
  type: "user" | "api_key" | "node" | "system";
  id: string;
  ip?: string;
  userAgent?: string;
}

export const systemActor: Actor = { type: "system", id: "" };

/** Appends an entry to the audit log. Every management action goes through here. */
export async function recordAudit(
  db: Executor,
  actor: Actor,
  entry: {
    action: string;
    organizationId?: string | null;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorType: actor.type,
    actorId: actor.id,
    ip: actor.ip ?? "",
    userAgent: (actor.userAgent ?? "").slice(0, 512),
    organizationId: entry.organizationId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? "",
    targetId: entry.targetId ?? "",
    metadata: entry.metadata ?? {},
  });
}
