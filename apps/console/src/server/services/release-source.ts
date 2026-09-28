import {
  DEFAULT_NODE_RELEASE_BASE_URL,
  forbiddenOriginRange,
  type ReleaseSource,
  type ReleaseSourceInput,
  releaseBaseUrl,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { outboundAddress, withinDeadline } from "../lib/outbound";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

const RELEASE_SOURCE_KEY = "node_release_source";

async function savedUrl(db: Executor): Promise<string> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, RELEASE_SOURCE_KEY));
  const parsed = releaseBaseUrl.safeParse(row?.value.url);
  return parsed.success ? parsed.data : "";
}

/**
 * Saved setting, then EDGEWEIR_NODE_RELEASE_BASE_URL, then the official
 * releases. Only a saved URL came from a web session; the other two are the
 * operator's and are fetched without the outbound policy.
 */
export async function getReleaseSource(app: AppContext): Promise<ReleaseSource> {
  const url = await savedUrl(app.db);
  if (url) return { url, effectiveUrl: url, source: "setting" };
  const env = app.env.EDGEWEIR_NODE_RELEASE_BASE_URL;
  if (env) return { url, effectiveUrl: env, source: "environment" };
  return { url, effectiveUrl: DEFAULT_NODE_RELEASE_BASE_URL, source: "default" };
}

export async function setReleaseSource(
  app: AppContext,
  input: ReleaseSourceInput,
  actor: Actor,
): Promise<ReleaseSource> {
  if (input.url) {
    const url = new URL(input.url);
    try {
      const signal = AbortSignal.timeout(10000);
      const address = await withinDeadline(outboundAddress(app, url.hostname), signal);
      if (url.protocol === "http:" && forbiddenOriginRange(address.address, []) === null)
        throw new Error("HTTPS required for public destinations");
    } catch {
      fail(
        "RELEASE_SOURCE_REFUSED",
        "the release source must resolve to an allowed address and use HTTPS on the public internet",
      );
    }
  }
  await app.db.transaction(async (tx) => {
    const before = await savedUrl(tx);
    if (input.url) {
      const value = { url: input.url };
      await tx
        .insert(schema.systemSetting)
        .values({ key: RELEASE_SOURCE_KEY, value })
        .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
    } else {
      await tx.delete(schema.systemSetting).where(eq(schema.systemSetting.key, RELEASE_SOURCE_KEY));
    }
    await recordAudit(tx, actor, {
      action: "system.release_source_update",
      targetType: "system_setting",
      targetId: RELEASE_SOURCE_KEY,
      metadata: { before, after: input.url },
    });
  });
  return getReleaseSource(app);
}
