import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Executor } from "../services/revisions";

/**
 * The console's PostgreSQL advisory locks. Every console instance, of
 * whatever version, must take the same keys: a key never changes.
 * Transaction locks are keyed `hashtext(<key>)`; the two session locks are
 * held on a pool connection of their own.
 */

/** Takes a transaction lock, released when the transaction ends. */
const xactLock = (tx: Executor, key: string, mode: "shared" | "exclusive" = "exclusive") =>
  tx.execute(
    mode === "shared"
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${key}))`
      : sql`select pg_advisory_xact_lock(hashtext(${key}))`,
  );

/**
 * Serializes everything that publishes a cluster's configuration or moves
 * its canary (revisions, rollout state, challenge keys) until the
 * transaction ends. A transaction that publishes several clusters takes
 * these locks in cluster id order (publishClusters), so two of them never
 * wait on each other.
 */
export const lockClusterPublish = (tx: Executor, clusterId: string) =>
  xactLock(tx, `edgeweir.publish.${clusterId}`);

/**
 * Statistics writers (ingestion, rollups) hold this lock shared; whatever
 * deletes statistics rows (retention, site deletion) holds it exclusively,
 * so it never removes data a writer is about to aggregate or reference.
 */
export const lockStats = (tx: Executor, mode: "shared" | "exclusive") =>
  xactLock(tx, "edgeweir.stats.retention", mode);

/**
 * Serializes changes to a cluster's port pools and layer-4 applications
 * (ports are checked against both). Taken before the cluster's publish lock.
 */
export const lockClusterL4 = (tx: Executor, clusterId: string) =>
  xactLock(tx, `edgeweir.l4.${clusterId}`);

/** Serializes the evaluation of a cluster's scheduling rules (address states, actions, DNS). */
export const lockClusterScheduling = (tx: Executor, clusterId: string) =>
  xactLock(tx, `edgeweir.scheduling.${clusterId}`);

/** Serializes changes to a cluster's node upgrades and their deliveries. */
export const lockClusterUpgrade = (tx: Executor, clusterId: string) =>
  xactLock(tx, `upgrade/${clusterId}`);

/**
 * Serializes CNAME prefix changes, new sites and layer-4 applications (their
 * random prefix) and DNS binding saves (line names), so a prefix that was
 * checked free cannot be taken meanwhile.
 */
export const lockCnamePrefixes = (tx: Executor) => xactLock(tx, "edgeweir.cname-prefix");

/**
 * Serializes changes to the same host names, so a check that a domain is
 * free and the insert after it cannot interleave. Taken in name order.
 */
export async function lockDomains(tx: Executor, names: string[]) {
  for (const name of [...new Set(names)].sort()) await xactLock(tx, `edgeweir.domain.${name}`);
}

/**
 * Serializes a site's PURGE-method tasks, so the per-minute quota is
 * counted and the task inserted in one step.
 */
export const lockPurgeMethod = (tx: Executor, siteId: string) =>
  xactLock(tx, `edgeweir.purge-method.${siteId}`);

/** Serializes saves of the platform protection settings. */
export const lockProtectionSettings = (tx: Executor) =>
  xactLock(tx, "edgeweir.protection-settings");

/** Serializes saves of the CC template. */
export const lockCcTemplate = (tx: Executor) => xactLock(tx, "edgeweir.cc-template");

/** Serializes saves of the platform's error pages. */
export const lockPlatformErrorPages = (tx: Executor) => xactLock(tx, "edgeweir.error-pages");

/** Serializes saves of the platform's rules. */
export const lockPlatformRules = (tx: Executor) => xactLock(tx, "edgeweir.platform-rules");

/** Serializes IP list writes (names and the entry quota are checked across lists). */
export const lockIpLists = (tx: Executor) => xactLock(tx, "edgeweir.ip-lists");

/** Serializes the creation of alert channels (the channel limit). */
export const lockAlertChannels = (tx: Executor) => xactLock(tx, "edgeweir.alert-channels");

/**
 * Ban writers hold this lock exclusively, before `nextval('ip_ban_seq')`, so
 * changes commit in sequence order; readers of the ban changes hold it
 * shared, so the current sequence value only covers committed changes.
 */
export const lockBans = (tx: Executor, mode: "shared" | "exclusive") =>
  xactLock(tx, "edgeweir.bans", mode);

/** Serializes usage computations, so that seq order is commit order for usage.changes readers. */
export const lockUsage = (tx: Executor) => xactLock(tx, "edgeweir.usage");

/** Serializes advances of the usage completeness watermark. */
export const lockUsageWatermark = (tx: Executor) => xactLock(tx, "edgeweir.usage-watermark");

/** Serializes reading, sealing and checking the stored better-auth secret at startup. */
export const lockAuthSecret = (tx: Executor) => xactLock(tx, "edgeweir.auth-secret");

/** Serializes the startup upgrade of legacy envelopes and the re-sealing after a key rotation. */
export const lockEnvelopeUpgrade = (tx: Executor) => xactLock(tx, "edgeweir.envelope-upgrade");

/** Serializes loading the node-channel CA, so exactly one is ever created. */
export const lockNodeCa = (tx: Executor) => xactLock(tx, "edgeweir.pki.node-channel");

/** Serializes the recompilation of every cluster after an upgrade. */
export const lockRecompile = (tx: Executor) => xactLock(tx, "edgeweir.recompile");

/** Serializes the maintenance of access_log partitions (creation and retention). */
export const lockLogPartitions = (tx: Executor) => xactLock(tx, "edgeweir.logs.partitions");

/** Serializes the creation of one access_log partition, keyed by its table name. */
export const lockLogPartition = (tx: Executor, table: string) => xactLock(tx, table);

/** One access log batch per node at a time: false while another one holds it. */
export async function tryLockNodeLogs(tx: Executor, nodeId: string): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext(${`logs/${nodeId}`})) AS locked`,
  );
  return result.rows[0]?.locked === true;
}

type Session = Pick<pg.PoolClient, "query">;

/**
 * One first-run setup at a time across console instances: a session lock,
 * false while another connection holds it. Released with unlockSetup.
 */
export async function tryLockSetup(client: Session): Promise<boolean> {
  const result = await client.query(
    "select pg_try_advisory_lock(hashtext('edgeweir.setup')) as locked",
  );
  return result.rows[0]?.locked === true;
}

export const unlockSetup = (client: Session) =>
  client.query("select pg_advisory_unlock(hashtext('edgeweir.setup'))");

/**
 * One alert sweep at a time across console instances: a session lock (550075
 * is the console's namespace of two-key session locks), false while another
 * connection holds it. Released with unlockAlertSweep.
 */
export async function tryLockAlertSweep(client: Session): Promise<boolean> {
  const result = await client.query("select pg_try_advisory_lock(550075, 6) as locked");
  return result.rows[0]?.locked === true;
}

export const unlockAlertSweep = (client: Session) =>
  client.query("select pg_advisory_unlock(550075, 6)");
