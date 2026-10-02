import { EventEmitter } from "node:events";
import { WatchEvent } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import type { ConfigEventBus } from "../../src/server/lib/events";
import { createLogger, setLogLevel } from "../../src/server/lib/logger";
import { type WatchTarget, watchStream } from "../../src/server/node-channel/watch";

setLogLevel("error");
const node = { id: "node-1", clusterId: "cluster-1" };

/** A stream over an in-memory source; `emitter` raises event bus events. */
function open(opts: { bans?: boolean; keepaliveMs?: number; target?: WatchTarget } = {}) {
  const emitter = new EventEmitter();
  const events = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
  } as Pick<ConfigEventBus, "on">;
  const state = { target: opts.target, reads: 0, tasks: false, active: true, banSequence: 7n };
  const abort = new AbortController();
  const stream = watchStream({
    node,
    bans: opts.bans ?? false,
    source: {
      target: async () => {
        state.reads++;
        return state.target;
      },
      hasTasks: async () => state.tasks,
      assertActive: async () => {
        if (!state.active) throw new Error("node is disabled");
      },
      banSequence: async () => state.banSequence,
    },
    events,
    log: createLogger({ test: true }),
    signal: abort.signal,
    keepaliveMs: opts.keepaliveMs ?? 60_000,
  });
  const next = async () => (await stream.next()).value;
  return { emitter, state, abort, stream, next };
}

describe("watch stream", () => {
  it("opens with the node's target and follows its cluster's publications", async () => {
    const { emitter, state, abort, stream, next } = open({
      target: { revision: 3, contentHash: "h3" },
    });
    expect(await next()).toMatchObject({
      event: WatchEvent.REVISION,
      latestRevision: 3n,
      contentHash: "h3",
    });
    const pending = next();
    // Another cluster's publication does not concern the node.
    emitter.emit("config", { clusterId: "cluster-2", revision: 9, contentHash: "x" });
    expect(state.reads).toBe(1);
    state.target = { revision: 4, contentHash: "h4" };
    emitter.emit("config", { clusterId: node.clusterId, revision: 4, contentHash: "h4" });
    expect(await pending).toMatchObject({ event: WatchEvent.REVISION, latestRevision: 4n });
    const tasks = next();
    emitter.emit("tasks", { clusterIds: [node.clusterId] });
    expect(await tasks).toMatchObject({ event: WatchEvent.TASKS, latestRevision: 4n });
    const ended = next();
    abort.abort();
    expect(await ended).toBeUndefined();
    expect((await stream.next()).done).toBe(true);
    // Every listener is removed with the stream.
    expect(emitter.eventNames()).toEqual([]);
  });

  it("announces revision 0 without a target, then keepalives", async () => {
    const { abort, next } = open({ keepaliveMs: 10 });
    expect(await next()).toMatchObject({ event: WatchEvent.REVISION, latestRevision: 0n });
    expect(await next()).toMatchObject({ event: WatchEvent.KEEPALIVE, latestRevision: 0n });
    abort.abort();
  });

  it("sends the ban sequence on open and on changes to nodes with bans", async () => {
    const { emitter, state, abort, next } = open({
      bans: true,
      target: { revision: 2, contentHash: "h2" },
    });
    expect(await next()).toMatchObject({ event: WatchEvent.REVISION, latestRevision: 2n });
    expect(await next()).toMatchObject({ event: WatchEvent.BANS, banSequence: 7n });
    const changed = next();
    state.banSequence = 8n;
    emitter.emit("bans", { clusterIds: null });
    expect(await changed).toMatchObject({
      event: WatchEvent.BANS,
      latestRevision: 2n,
      banSequence: 8n,
    });
    abort.abort();
  });

  it("ends with an error once the node may no longer watch", async () => {
    const { emitter, state, next } = open({ target: { revision: 1, contentHash: "h1" } });
    expect(await next()).toMatchObject({ latestRevision: 1n });
    const failed = next();
    state.active = false;
    emitter.emit("tasks", { clusterIds: [node.clusterId] });
    await expect(failed).rejects.toThrow("node is disabled");
    expect(emitter.eventNames()).toEqual([]);
  });
});
