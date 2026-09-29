import type { Server } from "node:http";
import type { Http2SecureServer } from "node:http2";
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
import { startNodeChannel } from "./node-channel/server";
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

  const { db, pool } = createDatabase(env.DATABASE_URL);
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

  let nodeChannel: Http2SecureServer | undefined;
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
    const closeServer = (s?: { close(cb: (err?: Error) => void): unknown }) =>
      new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
    (http as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
    await Promise.all([closeServer(http), closeServer(nodeChannel)]);
    await boss?.stop({ graceful: true, timeout: 5000 }).catch(() => {});
    await events.stop();
    await pool.end();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  return { ctx, attachHttp: (s) => (http = s), shutdown };
}
