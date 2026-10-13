import {
  isWebSocketNodeChannel,
  type NodeChannelAddress,
  nodeChannelName,
  parseIp,
  sameNodeChannelAddress,
} from "./addresses";
import type { NodeChannelState, NodeChannelStatus } from "./schemas";

/**
 * How a node or probe stands to the address the console gives out: from its
 * report when it has channel-follow-v1, otherwise from the TLS server name
 * and entry of its latest connection (an IP address sends no server name,
 * so only the entry counts then).
 */
export function nodeChannelStateOf(
  status: NodeChannelStatus | null,
  desired: NodeChannelAddress,
): NodeChannelState {
  if (!status) return "unknown";
  if (status.url !== null) {
    if (status.onFallback) return "fallback";
    if (sameNodeChannelAddress({ url: status.url, serverName: status.serverName }, desired))
      return "current";
    if (status.error && sameNodeChannelAddress(status.error, desired)) return "failed";
    return "pending";
  }
  const name = nodeChannelName(desired);
  const sameEntry = status.observedWebSocket === isWebSocketNodeChannel(desired.url);
  // Without a server name the agent verifies an IP address: perhaps the one given out.
  const sameName =
    status.observedServerName === ""
      ? parseIp(name) !== null
      : status.observedServerName.toLowerCase() === name;
  return sameEntry && sameName ? "current" : "upgrade";
}

/** The address a reporting agent connects to now: its own, or its fallback while on it. */
function inUse(status: NodeChannelStatus): NodeChannelAddress | null {
  if (status.url === null) return null;
  if (status.onFallback && status.fallbackUrl)
    return { url: status.fallbackUrl, serverName: status.fallbackServerName };
  return { url: status.url, serverName: status.serverName };
}

/**
 * The names a node or probe connects with: the address it reports using
 * (its fallback only while it runs on it; a fallback kept for later does not
 * count) and the server name of its latest connection. null: it may use any
 * IP address name (an older agent that sent no server name).
 */
export function nodeChannelNamesInUse(status: NodeChannelStatus | null): Set<string> | null {
  if (!status) return null;
  const names = new Set<string>();
  if (status.observedServerName) names.add(status.observedServerName.toLowerCase());
  const address = inUse(status);
  if (address) {
    names.add(nodeChannelName(address));
    return names;
  }
  return status.observedServerName ? names : null;
}

/** Whether a node or probe connects through the WebSocket entry. */
export function nodeChannelUsesWebSocket(status: NodeChannelStatus | null): boolean {
  if (!status) return false;
  const address = inUse(status);
  return status.observedWebSocket || (address !== null && isWebSocketNodeChannel(address.url));
}
