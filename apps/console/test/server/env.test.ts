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
