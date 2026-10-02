import { create } from "@bufbuild/protobuf";
import { type WatchConfigResponse, WatchConfigResponseSchema, WatchEvent } from "@edgeweir/proto";
import type { ConfigEventBus } from "../lib/events";
import type { Logger } from "../lib/logger";

/** A revision a node is told about. */
export interface WatchTarget {
  revision: number;
  contentHash: string;
}

/** What a watch stream reads; the node service binds it to the node and the database. */
export interface WatchSource {
  /** The node's target revision now (a canary node's may be the candidate). */
  target(): Promise<WatchTarget | undefined>;
  /** Whether tasks wait for the node. */
  hasTasks(): Promise<boolean>;
  /** Throws, ending the stream, once the node is disabled, deleted or its certificate superseded. */
  assertActive(): Promise<void>;
  /** The current ban sequence. */
  banSequence(): Promise<bigint>;
}

export interface WatchStreamOptions {
  node: { id: string; clusterId: string };
  /** The node receives dynamic bans: the ban sequence when the stream opens and on every change. */
  bans: boolean;
  source: WatchSource;
  events: Pick<ConfigEventBus, "on">;
  log: Logger;
  /** The request's signal. */
  signal: AbortSignal;
  /** Ends every stream, so the channel can shut down while nodes are connected. */
  closing?: AbortSignal;
  keepaliveMs: number;
}

/**
 * A node's watch stream. Events only mark what is due and wake the
 * stream: published configurations queue the node's target, created tasks
 * and changed bans set a flag, a NOTIFY reconnect re-reads everything.
 * Each round sends pending tasks first, then the highest revision queued
 * since the last one sent (a keepalive when there is none and nothing else
 * to send), then the ban sequence; it waits up to `keepaliveMs` when
 * nothing is due and checks the node is still active before sending.
 */
export async function* watchStream(
  options: WatchStreamOptions,
): AsyncGenerator<WatchConfigResponse, void, undefined> {
  const { node, bans, source, events, log, signal, closing, keepaliveMs } = options;
  const queue: WatchTarget[] = [];
  let tasksPending = false;
  let wake: (() => void) | undefined;
  const push = (item: WatchTarget) => {
    queue.push(item);
    wake?.();
  };
  const refresh = async () => {
    const target = await source.target();
    if (target) push({ revision: target.revision, contentHash: target.contentHash });
    if (await source.hasTasks()) {
      tasksPending = true;
      wake?.();
    }
  };
  // Events arrive outside the stream: a read that fails there is repeated
  // in the stream, where another error ends it and the node reconnects.
  let stale = false;
  const refreshLater = () =>
    refresh().catch((error) => {
      log.warn("watch refresh failed", { nodeId: node.id, error });
      stale = true;
      wake?.();
    });
  const offConfig = events.on("config", (e) => {
    if (e.clusterId === node.clusterId) void refreshLater();
  });
  const offTasks = events.on("tasks", (e) => {
    if (e.clusterIds.includes(node.clusterId)) {
      tasksPending = true;
      wake?.();
    }
  });
  let bansPending = bans;
  const offBans = events.on("bans", (e) => {
    if (bans && (e.clusterIds === null || e.clusterIds.includes(node.clusterId))) {
      bansPending = true;
      wake?.();
    }
  });
  const offReconnect = events.on("reconnected", () => {
    bansPending ||= bans;
    void refreshLater();
  });
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort);
  closing?.addEventListener("abort", onAbort);
  const ended = () => signal.aborted || closing?.aborted === true;
  log.info("watch stream opened", { nodeId: node.id });
  try {
    await refresh();
    if (queue.length === 0) {
      yield create(WatchConfigResponseSchema, {
        event: WatchEvent.REVISION,
        latestRevision: 0n,
      });
    }
    let lastSent = -1;
    while (!ended()) {
      if (tasksPending) {
        tasksPending = false;
        yield create(WatchConfigResponseSchema, {
          event: WatchEvent.TASKS,
          latestRevision: BigInt(Math.max(lastSent, 0)),
        });
        continue;
      }
      if (queue.length === 0 && !bansPending) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, keepaliveMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
      if (ended()) break;
      await source.assertActive();
      if (stale) {
        stale = false;
        await refresh();
      }
      if (tasksPending) continue;
      const item = queue
        .splice(0)
        .reduce<WatchTarget | undefined>(
          (max, cur) => (!max || cur.revision > max.revision ? cur : max),
          undefined,
        );
      if (item && item.revision !== lastSent) {
        lastSent = item.revision;
        yield create(WatchConfigResponseSchema, {
          event: WatchEvent.REVISION,
          latestRevision: BigInt(item.revision),
          contentHash: item.contentHash,
        });
      } else if (!item && !bansPending) {
        yield create(WatchConfigResponseSchema, {
          event: WatchEvent.KEEPALIVE,
          latestRevision: BigInt(Math.max(lastSent, 0)),
        });
      }
      if (bansPending) {
        bansPending = false;
        yield create(WatchConfigResponseSchema, {
          event: WatchEvent.BANS,
          latestRevision: BigInt(Math.max(lastSent, 0)),
          banSequence: await source.banSequence(),
        });
      }
    }
  } finally {
    offConfig();
    offTasks();
    offBans();
    offReconnect();
    signal.removeEventListener("abort", onAbort);
    closing?.removeEventListener("abort", onAbort);
    log.info("watch stream closed", { nodeId: node.id });
  }
}
