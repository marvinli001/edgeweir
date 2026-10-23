import { oc } from "@orpc/contract";
import * as z from "zod";
import { MANUAL_BAN_REASONS } from "./bans";
import { isoDateTime, uuid } from "./schemas";

/**
 * The IP greylist: addresses or prefixes whose requests are challenged or
 * rate-limited instead of refused, until they expire. Entries travel with
 * the bans (GetBans, outside configuration revisions) and share their
 * bounds: prefixes from /16 (IPv4) or /48 (IPv6), 1 minute to 7 days, the
 * manual reasons and the platform total of manual entries. The kernel never
 * drops a greylisted address.
 */

/** greylist-v1: the node asks GetBans for greylist entries and acts on them. */
export const GREYLIST_FEATURE = "greylist-v1";

/** The challenges an entry may ask for, weakest first (the node's levels). */
export const GREYLIST_CHALLENGES = ["cookie302", "js", "pow", "captcha"] as const;
/** Requests per window a client (IPv4 address, IPv6 /64) of a rate-limited entry may send. */
export const GREYLIST_RATE_REQUESTS = { min: 1, max: 100_000, default: 60 } as const;
export const GREYLIST_RATE_WINDOW = { min: 1, max: 3_600, default: 60 } as const;

const greylistScope = z.enum(["platform", "site"]);

const greylistAction = z.discriminatedUnion("kind", [
  /** Requests without a pass of this challenge's level get the challenge. */
  z.object({ kind: z.literal("challenge"), challenge: z.enum(GREYLIST_CHALLENGES) }),
  /** At most `requests` requests per `windowSeconds` per client; 429 above. */
  z.object({
    kind: z.literal("rate_limit"),
    requests: z.number().int().min(GREYLIST_RATE_REQUESTS.min).max(GREYLIST_RATE_REQUESTS.max),
    windowSeconds: z.number().int().min(GREYLIST_RATE_WINDOW.min).max(GREYLIST_RATE_WINDOW.max),
  }),
]);

const greylistEntry = z.object({
  id: uuid,
  scope: greylistScope,
  /** Canonical CIDR, e.g. "203.0.113.0/24". */
  cidr: z.string(),
  reason: z.enum(MANUAL_BAN_REASONS),
  /** Null for platform entries. */
  siteId: uuid.nullable(),
  siteName: z.string().nullable(),
  action: greylistAction,
  createdBy: z.object({ type: z.string(), id: z.string(), name: z.string() }).nullable(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  /** Online nodes that report this entry as not applied (no room). */
  unappliedNodes: z.number().int(),
});

const greylistList = z.object({
  items: z.array(greylistEntry),
  total: z.number().int(),
  /** Active nodes without greylist-v1: they ignore every entry. */
  unsupportedNodes: z.number().int(),
});

/** Active entries only, newest first. */
const greylistListInput = z.object({
  scope: greylistScope.optional(),
  siteId: uuid.optional(),
  /** An address or CIDR: entries that cover it or lie inside it. */
  address: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Greylists an address or prefix of a site or of every site, or greylists
 * the same (scope, site, CIDR) again: that sets the new action, reason and
 * expiry. A ban of the same CIDR is a separate entry and wins while both
 * last.
 */
export const greylistCreateInput = z
  .object({
    scope: greylistScope,
    /** Required for site entries, absent for platform entries. */
    siteId: uuid.optional(),
    /** An IP address or CIDR; prefixes at least /16 (IPv4) or /48 (IPv6). */
    cidr: z.string().trim().min(1).max(64),
    reason: z.enum(MANUAL_BAN_REASONS),
    /** 60 to 604800 seconds. */
    durationSeconds: z.number().int(),
    action: greylistAction,
  })
  .refine((input) => (input.scope === "site") === (input.siteId !== undefined), {
    message: "siteId is required for site entries and not allowed for platform entries",
    path: ["siteId"],
  });

const idParam = z.object({ id: uuid });
const ok = z.object({ ok: z.literal(true) });

export const greylistContract = {
  list: oc
    .route({ method: "GET", path: "/greylist", tags: ["greylist"] })
    .input(greylistListInput)
    .output(greylistList),
  create: oc
    .route({ method: "POST", path: "/greylist", tags: ["greylist"] })
    .input(greylistCreateInput)
    .output(greylistEntry),
  /** Lifts an entry before it expires. */
  delete: oc
    .route({ method: "DELETE", path: "/greylist/{id}", tags: ["greylist"] })
    .input(idParam)
    .output(ok),
};

export type GreylistEntry = z.infer<typeof greylistEntry>;
export type GreylistAction = z.infer<typeof greylistAction>;
export type GreylistList = z.infer<typeof greylistList>;
export type GreylistListInput = z.infer<typeof greylistListInput>;
export type GreylistCreateInput = z.infer<typeof greylistCreateInput>;
