import { oc } from "@orpc/contract";
import * as z from "zod";
import { type Cidr, cidrContains, cidrsOverlap, formatCidr, parseCidr } from "./addresses";
import { isoDateTime, uuid } from "./schemas";

/**
 * Dynamic IP bans: addresses or prefixes blocked until they expire, sent to
 * the nodes outside configuration revisions. Long-term blocking belongs in
 * IP lists.
 */

export const MANUAL_BAN_REASONS = ["abuse", "attack", "scanner", "spam", "other"] as const;
export const AUTO_BAN_REASONS = ["cc_ip_rate"] as const;

export const banScope = z.enum(["platform", "site"]);
export const banSource = z.enum(["manual", "auto"]);
export const manualBanReason = z.enum(MANUAL_BAN_REASONS);
export const autoBanReason = z.enum(AUTO_BAN_REASONS);
export const banReason = z.enum([...MANUAL_BAN_REASONS, ...AUTO_BAN_REASONS]);

/** A ban lasts from one minute to seven days. */
export const BAN_MIN_SECONDS = 60;
export const BAN_MAX_SECONDS = 7 * 24 * 3600;
/** Durations the console offers when banning. */
export const BAN_DURATIONS = [3600, 6 * 3600, 24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600] as const;
/** Shortest prefix a ban may cover. */
export const BAN_MIN_PREFIX = { 4: 16, 6: 48 } as const;
/** Page size of GetBans: default and cap. */
export const BAN_PAGE_DEFAULT = 2000;
export const BAN_PAGE_MAX = 5000;
/** Automatic bans a node reports per ReportBans call. */
export const MAX_REPORTED_BANS = 1000;
/** Active automatic bans kept per cluster; the oldest go first. */
export const MAX_AUTO_BANS_PER_CLUSTER = 10000;
/** Loopback and unspecified addresses, which no ban may cover. */
export const BAN_PROTECTED_RANGES = ["0.0.0.0/8", "127.0.0.0/8", "::/128", "::1/128"] as const;

const MAPPED_V4 = parseCidr("::ffff:0:0/96") as Cidr;

export type BanCidr =
  | { ok: true; cidr: Cidr; text: string }
  | { ok: false; code: "BAN_INVALID_CIDR" }
  | { ok: false; code: "BAN_PREFIX_TOO_SHORT"; min: number };

/**
 * Parses an address or CIDR for a ban: host bits are cleared, IPv6 is
 * lowercase and compressed, an IPv4-mapped IPv6 prefix becomes IPv4, and the
 * prefix must be at least /16 (IPv4) or /48 (IPv6).
 */
export function parseBanCidr(input: string): BanCidr {
  let cidr = parseCidr(input.trim());
  if (!cidr) return { ok: false, code: "BAN_INVALID_CIDR" };
  if (cidr.version === 6 && cidr.prefix >= 96 && cidrContains(MAPPED_V4, cidr))
    cidr = { version: 4, bytes: cidr.bytes.slice(12), prefix: cidr.prefix - 96 };
  const min = BAN_MIN_PREFIX[cidr.version];
  if (cidr.prefix < min) return { ok: false, code: "BAN_PREFIX_TOO_SHORT", min };
  return { ok: true, cidr, text: formatCidr(cidr) };
}

/** A single address ("/32" or "/128"), as automatic bans must be. */
export function isSingleAddress(cidr: Cidr): boolean {
  return cidr.prefix === (cidr.version === 4 ? 32 : 128);
}

/**
 * The first protected address or range the ban overlaps, or null. `extra`
 * holds addresses and CIDRs besides loopback and unspecified (node addresses,
 * the platform allow list).
 */
export function protectedBanOverlap(cidr: Cidr, extra: readonly string[]): string | null {
  for (const text of [...BAN_PROTECTED_RANGES, ...extra]) {
    const other = parseCidr(text.trim());
    if (other && cidrsOverlap(cidr, other)) return text;
  }
  return null;
}

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const banTrigger = z.object({
  /** e.g. ip_qps */
  metric: z.string(),
  observed: z.number(),
  threshold: z.number(),
  windowSeconds: z.number().int(),
});

export const ban = z.object({
  id: uuid,
  scope: banScope,
  /** Canonical CIDR, e.g. "203.0.113.7/32". */
  cidr: z.string(),
  reason: banReason,
  source: banSource,
  /** Null for platform bans. */
  siteId: uuid.nullable(),
  siteName: z.string().nullable(),
  /** Node that created an automatic ban. */
  node: z.object({ id: uuid, name: z.string() }).nullable(),
  trigger: banTrigger.nullable(),
  /** Who created a manual ban. */
  createdBy: z.object({ type: z.string(), id: z.string(), name: z.string() }).nullable(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  /** Position in the ban change sequence (decimal). */
  seq: decimal,
  /** Sent to the nodes (automatic bans only while sharing is on). */
  distributed: z.boolean(),
  /** Online nodes that report this manual ban as not applied (no room). */
  unappliedNodes: z.number().int(),
});

export const banList = z.object({
  items: z.array(ban),
  total: z.number().int(),
});

/** Active bans only (neither expired nor lifted), newest first. */
export const banListInput = z.object({
  scope: banScope.optional(),
  siteId: uuid.optional(),
  source: banSource.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const banFields = {
  /** An IP address or CIDR; prefixes at least /16 (IPv4) or /48 (IPv6). */
  cidr: z.string().trim().min(1).max(64),
  reason: manualBanReason,
  /** 60 to 604800 seconds. Banning an address again sets the new reason and expiry. */
  durationSeconds: z.number().int(),
};

export const banCreateInput = z
  .object({
    scope: banScope,
    /** Required for site bans, absent for platform bans. */
    siteId: uuid.optional(),
    ...banFields,
  })
  .refine((input) => (input.scope === "site") === (input.siteId !== undefined), {
    message: "siteId is required for site bans and not allowed for platform bans",
    path: ["siteId"],
  });

export const banSettings = z.object({
  /** Active manual bans across the platform. */
  maxTotal: z.number().int().min(100).max(100000),
  /** Automatic bans are sent to the other nodes of the cluster. */
  shareAutoBans: z.boolean(),
});

export const BAN_SETTINGS_DEFAULTS: BanSettings = { maxTotal: 10000, shareAutoBans: true };

const idParam = z.object({ id: uuid });
const ok = z.object({ ok: z.literal(true) });

/** Site bans and platform bans (every site of every cluster). */
export const bansContract = {
  list: oc
    .route({ method: "GET", path: "/bans", tags: ["bans"] })
    .input(banListInput)
    .output(banList),
  create: oc
    .route({ method: "POST", path: "/bans", tags: ["bans"] })
    .input(banCreateInput)
    .output(ban),
  /** Lifts a manual or automatic ban. */
  delete: oc
    .route({ method: "DELETE", path: "/bans/{id}", tags: ["bans"] })
    .input(idParam)
    .output(ok),
};

export type Ban = z.infer<typeof ban>;
export type BanList = z.infer<typeof banList>;
export type BanScope = z.infer<typeof banScope>;
export type BanSource = z.infer<typeof banSource>;
export type BanReason = z.infer<typeof banReason>;
export type BanSettings = z.infer<typeof banSettings>;
export type BanListInput = z.infer<typeof banListInput>;
export type BanCreateInput = z.infer<typeof banCreateInput>;
