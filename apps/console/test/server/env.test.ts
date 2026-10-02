import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/server/lib/env";

const base = {
  DATABASE_URL: "postgres://example.invalid/test",
  EDGEWEIR_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  BETTER_AUTH_SECRET: "x".repeat(32),
  EDGEWEIR_PUBLIC_URL: "https://console.example.com",
};

describe("documented node channel defaults", () => {
  it.each([undefined, ""])("derives the node URL when optional value is %j", (value) => {
    expect(loadEnv({ ...base, EDGEWEIR_NODE_API_URL: value }).nodeApiUrl).toBe(
      "https://console.example.com:8443",
    );
  });
  it("still rejects a malformed nonempty override", () => {
    expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_URL: "not-a-url" })).toThrow(
      "invalid configuration",
    );
  });
});

describe("console and node channel URLs", () => {
  const node = "https://cdn-admin.example.com:8443";

  it.each([
    "localhost:3000",
    "cdn-admin.example.com:8080",
    "https://cdn-admin.example.com/console",
    "https://cdn-admin.example.com/?next=1",
    "https://cdn-admin.example.com/#top",
    "https://admin:secret@cdn-admin.example.com",
    "ftp://cdn-admin.example.com",
    "https://",
  ])("refuses EDGEWEIR_PUBLIC_URL %j at startup, also with a node channel URL", (value) => {
    for (const nodeUrl of [undefined, node]) {
      expect(() =>
        loadEnv({ ...base, EDGEWEIR_PUBLIC_URL: value, EDGEWEIR_NODE_API_URL: nodeUrl }),
      ).toThrow(
        /^invalid configuration:\n {2}EDGEWEIR_PUBLIC_URL: expected http:\/\/ or https:\/\//,
      );
    }
  });

  it.each([
    "cdn-admin.example.com:8443",
    "http://cdn-admin.example.com:8443",
    "https://cdn-admin.example.com:8443/node",
  ])("refuses EDGEWEIR_NODE_API_URL %j", (value) => {
    expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_URL: value })).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_NODE_API_URL: expected https:\/\/host/,
    );
  });

  it("keeps the origin: a trailing slash and the default port are dropped", () => {
    const env = loadEnv({
      ...base,
      EDGEWEIR_PUBLIC_URL: "HTTPS://CDN-Admin.example.com:443/",
      EDGEWEIR_NODE_API_URL: "https://[2001:db8::1]:8443/",
    });
    expect(env.EDGEWEIR_PUBLIC_URL).toBe("https://cdn-admin.example.com");
    expect(env.nodeApiUrl).toBe("https://[2001:db8::1]:8443");
    expect(env.nodeApiHostnames).toContain("2001:db8::1");
    expect(loadEnv({ ...base, EDGEWEIR_PUBLIC_URL: "http://192.0.2.7:3000" }).nodeApiUrl).toBe(
      "https://192.0.2.7:8443",
    );
  });
});

describe("node channel listen address", () => {
  it.each([undefined, ""])("follows HOST when NODE_API_HOST is %j", (value) => {
    expect(loadEnv({ ...base, HOST: "127.0.0.1", NODE_API_HOST: value }).nodeApiHost).toBe(
      "127.0.0.1",
    );
  });
  it("binds the node channel apart from the web console", () => {
    const env = loadEnv({ ...base, HOST: "127.0.0.1", NODE_API_HOST: "0.0.0.0" });
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.nodeApiHost).toBe("0.0.0.0");
  });
});
