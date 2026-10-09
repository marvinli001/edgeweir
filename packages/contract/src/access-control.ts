import {
  normalizeHostForm,
  normalizeOriginForm,
  validUserAgentPattern,
} from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { ban } from "./bans";
import { clientIpMode } from "./edge";
import { staticRedirectTarget } from "./rules";
import { expectedUpdatedAt, extension, isoDateTime, pathPrefix, uuid } from "./schemas";

/**
 * A site's access control (feature access-control-v1, ADR-0039): site block
 * and allow lists, geo, CORS, hotlink protection, user agents, WebSocket
 * origins and idle timeout, and security response headers. Each part keeps
 * its settings while off; a site without settings reads as the defaults.
 */
export const ACCESS_MAX_SITE_LISTS = 16;
export const ACCESS_MAX_PREFIXES = 32;
export const HOTLINK_MAX_SOURCES = 200;
export const HOTLINK_MAX_EXTENSIONS = 64;
export const HOTLINK_REDIRECT_MAX = 2048;
export const USER_AGENT_MAX_RULES = 200;
export const CORS_MAX_ORIGINS = 100;
export const CORS_MAX_METHODS = 16;
export const CORS_MAX_HEADERS = 64;
export const CORS_MAX_AGE = { min: 0, max: 86_400, default: 600 } as const;
export const GEO_MAX_ENTRIES = 256;
export const WEBSOCKET_MAX_ORIGINS = 100;
export const WEBSOCKET_IDLE = { min: 60, max: 86_400, default: 3600 } as const;
export const PERMISSIONS_POLICY_MAX = 1024;

