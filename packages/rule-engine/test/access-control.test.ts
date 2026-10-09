import { describe, expect, it } from "vitest";
import {
  corsAllowOrigin,
  geoDecision,
  hostFormMatches,
  hotlinkDecision,
  normalizeHostForm,
  normalizeOrigin,
  normalizeOriginForm,
  originFormMatches,
  pathInScope,
  refererHost,
  userAgentDecision,
  validUserAgentPattern,
  websocketOriginAllowed,
} from "../src/index.ts";
import vectors from "./access_vectors.json" with { type: "json" };

// The node's Lua (test/lua/access.lua) runs the same file.
describe("access control vectors", () => {
  it("host forms", () => {
    for (const v of vectors.hostForms)
      expect(hostFormMatches(v.form, v.host), `${v.form} ${v.host}`).toBe(v.match);
    for (const v of vectors.normalizeHostForm)
      expect(normalizeHostForm(v.input), v.input).toBe(v.output);
  });
  it("Referer hosts", () => {
    for (const v of vectors.refererHost) expect(refererHost(v.input), v.input).toBe(v.host);
  });
  it("origins", () => {
    for (const v of vectors.normalizeOriginForm)
      expect(normalizeOriginForm(v.input, v.star), v.input).toBe(v.output);
    for (const v of vectors.normalizeOrigin)
      expect(normalizeOrigin(v.input), v.input).toBe(v.output);
    for (const v of vectors.originForms)
      expect(originFormMatches(v.form, v.origin), `${v.form} ${v.origin}`).toBe(v.match);
  });
  it("path scopes", () => {
    for (const v of vectors.pathScope)
      expect(pathInScope(v.path, v.prefixes, v.excluded), v.path).toBe(v.result);
  });
  it("user agents", () => {
    for (const v of vectors.userAgents)
      expect(userAgentDecision(v.rules, v.ua), JSON.stringify(v)).toBe(v.result);
    for (const v of vectors.validUserAgentPattern)
      expect(validUserAgentPattern(v.pattern), v.pattern).toBe(v.valid);
  });
  it("hotlink", () => {
    for (const v of vectors.hotlink) {
      const hosts = new Set(v.siteHosts);
      expect(hotlinkDecision(v.cfg, { ...v.req, siteHost: (h) => hosts.has(h) }), v.name).toBe(
        v.result,
      );
    }
  });
  it("geo", () => {
    for (const v of vectors.geo)
      expect(geoDecision(v.cfg, v.geo), JSON.stringify(v)).toBe(v.result);
  });
  it("CORS and WebSocket origins", () => {
    for (const v of vectors.cors)
      expect(corsAllowOrigin(v.cfg, v.origin), JSON.stringify(v)).toBe(v.result);
    for (const v of vectors.websocket)
      expect(websocketOriginAllowed(v.origins, v.origin), JSON.stringify(v)).toBe(v.result);
  });
});
