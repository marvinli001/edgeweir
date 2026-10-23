import { describe, expect, it } from "vitest";
import { connectionLimitSettings, greylistCreateInput } from "../src/index";

describe("greylist entries", () => {
  const base = {
    scope: "platform",
    cidr: "203.0.113.0/24",
    reason: "abuse",
    durationSeconds: 3600,
  };

  it("takes a challenge or a rate limit", () => {
    expect(
      greylistCreateInput.safeParse({ ...base, action: { kind: "challenge", challenge: "pow" } })
        .success,
    ).toBe(true);
    expect(
      greylistCreateInput.safeParse({
        ...base,
        action: { kind: "rate_limit", requests: 60, windowSeconds: 60 },
      }).success,
    ).toBe(true);
  });

  it("refuses unknown challenges, out-of-range limits and a site mismatch", () => {
    for (const action of [
      { kind: "challenge", challenge: "block" },
      { kind: "rate_limit", requests: 0, windowSeconds: 60 },
      { kind: "rate_limit", requests: 100_001, windowSeconds: 60 },
      { kind: "rate_limit", requests: 10, windowSeconds: 3601 },
      { kind: "block" },
    ])
      expect(greylistCreateInput.safeParse({ ...base, action }).success, action.kind).toBe(false);
    const action = { kind: "challenge", challenge: "js" };
    expect(greylistCreateInput.safeParse({ ...base, scope: "site", action }).success).toBe(false);
    expect(
      greylistCreateInput.safeParse({
        ...base,
        siteId: "00000000-0000-4000-8000-000000000001",
        action,
      }).success,
    ).toBe(false);
  });
});

describe("connection limit settings", () => {
  const base = { enabled: true, perIp: 100, newPerSecond: 20, burst: 0, ports: null };
  const ok = (patch: object) => connectionLimitSettings.safeParse({ ...base, ...patch }).success;

  it("takes either limit alone, a burst at or above the rate and port ranges", () => {
    expect(ok({})).toBe(true);
    expect(ok({ newPerSecond: 0 })).toBe(true);
    expect(ok({ perIp: 0 })).toBe(true);
    expect(ok({ burst: 20 })).toBe(true);
    expect(
      ok({
        ports: [
          { start: 443, end: 443 },
          { start: 80, end: 80 },
        ],
      }),
    ).toBe(true);
    // Off keeps whatever values it has.
    expect(ok({ enabled: false, perIp: 0, newPerSecond: 0 })).toBe(true);
  });

  it("refuses no limit, a low burst, a burst without a rate and bad ports", () => {
    expect(ok({ perIp: 0, newPerSecond: 0 })).toBe(false);
    expect(ok({ burst: 5 })).toBe(false);
    expect(ok({ newPerSecond: 0, burst: 5 })).toBe(false);
    expect(ok({ perIp: 100_001 })).toBe(false);
    expect(ok({ ports: [] })).toBe(false);
    expect(ok({ ports: [{ start: 90, end: 80 }] })).toBe(false);
    expect(ok({ ports: [{ start: 0, end: 80 }] })).toBe(false);
    expect(
      ok({
        ports: [
          { start: 80, end: 90 },
          { start: 90, end: 95 },
        ],
      }),
    ).toBe(false);
  });
});
