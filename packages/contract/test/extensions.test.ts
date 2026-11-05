import { describe, expect, it } from "vitest";
import {
  EXTENSION_FORMAT,
  EXTENSIONS_FEATURE,
  EXTENSIONS_NODE_FEATURE,
  EXTENSIONS_V2_FEATURE,
  type ExtensionNodeSettings,
  extensionManifest,
  extensionNodeSettings,
  extensionRequiredFeatures,
} from "../src/extensions";

const site = {
  format: EXTENSION_FORMAT,
  id: "hello-header",
  version: "1.0.0",
  publisher: "example.org",
  name: { en: "Hello header" },
  requires: { lua_api: 1 },
  hooks: ["header_filter"],
  capabilities: ["response_headers"],
};
const listener = { name: "status", default_port: 9145, methods: ["GET", "HEAD"] };
const node = {
  ...site,
  id: "node-status",
  requires: { lua_api: 2 },
  scope: "node",
  hooks: ["init", "log", "listen"],
  capabilities: ["timers", "request_body"],
  listeners: [listener],
};
const binding = { port: 9145, allow: ["10.1.2.3/8"] };
const clusterId = "00000000-0000-4000-8000-000000000001";

describe("extension scope", () => {
  it("defaults old packages to site scope without changing the input", () => {
    const before = JSON.stringify(site);
    const manifest = extensionManifest.parse(site);
    expect(manifest.scope).toBe("site");
    expect(manifest.listeners).toBeUndefined();
    expect(extensionRequiredFeatures(manifest)).toEqual([EXTENSIONS_FEATURE]);
    expect(JSON.stringify(site)).toBe(before);
    expect(extensionManifest.parse({ ...site, scope: "site" })).toEqual(manifest);
  });

  it("keeps API 2 site extensions and their sidecars/data independent of node scope", () => {
    const manifest = extensionManifest.parse({
      ...site,
      requires: { lua_api: 2 },
      capabilities: ["response_headers", "sidecar"],
      config: { site: { type: "object" } },
      secret: true,
      sidecar: { binary: "helper", memory_mb: 64 },
      data: { max_bytes: 1024, max_items: 1, max_total_bytes: 1024 },
    });
    expect(manifest.scope).toBe("site");
    expect(extensionRequiredFeatures(manifest)).toEqual([
      EXTENSIONS_FEATURE,
      EXTENSIONS_V2_FEATURE,
    ]);
  });

  it("requires a separate feature for node scope, with or without listeners", () => {
    const manifest = extensionManifest.parse(node);
    expect(manifest.listeners?.[0]?.max_body).toBe(4096);
    expect(extensionRequiredFeatures(manifest)).toEqual([
      EXTENSIONS_FEATURE,
      EXTENSIONS_V2_FEATURE,
      EXTENSIONS_NODE_FEATURE,
    ]);
    expect(
      extensionManifest.safeParse({ ...node, hooks: ["log"], listeners: undefined }).success,
    ).toBe(true);
  });

  it("refuses site/listener combinations and unknown members", () => {
    for (const input of [
      { ...site, scope: "sites" },
      { ...site, scope: "other" },
      { ...site, hooks: ["listen"] },
      { ...site, listeners: [] },
      { ...site, listeners: [listener] },
      { ...node, requires: { lua_api: 1 } },
      { ...node, unknown: true },
      { ...node, listeners: [{ ...listener, tls: true }] },
    ]) {
      expect(extensionManifest.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("refuses site-only hooks, capabilities and fields on node scope", () => {
    for (const hook of ["access", "access_late", "header_filter", "body_filter", "endpoint"]) {
      expect(extensionManifest.safeParse({ ...node, hooks: [hook] }).success, hook).toBe(false);
    }
    for (const capability of [
      "verdicts",
      "request_headers",
      "response_headers",
      "html_inject",
      "body_rewrite",
      "sidecar",
    ]) {
      expect(
        extensionManifest.safeParse({ ...node, capabilities: [capability] }).success,
        capability,
      ).toBe(false);
    }
    for (const change of [
      { config: { site: { type: "object" } } },
      { fields: [{ name: "seen", type: "boolean" }] },
      { endpoints: [{ path: "ping", methods: ["GET"] }] },
      { sidecar: { binary: "helper", memory_mb: 64 } },
      { data: { max_bytes: 1, max_items: 1, max_total_bytes: 1 } },
    ]) {
      expect(extensionManifest.safeParse({ ...node, ...change }).success).toBe(false);
    }
  });

  it("bounds and pairs HTTP listener declarations", () => {
    for (const listeners of [
      undefined,
      [],
      [listener, listener],
      [listener, { ...listener, name: "two" }, { ...listener, name: "three" }],
      ...[1023, 65536, 8443, 9145.5].map((port) => [{ ...listener, default_port: port }]),
      ...[[], ["GET", "GET"], ["PUT"], ["CONNECT"]].map((methods) => [{ ...listener, methods }]),
      [{ ...listener, max_body: 65537 }],
    ]) {
      expect(extensionManifest.safeParse({ ...node, listeners }).success).toBe(false);
    }
    expect(
      extensionManifest.safeParse({ ...node, hooks: ["log"], listeners: [listener] }).success,
    ).toBe(false);
    expect(
      extensionManifest.safeParse({
        ...node,
        listeners: [{ ...listener, default_port: 65535, max_body: 65536 }],
      }).success,
    ).toBe(true);
  });
});

describe("extension node listener settings", () => {
  const manifest = extensionManifest.parse(node);
  const settings = extensionNodeSettings(manifest, []);

  it("does not enable declared listeners implicitly; null and no clusters stay explicit", () => {
    expect(settings.parse({})).toEqual({ listeners: {} });
    expect(settings.parse({ clusterIds: null })).toEqual({ listeners: {}, clusterIds: null });
    const off: ExtensionNodeSettings = {
      listeners: { status: null },
      clusterIds: [],
    };
    expect(settings.parse(off)).toEqual(off);
  });

  it("requires an explicit port/allow list and normalizes IPs and ranges", () => {
    expect(
      settings.parse({
        listeners: {
          status: { ...binding, bind: "2001:0DB8::1", allow: ["10.1.2.3/8", "10.0.0.0/8"] },
        },
        clusterIds: [clusterId],
      }),
    ).toEqual({
      listeners: { status: { port: 9145, bind: "2001:db8::1", allow: ["10.0.0.0/8"] } },
      clusterIds: [clusterId],
    });
    expect(settings.parse({ listeners: { status: binding } }).listeners.status?.bind).toBe(
      "0.0.0.0",
    );
  });

  it("accepts non-mapped IPv6 addresses whose canonical text starts with ::ffff:", () => {
    expect(
      settings.parse({
        listeners: {
          status: {
            port: 9145,
            bind: "0:0:0:0:FFFF:1:C000:0201",
            allow: ["::ffff:1:c000:201", "::ffff:1:c000:2ff/120"],
          },
        },
      }).listeners.status,
    ).toEqual({
      port: 9145,
      bind: "::ffff:1:c000:201",
      allow: ["::ffff:1:c000:200/120", "::ffff:1:c000:201/128"],
    });
  });

  it("refuses undeclared names, missing safety fields, unknown members and malformed values", () => {
    for (const input of [
      { listeners: { other: binding } },
      { listeners: { other: null } },
      { listeners: { status: { allow: binding.allow } } },
      { listeners: { status: { port: 9145 } } },
      { listeners: { status: { ...binding, allow: [] } } },
      ...["example.org", "10.0.0.0/33", "::ffff:192.0.2.1/64", "0:0:0:0:0:FFFF:C000:0201/128"].map(
        (allow) => ({
          listeners: { status: { ...binding, allow: [allow] } },
        }),
      ),
      { listeners: { status: { ...binding, allow: Array(65).fill("10.0.0.0/8") } } },
      ...[
        "localhost",
        "[::]",
        "::ffff:192.0.2.1",
        "0:0:0:0:0:FFFF:C000:0201",
        "127.0.0.1;deny all",
      ].map((bind) => ({
        listeners: { status: { ...binding, bind } },
      })),
      ...[0, 80, 443, 8443, 65536, "9145"].map((port) => ({
        listeners: { status: { ...binding, port } },
      })),
      { listeners: { status: { ...binding, tls: true } } },
      { clusterIds: [clusterId, clusterId] },
      { clusterIds: ["not-a-uuid"] },
      { unknown: true },
    ]) {
      expect(settings.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(extensionNodeSettings(extensionManifest.parse(site), []).safeParse({}).success).toBe(
      false,
    );
  });

  it("rejects range conflicts and duplicate ports even on different bind addresses", () => {
    const reserved = extensionNodeSettings(manifest, [{ start: 9100, end: 9200 }]);
    const conflict = reserved.safeParse({ listeners: { status: binding } });
    expect(conflict.success).toBe(false);
    if (!conflict.success) {
      expect(conflict.error.issues[0]).toMatchObject({
        path: ["listeners", "status", "port"],
        message: "listener port conflict",
      });
    }
    const two = extensionManifest.parse({
      ...node,
      listeners: [listener, { ...listener, name: "health", default_port: 9146 }],
    });
    expect(
      extensionNodeSettings(two, []).safeParse({
        listeners: { status: binding, health: { ...binding, bind: "127.0.0.1" } },
      }).success,
    ).toBe(false);
    expect(reserved.safeParse({ listeners: { status: null } }).success).toBe(true);
  });
});
