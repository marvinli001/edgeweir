import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/** Usage windows are UTC and 5 minutes long. */
export const USAGE_WINDOW_SECONDS = 300;
export const MAX_USAGE_PAGE = 5000;

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

/**
 * Usage of one site in one window. The id is fixed per site and window; a
 * recomputation that changes a value keeps the id, increments `revision`
 * and takes a higher `seq`.
 */
export const usageRecord = z.object({
  id: z.string(),
  siteId: uuid,
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  /** Decimal integer strings (exact beyond 2^53). */
  requests: decimal,
  bytesSent: decimal,
  bytesReceived: decimal,
  revision: z.number().int().min(1),
  seq: decimal,
  updatedAt: isoDateTime,
});

export const usageListInput = z.object({
  /** Inclusive; a multiple of 5 minutes (UTC). */
  from: isoDateTime,
  /** Exclusive; a multiple of 5 minutes (UTC), after `from`. */
  to: isoDateTime,
  siteId: uuid.optional(),
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USAGE_PAGE).default(1000),
});

export const usageChangesInput = z.object({
  /** Returns records with a higher seq; "0" starts from the beginning. */
  afterSeq: decimal.default("0"),
  limit: z.coerce.number().int().min(1).max(MAX_USAGE_PAGE).default(1000),
});

/**
 * Windows that end at or before completeUntil have data from every node that
 * was active then; later data for them arrives as a revision. Null until
 * the first window is complete.
 */
const completeUntil = isoDateTime.nullable();

export const usageContract = {
  list: oc
    .route({ method: "GET", path: "/usage", tags: ["usage"] })
    .input(usageListInput)
    .output(
      z.object({
        items: z.array(usageRecord),
        nextCursor: z.string().nullable(),
        completeUntil,
      }),
    ),
  /** Records created or revised after `afterSeq`, in seq order (incremental sync). */
  changes: oc
    .route({ method: "GET", path: "/usage/changes", tags: ["usage"] })
    .input(usageChangesInput)
    .output(
      z.object({
        items: z.array(usageRecord),
        /** Pass as afterSeq next time; equals afterSeq when nothing changed. */
        lastSeq: decimal,
        completeUntil,
      }),
    ),
};

export const usageSettings = z.object({
  /** Days usage records are kept. */
  retentionDays: z.number().int().min(35).max(400),
  /** Nodes not seen for longer no longer hold back completeUntil. */
  offlineThresholdMinutes: z.number().int().min(5).max(1440),
});

export type UsageRecord = z.infer<typeof usageRecord>;
export type UsageSettings = z.infer<typeof usageSettings>;
