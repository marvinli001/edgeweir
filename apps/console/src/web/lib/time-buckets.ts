const MINUTE_MS = 60_000;

/** Minutes since the epoch on the viewer's wall clock, so boundaries fall on local hours and days. */
export function localMinutes(time: number): number {
  return Math.floor((time - new Date(time).getTimezoneOffset() * MINUTE_MS) / MINUTE_MS);
}

/** Bar widths that read as clock units, in minutes. */
const GROUP_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1_440];

export type BucketGroup = {
  /** Start of the group's span. */
  time: string;
  /** Per series, the sum of the group's buckets. */
  values: number[];
  /**
   * Whether the group holds exactly the buckets of its span, each ended by
   * `settled`: not the partial groups at the window's ends, nor a span a
   * clock change shortened or stretched.
   */
  complete: boolean;
};

/**
 * Merges adjacent buckets into groups aligned to the viewer's clock, so a chart keeps at most
 * about `max` points (hourly bars for a day of 10-minute buckets). Each group is labeled by the
 * start of its span; the first and the last one may be partial (`complete` is false), and so is
 * one with a bucket that ends after `settled` (its data may still be arriving).
 */
export function groupBuckets(
  times: string[],
  series: number[][],
  bucketSeconds: number,
  max = 32,
  settled = Number.POSITIVE_INFINITY,
): BucketGroup[] {
  const bucketMinutes = bucketSeconds / 60;
  const spanMinutes =
    GROUP_MINUTES.find(
      (span) => span % bucketMinutes === 0 && (times.length * bucketMinutes) / span <= max,
    ) ?? times.length * bucketMinutes;
  const perGroup = spanMinutes / bucketMinutes;
  const groups: (BucketGroup & { buckets: number; open: boolean })[] = [];
  let key: number | null = null;
  times.forEach((time, index) => {
    const at = new Date(time).getTime();
    const local = localMinutes(at);
    const next = Math.floor(local / spanMinutes);
    if (next !== key) {
      key = next;
      // Start of the span on the wall clock, counted back from this bucket's own instant.
      const start = at - (local - next * spanMinutes) * MINUTE_MS;
      groups.push({
        time: new Date(start).toISOString(),
        values: series.map(() => 0),
        complete: false,
        buckets: 0,
        open: false,
      });
    }
    const group = groups.at(-1);
    if (!group) return;
    group.buckets++;
    if (at + bucketSeconds * 1000 > settled) group.open = true;
    for (let i = 0; i < series.length; i++) {
      group.values[i] = (group.values[i] ?? 0) + (series[i]?.[index] ?? 0);
    }
  });
  return groups.map(({ buckets, open, ...group }) => ({
    ...group,
    complete: !open && buckets === perGroup,
  }));
}

/**
 * The complete groups, for line charts: a partial group at either end of the window sums fewer
 * buckets and would read as a dip. All groups when none is complete.
 */
export function wholeGroups(groups: BucketGroup[]): BucketGroup[] {
  const whole = groups.filter((group) => group.complete);
  return whole.length ? whole : groups;
}
