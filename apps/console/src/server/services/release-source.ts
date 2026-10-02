import {
  DEFAULT_NODE_RELEASE_BASE_URL,
  forbiddenOriginRange,
  type ReleaseSource,
  type ReleaseSourceInput,
  releaseSourceInput,
} from "@edgeweir/contract";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { outboundAddress, withinDeadline } from "../lib/outbound";
import type { Actor } from "./audit";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

const RELEASE_SOURCE_KEY = "node_release_source";

/** The saved mirror; an empty URL when none is saved. */
const releaseSourceSetting = defineSetting({
  key: RELEASE_SOURCE_KEY,
  schema: releaseSourceInput,
  defaults: { url: "" },
  auditAction: "system.release_source_update",
});

async function savedUrl(db: Executor): Promise<string> {
  return (await releaseSourceSetting.read(db)).url;
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
  await app.db.transaction((tx) =>
    // An empty URL removes the saved one: the environment or the default applies again.
    releaseSourceSetting.write(tx, actor, input.url ? { url: input.url } : null, {
      metadata: (before) => ({ before: before.url, after: input.url }),
    }),
  );
  return getReleaseSource(app);
}
