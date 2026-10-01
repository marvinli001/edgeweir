import { schema } from "@edgeweir/db";
import { afterAll, expect, it } from "vitest";
import { createClusterTx } from "../../src/server/services/clusters";
import { publishRevision } from "../../src/server/services/revisions";
import { createTestContext, seedOperator } from "./helpers";

it("publishes unchanged content above a restored cluster's reported LKG, ignoring other clusters", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());
  await seedOperator(ctx.db);
  const actor = { type: "user" as const, id: "user_admin" };
  const [cluster, other] = await ctx.db.transaction(async (tx) => [
    await createClusterTx(tx, { name: "restored", description: "" }, actor),
    await createClusterTx(tx, { name: "unrelated", description: "" }, actor),
  ]);
  if (!cluster || !other) throw new Error("missing cluster");
  const nodes = await ctx.db
    .insert(schema.node)
    .values([
      { clusterId: cluster.id, name: "edge" },
      { clusterId: other.id, name: "other" },
    ])
    .returning();
  await ctx.db.insert(schema.nodeConfigStatus).values(
    nodes.map((node, index) => ({
      nodeId: node.id,
      appliedRevision: index === 0 ? 1234 : 9999,
      revisionReceiptVerified: true,
    })),
  );
  const [untrusted] = await ctx.db
    .insert(schema.node)
    .values({ clusterId: cluster.id, name: "legacy unverified" })
    .returning();
  if (!untrusted) throw new Error("missing node");
  await ctx.db.insert(schema.nodeConfigStatus).values({
    nodeId: untrusted.id,
    appliedRevision: Number.MAX_SAFE_INTEGER - 1,
    revisionReceiptVerified: false,
  });
  const publish = () =>
    ctx.db.transaction((tx) =>
      publishRevision(tx, {
        clusterId: cluster.id,
        reason: { code: "cluster_created", params: {} },
      }),
    );
  const first = await publish();
  expect(first.created).toBe(true);
  expect(first.row.revision).toBe(1235);
  const second = await publish();
  expect(second.created).toBe(false);
  expect(second.row.revision).toBe(1235);
});
