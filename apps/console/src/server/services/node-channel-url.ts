import {
  isWebSocketNodeChannel,
  type NodeChannel,
  type NodeChannelInput,
  nodeChannelOrigin,
} from "@edgeweir/contract";
import { sql } from "drizzle-orm";
import * as z from "zod";
import type { AppContext } from "../lib/context";
import { NODE_CHANNEL_CHANNEL } from "../lib/events";
import type { Actor } from "./audit";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/** Bounds the names earlier URLs leave in the node channel certificate. */
const MAX_PREVIOUS_HOSTS = 32;

/**
 * The saved URL, and the hosts of the URLs nodes were given before it: nodes keep the URL they
 * enrolled with, so its name stays in the certificate. `webSocket`: a wss:// or ws:// URL was
 * in effect before, so nodes may still connect through the WebSocket entry.
 */
const nodeChannelSetting = defineSetting({
  key: "node_channel_url",
  schema: z.object({
    url: z.string(),
    previousHosts: z.array(z.string()).max(MAX_PREVIOUS_HOSTS),
    webSocket: z.boolean(),
  }),
  defaults: { url: "", previousHosts: [], webSocket: false },
  auditAction: "system.node_channel_update",
});

/** The name a node checks the certificate against: the URL's host name or IP. */
export function certificateName(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

function resolve(app: AppContext, url: string): NodeChannel {
  if (url) return { url, effectiveUrl: url, source: "setting" };
  return {
    url,
    effectiveUrl: app.env.nodeApiUrl,
    source: app.env.EDGEWEIR_NODE_API_URL ? "environment" : "default",
  };
}

/** Saved setting, then EDGEWEIR_NODE_API_URL, then https://<console host>:<NODE_API_PORT>. */
export async function getNodeChannel(app: AppContext, db: Executor = app.db): Promise<NodeChannel> {
  return resolve(app, (await nodeChannelSetting.read(db)).url);
}

/** The URL new install commands carry. */
export async function nodeChannelUrl(app: AppContext): Promise<string> {
  return (await getNodeChannel(app)).effectiveUrl;
}

/**
 * Whether the node channel's WebSocket entry answers: with EDGEWEIR_NODE_API_WEBSOCKET, while
 * the URL in effect is a wss:// or ws:// one, and once such a URL was in effect (nodes keep the
 * URL they enrolled with).
 */
export async function nodeChannelWebSocketOpen(app: AppContext): Promise<boolean> {
  if (app.env.EDGEWEIR_NODE_API_WEBSOCKET) return true;
  const saved = await nodeChannelSetting.read(app.db);
  return saved.webSocket || isWebSocketNodeChannel(resolve(app, saved.url).effectiveUrl);
}

/**
 * Every name the node channel certificate carries: the environment's (lib/env), the saved URL's
 * and those of the URLs nodes were given before it.
 */
export async function nodeChannelNames(app: AppContext): Promise<string[]> {
  const saved = await nodeChannelSetting.read(app.db);
  const names = new Set(app.env.nodeApiHostnames);
  for (const host of saved.previousHosts) names.add(host);
  if (saved.url) names.add(certificateName(saved.url));
  return [...names];
}

/**
 * Saves the URL (empty: the environment or the default applies again) and tells every console
 * instance, whose node channel then issues its certificate for the new name. The URL in effect
 * before keeps its name in the certificate for the nodes that enrolled with it.
 */
export async function setNodeChannel(
  app: AppContext,
  input: NodeChannelInput,
  actor: Actor,
): Promise<NodeChannel> {
  const url = input.url ? (nodeChannelOrigin(input.url) ?? input.url) : "";
  await app.db.transaction(async (tx) => {
    const before = await nodeChannelSetting.read(tx);
    const previousUrl = resolve(app, before.url).effectiveUrl;
    const previous = certificateName(previousUrl);
    const current = url ? certificateName(url) : undefined;
    const previousHosts = [...before.previousHosts.filter((host) => host !== previous), previous]
      .filter((host) => host !== current)
      .slice(-MAX_PREVIOUS_HOSTS);
    const webSocket =
      before.webSocket || isWebSocketNodeChannel(previousUrl) || isWebSocketNodeChannel(url);
    await nodeChannelSetting.write(
      tx,
      actor,
      { url, previousHosts, webSocket },
      { before, metadata: () => ({ before: before.url, after: url }) },
    );
    await tx.execute(sql`select pg_notify(${NODE_CHANNEL_CHANNEL}, '{}')`);
  });
  app.events.emitNodeChannelLocal();
  return getNodeChannel(app);
}
