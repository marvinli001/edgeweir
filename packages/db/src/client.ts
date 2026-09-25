import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
}

/** Creates a pooled node-postgres connection and a typed Drizzle instance. */
export function createDatabase(connectionString: string, max = 10): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max, application_name: "edgeweir" });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool };
}
