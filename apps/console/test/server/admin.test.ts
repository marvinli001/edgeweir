import { contract } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

/** Every contract procedure outside the admin area (checked against the contract below). */
const CONSOLE_PROCEDURES = [
  "logs.settings",
  "logs.configure",
  "logs.query",
  "logs.export",
  "accessKeys.list",
  "accessKeys.create",
  "accessKeys.revoke",
  "alerts.availableChannels",
  "alerts.subscriptions",
  "alerts.subscribe",
  "alerts.unsubscribe",
  "alerts.events",
  "dns.siteTarget",
  "domainOwnership.get",
  "domainOwnership.prepare",
  "domainOwnership.verify",
  "domainOwnership.revoke",
  "rules.get",
  "rules.save",
  "rules.validate",
  "ipLists.list",
  "ipLists.create",
  "ipLists.update",
  "ipLists.delete",
  "bans.list",
  "bans.create",
  "bans.delete",
  "protection.get",
  "protection.update",
  "security.state",
  "security.events",
  "certificates.list",
  "certificates.upload",
  "certificates.request",
  "certificates.renew",
  "certificates.delete",
  "https.get",
  "https.update",
  "dnsCredentials.list",
  "dnsCredentials.create",
  "dnsCredentials.delete",

  "system.status",
  "system.setup",
  "account.me",
  "account.setActiveOrganization",
  "overview.get",
  "sites.list",
  "sites.get",
  "sites.create",
  "sites.update",
  "sites.delete",
  "sites.purgeAll",
  "sites.originHealth",
  "sites.setEnabled",
  "sites.starred",
  "sites.setStarred",
  "analytics.topRequests",
  "analytics.traffic",
  "analytics.topSites",
  "analytics.breakdown",
  "cacheTasks.list",
  "cacheTasks.get",
  "cacheTasks.create",
  "members.list",
  "members.invite",
  "members.cancelInvitation",
  "members.updateRole",
  "members.remove",
  "organization.update",
  "organization.limits",
  "invitations.get",
  "invitations.accept",
  "usage.list",
  "usage.changes",
];

