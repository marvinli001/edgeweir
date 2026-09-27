import { afterAll, expect, it } from "vitest";
import {
  mintRevisionReceipt,
  verifyRevisionReceipt,
} from "../../src/server/services/revision-receipts";
import { createTestContext } from "./helpers";

it("authenticates the exact node, cluster, revision and hash across a database restore", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());
  const node = { id: crypto.randomUUID(), clusterId: crypto.randomUUID() },
    hash = "a".repeat(64);
  const token = mintRevisionReceipt(ctx, node, 1234, hash);
  expect(verifyRevisionReceipt(ctx, node, 1234, hash, token)).toBe(true);
  expect(verifyRevisionReceipt(ctx, node, Number.MAX_SAFE_INTEGER - 1, hash, token)).toBe(false);
  expect(verifyRevisionReceipt(ctx, { ...node, id: crypto.randomUUID() }, 1234, hash, token)).toBe(
    false,
  );
  expect(
    verifyRevisionReceipt(ctx, { ...node, clusterId: crypto.randomUUID() }, 1234, hash, token),
  ).toBe(false);
  expect(verifyRevisionReceipt(ctx, node, 1234, "b".repeat(64), token)).toBe(false);
  const forged = JSON.parse(token);
  forged.ciphertext = Buffer.from("forged").toString("base64");
  expect(verifyRevisionReceipt(ctx, node, 1234, hash, JSON.stringify(forged))).toBe(false);
  expect(verifyRevisionReceipt(ctx, node, 1234, hash, "")).toBe(false);
});
