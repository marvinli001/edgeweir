import {
  isWebSocketNodeChannel,
  type NodeChannel,
  type NodeChannelAddress,
  type NodeChannelInput,
  nodeChannelNamesInUse,
  nodeChannelOrigin,
  nodeChannelStateOf,
  nodeChannelUsesWebSocket,
  parseIp,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { gt, sql } from "drizzle-orm";
import * as z from "zod";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { NODE_CHANNEL_CHANNEL } from "../lib/events";
import { lockNodeChannel } from "../lib/locks";
import type { Actor } from "./audit";
import { toNodeChannelStatus } from "./node-channel-status";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/** Bounds the names earlier URLs leave in the node channel certificate. */
const MAX_PREVIOUS_HOSTS = 32;

/**
 * The saved URL, and the hosts of the URLs nodes were given before it: nodes keep the URL they
 * enrolled with, so its name stays in the certificate. `webSocket`: a wss:// or ws:// URL was
 * in effect before, so nodes may still connect through the WebSocket entry.
 */
type NodeChannelValue = { url: string; previousHosts: string[]; webSocket: boolean };

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
function certificateName(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

type ResolvedChannel = Pick<NodeChannel, "url" | "effectiveUrl" | "source">;

function resolve(app: AppContext, url: string): ResolvedChannel {
  if (url) return { url, effectiveUrl: url, source: "setting" };
  return {
    url,
    effectiveUrl: app.env.nodeApiUrl,
    source: app.env.EDGEWEIR_NODE_API_URL ? "environment" : "default",
  };
}

/** The address in effect: saved setting, then EDGEWEIR_NODE_API_URL, then the default. */
async function resolveSaved(app: AppContext, db: Executor) {
  const saved = await nodeChannelSetting.read(db);
  return { saved, channel: resolve(app, saved.url) };
}

/** The URL new install commands carry. */
export async function nodeChannelUrl(app: AppContext): Promise<string> {
  return (await resolveSaved(app, app.db)).channel.effectiveUrl;
}

/** The address enrolled nodes and probes (channel-follow-v1) move to: the URL in effect. */
export async function nodeChannelAddress(app: AppContext): Promise<NodeChannelAddress> {
  const url = await nodeChannelUrl(app);
  return { url, serverName: certificateName(url) };
}

/** A node's or probe's node channel data, for agents whose certificate is still valid. */
async function enrolledAgents(db: Executor) {
  const now = new Date();
  const nodes = await db
    .select({ channel: schema.node.channel })
    .from(schema.node)
    .where(gt(schema.node.certNotAfter, now));
  const probes = await db
    .select({ channel: schema.probe.channel })
    .from(schema.probe)
    .where(gt(schema.probe.certNotAfter, now));
  const status = (rows: { channel: schema.NodeChannelData | null }[]) =>
    rows.map((r) => toNodeChannelStatus(r.channel));
  return { nodes: status(nodes), probes: status(probes) };
}

type AgentStatuses = Awaited<ReturnType<typeof enrolledAgents>>;

/**
 * How many of the agents connect with a name: they verified it on their latest connection, or
 * report it as the address they use. A fallback they keep for later does not count: once the
 * name is gone, only that fallback fails. An older agent that sent no server name may use any
 * IP address name.
 */
function usingName(statuses: AgentStatuses["nodes"], name: string): number {
  return statuses.filter((status) => {
    const names = nodeChannelNamesInUse(status);
    return names === null ? status !== null && parseIp(name) !== null : names.has(name);
  }).length;
}

/**
 * Saved setting, then EDGEWEIR_NODE_API_URL, then https://<console host>:<NODE_API_PORT>; with
 * the names earlier URLs left in the certificate and the nodes and probes still on them.
 */
export async function getNodeChannel(app: AppContext, db: Executor = app.db): Promise<NodeChannel> {
  const { saved, channel } = await resolveSaved(app, db);
  const desired = { url: channel.effectiveUrl, serverName: certificateName(channel.effectiveUrl) };
  const agents = await enrolledAgents(db);
  const current = (statuses: AgentStatuses["nodes"]) =>
    statuses.filter((status) => nodeChannelStateOf(status, desired) === "current").length;
  const required =
    app.env.EDGEWEIR_NODE_API_WEBSOCKET || isWebSocketNodeChannel(channel.effectiveUrl);
  return {
    ...channel,
    serverName: desired.serverName,
    // The environment's names stay in the certificate whatever happens.
    previousNames: saved.previousHosts
      .filter((name) => name !== desired.serverName && !app.env.nodeApiHostnames.includes(name))
      .map((name) => ({
        name,
        nodes: usingName(agents.nodes, name),
        probes: usingName(agents.probes, name),
      })),
    webSocket: {
      open: required || saved.webSocket,
      closable: !required && saved.webSocket,
      nodes: agents.nodes.filter(nodeChannelUsesWebSocket).length,
      probes: agents.probes.filter(nodeChannelUsesWebSocket).length,
    },
    adoption: {
      nodes: agents.nodes.length,
      nodesCurrent: current(agents.nodes),
      probes: agents.probes.length,
      probesCurrent: current(agents.probes),
    },
  };
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
    await lockNodeChannel(tx);
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

/** Stores the setting and tells every console instance (their certificate and WebSocket entry). */
async function rewrite(
  app: AppContext,
  actor: Actor,
  update: (before: NodeChannelValue, agents: AgentStatuses) => NodeChannelValue,
  metadata: Record<string, string>,
): Promise<NodeChannel> {
  await app.db.transaction(async (tx) => {
    await lockNodeChannel(tx);
    const before = await nodeChannelSetting.read(tx);
    const after = update(before, await enrolledAgents(tx));
    await nodeChannelSetting.write(tx, actor, after, {
      before,
      metadata: () => ({ before: before.url, after: after.url, ...metadata }),
    });
    await tx.execute(sql`select pg_notify(${NODE_CHANNEL_CHANNEL}, '{}')`);
  });
  app.events.emitNodeChannelLocal();
  return getNodeChannel(app);
}

/**
 * Takes a name an earlier URL left in the node channel certificate out of it, once no node or
 * probe whose certificate is still valid connects with it (usingName). An agent with an
 * expired certificate must enroll again anyway; the environment's names always stay.
 */
export async function removeNodeChannelName(
  app: AppContext,
  name: string,
  actor: Actor,
): Promise<NodeChannel> {
  const target = name.toLowerCase();
  return rewrite(
    app,
    actor,
    (before, agents) => {
      const current = certificateName(resolve(app, before.url).effectiveUrl);
      if (
        target === current ||
        app.env.nodeApiHostnames.includes(target) ||
        !before.previousHosts.includes(target)
      )
        fail("NODE_CHANNEL_NAME_NOT_FOUND", "not a name an earlier node channel URL left");
      const nodes = usingName(agents.nodes, target);
      const probes = usingName(agents.probes, target);
      if (nodes || probes)
        fail("NODE_CHANNEL_NAME_IN_USE", "nodes or probes may still connect with this name", {
          nodes,
          probes,
        });
      return { ...before, previousHosts: before.previousHosts.filter((host) => host !== target) };
    },
    { removedName: target },
  );
}

/**
 * Closes the WebSocket entry an earlier wss:// or ws:// URL opened, once no node or probe whose
 * certificate is still valid may use it.
 */
export async function closeNodeChannelWebSocket(
  app: AppContext,
  actor: Actor,
): Promise<NodeChannel> {
  return rewrite(
    app,
    actor,
    (before, agents) => {
      if (
        !before.webSocket ||
        app.env.EDGEWEIR_NODE_API_WEBSOCKET ||
        isWebSocketNodeChannel(resolve(app, before.url).effectiveUrl)
      )
        fail("NODE_CHANNEL_WEBSOCKET_REQUIRED", "the WebSocket entry stays open");
      const nodes = agents.nodes.filter(nodeChannelUsesWebSocket).length;
      const probes = agents.probes.filter(nodeChannelUsesWebSocket).length;
      if (nodes || probes)
        fail("NODE_CHANNEL_WEBSOCKET_IN_USE", "nodes or probes may still use the WebSocket entry", {
          nodes,
          probes,
        });
      return { ...before, webSocket: false };
    },
    { webSocket: "closed" },
  );
}
