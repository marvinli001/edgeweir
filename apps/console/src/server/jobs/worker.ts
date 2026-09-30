import { schema } from "@edgeweir/db";
import { and, isNotNull, isNull, lt, or } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import type { AppContext } from "../lib/context";
import { pruneIdempotencyKeys } from "../lib/idempotency";
import { maintainLogs } from "../services/access-logs";
import { sweepAlerts } from "../services/alerts";
import { expireCacheTasks } from "../services/cache-tasks";
import { sweepCertificates } from "../services/certificate-worker";
import { reconcileDns } from "../services/dns";
import { enforceDomainOwnershipOnce } from "../services/domain-ownership";
import { pruneRevisions } from "../services/revisions";
import { maintainTraffic } from "../services/stats-rollup";
import { expireUpgrades } from "../services/upgrades";

export const QUEUES = {
  alerts: "alerts.sweep",
  dns: "dns.reconcile",
  domainMigration: "domains.enforce-ownership",
  traffic: "traffic.rollup",
  certificates: "certificates.sweep",
  pruneRevisions: "maintenance.prune-revisions",
  expireEnrollmentTokens: "maintenance.expire-enrollment-tokens",
  expireCacheTasks: "maintenance.expire-cache-tasks",
  pruneIdempotencyKeys: "maintenance.prune-idempotency-keys",
} as const;

/**
 * Background worker (ROLE=worker|all): pg-boss queues and cron schedules.
 * Certificate issuance via edgeweir-certd will be added here.
 */
export async function startWorker(ctx: AppContext): Promise<PgBoss> {
  const log = ctx.log.child({ component: "worker" });
  const boss = new PgBoss({ connectionString: ctx.env.DATABASE_URL, schema: "pgboss" });
  boss.on("error", (error) => log.error("pg-boss error", { error }));
  await boss.start();

  for (const name of Object.values(QUEUES)) await boss.createQueue(name);
  await boss.work(QUEUES.alerts, async () => {
    await sweepAlerts(ctx);
  });
  await boss.schedule(QUEUES.alerts, "* * * * *");
  await boss.send(QUEUES.alerts, {}, { singletonKey: "alerts-sweep" });
  await boss.work(QUEUES.dns, async () => {
    await reconcileDns(ctx);
  });
  await boss.schedule(QUEUES.dns, "* * * * *");
  await boss.send(QUEUES.dns, {}, { singletonKey: "dns-reconcile" });
  await boss.work(QUEUES.domainMigration, async () => {
    await enforceDomainOwnershipOnce(ctx);
  });
  await boss.send(QUEUES.domainMigration, {}, { singletonKey: "domain-ownership-v1" });
  await boss.work(QUEUES.traffic, async () => {
    // Each maintenance family must run even when another one needs a retry.
    const results = await Promise.allSettled([
      maintainTraffic(ctx.db),
      maintainLogs(ctx.db),
      expireUpgrades(ctx.db),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  await boss.schedule(QUEUES.traffic, "* * * * *");
  await boss.send(QUEUES.traffic, {}, { singletonKey: "traffic-rollup" });

  await boss.work(QUEUES.certificates, async () => {
    await sweepCertificates(ctx);
  });
  await boss.schedule(QUEUES.certificates, "* * * * *");
  await boss.send(QUEUES.certificates, {}, { singletonKey: "certificate-sweep" });

  await boss.work(QUEUES.pruneRevisions, async () => {
    const removed = await pruneRevisions(ctx.db);
    if (removed) log.info("pruned revisions", { removed });
  });
  await boss.work(QUEUES.expireEnrollmentTokens, async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const deleted = await ctx.db
      .delete(schema.enrollmentToken)
      .where(
        or(
          and(isNull(schema.enrollmentToken.usedAt), lt(schema.enrollmentToken.expiresAt, cutoff)),
          and(isNotNull(schema.enrollmentToken.usedAt), lt(schema.enrollmentToken.usedAt, cutoff)),
        ),
      )
      .returning({ id: schema.enrollmentToken.id });
    if (deleted.length) log.info("deleted stale enrollment tokens", { count: deleted.length });
  });

  await boss.work(QUEUES.expireCacheTasks, async () => {
    const expired = await expireCacheTasks(ctx.db);
    if (expired) log.info("expired undelivered cache tasks", { deliveries: expired });
  });

  await boss.work(QUEUES.pruneIdempotencyKeys, async () => {
    const removed = await pruneIdempotencyKeys(ctx.db);
    if (removed) log.info("pruned idempotency keys", { removed });
  });

  await boss.schedule(QUEUES.pruneRevisions, "17 * * * *");
  await boss.schedule(QUEUES.pruneIdempotencyKeys, "29 * * * *");
  await boss.schedule(QUEUES.expireCacheTasks, "43 * * * *");
  await boss.schedule(QUEUES.expireEnrollmentTokens, "*/30 * * * *");
  log.info("worker started", { queues: Object.values(QUEUES) });
  return boss;
}
