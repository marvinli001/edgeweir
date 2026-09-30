import { fail } from "./errors";

/**
 * Optimistic concurrency: 409 UPDATED_AT_MISMATCH, with the current value in
 * `data.updatedAt`, when the caller read an older version.
 */
export function assertUpdatedAt(current: Date, expected: string | undefined) {
  if (expected !== undefined && current.getTime() !== Date.parse(expected))
    fail("UPDATED_AT_MISMATCH", "the resource changed since it was read", {
      updatedAt: current.toISOString(),
    });
}
