import { schema } from "@edgeweir/db";
import { count, eq } from "drizzle-orm";
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

describe("organization technical limits", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let orgId: string;
  let otherOrgId: string;
  const origins = [{ address: "origin.test", port: 8080 }];
  const sitesOf = async (organizationId: string) =>
    (
      await ctx.db
        .select({ n: count() })
        .from(schema.site)
        .where(eq(schema.site.organizationId, organizationId))
    )[0]?.n ?? 0;
  const noLimits = {
    sites: null,
    domains: null,
    certificates: null,
    ipListEntries: null,
    purgeTasksPerMinute: null,
    purgeUrlsPerHour: null,
    members: null,
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const clusterId = (await admin.clusters.list())[0]?.id ?? "";
    orgId = (await admin.organizations.create({ name: "Limited", defaultClusterId: clusterId })).id;
    otherOrgId = (await admin.organizations.create({ name: "Other", defaultClusterId: clusterId }))
      .id;
    await admin.users.create({
      name: "Owner",
      email: "owner@limited.test",
      password: PASSWORD,
      organizationId: orgId,
      role: "owner",
    });
    await admin.users.create({
      name: "Member",
      email: "member@limited.test",
      password: PASSWORD,
      organizationId: orgId,
    });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@limited.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@limited.test"));
  });
  afterAll(() => pglite.close());

  it("has no organization-specific limits by default and reports usage", async () => {
    const limits = await admin.admin.organizations.getLimits({ id: orgId });
    expect(limits).toMatchObject({ organizationId: orgId, limits: noLimits, updatedAt: null });
    expect(limits.usage).toMatchObject({ sites: 0, members: 2, domains: 0 });
    // Members read their own organization's limits; nobody else's.
    expect((await member.organization.limits()).organizationId).toBe(orgId);
    expect((await rpcError(member.admin.organizations.getLimits({ id: orgId }))).status).toBe(403);
    expect(
      (await rpcError(member.admin.organizations.setLimits({ id: orgId, limits: {} }))).status,
    ).toBe(403);
  });

  it("saves limits with an audit entry of the values before and after", async () => {
    const saved = await admin.admin.organizations.setLimits({
      id: orgId,
      limits: { sites: 1, members: 10 },
    });
    expect(saved.limits).toEqual({ ...noLimits, sites: 1, members: 10 });
    expect(saved.updatedAt).not.toBeNull();
    const [entry] = (await admin.auditLogs.list({ action: "organization.limits_update" })).items;
    expect(entry).toMatchObject({
      organizationId: orgId,
      targetId: orgId,
      metadata: { from: noLimits, to: { ...noLimits, sites: 1, members: 10 } },
    });
    // Optimistic concurrency.
    const stale = await rpcError(
      admin.admin.organizations.setLimits({
        id: orgId,
        limits: { sites: 1 },
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(stale.code).toBe("UPDATED_AT_MISMATCH");
    expect(stale.data).toEqual({ updatedAt: saved.updatedAt });
    const next = await admin.admin.organizations.setLimits({
      id: orgId,
      limits: { sites: 1, members: 10 },
      expectedUpdatedAt: saved.updatedAt ?? undefined,
    });
    expect(next.updatedAt).not.toBe(saved.updatedAt);
  });

  it("refuses a second site with ORG_LIMIT_EXCEEDED once maxSites is 1", async () => {
    await owner.sites.create({ name: "first", domains: ["first.limited.test"], origins });
    const error = await rpcError(
      owner.sites.create({ name: "second", domains: ["second.limited.test"], origins }),
    );
    expect(error.code).toBe("ORG_LIMIT_EXCEEDED");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ resource: "sites", limit: 1, current: 1 });
    // Platform administrators create in the organization under the same limit.
    expect(await sitesOf(orgId)).toBe(1);
  });

  it("never exceeds the limit under concurrent creation", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { sites: 3 } });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        owner.sites.create({ name: `race-${i}`, domains: [`race-${i}.limited.test`], origins }),
      ),
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(refused).toHaveLength(4);
    for (const r of refused)
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "ORG_LIMIT_EXCEEDED" });
    expect(await sitesOf(orgId)).toBe(3);
  });

  it("keeps existing resources when a limit is lowered below usage", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { sites: 1 } });
    expect(await sitesOf(orgId)).toBe(3);
    expect((await owner.organization.limits()).usage.sites).toBe(3);
    expect(
      (await rpcError(owner.sites.create({ name: "x", domains: ["x.limited.test"], origins })))
        .code,
    ).toBe("ORG_LIMIT_EXCEEDED");
    // Other organizations are not affected.
    const [site] = (await admin.sites.list({ search: "first" })).items;
    expect(site?.name).toBe("first");
    expect((await admin.admin.organizations.getLimits({ id: otherOrgId })).limits).toEqual(
      noLimits,
    );
  });

  it("limits domains on create and update", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { domains: 5 } });
    const usage = (await owner.organization.limits()).usage.domains;
    expect(usage).toBe(3);
    const [site] = (await owner.sites.list({ search: "first" })).items;
    const error = await rpcError(
      owner.sites.update({
        id: site?.id ?? "",
        domains: ["first.limited.test", "a.limited.test", "b.limited.test", "e.limited.test"],
      }),
    );
    expect(error.data).toEqual({ resource: "domains", limit: 5, current: 3 });
    await owner.sites.update({
      id: site?.id ?? "",
      domains: ["first.limited.test", "a.limited.test"],
    });
    expect((await owner.organization.limits()).usage.domains).toBe(4);
    expect(
      (
        await rpcError(
          owner.sites.create({
            name: "wide",
            domains: ["c.limited.test", "d.limited.test"],
            origins,
          }),
        )
      ).data,
    ).toEqual({ resource: "domains", limit: 5, current: 4 });
  });

  it("limits certificates", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { certificates: 1 } });
    const material = await ctx.nodeCa.issueServerCertificate(["first.limited.test"]);
    const upload = (name: string) =>
      owner.certificates.upload({
        name,
        chainPem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
      });
    await upload("one");
    expect((await rpcError(upload("two"))).data).toEqual({
      resource: "certificates",
      limit: 1,
      current: 1,
    });
  });

  it("limits IP list entries across the organization's lists", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { ipListEntries: 3 } });
    const list = await owner.ipLists.create({
      name: "blocked",
      entries: ["192.0.2.1/32", "192.0.2.2/32"],
    });
    expect(
      (
        await rpcError(
          owner.ipLists.create({ name: "more", entries: ["198.51.100.0/24", "198.51.100.1/32"] }),
        )
      ).data,
    ).toEqual({ resource: "ipListEntries", limit: 3, current: 2 });
    expect(
      (
        await rpcError(
          owner.ipLists.update({
            id: list.id,
            kind: list.kind,
            entries: ["192.0.2.1/32", "192.0.2.2/32", "192.0.2.3/32", "192.0.2.4/32"],
          }),
        )
      ).code,
    ).toBe("ORG_LIMIT_EXCEEDED");
    // Shrinking or staying within the limit works.
    await owner.ipLists.update({ id: list.id, kind: list.kind, entries: ["192.0.2.1/32"] });
    await owner.ipLists.create({ name: "two", entries: ["198.51.100.0/24", "203.0.113.0/24"] });
  });

  it("limits members for additions, new accounts and invitations", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { members: 2 } });
    const error = await rpcError(
      admin.users.create({
        name: "Third",
        email: "third@limited.test",
        password: PASSWORD,
        organizationId: orgId,
      }),
    );
    expect(error.data).toEqual({ resource: "members", limit: 2, current: 2 });
    expect((await rpcError(owner.members.invite({ email: "invitee@limited.test" }))).code).toBe(
      "ORG_LIMIT_EXCEEDED",
    );
    await admin.admin.organizations.setLimits({ id: orgId, limits: { members: 3 } });
    const { invitation } = await owner.members.invite({ email: "invitee@limited.test" });
    await admin.admin.organizations.setLimits({ id: orgId, limits: { members: 2 } });
    // The invitation was issued under a higher limit; joining is refused now.
    const join = await app.request(`${origin}/rpc/invitations/accept`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-csrf-token": "orpc" },
      body: JSON.stringify({
        json: { id: invitation.id, name: "Invitee", password: PASSWORD },
      }),
    });
    expect(join.status).toBe(409);
    expect(JSON.stringify(await join.json())).toContain("ORG_LIMIT_EXCEEDED");
  });

  it("replaces the purge defaults with organization limits", async () => {
    await admin.admin.organizations.setLimits({
      id: orgId,
      limits: { purgeTasksPerMinute: 1, purgeUrlsPerHour: 3 },
    });
    const [site] = (await owner.sites.list({ search: "first" })).items;
    if (!site) throw new Error("site missing");
    await owner.cacheTasks.create({ type: "site", siteIds: [site.id] });
    const perMinute = await rpcError(owner.cacheTasks.create({ type: "site", siteIds: [site.id] }));
    expect(perMinute.code).toBe("ORG_LIMIT_EXCEEDED");
    expect(perMinute.data).toEqual({ resource: "purgeTasksPerMinute", limit: 1, current: 1 });
    await admin.admin.organizations.setLimits({
      id: orgId,
      limits: { purgeTasksPerMinute: 10, purgeUrlsPerHour: 3 },
    });
    const perHour = await rpcError(
      owner.cacheTasks.create({
        type: "url",
        urls: [
          "http://first.limited.test/a",
          "http://first.limited.test/b",
          "http://first.limited.test/c",
        ],
      }),
    );
    expect(perHour.data).toEqual({ resource: "purgeUrlsPerHour", limit: 3, current: 1 });
    const limits = await owner.organization.limits();
    expect(limits.usage).toMatchObject({ purgeTasksPerMinute: 1, purgeUrlsPerHour: 1 });
  });
});
