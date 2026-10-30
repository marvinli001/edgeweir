import { schema } from "@edgeweir/db";
import { and, isNotNull, isNull, lt, or } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import type { AppContext } from "../lib/context";
import { pruneIdempotencyKeys } from "../lib/idempotency";
import { deleteInBatches } from "../lib/retention";
import { maintainLogs } from "../services/access-logs";
import { reconcileAcmeCertificates } from "../services/acme-accounts";
import { sweepAlerts } from "../services/alerts";
import { sweepAutoMitigation } from "../services/auto-mitigation";
import { pruneBans } from "../services/bans";
import { expireCacheTasks, pruneCacheTasks } from "../services/cache-tasks";
import { sweepCertificates } from "../services/certificate-worker";
import { markUnloadableCertificates } from "../services/certificates";
import { rotateChallengeKeys } from "../services/challenge-keys";
import { expireCnamePrefixes } from "../services/cname-prefixes";
import { pruneDnsRevisions, reconcileDns } from "../services/dns";
import { withLease } from "../services/dns-lease";
import { pollProbeSources, sweepProbeSourceAlerts } from "../services/external-probes";
import { pruneNodeDebugLogs } from "../services/node-debug-logs";
import { pruneNodeLogs } from "../services/node-logs";
import { rotateOriginClientCertificates } from "../services/origin-pki";
import { recompileAfterUpgrade } from "../services/recompile";
import { pruneRevisions } from "../services/revisions";
import { evaluateRollouts } from "../services/rollout";
import {
  evaluateAfterProbeReport,
  SCHEDULING_INTERVAL_MS,
  schedulingTick,
} from "../services/scheduling";
import { pruneSecurityEvents } from "../services/security";
import { rotateSessionTicketKeys } from "../services/session-ticket-keys";
import { maintainTraffic } from "../services/stats-rollup";
import { expireUpgrades } from "../services/upgrades";
import { maintainUsage } from "../services/usage";
import { enforceUsageGuards } from "../services/usage-guard";

export const QUEUES = {
  alerts: "alerts.sweep",
  mitigation: "mitigation.evaluate",
  rollouts: "rollouts.evaluate",
  dns: "dns.reconcile",
  recompile: "maintenance.recompile",
  traffic: "traffic.rollup",
  certificates: "certificates.sweep",
  checkCertificates: "maintenance.check-certificates",
  linkAcmeAccounts: "maintenance.link-acme-accounts",
  pruneRevisions: "maintenance.prune-revisions",
  expireEnrollmentTokens: "maintenance.expire-enrollment-tokens",
  expireCacheTasks: "maintenance.expire-cache-tasks",
  pruneIdempotencyKeys: "maintenance.prune-idempotency-keys",
  pruneBans: "maintenance.prune-bans",
  rotateChallengeKeys: "maintenance.rotate-challenge-keys",
  rotateSessionTicketKeys: "maintenance.rotate-session-ticket-keys",
  rotateOriginClientCertificates: "maintenance.rotate-origin-client-certificates",
  pruneSecurityEvents: "maintenance.prune-security-events",
  pruneNodeLogs: "maintenance.prune-node-logs",
} as const;

/** Queues scheduled every minute ("* * * * *"). */
const MINUTE_QUEUES = [
  QUEUES.alerts,
  QUEUES.mitigation,
  QUEUES.rollouts,
  QUEUES.dns,
  QUEUES.traffic,
  QUEUES.certificates,
] as const;

