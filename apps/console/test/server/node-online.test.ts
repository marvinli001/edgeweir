import { afterEach, describe, expect, it } from "vitest";
import {
  heartbeatSeconds,
  isOnline,
  onlineWindowSeconds,
  setHeartbeatSeconds,
} from "../../src/server/lib/node-online";

describe("node online window", () => {
  afterEach(() => setHeartbeatSeconds(undefined));

  it("is three 15-second heartbeats by default", () => {
    expect([heartbeatSeconds(), onlineWindowSeconds()]).toEqual([15, 45]);
    const now = Date.now();
    expect(isOnline(new Date(now - 45_000), now)).toBe(true);
    expect(isOnline(new Date(now - 45_001), now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
  });

  it("shrinks with the end-to-end heartbeat", () => {
    setHeartbeatSeconds(5);
    expect([heartbeatSeconds(), onlineWindowSeconds()]).toEqual([5, 15]);
    const now = Date.now();
    expect(isOnline(new Date(now - 15_000), now)).toBe(true);
    expect(isOnline(new Date(now - 16_000), now)).toBe(false);
  });
});
