import { afterAll, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";
import {
  mintRevisionReceipt,
  verifyRevisionReceipt,
} from "../../src/server/services/revision-receipts";
import { createTestContext, TEST_MASTER_KEY } from "./helpers";

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

it("verifies receipts of the previous master key while it is configured", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());
  const node = { id: crypto.randomUUID(), clusterId: crypto.randomUUID() },
    hash = "c".repeat(64);
  // Minted before the rotation; nodes keep it until they fetch a configuration again.
  const token = mintRevisionReceipt(ctx, node, 7, hash);
  const next = Buffer.alloc(32, 8).toString("base64");
  const rotating = { ...ctx, masterKey: new MasterKey(next, TEST_MASTER_KEY) };
  expect(verifyRevisionReceipt(rotating, node, 7, hash, token)).toBe(true);
  expect(verifyRevisionReceipt(rotating, node, 8, hash, token)).toBe(false);
  // Receipts minted from now on use the new key.
  const fresh = mintRevisionReceipt(rotating, node, 8, hash);
  expect(JSON.parse(fresh).kid).toBe(rotating.masterKey.kid);
  // Once the previous key is removed, only those verify.
  const rotated = { ...ctx, masterKey: new MasterKey(next) };
  expect(verifyRevisionReceipt(rotated, node, 7, hash, token)).toBe(false);
  expect(verifyRevisionReceipt(rotated, node, 8, hash, fresh)).toBe(true);
});
