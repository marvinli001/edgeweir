import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as locks from "../../src/server/lib/locks";
import type { Executor } from "../../src/server/services/revisions";

/** The statements a lock helper runs, rendered as PostgreSQL text and parameters. */
async function statements(take: (tx: Executor) => Promise<unknown>) {
  const execute = vi.fn(async (_query: SQL) => ({ rows: [{ locked: true }] }));
  await take({ execute } as unknown as Executor);
  const dialect = new PgDialect();
  return execute.mock.calls.map(([query]) => {
    const { sql, params } = dialect.sqlToQuery(query);
    return { sql, params };
  });
}

const exclusive = (key: string) => ({
  sql: "select pg_advisory_xact_lock(hashtext($1))",
  params: [key],
});
const shared = (key: string) => ({
  sql: "select pg_advisory_xact_lock_shared(hashtext($1))",
  params: [key],
});

describe("advisory locks", () => {
  // Every console instance takes the same keys: these never change.
  it.each([
    ["publish", (tx: Executor) => locks.lockClusterPublish(tx, "c1"), "edgeweir.publish.c1"],
    ["l4", (tx: Executor) => locks.lockClusterL4(tx, "c1"), "edgeweir.l4.c1"],
    [
      "scheduling",
      (tx: Executor) => locks.lockClusterScheduling(tx, "c1"),
      "edgeweir.scheduling.c1",
    ],
    ["upgrade", (tx: Executor) => locks.lockClusterUpgrade(tx, "c1"), "upgrade/c1"],
    ["protection", locks.lockProtectionSettings, "edgeweir.protection-settings"],
    ["CC template", locks.lockCcTemplate, "edgeweir.cc-template"],
    ["error pages", locks.lockPlatformErrorPages, "edgeweir.error-pages"],
    ["platform rules", locks.lockPlatformRules, "edgeweir.platform-rules"],
    ["IP lists", locks.lockIpLists, "edgeweir.ip-lists"],
    ["alert channels", locks.lockAlertChannels, "edgeweir.alert-channels"],
    ["bans", (tx: Executor) => locks.lockBans(tx, "exclusive"), "edgeweir.bans"],
    ["stats", (tx: Executor) => locks.lockStats(tx, "exclusive"), "edgeweir.stats.retention"],
    ["usage", locks.lockUsage, "edgeweir.usage"],
    ["usage watermark", locks.lockUsageWatermark, "edgeweir.usage-watermark"],
    ["auth secret", locks.lockAuthSecret, "edgeweir.auth-secret"],
    ["envelopes", locks.lockEnvelopeUpgrade, "edgeweir.envelope-upgrade"],
    ["node CA", locks.lockNodeCa, "edgeweir.pki.node-channel"],
    ["recompile", locks.lockRecompile, "edgeweir.recompile"],
    ["log partitions", locks.lockLogPartitions, "edgeweir.logs.partitions"],
    [
      "log partition",
      (tx: Executor) => locks.lockLogPartition(tx, "access_log_20261002"),
      "access_log_20261002",
    ],
  ])("keys the %s lock", async (_name, take, key) => {
    expect(await statements(take)).toEqual([exclusive(key)]);
  });

  it("takes the shared side of the bans and statistics locks", async () => {
    expect(await statements((tx) => locks.lockBans(tx, "shared"))).toEqual([
      shared("edgeweir.bans"),
    ]);
    expect(await statements((tx) => locks.lockStats(tx, "shared"))).toEqual([
      shared("edgeweir.stats.retention"),
    ]);
  });

  it("locks each domain once, in name order", async () => {
    expect(
      await statements((tx) => locks.lockDomains(tx, ["b.example", "a.example", "b.example"])),
    ).toEqual([exclusive("edgeweir.domain.a.example"), exclusive("edgeweir.domain.b.example")]);
  });

  it("tries a node's log batch lock", async () => {
    let result: boolean | undefined;
    expect(
      await statements(async (tx) => {
        result = await locks.tryLockNodeLogs(tx, "n1");
      }),
    ).toEqual([
      { sql: "select pg_try_advisory_xact_lock(hashtext($1)) AS locked", params: ["logs/n1"] },
    ]);
    expect(result).toBe(true);
  });

  it("holds the setup and alert sweep session locks on the given connection", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] });
    const client = { query } as never;
    expect(await locks.tryLockSetup(client)).toBe(false);
    await locks.unlockSetup(client);
    expect(await locks.tryLockAlertSweep(client)).toBe(false);
    await locks.unlockAlertSweep(client);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      "select pg_try_advisory_lock(hashtext('edgeweir.setup')) as locked",
      "select pg_advisory_unlock(hashtext('edgeweir.setup'))",
      "select pg_try_advisory_lock(550075, 6) as locked",
      "select pg_advisory_unlock(550075, 6)",
    ]);
  });
});
