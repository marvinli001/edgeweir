import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { groupBuckets, wholeGroups } from "../../src/web/lib/time-buckets";

/** `count` one-minute buckets from `from`, each counting one. */
function minutes(from: string, count: number) {
  const start = Date.parse(from);
  const times = Array.from({ length: count }, (_, i) => new Date(start + i * 60_000).toISOString());
  return { times, series: [times.map(() => 1)] };
}

// Spans of up to 15 minutes start at the same instants in every time zone.
describe("bucket groups", () => {
  it("marks the partial groups at both ends of the window", () => {
    // Six hours and a minute from 12:02: five-minute groups from 12:00 to 18:00.
    const { times, series } = minutes("2026-10-07T12:02:00Z", 361);
    const groups = groupBuckets(times, series, 60, 120);
    expect(groups).toHaveLength(73);
    expect(groups[0]).toEqual({ time: "2026-10-07T12:00:00.000Z", values: [3], complete: false });
    expect(groups[1]).toEqual({ time: "2026-10-07T12:05:00.000Z", values: [5], complete: true });
    expect(groups.at(-1)).toEqual({
      time: "2026-10-07T18:00:00.000Z",
      values: [3],
      complete: false,
    });
    expect(groups.reduce((sum, group) => sum + (group.values[0] ?? 0), 0)).toBe(361);
  });

  it("keeps only complete groups for lines, so their ends do not dip", () => {
    const { times, series } = minutes("2026-10-07T12:02:00Z", 361);
    const whole = wholeGroups(groupBuckets(times, series, 60, 120));
    expect(whole).toHaveLength(71);
    expect(whole[0]?.time).toBe("2026-10-07T12:05:00.000Z");
    expect(whole.at(-1)?.time).toBe("2026-10-07T17:55:00.000Z");
    expect(whole.every((group) => group.values[0] === 5)).toBe(true);
  });

  it("leaves buckets that need no grouping whole", () => {
    const { times, series } = minutes("2026-10-07T12:02:30Z", 61);
    const groups = groupBuckets(times, series, 60, 120);
    expect(groups).toHaveLength(61);
    expect(groups.every((group) => group.complete && group.values[0] === 1)).toBe(true);
    expect(wholeGroups(groups)).toEqual(groups);
  });

  it("counts a bucket that ends after `settled` as partial, so the line stops before data still arriving", () => {
    // Ungrouped minutes up to 13:02 seen at 13:02:30: 13:01 and 13:02 may still be reported.
    const minutesOnly = minutes("2026-10-07T12:02:00Z", 61);
    const settled = Date.parse("2026-10-07T13:02:30Z") - 60_000;
    const ungrouped = wholeGroups(
      groupBuckets(minutesOnly.times, minutesOnly.series, 60, 120, settled),
    );
    expect(ungrouped).toHaveLength(59);
    expect(ungrouped.at(-1)?.time).toBe("2026-10-07T13:00:00.000Z");
    // Five-minute groups ending 17:59 seen at 17:59:30: the last group is full but not settled.
    const { times, series } = minutes("2026-10-07T12:02:00Z", 358);
    const groups = groupBuckets(times, series, 60, 120, Date.parse("2026-10-07T17:58:30Z"));
    expect(groups.at(-1)).toEqual({
      time: "2026-10-07T17:55:00.000Z",
      values: [5],
      complete: false,
    });
    expect(wholeGroups(groups).at(-1)?.time).toBe("2026-10-07T17:50:00.000Z");
  });

  it("keeps every group when none is complete", () => {
    const { times, series } = minutes("2026-10-07T12:03:00Z", 3);
    const groups = groupBuckets(times, series, 60, 1);
    expect(groups.map((group) => [group.values[0], group.complete])).toEqual([
      [2, false],
      [1, false],
    ]);
    expect(wholeGroups(groups)).toEqual(groups);
  });
});

describe("bucket groups across a clock change", () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    // Berlin falls back from 03:00 CEST to 02:00 CET at 01:00 UTC on 2026-10-25.
    process.env.TZ = "Europe/Berlin";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("labels each group by its first instant and leaves the stretched span out of lines", () => {
    // Hourly buckets from 22:00 CEST on the 24th to 07:00 CET on the 25th, in two-hour groups.
    const start = Date.parse("2026-10-24T20:00:00Z");
    const times = Array.from({ length: 11 }, (_, i) =>
      new Date(start + i * 3_600_000).toISOString(),
    );
    const groups = groupBuckets(times, [times.map(() => 1)], 3600, 6);
    expect(groups.map((group) => [group.time, group.values[0], group.complete])).toEqual([
      ["2026-10-24T20:00:00.000Z", 2, true],
      ["2026-10-24T22:00:00.000Z", 2, true],
      // 02:00 CEST, 02:00 CET and 03:00 CET: three hours in the local 02:00–04:00 span.
      ["2026-10-25T00:00:00.000Z", 3, false],
      ["2026-10-25T03:00:00.000Z", 2, true],
      ["2026-10-25T05:00:00.000Z", 2, true],
    ]);
    expect(wholeGroups(groups).map((group) => group.values[0])).toEqual([2, 2, 2, 2]);
  });
});
