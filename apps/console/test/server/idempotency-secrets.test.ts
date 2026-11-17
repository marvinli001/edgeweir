import { schema } from "@edgeweir/db";
import { expect, it } from "vitest";
import { createTestDatabase } from "./helpers";

it("removes previously cached Origin CA issuance responses without clearing unrelated requests", async () => {
  const { db, client } = await createTestDatabase({
    upTo: "0093_ordinary_randall_flagg",
    run: async (old) => {
      for (const [key, method, path] of [
        ["issue", "POST", "/api/v1/origin-certificates"],
        ["query", "POST", "/api/v1/origin-certificates?retry=1"],
        ["slash", "POST", "/api/v1/origin-certificates/?retry=1"],
        ["list", "GET", "/api/v1/origin-certificates"],
        [
          "revoke",
          "POST",
          "/api/v1/origin-certificates/00000000-0000-4000-8000-000000000001/revoke",
        ],
        ["site", "POST", "/api/v1/sites"],
      ]) {
        await old.query(
          `insert into idempotency_key (principal, key, method, path, body_hash, state, response_status, response_body, locked_until, expires_at)
           values ('user:operator', $1, $2, $3, 'hash', 'completed', 200, 'cached-response', now(), now() + interval '1 day')`,
          [key, method, path],
        );
      }
    },
  });
  try {
    expect((await db.select().from(schema.idempotencyKey)).map((row) => row.key).sort()).toEqual([
      "list",
      "revoke",
      "site",
    ]);
  } finally {
    await client.close();
  }
});