/** Common image, audio, video and download types. */
export const HOTLINK_DEFAULT_EXTENSIONS = [
  ...["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff"],
  ...["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"],
  ...["mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "ts", "m3u8", "mpd", "wmv", "3gp"],
  ...["zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "tar", "zst", "exe", "msi", "dmg", "pkg"],
  ...["apk", "ipa", "deb", "rpm", "iso", "pdf"],
] as const;
export const CORS_DEFAULT_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export const FRAME_OPTIONS = ["off", "DENY", "SAMEORIGIN"] as const;
export const REFERRER_POLICIES = [
  "off",
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
] as const;

const hasControl = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const unique = <T>(values: T[]) => [...new Set(values)];

/** Path prefixes count UTF-8 bytes, as nodes compare them. */
const accessPathPrefix = pathPrefix
  .refine(
    (value) => !/[?#]/.test(value) && !hasControl(value),
    "no query, fragment or control characters",
  )
  .refine((value) => new TextEncoder().encode(value).length <= 1024, "at most 1024 bytes");
const prefixes = z.array(accessPathPrefix).max(ACCESS_MAX_PREFIXES).default([]).transform(unique);

const custom = (ctx: z.RefinementCtx, value: string, message: string) => {
  ctx.addIssue({ code: "custom", message, input: value });
  return z.NEVER;
};

/** A hotlink source: `a.com`, `*.a.com`, `.a.com` or `*`, stored lowercase. */
export const hostForm = z
  .string()
  .max(256)
  .transform((value, ctx) => normalizeHostForm(value) ?? custom(ctx, value, "invalid host"));
/** A CORS origin: `https://a.com[:port]`, `https://*.a.com` or `*`. */
export const corsOrigin = z
  .string()
  .max(300)
  .transform(
    (value, ctx) => normalizeOriginForm(value, true) ?? custom(ctx, value, "invalid origin"),
  );
/** A WebSocket origin: `https://a.com[:port]` or `https://*.a.com`. */
export const websocketOrigin = z
  .string()
  .max(300)
  .transform((value, ctx) => normalizeOriginForm(value) ?? custom(ctx, value, "invalid origin"));
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const methodName = z.string().trim().toUpperCase().regex(token, "invalid method");
const headerName = z.string().trim().toLowerCase().regex(token, "invalid header name");

export const hotlinkSettings = z
  .object({
    enabled: z.boolean().default(false),
    allowEmpty: z.boolean().default(true),
    allowSiteDomains: z.boolean().default(true),
    allowed: z.array(hostForm).max(HOTLINK_MAX_SOURCES).default([]).transform(unique),
    denied: z.array(hostForm).max(HOTLINK_MAX_SOURCES).default([]).transform(unique),
    checkOrigin: z.boolean().default(false),
    extensions: z
      .array(extension)
      .max(HOTLINK_MAX_EXTENSIONS)
      .default([...HOTLINK_DEFAULT_EXTENSIONS])
      .transform(unique),
    pathPrefixes: prefixes,
    excludePathPrefixes: prefixes,
    /** deny: 403 with the error page; redirect: 302 to redirectUrl. */
    action: z.enum(["deny", "redirect"]).default("deny"),
    /** A site path or an http(s) URL; required for redirect. */
    redirectUrl: z
      .string()
      .trim()
      .max(HOTLINK_REDIRECT_MAX)
      .refine((v) => v === "" || staticRedirectTarget(v), "invalid redirect target")
      .default(""),
  })
  .superRefine((s, ctx) => {
    if (s.action === "redirect" && !s.redirectUrl)
      ctx.addIssue({ code: "custom", message: "redirect needs a target", path: ["redirectUrl"] });
  });

export const userAgentRule = z.object({
  pattern: z
    .string()
    .refine(
      validUserAgentPattern,
      "invalid pattern: printable ASCII, at most 8 *, escape only * and \\",
    ),
  action: z.enum(["allow", "deny"]),
});
export const userAgentSettings = z.object({
  rules: z.array(userAgentRule).max(USER_AGENT_MAX_RULES).default([]),
  pathPrefixes: prefixes,
  excludePathPrefixes: prefixes,
});

export const corsSettings = z
  .object({
    enabled: z.boolean().default(false),
    allowedOrigins: z.array(corsOrigin).max(CORS_MAX_ORIGINS).default([]).transform(unique),
    allowCredentials: z.boolean().default(false),
    allowedMethods: z
      .array(methodName)
      .min(1)
      .max(CORS_MAX_METHODS)
      .default([...CORS_DEFAULT_METHODS])
      .transform(unique),
    allowedHeaders: z.array(headerName).max(CORS_MAX_HEADERS).default([]).transform(unique),
    /** Answer preflights with their Access-Control-Request-Headers. */
    echoRequestHeaders: z.boolean().default(false),
    exposedHeaders: z.array(headerName).max(CORS_MAX_HEADERS).default([]).transform(unique),
    maxAgeSeconds: z
      .number()
      .int()
      .min(CORS_MAX_AGE.min)
      .max(CORS_MAX_AGE.max)
      .default(CORS_MAX_AGE.default),
    preflightToOrigin: z.boolean().default(false),
    keepOriginHeaders: z.boolean().default(false),
    pathPrefixes: prefixes,
  })
  .superRefine((s, ctx) => {
    if (s.enabled && s.allowedOrigins.length === 0)
      ctx.addIssue({ code: "custom", message: "add an origin", path: ["allowedOrigins"] });
  });

const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "a two-letter country code");
/** `CC-subdivision`: the country code and ip.geoip.subdivision (a code or an English name). */
const subdivision = z
  .string()
  .trim()
  .max(67)
  .transform((value, ctx) => {
    const m = /^([A-Za-z]{2})-(.+)$/.exec(value);
    if (!m || hasControl(value) || new TextEncoder().encode(m[2] ?? "").length > 64)
      return custom(ctx, value, "write CC-subdivision, e.g. US-CA");
    return `${(m[1] ?? "").toUpperCase()}-${m[2]}`;
  });
export const geoSettings = z
  .object({
    enabled: z.boolean().default(false),
    /** allow: only matching clients pass; deny: matching clients get 403. */
    mode: z.enum(["allow", "deny"]).default("deny"),
    countries: z.array(country).max(GEO_MAX_ENTRIES).default([]).transform(unique),
    subdivisions: z.array(subdivision).max(GEO_MAX_ENTRIES).default([]).transform(unique),
    asns: z
      .array(z.number().int().min(1).max(4_294_967_295))
      .max(GEO_MAX_ENTRIES)
      .default([])
      .transform(unique),
    pathPrefixes: prefixes,
    exceptPathPrefixes: prefixes,
  })
  .superRefine((s, ctx) => {
    if (s.enabled && !s.countries.length && !s.subdivisions.length && !s.asns.length)
      ctx.addIssue({
        code: "custom",
        message: "add a country, subdivision or ASN",
        path: ["countries"],
      });
  });

export const websocketSettings = z
  .object({
    allowAllOrigins: z.boolean().default(true),
    origins: z.array(websocketOrigin).max(WEBSOCKET_MAX_ORIGINS).default([]).transform(unique),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(WEBSOCKET_IDLE.min)
      .max(WEBSOCKET_IDLE.max)
      .default(WEBSOCKET_IDLE.default),
  })
  .superRefine((s, ctx) => {
    if (!s.allowAllOrigins && s.origins.length === 0)
      ctx.addIssue({ code: "custom", message: "add an origin", path: ["origins"] });
  });

export const securityHeaderSettings = z.object({
  nosniff: z.boolean().default(false),
  frameOptions: z.enum(FRAME_OPTIONS).default("off"),
  referrerPolicy: z.enum(REFERRER_POLICIES).default("off"),
  /** Empty: not set. */
  permissionsPolicy: z
    .string()
    .trim()
    .max(PERMISSIONS_POLICY_MAX)
    .regex(/^[\x20-\x7e]*$/, "printable ASCII only")
    .default(""),
  hideServer: z.boolean().default(false),
  removePoweredBy: z.boolean().default(false),
});

export const siteListSettings = z.object({
  /** IP lists whose addresses get 403 on this site. */
  blockListIds: z.array(uuid).max(ACCESS_MAX_SITE_LISTS).default([]).transform(unique),
  /** IP lists whose addresses skip this site's block lists, bans, geo, hotlink, user agent checks and challenges. */
  allowListIds: z.array(uuid).max(ACCESS_MAX_SITE_LISTS).default([]).transform(unique),
});

export const accessControlSettings = z.object({
  siteLists: siteListSettings.default(siteListSettings.parse({})),
  hotlink: hotlinkSettings.default(hotlinkSettings.parse({})),
  userAgents: userAgentSettings.default(userAgentSettings.parse({})),
  cors: corsSettings.default(corsSettings.parse({})),
  geo: geoSettings.default(geoSettings.parse({})),
  websocket: websocketSettings.default(websocketSettings.parse({})),
  securityHeaders: securityHeaderSettings.default(securityHeaderSettings.parse({})),
});

export const siteAccessControl = accessControlSettings.extend({
  siteId: uuid,
  /** Null until the settings were first saved. */
  updatedAt: isoDateTime.nullable(),
});

/** Replaces the parts present in the request; the others stay as they are. */
export const siteAccessControlUpdate = z.object({
  id: uuid,
  siteLists: siteListSettings.optional(),
  hotlink: hotlinkSettings.optional(),
  userAgents: userAgentSettings.optional(),
  cors: corsSettings.optional(),
  geo: geoSettings.optional(),
  websocket: websocketSettings.optional(),
  securityHeaders: securityHeaderSettings.optional(),
  expectedUpdatedAt,
});

export const ACCESS_CONTROL_PARTS = [
  "siteLists",
  "hotlink",
  "userAgents",
  "cors",
  "geo",
  "websocket",
  "securityHeaders",
] as const;
export type AccessControlPart = (typeof ACCESS_CONTROL_PARTS)[number];

const idParam = z.object({ id: uuid });

/** A site's access control. */
export const accessControlContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/access-control", tags: ["sites"] })
    .input(idParam)
    .output(siteAccessControl),
  /** Publishes the site's cluster (hot update). */
  update: oc
    .route({ method: "PATCH", path: "/sites/{id}/access-control", tags: ["sites"] })
    .input(siteAccessControlUpdate)
    .output(siteAccessControl),
};

export const ipCheckInput = z.object({
  /** An IPv4 or IPv6 address. */
  ip: z.string().trim().min(1).max(64),
  siteId: uuid.optional(),
});

/**
 * What the console knows about an address: the IP lists that contain it, the
 * active bans that cover it, how each cluster's client address setting sees
 * it, and (for a site) the outcome of the edge's list and ban steps. GeoIP is
 * not looked up (the console has no database).
 */
export const ipCheckResult = z.object({
  /** The address as nodes read it (IPv4-mapped IPv6 as IPv4). */
  ip: z.string(),
  site: z.object({ id: uuid, name: z.string() }).nullable(),
  lists: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      kind: z.enum(["collection", "allow", "block"]),
      /** The entries that contain the address. */
      entries: z.array(z.string()),
      /** For a site: whether it is one of the site's block or allow lists. */
      siteRole: z.enum(["block", "allow"]).nullable(),
    }),
  ),
  bans: z.array(ban),
  clusters: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      clientIp: clientIpMode,
      /** The address is a trusted proxy of the header mode: requests name their client in the header. */
      trustedProxy: z.boolean(),
      /** The address is a node of the cluster. */
      nodeAddress: z.boolean(),
    }),
  ),
  /** For a site: the first step of the edge that decides, in the edge's order. */
  verdict: z
    .object({
      outcome: z.enum([
        "platform_banned",
        "site_banned",
        "platform_blocked",
        "site_blocked",
        "allowed",
        "none",
      ]),
      platformAllowed: z.boolean(),
      siteAllowed: z.boolean(),
    })
    .nullable(),
});

export const ipCheckContract = {
  check: oc
    .route({ method: "GET", path: "/ip-check", tags: ["rules"] })
    .input(ipCheckInput)
    .output(ipCheckResult),
};

export type HotlinkSettings = z.infer<typeof hotlinkSettings>;
export type UserAgentSettings = z.infer<typeof userAgentSettings>;
export type CorsSettings = z.infer<typeof corsSettings>;
export type GeoSettings = z.infer<typeof geoSettings>;
export type WebsocketSettings = z.infer<typeof websocketSettings>;
export type SecurityHeaderSettings = z.infer<typeof securityHeaderSettings>;
export type SiteListSettings = z.infer<typeof siteListSettings>;
export type AccessControlSettings = z.infer<typeof accessControlSettings>;
export type SiteAccessControl = z.infer<typeof siteAccessControl>;
export type SiteAccessControlUpdate = z.infer<typeof siteAccessControlUpdate>;
export type IpCheckInput = z.infer<typeof ipCheckInput>;
export type IpCheckResult = z.infer<typeof ipCheckResult>;
