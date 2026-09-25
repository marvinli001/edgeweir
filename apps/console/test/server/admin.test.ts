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
      ["clusters.list", () => member.clusters.list()],
      ["clusters.get", () => member.clusters.get({ id })],
      ["clusters.create", () => member.clusters.create({ name: "x" })],
      ["clusters.update", () => member.clusters.update({ id, name: "x" })],
      ["clusters.delete", () => member.clusters.delete({ id })],
      ["clusters.revisions", () => member.clusters.revisions({ id })],
      ["clusters.rollback", () => member.clusters.rollback({ id, revision: 1 })],
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
      ["auditLogs.list", () => member.auditLogs.list({})],
      ["auditLogs.facets", () => member.auditLogs.facets()],
    ];
    for (const [name, call] of calls) {
      const error = await rpcError(call());
      expect(error.status, name).toBe(403);
    }
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
      origins: [{ address: "10.0.0.1" }],
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
