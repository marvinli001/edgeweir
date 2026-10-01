import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("special-purpose origin addresses and the platform allow list", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let clusterIds: string[];
  let siteId: string;

  const siteCount = async () => (await ctx.db.select({ n: count() }).from(schema.site))[0]?.n ?? 0;
  const compiledAllowList = async (clusterId: string) =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array())
      .originAllowedCidrs;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const edge = await admin.clusters.create({ name: "edge-b" });
    clusterIds = (await admin.clusters.list()).map((c) => c.id);
    const org = await admin.organizations.create({ name: "Tenant", defaultClusterId: edge.id });
    await admin.users.create({
      name: "Tina",
      email: "tina@tenant.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    siteId = (
      await tenant.sites.create({
        name: "shop",
        domains: ["shop.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
  });
  afterAll(() => client.close());

  it("refuses loopback, metadata, private, IPv6 loopback, mapped and localhost origins", async () => {
    const before = await siteCount();
    for (const [address, range] of [
      ["127.0.0.1", "127.0.0.0/8"],
      ["169.254.169.254", "169.254.0.0/16"],
      ["10.1.2.3", "10.0.0.0/8"],
      ["192.168.1.1", "192.168.0.0/16"],
      ["::1", "::1/128"],
      ["::ffff:127.0.0.1", "127.0.0.0/8"],
      ["fd00::1", "fc00::/7"],
      ["localhost", "localhost"],
      ["api.LOCALHOST", "localhost"],
    ] as const) {
      const error = await rpcError(
        tenant.sites.create({
          name: "evil",
          domains: ["evil.test"],
          origins: [{ address: "origin.example.com" }, { address, backup: true }],
        }),
      );
      expect(error, address).toMatchObject({
        code: "ORIGIN_ADDRESS_FORBIDDEN",
        status: 400,
        data: { address, range },
      });
    }
    expect(await siteCount()).toBe(before);

    // Editing the pool is refused too, and leaves the site as it was.
    const site = await tenant.sites.get({ id: siteId });
    const edit = await rpcError(
      tenant.sites.update({ id: siteId, origins: [{ address: "169.254.169.254", port: 80 }] }),
    );
    expect(edit.code).toBe("ORIGIN_ADDRESS_FORBIDDEN");
    expect(await tenant.sites.get({ id: siteId })).toEqual(site);

    // Platform administrators are held to the same list; names that resolvers read as
    // numbers are not addresses at all.
    expect(
      (
        await rpcError(
          admin.sites.create({
            name: "x",
            domains: ["x.test"],
            origins: [{ address: "10.0.0.1" }],
          }),
        )
      ).code,
    ).toBe("ORIGIN_ADDRESS_FORBIDDEN");
    expect(
      (
        await rpcError(
          tenant.sites.create({ name: "x", domains: ["x.test"], origins: [{ address: "127.1" }] }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    // Public literals and host names are fine (nodes check what names resolve to).
    await tenant.sites.update({
      id: siteId,
      origins: [{ address: "203.0.114.1" }, { address: "2606:4700::1111", backup: true }],
    });
  });

  it("allows listed ranges and compiles the list into every cluster with a new revision", async () => {
    expect(await admin.settings.originAllowList()).toEqual({ cidrs: [] });
    const before = await Promise.all(clusterIds.map((id) => latestRevision(ctx.db, id)));

    const saved = await admin.settings.setOriginAllowList({
      cidrs: ["172.16.0.0/12", "10.1.2.3/8", "FD00::/8", "10.0.0.0/8"],
    });
    // Normalized, sorted, without duplicates.
    expect(saved).toEqual({ cidrs: ["10.0.0.0/8", "172.16.0.0/12", "fd00::/8"] });
    expect(await admin.settings.originAllowList()).toEqual(saved);
    for (const [i, clusterId] of clusterIds.entries()) {
      const latest = await latestRevision(ctx.db, clusterId);
      expect(latest?.revision).toBe((before[i]?.revision ?? 0) + 1);
      expect(latest).toMatchObject({ reasonCode: "origin_allow_list_updated", reasonParams: {} });
      expect(await compiledAllowList(clusterId)).toEqual(saved.cidrs);
    }
    const [entry] = (await admin.auditLogs.list({ action: "system.origin_allow_list_update" }))
      .items;
    expect(entry).toMatchObject({
      actorName: "Platform Admin",
      targetType: "system_setting",
      metadata: { cidrs: saved.cidrs, added: saved.cidrs, removed: [] },
    });

    // Allowed now, for tenants too; IPv4-mapped addresses follow their IPv4 range.
    const allowed = await tenant.sites.update({
      id: siteId,
      origins: [
        { address: "10.1.2.3", port: 8080 },
        { address: "172.18.0.5", backup: true },
        { address: "::ffff:10.9.9.9", backup: true },
        { address: "fd00::5", backup: true },
      ],
    });
    expect(allowed.site.origins.map((o) => o.address)).toEqual([
      "10.1.2.3",
      "172.18.0.5",
      "::ffff:10.9.9.9",
      "fd00::5",
    ]);
    // A site change keeps the list in the compiled configuration.
    expect(await compiledAllowList(clusterIds[1] ?? "")).toEqual(saved.cidrs);
    // Ranges outside the list and localhost names stay refused.
    for (const address of ["127.0.0.1", "192.168.0.1", "localhost"]) {
      const error = await rpcError(tenant.sites.update({ id: siteId, origins: [{ address }] }));
      expect(error.code, address).toBe("ORIGIN_ADDRESS_FORBIDDEN");
    }
    // Invalid entries are refused before anything is stored.
    expect(
      (await rpcError(admin.settings.setOriginAllowList({ cidrs: ["10.0.0.0/33"] }))).code,
    ).toBe("BAD_REQUEST");
    expect(await admin.settings.originAllowList()).toEqual(saved);
  });

  it("publishes again when the list shrinks and refuses the removed ranges from then on", async () => {
    const saved = await admin.settings.setOriginAllowList({ cidrs: ["172.16.0.0/12"] });
    expect(saved.cidrs).toEqual(["172.16.0.0/12"]);
    for (const clusterId of clusterIds) {
      expect(await compiledAllowList(clusterId)).toEqual(["172.16.0.0/12"]);
    }
    const entries = await admin.auditLogs.list({ action: "system.origin_allow_list_update" });
    expect(entries.total).toBe(2);
    expect(entries.items[0]?.metadata).toMatchObject({
      added: [],
      removed: ["10.0.0.0/8", "fd00::/8"],
    });
    const error = await rpcError(
      tenant.sites.update({ id: siteId, origins: [{ address: "10.1.2.3" }] }),
    );
    expect(error.code).toBe("ORIGIN_ADDRESS_FORBIDDEN");
    await tenant.sites.update({ id: siteId, origins: [{ address: "172.18.0.5" }] });
  });

  it("is managed over /api/v1 with an administrator's API key", async () => {
    const cookie = await signIn(app, origin, "admin@example.com");
    const call = (path: string, init: RequestInit = {}) =>
      app.request(`${origin}${path}`, {
        ...init,
        headers: { origin, "content-type": "application/json", ...(init.headers ?? {}) },
      });
    const keyRes = await call("/api/auth/api-key/create", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "e2e" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    const put = await call("/api/v1/settings/origin-allow-list", {
      method: "PUT",
      headers: { "x-api-key": key },
      body: JSON.stringify({ cidrs: ["172.28.0.0/16"] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ cidrs: ["172.28.0.0/16"] });
    const get = await call("/api/v1/settings/origin-allow-list", { headers: { "x-api-key": key } });
    expect(await get.json()).toEqual({ cidrs: ["172.28.0.0/16"] });
    const last = (await admin.auditLogs.list({ action: "system.origin_allow_list_update" }))
      .items[0];
    expect(last?.actorType).toBe("api_key");
  });

  it("keeps the current allow list when rolling back to an older revision", async () => {
    const clusterId = clusterIds[1] ?? "";
    const revisions = await admin.clusters.revisions({ id: clusterId });
    const first = revisions.at(-1);
    expect(first?.reasonCode).toBe("cluster_created");
    const rolled = await admin.clusters.rollback({ id: clusterId, revision: first?.revision ?? 1 });
    const config = decodeNodeConfig(
      (await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array(),
    );
    expect(rolled.reasonCode).toBe("rollback");
    expect(config.sites).toEqual([]);
    expect(config.originAllowedCidrs).toEqual(["172.28.0.0/16"]);
    expect(config.contentHash).toBe(rolled.contentHash);
    expect(rolled.contentHash).not.toBe(first?.contentHash);
  });
});
