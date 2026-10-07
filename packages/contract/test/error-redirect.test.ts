import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validErrorRedirect } from "../src/error-pages";

/** Shared with edgeweir-node (internal/configir/testdata/error_redirect_vectors.json). */
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "error_redirect_vectors.json"), "utf8"),
) as { cases: { value: string; valid: boolean; note: string }[] };

describe("error page redirect URLs", () => {
  it("accepts exactly what nodes accept", () => {
    for (const c of vectors.cases) expect(validErrorRedirect(c.value), c.note).toBe(c.valid);
  });
});
