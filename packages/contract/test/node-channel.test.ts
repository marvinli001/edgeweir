import { describe, expect, it } from "vitest";
import {
  type NodeChannelStatus,
  nodeChannelName,
  nodeChannelNamesInUse,
  nodeChannelStateOf,
  nodeChannelUsesWebSocket,
  sameNodeChannelAddress,
} from "../src/index";

const at = "2026-10-14T00:00:00.000Z";
const desired = { url: "https://new.example.test:8443", serverName: "new.example.test" };

/** A report of an agent with channel-follow-v1 that uses `url`, seen with its own name. */
const reporting = (url: string, extra: Partial<NodeChannelStatus> = {}): NodeChannelStatus => ({
  url,
  serverName: "",
  fallbackUrl: null,
  fallbackServerName: "",
  onFallback: false,
  source: "enroll",
  switchedAt: at,
  error: null,
  observedServerName: nodeChannelName({ url, serverName: "" }),
  observedWebSocket: url.startsWith("ws"),
  observedAt: at,
  ...extra,
});

/** An agent without channel-follow-v1: only its connection is known. */
const older = (observedServerName: string, observedWebSocket = false): NodeChannelStatus => ({
  url: null,
  serverName: "",
  fallbackUrl: null,
  fallbackServerName: "",
  onFallback: false,
  source: null,
  switchedAt: null,
  error: null,
  observedServerName,
  observedWebSocket,
  observedAt: at,
});

describe("node channel addresses", () => {
  it("compares addresses as nodes do", () => {
    expect(
      sameNodeChannelAddress(
        { url: "https://New.Example.test:443", serverName: "" },
        { url: "https://new.example.test/", serverName: "NEW.example.test" },
      ),
    ).toBe(true);
    expect(
      sameNodeChannelAddress(
        { url: "wss://new.example.test:443", serverName: "" },
        { url: "wss://new.example.test", serverName: "" },
      ),
    ).toBe(true);
    for (const other of [
      { url: "wss://new.example.test:8443", serverName: "" },
      { url: "https://new.example.test:9443", serverName: "" },
      { url: "https://new.example.test:8443", serverName: "other.example.test" },
      { url: "https://new.example.test:8443/path", serverName: "" },
    ])
      expect(sameNodeChannelAddress(desired, other), other.url).toBe(false);
    expect(nodeChannelName({ url: "https://[2001:DB8::7]:8443", serverName: "" })).toBe(
      "2001:db8::7",
    );
  });

  it("tells how an agent stands to the console's address", () => {
    expect(nodeChannelStateOf(null, desired)).toBe("unknown");
    expect(nodeChannelStateOf(reporting(desired.url), desired)).toBe("current");
    const old = "https://old.example.test:8443";
    expect(nodeChannelStateOf(reporting(old), desired)).toBe("pending");
    const error = {
      code: "unreachable",
      message: "dial tcp: i/o timeout",
      url: desired.url,
      serverName: desired.serverName,
      at,
    };
    expect(nodeChannelStateOf(reporting(old, { error }), desired)).toBe("failed");
    // A failure for an earlier address of the console does not count.
    const earlier = { ...error, url: "https://older.example.test:8443", serverName: "" };
    expect(nodeChannelStateOf(reporting(old, { error: earlier }), desired)).toBe("pending");
    expect(
      nodeChannelStateOf(
        reporting(desired.url, { onFallback: true, fallbackUrl: old, error }),
        desired,
      ),
    ).toBe("fallback");
    // Older agents: by the server name and entry of their latest connection.
    expect(nodeChannelStateOf(older("new.example.test"), desired)).toBe("current");
    expect(nodeChannelStateOf(older("old.example.test"), desired)).toBe("upgrade");
    expect(nodeChannelStateOf(older("new.example.test", true), desired)).toBe("upgrade");
    // No server name: an IP address, which a host name cannot be.
    expect(nodeChannelStateOf(older(""), desired)).toBe("upgrade");
    expect(nodeChannelStateOf(older(""), { url: "https://192.0.2.7:8443", serverName: "" })).toBe(
      "current",
    );
  });

  it("counts the names agents connect with, not the fallbacks they keep", () => {
    const old = "https://old.example.test:8443";
    expect([
      ...(nodeChannelNamesInUse(reporting(desired.url, { fallbackUrl: old })) ?? []),
    ]).toEqual(["new.example.test"]);
    // On the fallback: its name counts (and the connection shows it).
    const onFallback = reporting(desired.url, {
      fallbackUrl: old,
      onFallback: true,
      observedServerName: "old.example.test",
    });
    expect(nodeChannelNamesInUse(onFallback)).toEqual(new Set(["old.example.test"]));
    expect(nodeChannelNamesInUse(older("old.example.test"))).toEqual(new Set(["old.example.test"]));
    // An older agent that sent no server name may use any IP address name.
    expect(nodeChannelNamesInUse(older(""))).toBeNull();
    expect(nodeChannelNamesInUse(null)).toBeNull();
  });

  it("tells which agents use the WebSocket entry", () => {
    expect(nodeChannelUsesWebSocket(reporting("wss://new.example.test"))).toBe(true);
    expect(
      nodeChannelUsesWebSocket(reporting(desired.url, { fallbackUrl: "wss://old.example.test" })),
    ).toBe(false);
    expect(
      nodeChannelUsesWebSocket(
        reporting(desired.url, { fallbackUrl: "wss://old.example.test", onFallback: true }),
      ),
    ).toBe(true);
    expect(nodeChannelUsesWebSocket(older("new.example.test", true))).toBe(true);
    expect(nodeChannelUsesWebSocket(null)).toBe(false);
  });
});
