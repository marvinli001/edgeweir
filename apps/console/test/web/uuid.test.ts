import { describe, expect, it } from "vitest";
import { randomUuid } from "../../src/web/lib/uuid";

describe("randomUuid", () => {
  it("generates version 4 UUIDs without crypto.randomUUID", () => {
    const ids = new Set(Array.from({ length: 1000 }, randomUuid));
    expect(ids.size).toBe(1000);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
