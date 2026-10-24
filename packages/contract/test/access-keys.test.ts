import { describe, expect, it } from "vitest";
import {
  ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
  ACCESS_KEY_MAX_REQUESTS_PER_MINUTE,
  contract,
} from "../src";

const input = (procedure: { "~orpc": { inputSchema?: unknown } }) =>
  procedure["~orpc"].inputSchema as {
    safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> };
  };

describe("AccessKey request limit", () => {
  const create = input(contract.accessKeys.create);
  const update = input(contract.accessKeys.update);

  it("defaults a new key to 600 requests per minute", () => {
    expect(ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE).toBe(600);
    expect(create.safeParse({ name: "ci" }).data).toEqual({
      name: "ci",
      scope: "write",
      requestsPerMinute: 600,
    });
  });

  it("takes a whole number in range or null for unlimited", () => {
    for (const requestsPerMinute of [1, 5000, ACCESS_KEY_MAX_REQUESTS_PER_MINUTE, null])
      expect(
        create.safeParse({ name: "ci", requestsPerMinute }).success,
        String(requestsPerMinute),
      ).toBe(true);
    for (const requestsPerMinute of [0, -1, 1.5, ACCESS_KEY_MAX_REQUESTS_PER_MINUTE + 1, "600"])
      expect(
        create.safeParse({ name: "ci", requestsPerMinute }).success,
        String(requestsPerMinute),
      ).toBe(false);
  });

  it("leaves the limit alone on an update that does not name it", () => {
    expect(update.safeParse({ id: "k1", name: "renamed" }).data).toEqual({
      id: "k1",
      name: "renamed",
    });
    expect(update.safeParse({ id: "k1", requestsPerMinute: null }).data).toEqual({
      id: "k1",
      requestsPerMinute: null,
    });
    expect(update.safeParse({ id: "k1", requestsPerMinute: 0 }).success).toBe(false);
    expect(update.safeParse({ id: "k1", name: " " }).success).toBe(false);
  });

  it("serves the update as PATCH /access-keys/{id}", () => {
    expect(contract.accessKeys.update["~orpc"].route).toMatchObject({
      method: "PATCH",
      path: "/access-keys/{id}",
    });
  });
});
