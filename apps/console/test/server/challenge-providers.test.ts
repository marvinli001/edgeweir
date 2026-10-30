import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { nodeProviderSecrets } from "../../src/server/services/challenge-providers";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Fake values: never key-shaped (push protection).
const TURNSTILE_SECRET = "fake-turnstile-secret-for-tests";
const TENCENT = {
  secretId: "fake-tencent-secret-id",
  secretKey: "fake-tencent-secret-key",
  appSecretKey: "fake-tencent-app-secret",
};

describe("interactive challenge providers", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let otherClusterId: string;
  let siteId: string;
  let builtinSiteId: string;
  let farSiteId: string;
  const origins = [{ address: "origin.test" }];
  const config = async (cluster = clusterId) =>
    decodeNodeConfig((await latestRevision(ctx.db, cluster))?.ir ?? new Uint8Array());
  const revision = async (cluster = clusterId) =>
    (await latestRevision(ctx.db, cluster))?.revision ?? 0;
  const rawIr = async (cluster = clusterId) =>
    Buffer.from((await latestRevision(ctx.db, cluster))?.ir ?? new Uint8Array()).toString("latin1");
  const rows = () => ctx.db.select().from(schema.challengeProvider);
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  const noLog = () => {};

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    otherClusterId = (await admin.clusters.create({ name: "far", description: "" })).id;
    siteId = (await admin.sites.create({ name: "shop", domains: ["shop.cp.test"], origins })).site
      .id;
    builtinSiteId = (
      await admin.sites.create({ name: "plain", domains: ["plain.cp.test"], origins })
    ).site.id;
    farSiteId = (
      await admin.sites.create({
        name: "far",
        clusterId: otherClusterId,
        domains: ["far.cp.test"],
        origins,
      })
    ).site.id;
    // Protection (and so the provider) is compiled for clusters with challenges.
    await admin.protection.update({ id: siteId, underAttack: true });
    await admin.protection.update({ id: farSiteId, underAttack: true });
  });
  afterAll(() => pglite.close());

  it("reads the built-in image as the default, site and global", async () => {
    const protection = await admin.protection.get({ id: siteId });
    expect(protection).toMatchObject({
      interactiveProvider: "global",
      provider: { kind: "builtin", secretSet: false },
      globalProvider: { kind: "builtin", secretSet: false },
    });
    expect((await admin.settings.protection()).provider).toMatchObject({ kind: "builtin" });
  });

  it("seals the global provider's secret, never reads it back and keeps it when left out", async () => {
    const platform = await admin.settings.protection();
    const saved = await admin.settings.setProtection({
      ...platform,
      provider: {
        kind: "turnstile",
        siteKey: "0xFAKE-site-key",
        secret: { secret: TURNSTILE_SECRET },
      },
    });
    expect(saved.provider).toMatchObject({
      kind: "turnstile",
      siteKey: "0xFAKE-site-key",
      secretSet: true,
    });
    expect(JSON.stringify(saved)).not.toContain(TURNSTILE_SECRET);
    expect(JSON.stringify(await admin.settings.protection())).not.toContain(TURNSTILE_SECRET);
    const [row] = await ctx.db
      .select()
      .from(schema.challengeProvider)
      .where(isNull(schema.challengeProvider.siteId));
    expect(row?.secretEnvelope).toBeTruthy();
    expect(row?.secretEnvelope).not.toContain(TURNSTILE_SECRET);
    expect(row?.secretVersion).toBe(1);
    const [audit] = await audits("system.protection_update");
    expect(JSON.stringify(audit)).not.toContain(TURNSTILE_SECRET);

    // The sites following the global default get it: the provider, never the secret.
    const site = (await config()).sites.find((s) => s.id === siteId);
    expect(site?.protection?.interactive).toMatchObject({
      kind: "turnstile",
      siteKey: "0xFAKE-site-key",
      credentialId: row?.id,
      credentialVersion: 1n,
    });
    expect(await rawIr()).not.toContain(TURNSTILE_SECRET);
    expect((await config()).requiredFeatures).toContain("challenge-v3");

    // The same form again: no new secret version, no new revision.
    const before = await revision();
    await admin.settings.setProtection({
      ...platform,
      provider: { kind: "turnstile", siteKey: "0xFAKE-site-key" },
    });
    expect(await revision()).toBe(before);
    const [same] = await ctx.db
      .select()
      .from(schema.challengeProvider)
      .where(isNull(schema.challengeProvider.siteId));
    expect([same?.secretEnvelope, same?.secretVersion]).toEqual([row?.secretEnvelope, 1]);
  });

  it("requires every secret field for a new kind and for a site's own provider", async () => {
    const platform = await admin.settings.protection();
    const missing = await rpcError(
      admin.settings.setProtection({
        ...platform,
        provider: { kind: "recaptcha_v2", siteKey: "fake-v2" },
      }),
    );
    expect([missing.status, missing.code]).toEqual([400, "CHALLENGE_PROVIDER_SECRET_REQUIRED"]);
    expect(missing.data).toMatchObject({ fields: "secret" });

    const partial = await rpcError(
      admin.protection.update({
        id: siteId,
        interactiveProvider: "site",
        provider: { kind: "tencent", siteKey: "190000001", secret: { secretId: TENCENT.secretId } },
      }),
    );
    expect([partial.code, partial.data]).toEqual([
      "CHALLENGE_PROVIDER_SECRET_REQUIRED",
      { fields: "secretKey, appSecretKey" },
    ]);
    const unknown = await rpcError(
      admin.protection.update({
        id: siteId,
        provider: { kind: "turnstile", siteKey: "x", secret: { secretKey: "fake" } },
      }),
    );
    expect(unknown.status).toBe(400);
    expect(await ctx.db.select().from(schema.challengeProvider)).toHaveLength(1);
  });

  it("uses a site's own provider, raises its version on a new secret and the built-in on builtin", async () => {
    const own = await admin.protection.update({
      id: siteId,
      interactiveProvider: "site",
      provider: { kind: "tencent", siteKey: "190000001", secret: TENCENT },
    });
    expect(own).toMatchObject({
      interactiveProvider: "site",
      provider: { kind: "tencent", siteKey: "190000001", secretSet: true },
      globalProvider: { kind: "turnstile" },
    });
    expect(JSON.stringify(own)).not.toContain(TENCENT.secretKey);
    const [audit] = await audits("site.protection_update");
    expect(JSON.stringify(audit)).not.toContain(TENCENT.secretKey);
    const row = (await rows()).find((r) => r.siteId === siteId);
    const site = (await config()).sites.find((s) => s.id === siteId);
    expect(site?.protection?.interactive).toMatchObject({
      kind: "tencent",
      credentialId: row?.id,
      credentialVersion: 1n,
    });

    // One secret field replaced: the others stay, the version rises.
    await admin.protection.update({
      id: siteId,
      provider: {
        kind: "tencent",
        siteKey: "190000001",
        secret: { secretKey: "fake-rotated-key" },
      },
    });
    const rotated = (await rows()).find((r) => r.siteId === siteId);
    expect(rotated?.secretVersion).toBe(2);
    const [secret] = await nodeProviderSecrets(
      ctx.db,
      ctx.masterKey,
      clusterId,
      [row?.id ?? ""],
      noLog,
    );
    expect(JSON.parse(secret?.secretAccessKey ?? "{}")).toEqual({
      ...TENCENT,
      secretKey: "fake-rotated-key",
    });
    expect(secret?.version).toBe(2n);

    // Another kind needs its own fields; the saved ones are not carried over.
    const geetest = await rpcError(
      admin.protection.update({
        id: siteId,
        provider: { kind: "geetest", siteKey: "fake-captcha-id" },
      }),
    );
    expect(geetest.data).toEqual({ fields: "captchaKey" });

    await admin.protection.update({ id: builtinSiteId, interactiveProvider: "builtin" });
    const plain = (await config()).sites.find((s) => s.id === builtinSiteId);
    expect(plain?.protection?.interactive).toBeUndefined();
  });

  it("hands provider secrets to nodes of a cluster with sites that use them", async () => {
    const all = await rows();
    const global = all.find((r) => r.siteId === null);
    const own = all.find((r) => r.siteId === siteId);
    const ids = [global?.id ?? "", own?.id ?? "", crypto.randomUUID()];
    // shop uses its own row; the unknown id gives nothing.
    const near = await nodeProviderSecrets(ctx.db, ctx.masterKey, clusterId, ids, noLog);
    expect(near.map((c) => c.id)).toContain(own?.id);
    expect(near).toHaveLength(near.some((c) => c.id === global?.id) ? 2 : 1);
    // far follows the global default; shop's row is not of its cluster.
    const far = await nodeProviderSecrets(ctx.db, ctx.masterKey, otherClusterId, ids, noLog);
    expect(far.map((c) => [c.id, c.accessKeyId])).toEqual([[global?.id, ""]]);
    expect(JSON.parse(far[0]?.secretAccessKey ?? "{}")).toEqual({ secret: TURNSTILE_SECRET });
    expect(
      (await config(otherClusterId)).sites.find((s) => s.id === farSiteId)?.protection?.interactive,
    ).toMatchObject({
      kind: "turnstile",
      credentialId: global?.id,
    });
  });

  it("compiles managed and non-interactive challenge rule actions and managed Under Attack", async () => {
    await admin.rules.save({
      id: builtinSiteId,
      rules: [
        {
          name: "login",
          phase: "waf-custom",
          enabled: true,
          expression: 'http.request.uri.path eq "/login"',
          action: { kind: "managed_challenge" },
        },
        {
          name: "api",
          phase: "waf-custom",
          enabled: true,
          expression: 'http.request.uri.path eq "/api"',
          action: { kind: "js_challenge" },
        },
      ],
    });
    const rules = (await config()).sites.find((s) => s.id === builtinSiteId)?.rules ?? [];
    expect(rules.map((r) => r.action)).toMatchObject([
      { kind: "challenge", challenge: "managed" },
      { kind: "challenge", challenge: "pow" },
    ]);
    expect((await admin.rules.get({ id: builtinSiteId })).map((r) => r.action.kind)).toEqual([
      "managed_challenge",
      "js_challenge",
    ]);
    const wrongPhase = await rpcError(
      admin.rules.save({
        id: builtinSiteId,
        rules: [
          {
            name: "late",
            phase: "ratelimit",
            enabled: true,
            expression: "true",
            action: { kind: "managed_challenge" } as never,
          },
        ],
      }),
    );
    expect(wrongPhase.status).toBe(400);
    await admin.rules.save({ id: builtinSiteId, rules: [] });

    await admin.protection.update({
      id: builtinSiteId,
      underAttack: true,
      underAttackChallenge: "managed",
    });
    const site = (await config()).sites.find((s) => s.id === builtinSiteId);
    expect(site?.protection).toMatchObject({ underAttack: true, underAttackChallenge: "managed" });
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["challenge-v1", "challenge-v3"]),
    );
  });
});
