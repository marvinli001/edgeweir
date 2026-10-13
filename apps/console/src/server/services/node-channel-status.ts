import type { NodeChannelStatus } from "@edgeweir/contract";
import type { schema } from "@edgeweir/db";

/** A node's or probe's stored node channel data as the API shows it. */
export function toNodeChannelStatus(data: schema.NodeChannelData | null): NodeChannelStatus | null {
  if (!data) return null;
  const reported = data.reported;
  return {
    url: reported?.url ?? null,
    serverName: reported?.serverName ?? "",
    fallbackUrl: reported?.fallbackUrl || null,
    fallbackServerName: reported?.fallbackServerName ?? "",
    onFallback: reported?.onFallback ?? false,
    source: reported?.source ?? null,
    switchedAt: reported?.switchedAt ?? null,
    error: reported?.error ?? null,
    observedServerName: data.observed.serverName,
    observedWebSocket: data.observed.webSocket,
    observedAt: data.observed.at,
  };
}