/**
 * Background worker (ROLE=worker|all): pg-boss queues and cron schedules
 * (listed in ARCHITECTURE.md), plus the in-process scheduling timer.
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
  // State and expiry live in site_auto_mitigation, so a restart or a repeated job only
  // evaluates again; row locks serialise it with the nodes' reports and the operator.
  await boss.work(QUEUES.mitigation, async () => {
    await sweepAutoMitigation(ctx);
  });
  await boss.schedule(QUEUES.mitigation, "* * * * *");
  await boss.send(QUEUES.mitigation, {}, { singletonKey: "mitigation-evaluate" });
  await boss.work(QUEUES.rollouts, async () => {
    await evaluateRollouts(ctx);
  });
  await boss.schedule(QUEUES.rollouts, "* * * * *");
  await boss.work(QUEUES.dns, async () => {
    // Replaced CNAME prefixes leave the plan after their 24 hours; the
    // reconciliation runs whatever happens to them.
    try {
      const expired = await expireCnamePrefixes(ctx);
      if (expired.length) log.info("expired replaced CNAME prefixes", { clusters: expired });
    } catch (error) {
      log.warn("cannot expire replaced CNAME prefixes", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await reconcileDns(ctx);
  });
  await boss.schedule(QUEUES.dns, "* * * * *");
  await boss.send(QUEUES.dns, {}, { singletonKey: "dns-reconcile" });
  await boss.work(QUEUES.recompile, async () => {
    await recompileAfterUpgrade(ctx);
  });
  await boss.send(QUEUES.recompile, {}, { singletonKey: "recompile" });
  await boss.work(QUEUES.traffic, async () => {
    // Each maintenance family must run even when another one needs a retry.
    const results = await Promise.allSettled([
      maintainTraffic(ctx.db),
      // Usage protection right after the windows it reads are recomputed;
      // an alert it starts or ends is swept at once.
      maintainUsage(ctx.db).finally(async () => {
        if (await enforceUsageGuards(ctx))
          await boss.send(QUEUES.alerts, {}, { singletonKey: "alerts-sweep" });
      }),
      maintainLogs(ctx.db, Date.now(), ctx.env),
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
  // Once per start: uploads stored before keys nodes cannot load were refused.
  await boss.work(QUEUES.checkCertificates, async () => {
    await markUnloadableCertificates(ctx);
  });
  await boss.send(QUEUES.checkCertificates, {}, { singletonKey: "check-certificates" });
  // Once per start: ACME certificates issued before CAs were chosen per
  // certificate (EDGEWEIR_ACME_DIRECTORY) and before accounts were linked.
  await boss.work(QUEUES.linkAcmeAccounts, async () => {
    const changed = await reconcileAcmeCertificates(ctx);
    if (changed) log.info("reconciled ACME certificates", { changed });
  });
  await boss.send(QUEUES.linkAcmeAccounts, {}, { singletonKey: "link-acme-accounts" });

  await boss.work(QUEUES.pruneRevisions, async () => {
    const removed = await pruneRevisions(ctx.db);
    if (removed) log.info("pruned revisions", { removed });
    const dns = await pruneDnsRevisions(ctx.db);
    if (dns) log.info("pruned DNS revisions", { removed: dns });
  });
  await boss.work(QUEUES.expireEnrollmentTokens, async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const deleted = await deleteInBatches(
      ctx.db,
      schema.enrollmentToken,
      or(
        and(isNull(schema.enrollmentToken.usedAt), lt(schema.enrollmentToken.expiresAt, cutoff)),
        and(isNotNull(schema.enrollmentToken.usedAt), lt(schema.enrollmentToken.usedAt, cutoff)),
      ),
    );
    if (deleted) log.info("deleted stale enrollment tokens", { count: deleted });
  });

  await boss.work(QUEUES.expireCacheTasks, async () => {
    const expired = await expireCacheTasks(ctx.db);
    if (expired) log.info("expired undelivered cache tasks", { deliveries: expired });
    const pruned = await pruneCacheTasks(ctx.db);
    if (pruned) log.info("deleted old cache tasks", { removed: pruned });
  });

  await boss.work(QUEUES.pruneIdempotencyKeys, async () => {
    const removed = await pruneIdempotencyKeys(ctx.db);
    if (removed) log.info("pruned idempotency keys", { removed });
  });

  await boss.work(QUEUES.pruneBans, async () => {
    const removed = await pruneBans(ctx.db);
    if (removed) log.info("deleted expired bans", { removed });
  });

  // Hourly check; a cluster's keys rotate once they are a day old.
  await boss.work(QUEUES.rotateChallengeKeys, async () => {
    const rotated = await rotateChallengeKeys(ctx);
    if (rotated.length) log.info("rotated challenge keys", { clusters: rotated });
  });

  // Hourly check; a cluster's keys rotate once they are 12 hours old.
  await boss.work(QUEUES.rotateSessionTicketKeys, async () => {
    const rotated = await rotateSessionTicketKeys(ctx);
    if (rotated.length) log.info("rotated session ticket keys", { clusters: rotated });
  });

  // Hourly check; a cluster's origin client certificate is replaced 30 days before it expires.
  await boss.work(QUEUES.rotateOriginClientCertificates, async () => {
    const rotated = await rotateOriginClientCertificates(ctx);
    if (rotated.length) log.info("replaced origin client certificates", { clusters: rotated });
  });

  await boss.work(QUEUES.pruneSecurityEvents, async () => {
    const removed = await pruneSecurityEvents(ctx.db);
    if (removed) log.info("deleted old security events", { removed });
  });

  // Node logs past their retention or beyond each node's limit (ADR-0050):
  // at start (a worker that was down catches up), then every 10 minutes.
  await boss.work(QUEUES.pruneNodeLogs, async () => {
    const removed = await pruneNodeLogs(ctx.db);
    if (removed) log.info("deleted old node logs", { removed });
    const pulls = await pruneNodeDebugLogs(ctx.db);
    if (pulls) log.info("deleted old debug log pulls", { pulls });
  });
  await boss.send(QUEUES.pruneNodeLogs, {}, { singletonKey: "prune-node-logs" });

  // Scheduling (probe reachability and rules) every 10 s: pg-boss cron runs
  // at most once a minute, so an in-process timer, and a lease lets one
  // console process evaluate at a time. A run that is still busy skips a tick.
  let evaluating = false;
  const scheduling = setInterval(() => {
    if (evaluating) return;
    evaluating = true;
    schedulingTick(ctx)
      .catch((error: unknown) => log.warn("scheduling evaluation failed", { error }))
      .finally(() => {
        evaluating = false;
      });
  }, SCHEDULING_INTERVAL_MS);
  scheduling.unref();
  boss.on("stopped", () => clearInterval(scheduling));

  // External probe sources (ADR-0069): due polls and stale alerts on the same
  // 10-second timer, one process at a time; a poll's results are evaluated at once.
  let polling = false;
  const sources = setInterval(() => {
    if (polling) return;
    polling = true;
    withLease(ctx.db, "probe-sources:poll", 120, async () => {
      const clusters = await pollProbeSources(ctx);
      await sweepProbeSourceAlerts(ctx.db);
      if (clusters.length) await evaluateAfterProbeReport(ctx, clusters);
    })
      .catch((error: unknown) => log.warn("probe source polling failed", { error }))
      .finally(() => {
        polling = false;
      });
  }, SCHEDULING_INTERVAL_MS);
  sources.unref();
  boss.on("stopped", () => clearInterval(sources));

  // End-to-end tests only (EDGEWEIR_E2E_TICK_SECONDS): the every-minute jobs
  // run every few seconds too, one per queue and time slot.
  const tick = ctx.env.EDGEWEIR_E2E_TICK_SECONDS;
  if (tick) {
    const timer = setInterval(() => {
      for (const name of MINUTE_QUEUES)
        boss
          .send(name, {}, { singletonKey: "e2e-tick", singletonSeconds: tick })
          .catch((error: unknown) => log.warn("e2e tick failed", { queue: name, error }));
    }, tick * 1000);
    timer.unref();
    boss.on("stopped", () => clearInterval(timer));
  }

  await boss.schedule(QUEUES.pruneBans, "*/10 * * * *");
  await boss.schedule(QUEUES.rotateChallengeKeys, "11 * * * *");
  await boss.schedule(QUEUES.rotateSessionTicketKeys, "13 * * * *");
  await boss.schedule(QUEUES.rotateOriginClientCertificates, "19 * * * *");
  await boss.schedule(QUEUES.pruneSecurityEvents, "37 * * * *");
  await boss.schedule(QUEUES.pruneNodeLogs, "*/10 * * * *");
  await boss.schedule(QUEUES.pruneRevisions, "17 * * * *");
  await boss.schedule(QUEUES.pruneIdempotencyKeys, "29 * * * *");
  await boss.schedule(QUEUES.expireCacheTasks, "43 * * * *");
  await boss.schedule(QUEUES.expireEnrollmentTokens, "*/30 * * * *");
  log.info("worker started", { queues: Object.values(QUEUES) });
  return boss;
}
