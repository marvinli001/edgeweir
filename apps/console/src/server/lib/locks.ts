import { sql } from "drizzle-orm";
import type { Executor } from "../services/revisions";

/**
 * Serializes everything that publishes a cluster's configuration or moves
 * its canary (revisions, rollout state, challenge keys) until the
 * transaction ends. A transaction that publishes several clusters takes
 * these locks in cluster id order (publishClusters), so two of them never
 * wait on each other.
 */
export const lockClusterPublish = (tx: Executor, clusterId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${clusterId}`}))`);
