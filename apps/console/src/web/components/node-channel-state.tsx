import {
  isChannelErrorCode,
  type NodeChannelState,
  type NodeChannelStatus,
  nodeChannelStateOf,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const STATE_LABELS: Record<Exclude<NodeChannelState, "current" | "unknown">, () => string> = {
  pending: () => m.node_channel_state_pending(),
  failed: () => m.node_channel_state_failed(),
  fallback: () => m.node_channel_state_fallback(),
  upgrade: () => m.node_channel_state_upgrade(),
};

const ERROR_TEXT: Record<string, () => string> = {
  unreachable: () => m.node_channel_error_unreachable(),
  websocket_refused: () => m.node_channel_error_websocket_refused(),
  tls_untrusted: () => m.node_channel_error_tls_untrusted(),
  rejected: () => m.node_channel_error_rejected(),
  wrong_identity: () => m.node_channel_error_wrong_identity(),
  invalid_address: () => m.node_channel_error_invalid_address(),
};

/** Why an address failed its check: the localized code, else the agent's own text. */
export function channelErrorText(error: NonNullable<NodeChannelStatus["error"]>): string {
  return isChannelErrorCode(error.code)
    ? (ERROR_TEXT[error.code]?.() ?? error.message)
    : error.message;
}

/** The state of a node or probe against the address the console gives out (undefined: loading). */
export function useNodeChannelState(
  status: NodeChannelStatus | null,
): NodeChannelState | undefined {
  const channel = useQuery({ ...orpc.settings.nodeChannel.queryOptions(), staleTime: 30_000 });
  if (!channel.data) return undefined;
  return nodeChannelStateOf(status, {
    url: channel.data.effectiveUrl,
    serverName: channel.data.serverName,
  });
}

/** A badge while a node or probe is not on the console's address (nothing once it is). */
export function NodeChannelBadge({
  status,
  testId,
}: {
  status: NodeChannelStatus | null;
  testId: string;
}) {
  const state = useNodeChannelState(status);
  if (!state || state === "current" || state === "unknown") return null;
  const title = status?.error ? channelErrorText(status.error) : undefined;
  return (
    <Badge
      variant={state === "failed" ? "destructive" : "outline"}
      title={title}
      data-testid={testId}
      data-state={state}
    >
      {STATE_LABELS[state]()}
    </Badge>
  );
}

/** A node's node channel address in the details: in use, its fallback, and what went wrong. */
export function NodeChannelFact({ status }: { status: NodeChannelStatus | null }) {
  const state = useNodeChannelState(status);
  if (!status) return <span className="text-muted-foreground">—</span>;
  const inUse = status.onFallback ? status.fallbackUrl : status.url;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {inUse ? (
          <span className="font-mono break-all" data-testid="node-channel-url">
            {inUse}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        <NodeChannelBadge status={status} testId="node-channel-state" />
      </span>
      {(state === "failed" || state === "fallback") && status.error ? (
        <span className="text-xs text-destructive" data-testid="node-channel-error">
          {channelErrorText(status.error)}
        </span>
      ) : null}
      {status.fallbackUrl && !status.onFallback ? (
        <span
          className="text-xs break-all text-muted-foreground"
          data-testid="node-channel-fallback"
        >
          {m.node_channel_fallback({ url: status.fallbackUrl })}
        </span>
      ) : null}
    </span>
  );
}
