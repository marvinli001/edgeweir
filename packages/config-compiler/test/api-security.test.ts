import { toBinary } from "@bufbuild/protobuf";
import { API_SECURITY_DEFAULTS, API_SECURITY_FEATURE } from "@edgeweir/contract";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  compileNodeConfig,
  decodeNodeConfig,
  encodeNodeConfig,
  nodeRequirements,
} from "../src/index";
import { site } from "./v0230-models";

describe("API security configuration", () => {
  const build = (settings = structuredClone(API_SECURITY_DEFAULTS)) =>
    compileNodeConfig({ clusterId: "c", sites: [site("a", { apiSecurity: settings })] }, 1n);

  it("keeps off policies out of the wire and required features", () => {
    const bare = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 1n);
    expect(toBinary(NodeConfigSchema, build())).toEqual(toBinary(NodeConfigSchema, bare));
    expect(nodeRequirements(build())).not.toContain(API_SECURITY_FEATURE);
  });

  it.each(["discovery", "schema", "graphql"] as const)(
    "requires the capability for %s including observe",
    (check) => {
      const settings = structuredClone(API_SECURITY_DEFAULTS);
      if (check === "discovery") settings.discovery.enabled = true;
      else settings[check].mode = "observe";
      const config = build(settings);
      expect(config.requiredFeatures).toContain(API_SECURITY_FEATURE);
      expect(nodeRequirements(config)).toContain(API_SECURITY_FEATURE);
      expect(JSON.parse(config.sites[0]?.apiSecurityJson ?? "{}")).toEqual(settings);
      expect(decodeNodeConfig(encodeNodeConfig(config)).sites[0]?.apiSecurityJson).toBe(
        config.sites[0]?.apiSecurityJson,
      );
    },
  );

  it("encodes object keys deterministically and binds policy changes into the content hash", () => {
    const first = structuredClone(API_SECURITY_DEFAULTS);
    first.schema.mode = "observe";
    first.schema.endpoints = [
      {
        method: "POST",
        path: "/api/users",
        parameters: [],
        body: {
          required: true,
          schema: {
            type: "object",
            properties: {
              z: { type: "integer", maximum: 5, minimum: 1 },
              a: { type: "string", maxLength: 8 },
            },
          },
        },
      },
    ];
    const reordered = structuredClone(first);
    if (reordered.schema.endpoints[0]?.body)
      reordered.schema.endpoints[0].body.schema = {
        properties: {
          a: { maxLength: 8, type: "string" },
          z: { minimum: 1, maximum: 5, type: "integer" },
        },
        type: "object",
      };
    expect(build(first).contentHash).toBe(build(reordered).contentHash);
    reordered.schema.mode = "enforce";
    expect(build(first).contentHash).not.toBe(build(reordered).contentHash);
  });
});
