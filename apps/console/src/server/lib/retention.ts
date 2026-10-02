import { type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Executor } from "../services/revisions";

/** Rows a retention job deletes per statement. */
export const RETENTION_BATCH = 5000;

/**
 * Deletes the rows of `table` that `where` matches, at most `batch` per
 * statement, until a statement finds fewer; returns how many. Outside a
 * transaction each statement commits on its own, so a backlog (a shorter
 * retention, a worker that was down) is no single long delete, and only
 * the count leaves the database, not the rows.
 */
export async function deleteInBatches(
  db: Executor,
  table: PgTable,
  where: SQL | undefined,
  batch = RETENTION_BATCH,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    // ctid = any(array(...)): a TID scan of the rows the batch picked.
    const result = await db.execute<{ n: number }>(sql`
      with gone as (
        delete from ${table}
        where ctid = any(array(select ctid from ${table} where ${where ?? sql`true`} limit ${batch}))
        returning 1
      )
      select count(*)::int as n from gone`);
    const n = Number(result.rows[0]?.n ?? 0);
    deleted += n;
    if (n < batch) return deleted;
  }
}
