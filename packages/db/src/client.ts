import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
}

/**
 * Creates a pooled node-postgres connection and a typed Drizzle instance.
 *
 * A connection lost while PostgreSQL restarts or terminates the backend is
 * an "error" event, which ends the process unless something listens. The pool
 * re-emits errors of idle clients (they go to onError); a checked-out client,
 * e.g. in a transaction, emits on itself, and its pending and later queries
 * fail with the error, so its own listener only keeps the event from throwing.
 */
export function createDatabase(
  connectionString: string,
  onError: (error: Error) => void,
  max = 10,
): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max, application_name: "edgeweir" });
  pool.on("error", onError);
  pool.on("connect", (client) => client.on("error", () => {}));
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool };
}
