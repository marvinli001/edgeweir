import { schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { count } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { recordAudit } from "./audit";
import { createClusterTx } from "./clusters";
import type { Executor } from "./revisions";

export async function isInitialized(db: Executor): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.user);
  return (row?.n ?? 0) > 0;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "default";
}

/**
 * First-run setup: creates the platform administrator, the first tenant
 * organization and the default cluster. Only allowed while no user exists.
 */
export async function runSetup(
  ctx: AppContext,
  input: { name: string; email: string; password: string; organizationName: string },
  meta: { ip: string; userAgent: string },
): Promise<{ userId: string; organizationId: string }> {
  const client = await ctx.pool.connect();
  try {
    // Session-level lock so two concurrent setup requests cannot both pass.
    await client.query("select pg_advisory_lock(hashtext('edgeweir.setup'))");
    if (await isInitialized(ctx.db)) {
      throw new ORPCError("FORBIDDEN", { message: "setup has already been completed" });
    }
    const created = await ctx.auth.api.createUser({
      body: { email: input.email, password: input.password, name: input.name, role: "admin" },
    });
    const userId = created.user.id;
    const org = await ctx.auth.api.createOrganization({
      body: { name: input.organizationName, slug: slugify(input.organizationName), userId },
    });
    if (!org) throw new Error("organization creation failed");
    const actor = { type: "user" as const, id: userId, ...meta };
    await ctx.db.transaction(async (tx) => {
      const [clusters] = await tx.select({ n: count() }).from(schema.cluster);
      if ((clusters?.n ?? 0) === 0) {
        await createClusterTx(tx, { name: "default", description: "Default cluster" }, actor);
      }
      await recordAudit(tx, actor, {
        action: "system.setup",
        organizationId: org.id,
        targetType: "user",
        targetId: userId,
        metadata: { email: input.email },
      });
    });
    return { userId, organizationId: org.id };
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('edgeweir.setup'))").catch(() => {});
    client.release();
  }
}
