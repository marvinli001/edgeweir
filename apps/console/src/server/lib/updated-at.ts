import { fail } from "./errors";

/**
 * Optimistic concurrency: 409 UPDATED_AT_MISMATCH, with the current value in
 * `data.updatedAt` ("" when there is none yet), when the caller read an older
 * version.
 */
export function assertUpdatedAt(
  current: Date | null | undefined,
  expected: string | undefined,
  message = "the resource changed since it was read",
) {
  if (expected !== undefined && current?.getTime() !== Date.parse(expected))
    fail("UPDATED_AT_MISMATCH", message, { updatedAt: current?.toISOString() ?? "" });
}

/** A newer `updated_at` than the stored one, so that editors holding the old one get a 409. */
export const nextUpdatedAt = (previous: Date | null | undefined) =>
  new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
