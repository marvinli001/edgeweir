import type { AccessControlModel, CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The access control behind the v0.28.0 vector (site a): site lists, hotlink
 * with a redirect, user agent rules (order kept), CORS (methods in order),
 * geo with every list, a restricted WebSocket with its idle timeout, and
 * every security header; lists given out of order.
 */
export const v0280Access = (): AccessControlModel => ({
  blockListIds: ["list-block-2", "list-block-1"],
  allowListIds: ["list-allow"],
  hotlink: {
    allowEmpty: true,
    allowSiteDomains: true,
    allowed: ["*.friend.test", "friend.test"],
    denied: ["evil.test", ".bad.test"],
    checkOrigin: true,
    extensions: ["png", "jpg", "mp4"],
    pathPrefixes: ["/media/"],
    excludePathPrefixes: ["/public/", "/media/free/"],
    redirectUrl: "/hotlink.png",
  },
  userAgents: {
    rules: [
      { pattern: "*", allow: false },
      { pattern: "*Googlebot*", allow: true },
      { pattern: "", allow: false },
    ],
    pathPrefixes: ["/"],
    excludePathPrefixes: ["/robots.txt"],
  },
  cors: {
    allowedOrigins: ["https://*.app.test", "https://app.test"],
    allowCredentials: true,
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["x-token", "content-type"],
    echoRequestHeaders: false,
    exposedHeaders: ["x-request-id", "etag"],
    maxAgeSeconds: 600,
    preflightToOrigin: false,
    keepOriginHeaders: true,
    pathPrefixes: ["/api/"],
  },
  geo: {
    allowOnly: false,
    countries: ["KP", "CN"],
    subdivisions: ["US-CA"],
    asns: [64513, 64512],
    pathPrefixes: [],
    exceptPathPrefixes: ["/status"],
  },
  websocket: { origins: ["https://chat.app.test", "https://app.test"], idleTimeoutSeconds: 600 },
  securityHeaders: {
    nosniff: true,
    frameOptions: "SAMEORIGIN",
    referrerPolicy: "strict-origin-when-cross-origin",
    permissionsPolicy: "camera=(), microphone=()",
    hideServer: true,
    removePoweredBy: true,
  },
});

/** Site a with access control, site b without; the IP lists the site lists name. */
export const v0280Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), accessControl: v0280Access() }), site("b", { tls: tls() })],
  ipLists: [
    {
      id: "list-block-1",
      name: "block_one",
      entries: ["198.51.100.0/24"],
      kind: "collection",
      platform: true,
    },
    {
      id: "list-block-2",
      name: "block_two",
      entries: ["203.0.113.7/32"],
      kind: "collection",
      platform: true,
    },
    {
      id: "list-allow",
      name: "office",
      entries: ["192.0.2.0/24"],
      kind: "collection",
      platform: true,
    },
  ],
});
