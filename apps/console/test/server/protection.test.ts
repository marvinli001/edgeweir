import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  CHALLENGE_KEY_ROTATION_MS,
  rotateChallengeKeys,
} from "../../src/server/services/challenge-keys";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  approveSiteDomains,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const template = {
  maxLevel: "pow" as const,
  highPowInsteadOfCaptcha: false,
  windowSeconds: 20,
  siteQps: 500,
  urlQps: 100,
  ipQps: 30,
  ipBanSeconds: 900,
  originErrorPercent: 40,
  originErrorMinRequests: 50,
  escalateAfterSeconds: 15,
  cooldownSeconds: 120,
};

describe("site protection, platform protection and challenge keys", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let outsider: ApiClient;
  let clusterId: string;
  let otherClusterId: string;
  let orgId: string;
  let siteId: string;
  let otherSiteId: string;
  let quietSiteId: string;
  const origins = [{ address: "origin.test" }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async (cluster = clusterId) =>
    decodeNodeConfig((await latestRevision(ctx.db, cluster))?.ir ?? new Uint8Array());
  const keysOf = (cluster: string) =>
    ctx.db
      .select()
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.clusterId, cluster))
      .orderBy(schema.challengeKey.role);
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    otherClusterId = (await admin.clusters.create({ name: "quiet", description: "" })).id;
    orgId = (await admin.organizations.create({ name: "Shield", defaultClusterId: clusterId })).id;
    const otherOrgId = (
      await admin.organizations.create({ name: "Elsewhere", defaultClusterId: clusterId })
    ).id;
    const users: [string, string, "owner" | "member"][] = [
      ["owner@shield.test", orgId, "owner"],
      ["member@shield.test", orgId, "member"],
      ["owner@elsewhere.test", otherOrgId, "owner"],
    ];
    for (const [email, organizationId, role] of users)
      await admin.users.create({ name: email, email, password: PASSWORD, organizationId, role });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@shield.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@shield.test"));
    outsider = rpcClient(app, origin, await signIn(app, origin, "owner@elsewhere.test"));
    siteId = (await owner.sites.create({ name: "shop", domains: ["shop.shield.test"], origins }))
      .site.id;
    otherSiteId = (
      await outsider.sites.create({ name: "else", domains: ["else.elsewhere.test"], origins })
    ).site.id;
    quietSiteId = (
      await admin.sites.create({
        name: "quiet",
        clusterId: otherClusterId,
        domains: ["quiet.quietplace.test"],
        origins,
      })
    ).site.id;
    for (const id of [siteId, otherSiteId, quietSiteId]) await approveSiteDomains(admin, id);
  });
  afterAll(() => pglite.close());

  it("reads the defaults and leaves unused clusters without protection or keys", async () => {
    const protection = await member.protection.get({ id: siteId });
    expect(protection).toMatchObject({
      siteId,
      underAttack: false,
      underAttackChallenge: "js",
      passTtlSeconds: 1800,
      powDifficulty: 16,
      powHighDifficulty: 20,
      cc: {
        enabled: false,
        followTemplate: true,
        maxLevel: "captcha",
        windowSeconds: 10,
        siteQps: 1000,
        urlQps: 200,
        ipQps: 50,
        ipBanSeconds: 600,
        originErrorPercent: 50,
        originErrorMinRequests: 100,
        escalateAfterSeconds: 10,
        cooldownSeconds: 60,
      },
      ccTemplate: { maxLevel: "captcha", siteQps: 1000, ipBanSeconds: 600 },
      effectiveCc: null,
      logJa4: false,
      platformUnderAttack: false,
      updatedAt: null,
    });
    const current = await config();
    expect(current.challengeKeys).toEqual([]);
    expect(current.platformProtection).toBeUndefined();
    expect(current.sites.every((site) => !site.protection)).toBe(true);
    expect(current.requiredFeatures).not.toContain("challenge-v1");
    expect(await keysOf(clusterId)).toEqual([]);
  });

  it("allows owners to change protection, members to read it and nobody else to reach it", async () => {
    expect(
      await rpcError(member.protection.update({ id: siteId, underAttack: true })),
    ).toMatchObject({ code: "ORG_ADMIN_REQUIRED", status: 403 });
    expect(
      await rpcError(outsider.protection.update({ id: siteId, underAttack: true })),
    ).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    expect(await rpcError(outsider.protection.get({ id: siteId }))).toMatchObject({
      code: "SITE_NOT_FOUND",
    });
    expect(await rpcError(outsider.security.state({ id: siteId }))).toMatchObject({
      code: "SITE_NOT_FOUND",
    });
    expect(await rpcError(outsider.security.events({ id: siteId }))).toMatchObject({
      code: "SITE_NOT_FOUND",
    });
    // Tenants never reach the platform settings.
    for (const call of [
      () => owner.settings.protection(),
      () => owner.settings.ccTemplate(),
      () => owner.settings.setCcTemplate(template),
      () =>
        owner.settings.setProtection({
          underAttack: true,
          underAttackChallenge: "js",
          eventRetentionDays: 30,
        }),
    ])
      expect((await rpcError(call())).status).toBe(403);
    // Read-only AccessKeys read but cannot write.
    const reader = await owner.accessKeys.create({ name: "protection-read", scope: "read" });
    const read = await api(reader.key, "GET", `/sites/${siteId}/protection`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ siteId, underAttack: false });
    const write = await api(reader.key, "PATCH", `/sites/${siteId}/protection`, {
      underAttack: true,
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    expect((await api(reader.key, "GET", `/sites/${siteId}/security`)).status).toBe(200);
    expect((await api(reader.key, "GET", `/sites/${siteId}/security/events`)).status).toBe(200);
    expect(await keysOf(clusterId)).toEqual([]);
  });

  it("turns on Under Attack through /api/v1, creating the cluster's keys and publishing", async () => {
    const before = (await config()).revision;
    const writer = await owner.accessKeys.create({ name: "protection-write", scope: "write" });
    const res = await api(writer.key, "PATCH", `/sites/${siteId}/protection`, {
      underAttack: true,
      underAttackChallenge: "pow",
      passTtlSeconds: 3600,
      powDifficulty: 18,
      powHighDifficulty: 22,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      underAttack: true,
      underAttackChallenge: "pow",
      passTtlSeconds: 3600,
      powDifficulty: 18,
      powHighDifficulty: 22,
    });
    const keys = await keysOf(clusterId);
    expect(keys.map((key) => key.role).sort()).toEqual(["current", "next", "previous"]);
    // Secrets are generated when a node first asks for them.
    expect(keys.every((key) => key.secret === null)).toBe(true);
    const current = await config();
    expect(current.revision).toBeGreaterThan(before);
    const revision = await latestRevision(ctx.db, clusterId);
    expect(revision).toMatchObject({
      reasonCode: "site_protection_updated",
      reasonParams: { site: "shop" },
    });
    expect(current.challengeKeys.map((key) => key.id)).toEqual(keys.map((key) => key.id).sort());
    expect(current.challengeKeys.map((key) => key.role)).toEqual(
      [...keys].sort((a, b) => (a.id < b.id ? -1 : 1)).map((key) => key.role),
    );
    expect(current.platformProtection).toMatchObject({ underAttack: false });
    const shop = current.sites.find((site) => site.id === siteId);
    expect(shop?.protection).toMatchObject({
      underAttack: true,
      underAttackChallenge: "pow",
      passTtlSeconds: 3600,
      powDifficulty: 18,
      powHighDifficulty: 22,
      logJa4: false,
    });
    // Every other site of the cluster carries its (default) protection too.
    expect(current.sites.find((site) => site.id === otherSiteId)?.protection).toMatchObject({
      underAttack: false,
      passTtlSeconds: 1800,
    });
    expect(current.requiredFeatures).toContain("challenge-v1");
    // The other cluster is untouched.
    expect((await config(otherClusterId)).challengeKeys).toEqual([]);
    expect(await keysOf(otherClusterId)).toEqual([]);
    const [audit] = await audits("site.protection_update");
    expect(audit).toMatchObject({ organizationId: orgId, targetId: siteId, actorType: "api_key" });
    expect(audit?.metadata).toMatchObject({
      from: { underAttack: false },
      to: { underAttack: true, underAttackChallenge: "pow" },
    });
  });

  it("validates the proof-of-work difficulties and ranges", async () => {
    expect(
      await rpcError(owner.protection.update({ id: siteId, powHighDifficulty: 17 })),
    ).toMatchObject({ code: "PROTECTION_POW_DIFFICULTY", status: 400, data: { min: 18 } });
    for (const input of [
      { passTtlSeconds: 299 },
      { passTtlSeconds: 86401 },
      { powDifficulty: 7 },
      { powDifficulty: 25 },
      { powHighDifficulty: 27 },
      { cc: { windowSeconds: 4 } },
      { cc: { ipBanSeconds: 59 } },
    ])
      expect((await rpcError(owner.protection.update({ id: siteId, ...input }))).status).toBe(400);
  });

  it("follows the platform CC template until the site uses its own thresholds", async () => {
    await admin.settings.setCcTemplate(template);
    // Following sites with CC off do not publish.
    const idle = (await latestRevision(ctx.db, clusterId))?.reasonCode;
    expect(idle).not.toBe("cc_template_updated");
    const following = await owner.protection.update({ id: siteId, cc: { enabled: true } });
    expect(following.cc).toMatchObject({ enabled: true, followTemplate: true, ...template });
    expect(following.effectiveCc).toEqual(template);
    expect(following.ccTemplate).toEqual(template);
    const cc = (await config()).sites.find((site) => site.id === siteId)?.protection?.cc;
    expect(cc).toMatchObject({ enabled: true, ...template });

    const changed = { ...template, siteQps: 800, maxLevel: "captcha" as const };
    await admin.settings.setCcTemplate(changed);
    expect(await latestRevision(ctx.db, clusterId)).toMatchObject({
      reasonCode: "cc_template_updated",
    });
    expect((await config()).sites.find((s) => s.id === siteId)?.protection?.cc).toMatchObject({
      siteQps: 800,
      maxLevel: "captcha",
    });
    // The quiet cluster has no following site and gets no revision.
    expect((await latestRevision(ctx.db, otherClusterId))?.reasonCode).not.toBe(
      "cc_template_updated",
    );
    const [audit] = await audits("system.cc_template_update");
    expect(audit?.metadata).toMatchObject({ to: template });

    const own = await owner.protection.update({
      id: siteId,
      cc: { followTemplate: false, siteQps: 42, maxLevel: "js" },
    });
    expect(own.effectiveCc).toMatchObject({ siteQps: 42, maxLevel: "js", urlQps: 100 });
    await admin.settings.setCcTemplate({ ...changed, siteQps: 700 });
    expect((await config()).sites.find((s) => s.id === siteId)?.protection?.cc).toMatchObject({
      siteQps: 42,
      maxLevel: "js",
    });
    // A custom policy keeps its thresholds; the template is still shown beside them.
    expect((await member.protection.get({ id: siteId })).ccTemplate.siteQps).toBe(700);
    const off = await owner.protection.update({ id: siteId, cc: { enabled: false } });
    expect(off.effectiveCc).toBeNull();
    expect(off.cc).toMatchObject({ enabled: false, followTemplate: false, siteQps: 42 });
    expect((await config()).sites.find((s) => s.id === siteId)?.protection?.cc).toBeUndefined();
  });

  it("refuses tenants a feature that active nodes lack; administrators may require it", async () => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId: otherClusterId, name: "old-edge", supportedFeatures: ["rules-v1"] })
      .returning();
    if (!node) throw new Error("node missing");
    await admin.organizations.update({ id: orgId, defaultClusterId: otherClusterId });
    const oldSite = (
      await owner.sites.create({ name: "old", domains: ["old.shield.test"], origins })
    ).site.id;
    await approveSiteDomains(admin, oldSite);
    const before = (await config(otherClusterId)).revision;
    expect(
      await rpcError(owner.protection.update({ id: oldSite, underAttack: true })),
    ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED", data: { features: "challenge-v1" } });
    expect(await rpcError(owner.protection.update({ id: oldSite, logJa4: true }))).toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
    });
    expect(
      await rpcError(
        owner.rules.save({
          id: oldSite,
          rules: [
            {
              name: "ja4",
              phase: "waf-custom",
              expression: 'tls.ja4 eq "t13d1516h2_8daaf6152771_02713d6af862"',
              action: { kind: "challenge", type: "js" },
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
    expect((await config(otherClusterId)).revision).toBe(before);
    expect((await owner.protection.get({ id: oldSite })).underAttack).toBe(false);
    expect(await keysOf(otherClusterId)).toEqual([]);
    // Nodes with the capabilities admit the change.
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1", "challenge-v1", "ja4-v1"] })
      .where(eq(schema.node.id, node.id));
    await owner.protection.update({ id: oldSite, logJa4: true });
    const logging = await config(otherClusterId);
    expect(logging.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "ja4-v1"]));
    expect(logging.challengeKeys).toEqual([]);
    expect(logging.sites.find((s) => s.id === oldSite)?.protection?.logJa4).toBe(true);
    await owner.protection.update({ id: oldSite, logJa4: false });
    expect((await config(otherClusterId)).requiredFeatures).not.toContain("challenge-v1");
    // An administrator may deliberately require the upgrade.
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["rules-v1"] })
      .where(eq(schema.node.id, node.id));
    await admin.protection.update({ id: oldSite, underAttack: true });
    expect((await config(otherClusterId)).requiredFeatures).toContain("challenge-v1");
    await admin.protection.update({ id: oldSite, underAttack: false });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node.id));
    await admin.organizations.update({ id: orgId, defaultClusterId: clusterId });
  });

  it("applies platform Under Attack to every cluster and audits it", async () => {
    const settings = await admin.settings.protection();
    expect(settings).toEqual({
      underAttack: false,
      underAttackChallenge: "js",
      eventRetentionDays: 30,
    });
    const saved = await admin.settings.setProtection({
      underAttack: true,
      underAttackChallenge: "cookie302",
      eventRetentionDays: 60,
    });
    expect(saved.eventRetentionDays).toBe(60);
    for (const cluster of [clusterId, otherClusterId]) {
      const current = await config(cluster);
      expect(current.platformProtection).toMatchObject({
        underAttack: true,
        underAttackChallenge: "cookie302",
      });
      expect(current.challengeKeys).toHaveLength(3);
      expect(await latestRevision(ctx.db, cluster)).toMatchObject({
        reasonCode: "platform_protection_updated",
      });
    }
    expect((await member.protection.get({ id: siteId })).platformUnderAttack).toBe(true);
    // Retention alone publishes nothing.
    const revision = (await config()).revision;
    await admin.settings.setProtection({
      underAttack: true,
      underAttackChallenge: "cookie302",
      eventRetentionDays: 30,
    });
    expect((await config()).revision).toBe(revision);
    expect((await audits("system.protection_update")).length).toBe(2);
    await admin.settings.setProtection({
      underAttack: false,
      underAttackChallenge: "js",
      eventRetentionDays: 30,
    });
    // The quiet cluster no longer uses challenges; its keys stay for later.
    const quiet = await config(otherClusterId);
    expect(quiet.challengeKeys).toEqual([]);
    expect(quiet.platformProtection).toBeUndefined();
    expect(await keysOf(otherClusterId)).toHaveLength(3);
  });

  it("compiles the challenge rule action and tls.ja4 rate limit keys", async () => {
    await owner.rules.save({
      id: siteId,
      rules: [
        {
          name: "login",
          phase: "waf-custom",
          expression: 'http.request.uri.path eq "/login"',
          action: { kind: "challenge", type: "captcha" },
        },
        {
          name: "fingerprint",
          phase: "ratelimit",
          expression: 'tls.ja4 ne ""',
          action: { kind: "rate_limit", limit: 10, windowSeconds: 10, key: "tls.ja4" },
        },
      ],
    });
    const rules = (await config()).sites.find((s) => s.id === siteId)?.rules ?? [];
    expect(rules[0]?.action).toMatchObject({ kind: "challenge", challenge: "captcha" });
    expect(rules[1]?.action).toMatchObject({ kind: "rate_limit", key: "tls.ja4" });
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["challenge-v1", "ja4-v1"]),
    );
    const error = await rpcError(
      owner.rules.save({
        id: siteId,
        rules: [
          {
            name: "wrong phase",
            phase: "ratelimit",
            expression: "true",
            action: { kind: "challenge", type: "js" } as never,
          },
        ],
      }),
    );
    expect(error.status).toBe(400);
    await owner.rules.save({ id: siteId, rules: [] });
  });

  it("rotates keys daily and publishes only clusters whose configuration carries them", async () => {
    const before = await keysOf(clusterId);
    const role = (keys: typeof before, r: string) => keys.find((key) => key.role === r)?.id;
    const quietBefore = await keysOf(otherClusterId);
    const quietRevision = (await config(otherClusterId)).revision;
    // Not yet a day old.
    expect(await rotateChallengeKeys(ctx)).toEqual([]);
    const later = new Date(Date.now() + CHALLENGE_KEY_ROTATION_MS + 60_000);
    expect((await rotateChallengeKeys(ctx, later)).sort()).toEqual(
      [clusterId, otherClusterId].sort(),
    );
    const after = await keysOf(clusterId);
    expect(after).toHaveLength(3);
    expect(role(after, "previous")).toBe(role(before, "current"));
    expect(role(after, "current")).toBe(role(before, "next"));
    expect(after.map((key) => key.id)).not.toContain(role(before, "previous"));
    const fresh = role(after, "next");
    expect(before.map((key) => key.id)).not.toContain(fresh);
    const revision = await latestRevision(ctx.db, clusterId);
    expect(revision?.reasonCode).toBe("challenge_keys_rotated");
    expect((await config()).challengeKeys.map((key) => `${key.id}:${key.role}`).sort()).toEqual(
      after.map((key) => `${key.id}:${key.role}`).sort(),
    );
    // The quiet cluster rotates too, without a revision: its configuration has no keys.
    expect((await keysOf(otherClusterId)).map((k) => k.id)).not.toEqual(
      quietBefore.map((k) => k.id),
    );
    expect((await config(otherClusterId)).revision).toBe(quietRevision);
    // Rotated once per day.
    expect(await rotateChallengeKeys(ctx, later)).toEqual([]);
    const rotations = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "cluster.challenge_keys_rotate"),
          eq(schema.auditLog.targetId, clusterId),
        ),
      );
    expect(rotations).toHaveLength(1);
    expect(rotations[0]?.metadata).toMatchObject({ revision: revision?.revision });
  });

  it("rolls back with the current keys and the current platform protection", async () => {
    const target = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await owner.protection.update({ id: siteId, underAttack: false });
    expect((await config()).challengeKeys).toEqual([]);
    // Rotate so that the target's previous key no longer exists.
    await rotateChallengeKeys(ctx, new Date(Date.now() + 3 * CHALLENGE_KEY_ROTATION_MS));
    const keys = await keysOf(clusterId);
    await admin.clusters.rollback({ id: clusterId, revision: target });
    const restored = await config();
    expect(restored.sites.find((s) => s.id === siteId)?.protection?.underAttack).toBe(true);
    expect(restored.challengeKeys.map((key) => key.id).sort()).toEqual(
      keys.map((key) => key.id).sort(),
    );
    expect(restored.platformProtection).toMatchObject({ underAttack: false });
    expect(restored.requiredFeatures).toContain("challenge-v1");
    await owner.protection.update({ id: siteId, underAttack: false });
  });
});
