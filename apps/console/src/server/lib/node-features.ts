import { nodeSupportsFeature } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../services/revisions";
import { fail } from "./errors";

/**
 * Refuses with NODE_CAPABILITY_REQUIRED while an active node of the clusters lacks one of
 * `features`, naming the missing features and (the first five of) the nodes that lack them.
 */
export async function assertNodeFeatures(
  tx: Executor,
  clusterIds: string[],
  features: string[],
  message: string,
) {
  if (!features.length || !clusterIds.length) return;
  const nodes = await tx
    .select({ name: schema.node.name, features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(inArray(schema.node.clusterId, clusterIds), eq(schema.node.status, "active")))
    .orderBy(asc(schema.node.name));
  const missing = features.filter((feature) =>
    nodes.some((node) => !nodeSupportsFeature(node.features, feature)),
  );
  if (!missing.length) return;
  const lacking = nodes
    .filter((node) => missing.some((feature) => !nodeSupportsFeature(node.features, feature)))
    .map((node) => node.name);
  const shown = lacking.slice(0, 5).join(", ");
  fail("NODE_CAPABILITY_REQUIRED", message, {
    features: missing.join(", "),
    nodes: lacking.length > 5 ? `${shown} +${lacking.length - 5}` : shown,
  });
}
