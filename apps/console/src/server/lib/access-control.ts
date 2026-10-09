import type { AccessControlModel } from "@edgeweir/config-compiler";
import {
  type AccessControlSettings,
  corsSettings,
  geoSettings,
  hotlinkSettings,
  securityHeaderSettings,
  userAgentSettings,
  WEBSOCKET_IDLE,
  websocketSettings,
} from "@edgeweir/contract";
import type { schema } from "@edgeweir/db";
import type * as z from "zod";

type SiteRow = typeof schema.site.$inferSelect;

/** One stored part: its saved settings, or the defaults when absent or unreadable. */
function part<S extends z.ZodType>(type: S, value: unknown): z.output<S> {
  const parsed = type.safeParse(value ?? {});
  return parsed.success ? parsed.data : type.parse({});
}

/** A site's access control as stored (site.access_control and the list columns). */
export function readAccessControl(
  site: Pick<SiteRow, "accessControl" | "blockListIds" | "allowListIds">,
): AccessControlSettings {
  const stored = (site.accessControl ?? {}) as Record<string, unknown>;
  return {
    siteLists: { blockListIds: [...site.blockListIds], allowListIds: [...site.allowListIds] },
    hotlink: part(hotlinkSettings, stored.hotlink),
    userAgents: part(userAgentSettings, stored.userAgents),
    cors: part(corsSettings, stored.cors),
    geo: part(geoSettings, stored.geo),
    websocket: part(websocketSettings, stored.websocket),
    securityHeaders: part(securityHeaderSettings, stored.securityHeaders),
  };
}

/** Whether a site uses any part of access control (and so needs access-control-v1). */
export function accessControlUsed(settings: AccessControlSettings): boolean {
  return accessControlModel(settings, null) !== null;
}

/**
 * The compiled model of a site's access control: only the parts in use;
 * null when none is, so the site compiles exactly as before. `lists` are
 * the ids of existing IP lists (null: keep every id).
 */
export function accessControlModel(
  s: AccessControlSettings,
  lists: ReadonlySet<string> | null,
): AccessControlModel | null {
  const known = (ids: string[]) => (lists ? ids.filter((id) => lists.has(id)) : ids);
  const h = s.hotlink;
  const u = s.userAgents;
  const c = s.cors;
  const g = s.geo;
  const w = s.websocket;
  const sh = s.securityHeaders;
  const model: AccessControlModel = {
    blockListIds: known(s.siteLists.blockListIds),
    allowListIds: known(s.siteLists.allowListIds),
    ...(h.enabled
      ? {
          hotlink: {
            allowEmpty: h.allowEmpty,
            allowSiteDomains: h.allowSiteDomains,
            allowed: h.allowed,
            denied: h.denied,
            checkOrigin: h.checkOrigin,
            extensions: h.extensions,
            pathPrefixes: h.pathPrefixes,
            excludePathPrefixes: h.excludePathPrefixes,
            redirectUrl: h.action === "redirect" ? h.redirectUrl : "",
          },
        }
      : {}),
    ...(u.rules.length
      ? {
          userAgents: {
            rules: u.rules.map((r) => ({ pattern: r.pattern, allow: r.action === "allow" })),
            pathPrefixes: u.pathPrefixes,
            excludePathPrefixes: u.excludePathPrefixes,
          },
        }
      : {}),
    ...(c.enabled
      ? {
          cors: {
            allowedOrigins: c.allowedOrigins,
            allowCredentials: c.allowCredentials,
            allowedMethods: c.allowedMethods,
            allowedHeaders: c.echoRequestHeaders ? [] : c.allowedHeaders,
            echoRequestHeaders: c.echoRequestHeaders,
            exposedHeaders: c.exposedHeaders,
            maxAgeSeconds: c.maxAgeSeconds,
            preflightToOrigin: c.preflightToOrigin,
            keepOriginHeaders: c.keepOriginHeaders,
            pathPrefixes: c.pathPrefixes,
          },
        }
      : {}),
    ...(g.enabled
      ? {
          geo: {
            allowOnly: g.mode === "allow",
            countries: g.countries,
            subdivisions: g.subdivisions,
            asns: g.asns,
            pathPrefixes: g.pathPrefixes,
            exceptPathPrefixes: g.exceptPathPrefixes,
          },
        }
      : {}),
    ...(!w.allowAllOrigins || w.idleTimeoutSeconds !== WEBSOCKET_IDLE.default
      ? {
          websocket: {
            origins: w.allowAllOrigins ? [] : w.origins,
            idleTimeoutSeconds:
              w.idleTimeoutSeconds === WEBSOCKET_IDLE.default ? 0 : w.idleTimeoutSeconds,
          },
        }
      : {}),
    ...(sh.nosniff ||
    sh.frameOptions !== "off" ||
    sh.referrerPolicy !== "off" ||
    sh.permissionsPolicy !== "" ||
    sh.hideServer ||
    sh.removePoweredBy
      ? {
          securityHeaders: {
            nosniff: sh.nosniff,
            frameOptions: sh.frameOptions === "off" ? "" : sh.frameOptions,
            referrerPolicy: sh.referrerPolicy === "off" ? "" : sh.referrerPolicy,
            permissionsPolicy: sh.permissionsPolicy,
            hideServer: sh.hideServer,
            removePoweredBy: sh.removePoweredBy,
          },
        }
      : {}),
  };
  const used =
    model.blockListIds.length ||
    model.allowListIds.length ||
    model.hotlink ||
    model.userAgents ||
    model.cors ||
    model.geo ||
    model.websocket ||
    model.securityHeaders;
  return used ? model : null;
}