function procedureNames(node: unknown, prefix = ""): string[] {
  if (node && typeof node === "object" && "~orpc" in node) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    procedureNames(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("admin area procedures", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let member: ApiClient;
  let defaultOrgId: string;
  let adminUserId: string;

  beforeAll(async () => {
    ({ organizationId: defaultOrgId, userId: adminUserId } = await setupPlatform(ctx));
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    await admin.users.create({
      name: "Tenant Member",
      email: "member@example.com",
      password: PASSWORD,
      organizationId: defaultOrgId,
      role: "member",
    });
    member = rpcClient(app, origin, await signIn(app, origin, "member@example.com"));
  });
  afterAll(() => pglite.close());

  it("refuses every admin-area procedure to a tenant member with 403", async () => {
    const [cluster] = await admin.clusters.list();
    const id = cluster?.id ?? "";
    const uuid = "00000000-0000-4000-8000-000000000000";
    const calls: [string, () => Promise<unknown>][] = [
      ["alerts.channels", () => member.alerts.channels()],
      [
        "alerts.createChannel",
        () =>
          member.alerts.createChannel({
            name: "x",
            config: { kind: "webhook", url: "https://example.test/webhook" },
          }),
      ],
      ["alerts.updateChannel", () => member.alerts.updateChannel({ id: uuid, name: "x" })],
      ["alerts.deleteChannel", () => member.alerts.deleteChannel({ id: uuid })],
      ["alerts.testChannel", () => member.alerts.testChannel({ id: uuid })],
      ["alerts.policy", () => member.alerts.policy()],
      ["alerts.setPolicy", () => member.alerts.setPolicy({})],
      ["alerts.smtp", () => member.alerts.smtp()],
      [
        "alerts.setSmtp",
        () =>
          member.alerts.setSmtp({
            host: "smtp.example.test",
            from: "alerts@example.test",
            username: "test",
            password: "test",
          }),
      ],
      [
        "dns.updateProvider",
        () => member.dns.updateProvider({ id: uuid, credentials: { api_token: "test" } }),
      ],
      ["dns.providers", () => member.dns.providers()],
      [
        "dns.createProvider",
        () =>
          member.dns.createProvider({
            name: "test",
            provider: "cloudflare",
            zone: "example.test",
            credentials: { api_token: "test" },
          }),
      ],
      ["upgrades.release", () => member.upgrades.release({ version: "0.1.0" })],
      ["upgrades.list", () => member.upgrades.list({})],
      ["upgrades.create", () => member.upgrades.create({ version: "0.1.0", nodeGroupId: uuid })],
      ["upgrades.promote", () => member.upgrades.promote({ id: uuid })],
      ["upgrades.cancel", () => member.upgrades.cancel({ id: uuid })],
      ["dns.deleteProvider", () => member.dns.deleteProvider({ id: uuid })],
      ["dns.get", () => member.dns.get()],
      ["dns.save", () => member.dns.save({ enabled: false })],
      ["dns.revisions", () => member.dns.revisions()],
      ["dns.rollback", () => member.dns.rollback({ revision: 1 })],
      ["dns.reconcile", () => member.dns.reconcile()],
      ["dns.protection", () => member.dns.protection()],
      ["dns.setProtection", () => member.dns.setProtection({ massRemovalRatio: 0.5 })],
      ["dns.forcePublish", () => member.dns.forcePublish({ revision: 1 })],
      [
        "domainOwnership.approve",
        () => member.domainOwnership.approve({ siteId: uuid, domain: "example.test" }),
      ],
      ["platformRules.get", () => member.platformRules.get()],
      ["platformRules.save", () => member.platformRules.save({ rules: [] })],
      ["platformIpLists.list", () => member.platformIpLists.list()],
      [
        "platformIpLists.create",
        () => member.platformIpLists.create({ name: "blocked", entries: [] }),
      ],
      [
        "platformIpLists.update",
        () => member.platformIpLists.update({ id: uuid, entries: [], kind: "block" }),
      ],
      ["platformIpLists.delete", () => member.platformIpLists.delete({ id: uuid })],
      ["clusters.list", () => member.clusters.list()],
      ["clusters.get", () => member.clusters.get({ id })],
      ["clusters.create", () => member.clusters.create({ name: "x" })],
      ["clusters.update", () => member.clusters.update({ id, name: "x" })],
      ["clusters.delete", () => member.clusters.delete({ id })],
      ["clusters.revisions", () => member.clusters.revisions({ id })],
      ["clusters.rollback", () => member.clusters.rollback({ id, revision: 1 })],
      ["clusters.rollout", () => member.clusters.rollout({ id })],
      [
        "clusters.setRolloutPolicy",
        () =>
          member.clusters.setRolloutPolicy({
            id,
            enabled: true,
            windowSeconds: 300,
            autoPromote: true,
            errorRatioMultiplier: 2,
            errorRatioFloor: 0.05,
            minRequests: 100,
          }),
      ],
      ["clusters.promoteRollout", () => member.clusters.promoteRollout({ id })],
      ["clusters.abortRollout", () => member.clusters.abortRollout({ id })],
      [
        "clusters.createEnrollmentToken",
        () => member.clusters.createEnrollmentToken({ clusterId: id }),
      ],
      ["nodeGroups.list", () => member.nodeGroups.list({})],
      ["nodeGroups.create", () => member.nodeGroups.create({ clusterId: id, name: "g" })],
      ["nodeGroups.update", () => member.nodeGroups.update({ id: uuid, name: "g" })],
      ["nodeGroups.delete", () => member.nodeGroups.delete({ id: uuid })],
      ["regions.list", () => member.regions.list()],
      ["regions.create", () => member.regions.create({ name: "East", code: "east" })],
      ["regions.update", () => member.regions.update({ id: uuid, name: "x" })],
      ["regions.delete", () => member.regions.delete({ id: uuid })],
      ["nodes.list", () => member.nodes.list({})],
      ["nodes.get", () => member.nodes.get({ id: uuid })],
      ["nodes.update", () => member.nodes.update({ id: uuid, name: "n" })],
      ["nodes.disable", () => member.nodes.disable({ id: uuid })],
      ["nodes.enable", () => member.nodes.enable({ id: uuid })],
      ["nodes.delete", () => member.nodes.delete({ id: uuid })],
      ["organizations.list", () => member.organizations.list()],
      ["organizations.create", () => member.organizations.create({ name: "Evil" })],
      ["organizations.update", () => member.organizations.update({ id: defaultOrgId })],
      ["organizations.members", () => member.organizations.members({ id: defaultOrgId })],
      [
        "organizations.addMember",
        () => member.organizations.addMember({ organizationId: defaultOrgId, userId: "u" }),
      ],
      [
        "organizations.updateMember",
        () =>
          member.organizations.updateMember({
            organizationId: defaultOrgId,
            memberId: "m",
            role: "owner",
          }),
      ],
      [
        "organizations.removeMember",
        () => member.organizations.removeMember({ organizationId: defaultOrgId, memberId: "m" }),
      ],
      [
        "organizations.invite",
        () => member.organizations.invite({ organizationId: defaultOrgId, email: "x@example.com" }),
      ],
      ["users.list", () => member.users.list({})],
      [
        "users.create",
        () => member.users.create({ name: "x", email: "x@example.com", password: PASSWORD }),
      ],
      ["users.setAdmin", () => member.users.setAdmin({ id: "u", isAdmin: true })],
      ["users.setDisabled", () => member.users.setDisabled({ id: "u", disabled: true })],
      ["settings.get", () => member.settings.get()],
      ["settings.originAllowList", () => member.settings.originAllowList()],
      [
        "settings.setOriginAllowList",
        () => member.settings.setOriginAllowList({ cidrs: ["0.0.0.0/0"] }),
      ],
      ["settings.releaseSource", () => member.settings.releaseSource()],
      [
        "settings.setReleaseSource",
        () => member.settings.setReleaseSource({ url: "https://mirror.example.test" }),
      ],
      ["settings.dnsResolvers", () => member.settings.dnsResolvers()],
      ["settings.setDnsResolvers", () => member.settings.setDnsResolvers({ servers: ["1.1.1.1"] })],
      ["auditLogs.list", () => member.auditLogs.list({})],
      ["auditLogs.facets", () => member.auditLogs.facets()],
      ["analytics.topNodes", () => member.analytics.topNodes({})],
      ["admin.sites.suspend", () => member.admin.sites.suspend({ id: uuid, reason: "billing" })],
      ["admin.sites.resume", () => member.admin.sites.resume({ id: uuid })],
      ["admin.organizations.getLimits", () => member.admin.organizations.getLimits({ id: "x" })],
      ["settings.usage", () => member.settings.usage()],
      [
        "settings.setUsage",
        () => member.settings.setUsage({ retentionDays: 100, offlineThresholdMinutes: 60 }),
      ],
      ["serviceAccounts.list", () => member.serviceAccounts.list()],
      ["serviceAccounts.create", () => member.serviceAccounts.create({ name: "x", scopes: [] })],
      ["serviceAccounts.update", () => member.serviceAccounts.update({ id: uuid, enabled: false })],
      ["serviceAccounts.delete", () => member.serviceAccounts.delete({ id: uuid })],
      ["serviceAccounts.createKey", () => member.serviceAccounts.createKey({ id: uuid })],
      [
        "serviceAccounts.revokeKey",
        () => member.serviceAccounts.revokeKey({ id: uuid, keyId: uuid }),
      ],
      [
        "admin.organizations.setLimits",
        () => member.admin.organizations.setLimits({ id: "x", limits: {} }),
      ],
      ["admin.bans.list", () => member.admin.bans.list({})],
      [
        "admin.bans.create",
        () =>
          member.admin.bans.create({
            scope: "platform",
            cidr: "203.0.113.0/24",
            reason: "attack",
            durationSeconds: 3600,
          }),
      ],
      ["admin.bans.delete", () => member.admin.bans.delete({ id: uuid })],
      ["settings.bans", () => member.settings.bans()],
      ["settings.setBans", () => member.settings.setBans({ maxTotal: 100, shareAutoBans: false })],
      ["settings.protection", () => member.settings.protection()],
      [
        "settings.setProtection",
        () =>
          member.settings.setProtection({
            underAttack: true,
            underAttackChallenge: "js",
            eventRetentionDays: 30,
          }),
      ],
      ["settings.ccTemplate", () => member.settings.ccTemplate()],
      [
        "settings.setCcTemplate",
        () =>
          member.settings.setCcTemplate({
            maxLevel: "js",
            highPowInsteadOfCaptcha: false,
            windowSeconds: 10,
            siteQps: 1,
            urlQps: 1,
            ipQps: 1,
            ipBanSeconds: 600,
            originErrorPercent: 50,
            originErrorMinRequests: 100,
            escalateAfterSeconds: 10,
            cooldownSeconds: 60,
          }),
      ],
    ];
    for (const [name, call] of calls) {
      const error = await rpcError(call());
      expect(error.status, name).toBe(403);
    }
    // Every procedure is either in the console list or covered by this table.
    const covered = [...CONSOLE_PROCEDURES, ...calls.map(([name]) => name)].sort();
    expect(covered).toEqual(procedureNames(contract).sort());
    // A member still reaches the console.
    expect((await member.sites.list({})).total).toBe(0);
    expect((await member.account.me()).user.isAdmin).toBe(false);
  });

  it("renames clusters and refuses to delete clusters that still hold sites", async () => {
    const created = await admin.clusters.create({ name: "edge-b", description: "second" });
    expect(created.latestRevision).toMatchObject({ revision: 1, reasonCode: "cluster_created" });
    const dup = await rpcError(admin.clusters.update({ id: created.id, name: "default" }));
    expect(dup).toMatchObject({
      code: "CLUSTER_NAME_TAKEN",
      status: 409,
      data: { name: "default" },
    });
    const renamed = await admin.clusters.update({ id: created.id, name: "edge-bj" });
    expect(renamed).toMatchObject({ name: "edge-bj", description: "second" });

    const site = await admin.sites.create({
      name: "pinned",
      clusterId: created.id,
      domains: ["pinned.test"],
      origins: [{ address: "origin.internal" }],
    });
    const busy = await rpcError(admin.clusters.delete({ id: created.id }));
    expect(busy).toMatchObject({
      code: "CLUSTER_NOT_EMPTY",
      status: 409,
      data: { nodes: 0, sites: 1 },
    });
    await admin.sites.delete({ id: site.site.id });
    expect(await admin.clusters.delete({ id: created.id })).toEqual({ ok: true });
    expect((await rpcError(admin.clusters.get({ id: created.id }))).code).toBe("CLUSTER_NOT_FOUND");
  });

  it("manages regions and node groups", async () => {
    const [cluster] = await admin.clusters.list();
    if (!cluster) throw new Error("no cluster");
    const east = await admin.regions.create({ name: "East China", code: "CN-East" });
    expect(east).toMatchObject({ code: "cn-east", nodeGroupCount: 0 });
    expect((await rpcError(admin.regions.create({ name: "Dup", code: "cn-east" }))).code).toBe(
      "REGION_CODE_TAKEN",
    );
    const renamedRegion = await admin.regions.update({ id: east.id, name: "East" });
    expect(renamedRegion.name).toBe("East");

    const groups = await admin.nodeGroups.list({ clusterId: cluster.id });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "default", isDefault: true });
    const group = await admin.nodeGroups.create({
      clusterId: cluster.id,
      name: "shanghai",
      regionId: east.id,
    });
    expect(group).toMatchObject({ regionName: "East", regionCode: "cn-east", nodeCount: 0 });
    expect(
      (await rpcError(admin.nodeGroups.create({ clusterId: cluster.id, name: "shanghai" }))).code,
    ).toBe("NODE_GROUP_NAME_TAKEN");
    const moved = await admin.nodeGroups.update({ id: group.id, name: "sh", regionId: null });
    expect(moved).toMatchObject({ name: "sh", regionId: null });
    const regions = await admin.regions.list();
    expect(regions.find((r) => r.id === east.id)?.nodeGroupCount).toBe(0);

    const defaultGroup = groups[0];
    if (!defaultGroup) throw new Error("no default group");
    expect((await rpcError(admin.nodeGroups.delete({ id: defaultGroup.id }))).code).toBe(
      "NODE_GROUP_IS_DEFAULT",
    );
    expect(await admin.nodeGroups.delete({ id: group.id })).toEqual({ ok: true });
    expect(await admin.regions.delete({ id: east.id })).toEqual({ ok: true });
    expect(await admin.regions.list()).toEqual([]);
  });

  it("renames, moves, disables, enables and deletes nodes (revoking the certificate)", async () => {
    const [cluster] = await admin.clusters.list();
    if (!cluster) throw new Error("no cluster");
    const [defaultGroup] = await admin.nodeGroups.list({ clusterId: cluster.id });
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: cluster.id,
        nodeGroupId: defaultGroup?.id ?? null,
        name: "edge-1",
        certSerial: "0A:1B:2C",
        certFingerprint: "ab".repeat(32),
      })
      .returning();
    if (!node) throw new Error("no node");
    const group = await admin.nodeGroups.create({ clusterId: cluster.id, name: "canary" });

    const other = await admin.clusters.create({ name: "elsewhere" });
    const [otherGroup] = await admin.nodeGroups.list({ clusterId: other.id });
    const mismatch = await rpcError(
      admin.nodes.update({ id: node.id, nodeGroupId: otherGroup?.id ?? "" }),
    );
    expect(mismatch.code).toBe("NODE_GROUP_CLUSTER_MISMATCH");

    const updated = await admin.nodes.update({
      id: node.id,
      name: "edge-sh-1",
      nodeGroupId: group.id,
    });
    expect(updated).toMatchObject({
      name: "edge-sh-1",
      nodeGroupId: group.id,
      nodeGroupName: "canary",
    });
    expect(
      (await admin.nodeGroups.list({ clusterId: cluster.id })).find((g) => g.id === group.id),
    ).toMatchObject({ nodeCount: 1 });

    expect((await admin.nodes.disable({ id: node.id })).status).toBe("disabled");
    expect((await admin.nodes.enable({ id: node.id })).status).toBe("active");

    // Deleting the group moves its nodes back to the default group.
    await admin.nodeGroups.delete({ id: group.id });
    expect((await admin.nodes.get({ id: node.id })).nodeGroupId).toBe(defaultGroup?.id);

    expect(await admin.nodes.delete({ id: node.id })).toEqual({ ok: true });
    expect((await rpcError(admin.nodes.get({ id: node.id }))).code).toBe("NODE_NOT_FOUND");
    const revoked = await ctx.db
      .select()
      .from(schema.nodeCertificateRevocation)
      .where(eq(schema.nodeCertificateRevocation.nodeId, node.id));
    expect(revoked).toMatchObject([{ serial: "a1b2c", reason: "node deleted" }]);
    await admin.clusters.delete({ id: other.id });
  });

  it("creates organizations with a default cluster and manages their members", async () => {
    const [cluster] = await admin.clusters.list();
    const org = await admin.organizations.create({
      name: "Tenant Org",
      defaultClusterId: cluster?.id ?? null,
    });
    expect(org).toMatchObject({
      slug: "tenant-org",
      memberCount: 0,
      defaultClusterName: "default",
      requireTwoFactor: false,
    });
    expect((await rpcError(admin.organizations.create({ name: "Tenant-Org" }))).code).toBe(
      "ORGANIZATION_SLUG_TAKEN",
    );

    const user = await admin.users.create({
      name: "Owner Two",
      email: "owner2@example.com",
      password: PASSWORD,
    });
    const added = await admin.organizations.addMember({
      organizationId: org.id,
      userId: user.id,
      role: "owner",
    });
    expect(added).toMatchObject({ name: "Owner Two", role: "owner" });
    expect(
      (await rpcError(admin.organizations.addMember({ organizationId: org.id, userId: user.id })))
        .code,
    ).toBe("ALREADY_MEMBER");
    // The last owner cannot be demoted or removed.
    const lastOwner = await rpcError(
      admin.organizations.updateMember({
        organizationId: org.id,
        memberId: added.id,
        role: "member",
      }),
    );
    expect(lastOwner.code).toBe("LAST_OWNER");

    const invite = await admin.organizations.invite({
      organizationId: org.id,
      email: "Invitee@Example.com",
      role: "admin",
    });
    expect(invite.url).toBe(`${origin}/invite/${invite.invitation.id}`);
    const members = await admin.organizations.members({ id: org.id });
    expect(members.members.map((m) => m.email)).toEqual(["owner2@example.com"]);
    expect(members.invitations).toMatchObject([{ email: "invitee@example.com", role: "admin" }]);

    const updated = await admin.organizations.update({
      id: org.id,
      name: "Tenant Org Ltd",
      defaultClusterId: null,
      requireTwoFactor: true,
    });
    expect(updated).toMatchObject({
      name: "Tenant Org Ltd",
      defaultClusterId: null,
      requireTwoFactor: true,
      memberCount: 1,
    });
    await admin.organizations.addMember({
      organizationId: org.id,
      userId: adminUserId,
      role: "owner",
    });
    expect(
      await admin.organizations.removeMember({ organizationId: org.id, memberId: added.id }),
    ).toEqual({ ok: true });
    const list = await admin.organizations.list();
    expect(list.map((o) => o.name)).toEqual(["Default", "Tenant Org Ltd"]);
  });

  it("creates users, grants admin and disables accounts everywhere", async () => {
    const created = await admin.users.create({
      name: "Ops",
      email: "OPS@example.com",
      password: PASSWORD,
      isAdmin: true,
    });
    expect(created).toMatchObject({ email: "ops@example.com", isAdmin: true, memberships: [] });
    const dup = await rpcError(
      admin.users.create({ name: "Ops", email: "ops@example.com", password: PASSWORD }),
    );
    expect(dup).toMatchObject({ code: "EMAIL_TAKEN", data: { email: "ops@example.com" } });
    expect(JSON.stringify(dup)).not.toContain(PASSWORD);

    const self = await rpcError(admin.users.setAdmin({ id: adminUserId, isAdmin: false }));
    expect(self.code).toBe("CANNOT_MODIFY_SELF");
    expect(
      (await rpcError(admin.users.setDisabled({ id: adminUserId, disabled: true }))).code,
    ).toBe("CANNOT_MODIFY_SELF");
    expect((await admin.users.setAdmin({ id: created.id, isAdmin: false })).isAdmin).toBe(false);

    const ops = rpcClient(app, origin, await signIn(app, origin, "ops@example.com"));
    expect((await ops.account.me()).user.email).toBe("ops@example.com");
    expect((await admin.users.setDisabled({ id: created.id, disabled: true })).disabled).toBe(true);
    // The existing session is gone and signing in again is refused.
    expect((await rpcError(ops.account.me())).status).toBe(401);
    const res = await app.request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "ops@example.com", password: PASSWORD }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await admin.users.setDisabled({ id: created.id, disabled: false })).disabled).toBe(
      false,
    );

    const found = await admin.users.list({ search: "tenant member" });
    expect(found.map((u) => u.email)).toEqual(["member@example.com"]);
    expect(found[0]?.memberships).toMatchObject([{ organizationName: "Default", role: "member" }]);
  });

  it("filters and pages the audit log and shows actor and target names", async () => {
    const all = await admin.auditLogs.list({ limit: 200 });
    expect(all.total).toBeGreaterThan(10);
    const facets = await admin.auditLogs.facets();
    expect(facets.actions).toEqual(expect.arrayContaining(["cluster.create", "node.delete"]));
    expect(facets.targetTypes).toEqual(expect.arrayContaining(["cluster", "node", "user"]));

    const deletes = await admin.auditLogs.list({ action: "node.delete" });
    expect(deletes.total).toBe(1);
    expect(deletes.items[0]).toMatchObject({
      actorType: "user",
      actorName: "Platform Admin",
      targetType: "node",
      targetName: "edge-sh-1",
    });

    const clusters = await admin.auditLogs.list({ targetType: "cluster", limit: 2 });
    expect(clusters.items).toHaveLength(2);
    const page2 = await admin.auditLogs.list({ targetType: "cluster", limit: 2, offset: 2 });
    expect(page2.total).toBe(clusters.total);
    expect(page2.items[0]?.id).toBeLessThan(clusters.items[1]?.id ?? 0);

    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await admin.auditLogs.list({ from: future })).total).toBe(0);
    expect((await admin.auditLogs.list({ to: future })).total).toBe(all.total);
  });
});
