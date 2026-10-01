import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/client";

/** Accepts connections like PostgreSQL (no password) and never answers a query. */
async function fakePostgres() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    // AuthenticationOk, then ReadyForQuery (idle), after the startup message.
    socket.once("data", () =>
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://edgeweir@127.0.0.1:${port}/edgeweir`,
    /** What a PostgreSQL restart or pg_terminate_backend looks like to the client. */
    terminate: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("createDatabase", () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  it("survives losing idle and checked-out connections (audit 2026-10-01 P0-1)", async () => {
    const server = await fakePostgres();
    cleanup.push(server.close);
    const errors: Error[] = [];
    const { pool } = createDatabase(server.url, (error) => errors.push(error));
    cleanup.push(() => pool.end());

    // Idle in the pool: the pool reports it and drops the client.
    (await pool.connect()).release();
    expect(pool.idleCount).toBe(1);
    server.terminate();
    await settle();
    expect(errors).toHaveLength(1);
    expect(pool.totalCount).toBe(0);

    // Checked out, as in a transaction: the query fails instead of the process.
    const client = await pool.connect();
    const pending = client.query("select 1");
    server.terminate();
    await expect(pending).rejects.toThrow();
    await settle();
    await expect(client.query("select 1")).rejects.toThrow(/not queryable/);
    client.release(new Error("connection lost"));
    expect(pool.totalCount).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
