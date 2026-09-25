import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { MasterKey } from "../../src/server/lib/envelope";
import { ensureSetupToken, SETUP_TOKEN_PREFIX } from "../../src/server/services/setup";
import { createTestContext, PASSWORD, rpcClient, rpcError, signIn } from "./helpers";

describe("first-run setup token", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const client = rpcClient(app, origin);
  afterAll(() => pglite.close());

  const input = {
    name: "Platform Admin",
    email: "Admin@Example.com",
    password: PASSWORD,
    organizationName: "Acme Edge",
  };

  it("issues one token, stored sealed and hashed, and repeats it on restart", async () => {
    const token = await ensureSetupToken(ctx);
    expect(token?.startsWith(SETUP_TOKEN_PREFIX)).toBe(true);
    expect(await ensureSetupToken(ctx)).toBe(token);
    const [row] = await ctx.db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, "setup_token"));
    expect(JSON.stringify(row?.value)).not.toContain(token);
  });

  it("refuses setup without the right token", async () => {
    const error = await rpcError(client.system.setup({ ...input, setupToken: "ews_wrong" }));
    expect(error.code).toBe("SETUP_TOKEN_INVALID");
    expect(error.status).toBe(403);
    expect((await client.system.status()).initialized).toBe(false);
    const [rejected] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.setup_rejected"));
    expect(rejected).toBeDefined();
  });

  it("creates the administrator, organization and default cluster with the token", async () => {
    const token = await ensureSetupToken(ctx);
    if (!token) throw new Error("no token");
    const result = await client.system.setup({ ...input, setupToken: token });
    expect(result.organizationId).toBeTruthy();
    expect((await client.system.status()).initialized).toBe(true);

    // The token is spent: no new token, and a second setup is refused.
    expect(await ensureSetupToken(ctx)).toBeNull();
    const again = await rpcError(client.system.setup({ ...input, setupToken: token }));
    expect(again.code).toBe("SETUP_DONE");

    const cookie = await signIn(app, origin, "admin@example.com");
    const admin = rpcClient(app, origin, cookie);
    const me = await admin.account.me();
    expect(me.user).toMatchObject({ name: "Platform Admin", isAdmin: true });
    expect(me.activeOrganization).toMatchObject({ name: "Acme Edge", slug: "acme-edge" });
    const clusters = await admin.clusters.list();
    expect(clusters.map((c) => c.name)).toEqual(["default"]);
    expect(clusters[0]?.latestRevision).toMatchObject({
      revision: 1,
      reasonCode: "cluster_created",
      reasonParams: { cluster: "default" },
      reason: "cluster default created",
    });
    const settings = await admin.settings.get();
    expect(settings.setupCompletedAt).not.toBeNull();
    const audit = await admin.auditLogs.list({ action: "system.setup" });
    expect(audit.items[0]).toMatchObject({
      actorName: "Platform Admin",
      targetName: "Platform Admin",
    });
  });
});

describe("setup token storage", async () => {
  const { ctx, client: pglite } = await createTestContext();
  afterAll(() => pglite.close());

  it("is shared by instances starting together and reissued after a master key change", async () => {
    const [a, b] = await Promise.all([ensureSetupToken(ctx), ensureSetupToken(ctx)]);
    expect(a).toMatch(/^ews_/);
    expect(b).toBe(a);
    const rotated = {
      db: ctx.db,
      masterKey: new MasterKey(Buffer.alloc(32, 9).toString("base64")),
    };
    const reissued = await ensureSetupToken(rotated);
    expect(reissued).toMatch(/^ews_/);
    expect(reissued).not.toBe(a);
    expect(await ensureSetupToken(rotated)).toBe(reissued);
  });
});
