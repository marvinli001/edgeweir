import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NODE_LOG_REDACTED,
  nodeLogQuery,
  nodeLogRetention,
  redactNodeLogField,
  redactNodeLogText,
} from "../src/index";

const vectors: { name: string; in: string; out: string }[] = JSON.parse(
  readFileSync(new URL("./fixtures/node-log-redaction.json", import.meta.url), "utf8"),
);

describe("redactNodeLogText", () => {
  it("has the node's vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });
  for (const v of vectors) {
    it(v.name, () => {
      expect(redactNodeLogText(v.in)).toBe(v.out);
      expect(redactNodeLogText(v.out)).toBe(v.out);
    });
  }
});

describe("redactNodeLogField", () => {
  it("removes whole values of credential-like keys", () => {
    expect(redactNodeLogField("token", "plain")).toBe(NODE_LOG_REDACTED);
    expect(redactNodeLogField("private_key_pem", "x")).toBe(NODE_LOG_REDACTED);
    expect(redactNodeLogField("Authorization", "Basic x")).toBe(NODE_LOG_REDACTED);
    expect(redactNodeLogField("revision", "42")).toBe("42");
    expect(redactNodeLogField("request", "GET /a?sig=1 HTTP/1.1")).toBe(
      `GET /a?${NODE_LOG_REDACTED} HTTP/1.1`,
    );
  });
});

describe("node log schemas", () => {
  it("bounds the query and the retention", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(nodeLogQuery.parse({ id }).limit).toBe(100);
    expect(nodeLogQuery.safeParse({ id, limit: 201 }).success).toBe(false);
    expect(nodeLogQuery.safeParse({ id, minLevel: "debug" }).success).toBe(false);
    expect(nodeLogQuery.safeParse({ id, source: "certd" }).success).toBe(false);
    expect(nodeLogRetention.safeParse({ days: 7, perNode: 10000 }).success).toBe(true);
    expect(nodeLogRetention.safeParse({ days: 31, perNode: 10000 }).success).toBe(false);
    expect(nodeLogRetention.safeParse({ days: 7, perNode: 999 }).success).toBe(false);
  });
});
