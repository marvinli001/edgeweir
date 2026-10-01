import type { Server } from "node:http";
import { createDatabase, runMigrations } from "@edgeweir/db";
import type { PgBoss } from "pg-boss";
import { startWorker } from "./jobs/worker";
import { createAuth } from "./lib/auth";
import { assertAuthSecret, resolveAuthSecret } from "./lib/auth-secret";
import type { AppContext } from "./lib/context";
import { loadEnv } from "./lib/env";
import { MasterKey } from "./lib/envelope";
import { ConfigEventBus } from "./lib/events";
import { logger, setLogLevel } from "./lib/logger";
import { CLOSE_GRACE_MS, type NodeChannel, startNodeChannel } from "./node-channel/server";
import { loadOrCreateNodeCa } from "./pki/store";
import { upgradeLegacyEnvelopes } from "./services/envelope-upgrade";
import { announceSetupToken, ensureSetupToken } from "./services/setup";

async function waitForDatabase(pool: import("pg").Pool, timeoutMs = 60_000) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      logger.warn("database not reachable yet", { attempt, error: (error as Error).message });
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000)));
    }
  }
}

/** The whole shutdown, after which the process exits with 1. */
export const SHUTDOWN_TIMEOUT_MS = 8000;

/**
 * Stops the HTTP listener and closes idle connections at once; requests in
 * flight get `graceMs` before their connections are closed too.
 */
export function closeHttp(server: Server | undefined, graceMs = CLOSE_GRACE_MS): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(deadline);
      resolve();
    });
    server.closeIdleConnections();
  });
}

export interface Running {
  ctx: AppContext;
  /** Registers the HTTP server so it is closed on shutdown. */
  attachHttp(server: Server): void;
  shutdown(): Promise<void>;
}

/** Loads config, migrates the database and starts the roles selected by ROLE. */
export async function bootstrap(): Promise<Running> {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);
  const log = logger;
  log.info("starting edgeweir console", { version: env.version, role: env.ROLE });
  // A promise nobody awaits must not take down the UI, API, node channel and
  // worker with it (Node.js exits on an unhandled rejection by default).
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

  const { db, pool } = createDatabase(env.DATABASE_URL, (error) =>
    log.warn("database connection lost", { error }),
  );
  await waitForDatabase(pool);
  await runMigrations(pool);
  log.info("database migrated");

  const masterKey = new MasterKey(env.EDGEWEIR_MASTER_KEY);
  const authSecret = resolveAuthSecret(env);
  await assertAuthSecret(db, authSecret, log);
  log.info("session secret", { source: authSecret.source });
  // Secrets sealed before envelopes were bound to their record id.
  await upgradeLegacyEnvelopes(db, masterKey, log);
  const nodeCa = await loadOrCreateNodeCa(db, masterKey);
  const auth = createAuth({
    db,
    secret: authSecret.value,
    publicUrl: env.EDGEWEIR_PUBLIC_URL,
  });
  const events = new ConfigEventBus(env.DATABASE_URL, log.child({ component: "events" }));
  const ctx: AppContext = { env, db, pool, auth, masterKey, nodeCa, events, log };

  let nodeChannel: NodeChannel | undefined;
  let boss: PgBoss | undefined;
  let http: Server | undefined;

  if (env.ROLE === "app" || env.ROLE === "all") {
    const setupToken = await ensureSetupToken(ctx);
    if (setupToken) announceSetupToken(log, setupToken, env.EDGEWEIR_PUBLIC_URL);
    await events.start();
    nodeChannel = await startNodeChannel(ctx);
  }
  if (env.ROLE === "worker" || env.ROLE === "all") {
    boss = await startWorker(ctx);
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log.info("shutting down");
    // Requests in flight get CLOSE_GRACE_MS; the listeners, the watch streams
    // of connected nodes and pg-boss stop at the same time.
    await Promise.all([
      closeHttp(http),
      // Also stops rotating the node channel certificate.
      nodeChannel?.close(CLOSE_GRACE_MS),
      boss
        ?.stop({ graceful: true, timeout: 5000 })
        .catch((error: unknown) => log.warn("pg-boss did not stop cleanly", { error })),
    ]);
    await events.stop();
    await pool.end();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      // Exit before the container runtime's SIGKILL (10 s after SIGTERM by default).
      setTimeout(() => {
        log.error("shutdown timed out", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      void shutdown().finally(() => process.exit(0));
    });
  }
  return { ctx, attachHttp: (s) => (http = s), shutdown };
}
