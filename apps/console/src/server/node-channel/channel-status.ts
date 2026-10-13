import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { CHANNEL_FOLLOW_FEATURE, isChannelErrorCode } from "@edgeweir/contract";
import type { schema } from "@edgeweir/db";
import {
  type ChannelAddress,
  ChannelAddressSchema,
  ChannelSource,
  type ChannelStatus,
} from "@edgeweir/proto";
import type { AppContext } from "../lib/context";
import { nodeChannelAddress } from "../services/node-channel-url";
import type { PeerInfo } from "./service";

const MAX_URL = 2048;
const MAX_NAME = 253;
const MAX_MESSAGE = 512;

const clip = (value: string, max: number) => value.slice(0, max);

const SOURCES = {
  [ChannelSource.UNSPECIFIED]: "enroll",
  [ChannelSource.ENROLL]: "enroll",
  [ChannelSource.CONSOLE]: "console",
  [ChannelSource.COMMAND]: "command",
} as const;

/**
 * The node channel data of a heartbeat (or probe round): the agent's report
 * (channel-follow-v1, bounded; none from older agents) and what the console
 * saw of the connection.
 */
export function channelData(
  status: ChannelStatus | undefined,
  peer: PeerInfo,
  now: Date,
): schema.NodeChannelData {
  const observed = {
    serverName: clip((peer.serverName ?? "").toLowerCase(), MAX_NAME),
    webSocket: peer.webSocket === true,
    at: now.toISOString(),
  };
  if (!status?.current?.url) return { observed };
  const failed = status.failed;
  return {
    reported: {
      url: clip(status.current.url, MAX_URL),
      serverName: clip(status.current.serverName, MAX_NAME),
      fallbackUrl: clip(status.fallback?.url ?? "", MAX_URL),
      fallbackServerName: clip(status.fallback?.serverName ?? "", MAX_NAME),
      onFallback: status.onFallback,
      source: SOURCES[status.source] ?? "enroll",
      switchedAt: status.switchedAt ? timestampDate(status.switchedAt).toISOString() : null,
      error: failed?.url
        ? {
            // Unknown codes are kept short; the UI shows the message for them.
            code: isChannelErrorCode(status.errorCode)
              ? status.errorCode
              : clip(status.errorCode, 64),
            message: clip(status.error, MAX_MESSAGE),
            url: clip(failed.url, MAX_URL),
            serverName: clip(failed.serverName, MAX_NAME),
            at: (status.failedAt ? timestampDate(status.failedAt) : now).toISOString(),
          }
        : null,
    },
    observed,
  };
}

/** The address the console gives out to an agent that reports channel-follow-v1 (else none). */
export async function channelAddressFor(
  app: AppContext,
  features: readonly string[],
): Promise<ChannelAddress | undefined> {
  if (!features.includes(CHANNEL_FOLLOW_FEATURE)) return undefined;
  return create(ChannelAddressSchema, await nodeChannelAddress(app));
}
