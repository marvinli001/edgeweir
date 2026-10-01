import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { ensureSetupToken, runSetup } from "../../src/server/services/setup";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  signIn,
} from "./helpers";

/**
 * Audit entries commit with the change they describe: when writing the entry
 * fails (a trigger makes it fail on demand), the change is rolled back too.
 */
describe("audit entries share the business transaction", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;

  const failAuditFor = (action: string) =>
    client.query("insert into test_fail_audit (action) values ($1)", [action]);
  const count = async (table: string, where = "true") =>
    (await client.query<{ n: number }>(`select count(*)::int as n from "${table}" where ${where}`))
      .rows[0]?.n;

  beforeAll(async () => {
    await client.exec(`
      create table test_fail_audit (action text primary key);
      create function test_fail_audit() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from test_fail_audit where action = new.action) then
          raise exception 'audit write failed (test): %', new.action;
        end if;
        return new;
      end $$;
      create trigger test_fail_audit before insert on audit_log
        for each row execute function test_fail_audit();
    `);
  });
  afterEach(() => client.query("delete from test_fail_audit"));
  afterAll(() => client.close());

  it("rolls back the first-run setup and keeps the token usable", async () => {
    const setupToken = await ensureSetupToken(ctx);
    if (!setupToken) throw new Error("no setup token");
    const input = {
      setupToken,
      name: "Platform Admin",
      email: "admin@example.com",
      password: PASSWORD,
    };
    const meta = { ip: "127.0.0.1", userAgent: "vitest" };
    await failAuditFor("system.setup");
    await expect(runSetup(ctx, input, meta)).rejects.toThrow(/insert into "audit_log"/);
    expect(await count("user")).toBe(0);
    expect(await count("cluster")).toBe(0);
    expect(await ensureSetupToken(ctx)).toBe(setupToken);

    await client.query("delete from test_fail_audit");
    await runSetup(ctx, input, meta);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
  });

  it("stores no enrollment token without its audit entry", async () => {
    await failAuditFor("enrollment_token.create");
    await rpcError(admin.clusters.createEnrollmentToken({ clusterId }));
    expect(await count("enrollment_token")).toBe(0);
  });

  it("stores no origin allow list and publishes nothing when the update cannot be audited", async () => {
    const revisions = await count("config_revision");
    await failAuditFor("system.origin_allow_list_update");
    await rpcError(admin.settings.setOriginAllowList({ cidrs: ["10.0.0.0/8"] }));
    const [row] = await ctx.db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, "origin_allow_list"));
    expect(row).toBeUndefined();
    expect(await count("config_revision")).toBe(revisions);
  });
});
