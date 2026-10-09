import "reflect-metadata";
import { ACCESS_CONTROL_FEATURE, decodeNodeConfig } from "@edgeweir/config-compiler";
import type { SiteAccessControlUpdate } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { updateAccessControl } from "../../src/server/services/access-control";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const service = {
  actor: { type: "service_account" as const, id: "service-account-g13", name: "integration" },
};
type Update = Omit<SiteAccessControlUpdate, "id">;

describe("access control (G13)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";
  const lists: Record<string, string> = {};

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return { row, ir: decodeNodeConfig(row.ir) };
  };
  const access = async (id = siteId) =>
    (await config()).ir.sites.find((s) => s.id === id)?.accessControl;
  const save = async (update: Update, id = siteId) =>
    admin.accessControl.update({
      id,
      ...update,
      expectedUpdatedAt: (await admin.accessControl.get({ id })).updatedAt ?? undefined,
    });
  const refused = async (update: unknown) =>
    (await rpcError(admin.accessControl.update({ id: siteId, ...(update as Update) }))).code;
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "media",
        domains: ["media.g13.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    otherSiteId = (
      await admin.sites.create({
        name: "other",
        domains: ["other.g13.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g13",
        lastSeenAt: new Date(),
        supportedFeatures: ["tls-v1", ACCESS_CONTROL_FEATURE, "geoip-city-v1", "geoip-asn-v1"],
      })
      .returning();
    nodeId = node?.id ?? "";
    for (const [name, kind, entries] of [
      ["scrapers", "collection", ["198.51.100.0/24"]],
      ["office", "collection", ["192.0.2.0/24", "198.51.100.7"]],
      ["global_block", "block", ["203.0.113.0/24"]],
      ["global_allow", "allow", ["203.0.113.9"]],
    ] as const)
      lists[name] = (await admin.ipLists.create({ name, kind, entries: [...entries] })).id;
  });

  afterAll(() => pglite.close());

  describe("validation", () => {
    it("reads defaults for a site never saved", async () => {
      const read = await admin.accessControl.get({ id: siteId });
      expect(read.updatedAt).toBeNull();
      expect(read.hotlink).toMatchObject({ enabled: false, allowEmpty: true, action: "deny" });
      expect(read.hotlink.extensions).toContain("png");
      expect(read.cors.allowedMethods).toEqual([
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ]);
      expect(read.cors.maxAgeSeconds).toBe(600);
      expect(read.websocket).toEqual({
        allowAllOrigins: true,
        origins: [],
        idleTimeoutSeconds: 3600,
      });
      expect(read.securityHeaders).toMatchObject({ frameOptions: "off", referrerPolicy: "off" });
      expect(await access()).toBeUndefined();
    });

    it("refuses settings nodes could not use", async () => {
      const hotlink = { enabled: true };
      // Host forms: exact, *.one-level, .suffix or * alone.
      expect(await refused({ hotlink: { ...hotlink, allowed: ["*.*.a.com"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(await refused({ hotlink: { ...hotlink, denied: ["https://a.com"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused({
          hotlink: { ...hotlink, allowed: Array.from({ length: 201 }, (_, i) => `h${i}.a.com`) },
        }),
      ).toBe("BAD_REQUEST");
      expect(await refused({ hotlink: { ...hotlink, action: "redirect" } })).toBe("BAD_REQUEST");
      expect(
        await refused({ hotlink: { ...hotlink, action: "redirect", redirectUrl: "//evil.com/x" } }),
      ).toBe("BAD_REQUEST");
      expect(await refused({ hotlink: { ...hotlink, pathPrefixes: ["/a?b"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused({
          hotlink: {
            ...hotlink,
            extensions: Array(65)
              .fill("png")
              .map((e, i) => `${e}${i}`),
          },
        }),
      ).toBe("BAD_REQUEST");
      // User agents: wildcard rules, at most 200.
      expect(await refused({ userAgents: { rules: [{ pattern: "a\\b", action: "deny" }] } })).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused({ userAgents: { rules: [{ pattern: "*".repeat(9), action: "deny" }] } }),
      ).toBe("BAD_REQUEST");
      expect(
        await refused({
          userAgents: {
            rules: Array.from({ length: 201 }, () => ({ pattern: "x", action: "deny" })),
          },
        }),
      ).toBe("BAD_REQUEST");
      // CORS: an origin when on; no * with credentials; origins without paths.
      expect(await refused({ cors: { enabled: true } })).toBe("BAD_REQUEST");
      expect(
        await refused({ cors: { enabled: true, allowedOrigins: ["*"], allowCredentials: true } }),
      ).toBe("CORS_CREDENTIALS_WILDCARD");
      expect(await refused({ cors: { enabled: true, allowedOrigins: ["https://a.com/x"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused({
          cors: { enabled: true, allowedOrigins: ["https://a.com"], maxAgeSeconds: 86_401 },
        }),
      ).toBe("BAD_REQUEST");
      expect(
        await refused({
          cors: { enabled: true, allowedOrigins: ["https://a.com"], allowedMethods: [] },
        }),
      ).toBe("BAD_REQUEST");
      // Geo: a list when on; country codes; CC-subdivision.
      expect(await refused({ geo: { enabled: true } })).toBe("BAD_REQUEST");
      expect(await refused({ geo: { enabled: true, countries: ["CHN"] } })).toBe("BAD_REQUEST");
      expect(await refused({ geo: { enabled: true, subdivisions: ["California"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(await refused({ geo: { enabled: true, asns: [0] } })).toBe("BAD_REQUEST");
      // WebSocket: origins when restricted (no * alone); idle 60-86400.
      expect(await refused({ websocket: { allowAllOrigins: false } })).toBe("BAD_REQUEST");
      expect(await refused({ websocket: { allowAllOrigins: false, origins: ["*"] } })).toBe(
        "BAD_REQUEST",
      );
      expect(await refused({ websocket: { idleTimeoutSeconds: 59 } })).toBe("BAD_REQUEST");
      expect(await refused({ websocket: { idleTimeoutSeconds: 86_401 } })).toBe("BAD_REQUEST");
      // Security headers.
      expect(await refused({ securityHeaders: { frameOptions: "ALLOW-FROM" } })).toBe(
        "BAD_REQUEST",
      );
      expect(await refused({ securityHeaders: { permissionsPolicy: "camera=(é)" } })).toBe(
        "BAD_REQUEST",
      );
      expect(await refused({ securityHeaders: { permissionsPolicy: "x".repeat(1025) } })).toBe(
        "BAD_REQUEST",
      );
      // Site lists: existing lists, at most 16 a side, never both sides.
      expect(
        await refused({ siteLists: { blockListIds: ["00000000-0000-4000-8000-000000000000"] } }),
      ).toBe("IP_LIST_NOT_FOUND");
      const conflict = await rpcError(
        admin.accessControl.update({
          id: siteId,
          siteLists: { blockListIds: [lists.scrapers ?? ""], allowListIds: [lists.scrapers ?? ""] },
        }),
      );
      expect(conflict).toMatchObject({ code: "SITE_LIST_CONFLICT", data: { lists: "scrapers" } });
      expect(
        await refused({
          siteLists: {
            blockListIds: Array.from(
              { length: 17 },
              (_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
            ),
          },
        }),
      ).toBe("BAD_REQUEST");
      // Nothing was saved.
      expect((await admin.accessControl.get({ id: siteId })).updatedAt).toBeNull();
    });

    it("normalizes forms and keeps the parts a request leaves out", async () => {
      const first = await save({
        hotlink: {
          enabled: true,
          allowed: ["Friend.TEST.", "*.cdn.friend.test", "friend.test"],
          denied: [".Evil.test"],
          extensions: [".PNG", "jpg"],
        },
        cors: {
          enabled: true,
          allowedOrigins: ["HTTPS://App.test:443", "https://*.app.test", "http://localhost:3000"],
          allowedMethods: ["get", "post"],
          allowedHeaders: ["X-Token"],
        },
      } as Update);
      expect(first.hotlink.allowed).toEqual(["friend.test", "*.cdn.friend.test"]);
      expect(first.hotlink.denied).toEqual([".evil.test"]);
      expect(first.hotlink.extensions).toEqual(["png", "jpg"]);
      expect(first.cors.allowedOrigins).toEqual([
        "https://app.test",
        "https://*.app.test",
        "http://localhost:3000",
      ]);
      expect(first.cors.allowedMethods).toEqual(["GET", "POST"]);
      expect(first.cors.allowedHeaders).toEqual(["x-token"]);
      const second = await save({
        securityHeaders: { nosniff: true, frameOptions: "DENY" },
      } as Update);
      expect(second.hotlink).toEqual(first.hotlink);
      expect(second.cors).toEqual(first.cors);
      expect(second.securityHeaders).toMatchObject({ nosniff: true, frameOptions: "DENY" });
      // A stale read is refused.
      expect(
        (
          await rpcError(
            admin.accessControl.update({
              id: siteId,
              geo: { enabled: false } as Update["geo"],
              expectedUpdatedAt: first.updatedAt ?? undefined,
            } as SiteAccessControlUpdate),
          )
        ).code,
      ).toBe("UPDATED_AT_MISMATCH");
    });
  });

  describe("compilation", () => {
    it("sends only the parts in use, with access-control-v1", async () => {
      const ir = await access();
      expect(ir?.hotlink?.allowed).toEqual(["*.cdn.friend.test", "friend.test"]);
      expect(ir?.hotlink?.redirectUrl).toBe("");
      expect(ir?.cors?.allowedOrigins).toEqual([
        "http://localhost:3000",
        "https://*.app.test",
        "https://app.test",
      ]);
      expect(ir?.securityHeaders).toMatchObject({
        nosniff: true,
        frameOptions: "DENY",
        referrerPolicy: "",
      });
      expect(ir?.geo).toBeUndefined();
      expect(ir?.userAgents).toBeUndefined();
      expect(ir?.websocket).toBeUndefined();
      expect((await config()).ir.requiredFeatures).toContain(ACCESS_CONTROL_FEATURE);
      expect(await access(otherSiteId)).toBeUndefined();
      const { row } = await config();
      expect([row.reasonCode, row.reasonParams]).toEqual([
        "site_access_control_updated",
        { site: "media" },
      ]);
    });

    it("keeps settings while a part is off and compiles nothing for it", async () => {
      await save({
        hotlink: { ...(await admin.accessControl.get({ id: siteId })).hotlink, enabled: false },
        cors: { ...(await admin.accessControl.get({ id: siteId })).cors, enabled: false },
        securityHeaders: { nosniff: false, frameOptions: "off" } as Update["securityHeaders"],
      });
      const read = await admin.accessControl.get({ id: siteId });
      expect(read.hotlink.allowed).toEqual(["friend.test", "*.cdn.friend.test"]);
      expect(await access()).toBeUndefined();
      expect((await config()).ir.requiredFeatures).not.toContain(ACCESS_CONTROL_FEATURE);
    });

    it("compiles every part: lists, UA order, geo features, WebSocket and the hotlink redirect", async () => {
      await save({
        siteLists: { blockListIds: [lists.scrapers ?? ""], allowListIds: [lists.office ?? ""] },
        hotlink: {
          enabled: true,
          action: "redirect",
          redirectUrl: "/hotlink.png",
          allowed: [],
          denied: [],
        },
        userAgents: {
          rules: [
            { pattern: "*", action: "deny" },
            { pattern: "*Googlebot*", action: "allow" },
          ],
          excludePathPrefixes: ["/robots.txt"],
        },
        geo: {
          enabled: true,
          mode: "deny",
          countries: ["kp"],
          subdivisions: ["us-CA"],
          asns: [64512],
        },
        websocket: {
          allowAllOrigins: false,
          origins: ["https://chat.app.test:443"],
          idleTimeoutSeconds: 600,
        },
      } as Update);
      const ir = await access();
      expect(ir?.blockListIds).toEqual([lists.scrapers]);
      expect(ir?.allowListIds).toEqual([lists.office]);
      expect(ir?.hotlink?.redirectUrl).toBe("/hotlink.png");
      expect(ir?.userAgents?.rules).toMatchObject([
        { pattern: "*", allow: false },
        { pattern: "*Googlebot*", allow: true },
      ]);
      expect(ir?.geo).toMatchObject({
        allowOnly: false,
        countries: ["KP"],
        subdivisions: ["US-CA"],
        asns: [64512],
      });
      expect(ir?.websocket).toMatchObject({
        origins: ["https://chat.app.test"],
        idleTimeoutSeconds: 600,
      });
      const features = (await config()).ir.requiredFeatures;
      expect(features).toEqual(
        expect.arrayContaining([ACCESS_CONTROL_FEATURE, "geoip-city-v1", "geoip-asn-v1"]),
      );
      // The default idle timeout with every origin compiles nothing.
      await save({ websocket: { allowAllOrigins: true, origins: [], idleTimeoutSeconds: 3600 } });
      expect((await access())?.websocket).toBeUndefined();
    });

    it("audits which parts changed, never their lists", async () => {
      const [last] = (await audits("site.access_control_update")).sort(
        (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
      );
      expect(last?.targetId).toBe(siteId);
      expect(last?.metadata).toMatchObject({ parts: ["websocket"] });
      const all = JSON.stringify(await audits("site.access_control_update"));
      expect(all).not.toContain("friend.test");
      expect(all).not.toContain("Googlebot");
      expect(all).not.toContain("chat.app.test");
    });

    it("keeps lists chosen as site lists from deletion", async () => {
      const inUse = await rpcError(admin.ipLists.delete({ id: lists.scrapers ?? "" }));
      expect(inUse).toMatchObject({ code: "IP_LIST_IN_USE" });
      expect(String((inUse.data as { users: string }).users)).toContain("media");
      expect((await rpcError(admin.ipLists.delete({ id: lists.office ?? "" }))).code).toBe(
        "IP_LIST_IN_USE",
      );
    });
  });

  describe("nodes (0.4)", () => {
    it("holds access control for changes without the operator while a node lacks access-control-v1", async () => {
      await save({
        siteLists: { blockListIds: [], allowListIds: [] },
        hotlink: { ...(await admin.accessControl.get({ id: otherSiteId })).hotlink },
        userAgents: { rules: [] },
        geo: { enabled: false } as Update["geo"],
      });
      expect(await access()).toBeUndefined();
      await setNodeFeatures(["tls-v1"]);
      try {
        expect((await admin.sites.features({ id: siteId })).accessControl).toEqual({
          available: false,
          reason: "nodes",
        });
        const before = (await config()).row.revision;
        expect(
          await rpcError(
            updateAccessControl(
              ctx.db,
              { id: siteId, securityHeaders: { nosniff: true } } as SiteAccessControlUpdate,
              service,
            ),
          ),
        ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
        expect((await config()).row.revision).toBe(before);
        // The operator's saves still publish (nodes keep their last good configuration).
        await save({ securityHeaders: { hideServer: true } as Update["securityHeaders"] });
        expect((await access())?.securityHeaders?.hideServer).toBe(true);
      } finally {
        await setNodeFeatures(["tls-v1", ACCESS_CONTROL_FEATURE, "geoip-city-v1", "geoip-asn-v1"]);
      }
      expect((await admin.sites.features({ id: siteId })).accessControl).toEqual({
        available: true,
        reason: null,
      });
    });
  });

  describe("IP check", () => {
    it("lists the lists and bans that cover an address, and the site's outcome", async () => {
      await save({
        siteLists: { blockListIds: [lists.scrapers ?? ""], allowListIds: [lists.office ?? ""] },
      });
      // 198.51.100.7: in the site block list (scrapers) and the site allow list (office).
      const both = await admin.ipCheck.check({ ip: "198.51.100.7", siteId });
      expect(both.ip).toBe("198.51.100.7");
      expect(both.site).toEqual({ id: siteId, name: "media" });
      expect(both.lists.map((l) => [l.name, l.siteRole, l.entries])).toEqual([
        ["office", "allow", ["198.51.100.7/32"]],
        ["scrapers", "block", ["198.51.100.0/24"]],
      ]);
      expect(both.verdict).toEqual({
        outcome: "allowed",
        platformAllowed: false,
        siteAllowed: true,
      });
      // 198.51.100.8: only blocked by the site; another site does not see it.
      expect((await admin.ipCheck.check({ ip: "198.51.100.8", siteId })).verdict?.outcome).toBe(
        "site_blocked",
      );
      expect(
        (await admin.ipCheck.check({ ip: "198.51.100.8", siteId: otherSiteId })).verdict?.outcome,
      ).toBe("none");
      // IPv4-mapped IPv6 is the IPv4 address, as nodes read it.
      expect((await admin.ipCheck.check({ ip: "::ffff:198.51.100.8", siteId })).ip).toBe(
        "198.51.100.8",
      );
      // Platform lists: block, and the platform allow list exempting it.
      expect((await admin.ipCheck.check({ ip: "203.0.113.5", siteId })).verdict?.outcome).toBe(
        "platform_blocked",
      );
      expect((await admin.ipCheck.check({ ip: "203.0.113.9", siteId })).verdict).toEqual({
        outcome: "allowed",
        platformAllowed: true,
        siteAllowed: false,
      });
      // Bans: the site's, then a platform ban that comes first; the site allow list exempts
      // only the site's.
      await admin.bans.create({
        scope: "site",
        siteId,
        cidr: "198.51.100.9",
        reason: "abuse",
        durationSeconds: 3600,
      });
      await admin.bans.create({
        scope: "site",
        siteId,
        cidr: "192.0.2.10",
        reason: "abuse",
        durationSeconds: 3600,
      });
      expect((await admin.ipCheck.check({ ip: "198.51.100.9", siteId })).verdict?.outcome).toBe(
        "site_banned",
      );
      const exempt = await admin.ipCheck.check({ ip: "192.0.2.10", siteId });
      expect(exempt.bans.map((b) => b.scope)).toEqual(["site"]);
      expect(exempt.verdict?.outcome).toBe("allowed");
      await admin.bans.create({
        scope: "platform",
        cidr: "192.0.2.10",
        reason: "abuse",
        durationSeconds: 3600,
      });
      expect((await admin.ipCheck.check({ ip: "192.0.2.10", siteId })).verdict?.outcome).toBe(
        "platform_banned",
      );
      // Without a site: every ban, every cluster, no verdict.
      const plain = await admin.ipCheck.check({ ip: "198.51.100.9" });
      expect(plain.site).toBeNull();
      expect(plain.verdict).toBeNull();
      expect(plain.bans).toHaveLength(1);
      expect(plain.clusters.map((c) => c.id)).toContain(clusterId);
      expect(plain.lists.every((l) => l.siteRole === null)).toBe(true);
      expect((await rpcError(admin.ipCheck.check({ ip: "10.0.0.0/8" }))).code).toBe(
        "IP_ADDRESS_INVALID",
      );
      expect((await rpcError(admin.ipCheck.check({ ip: "1.2.3" }))).code).toBe(
        "IP_ADDRESS_INVALID",
      );
    });

    it("tells trusted proxies of the header mode apart", async () => {
      await admin.clusters.setClientIp({
        clusterId,
        settings: {
          mode: "header",
          trustedCidrs: ["10.9.0.0/16"],
          header: "x-forwarded-for",
          dropForwardedFor: false,
        },
      });
      const proxy = await admin.ipCheck.check({ ip: "10.9.1.2", siteId });
      expect(proxy.clusters).toEqual([
        expect.objectContaining({
          id: clusterId,
          clientIp: "header",
          trustedProxy: true,
          nodeAddress: false,
        }),
      ]);
      const client = await admin.ipCheck.check({ ip: "10.8.1.2", siteId });
      expect(client.clusters[0]?.trustedProxy).toBe(false);
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const reads = [`/sites/${siteId}/access-control`, `/ip-check?ip=198.51.100.7&siteId=${siteId}`];
    for (const path of reads) {
      expect((await api(reader, "GET", path)).status, path).toBe(200);
      const refusedKey = await api(key, "GET", path);
      expect([refusedKey.status, refusedKey.json.code], path).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    const path = `/sites/${siteId}/access-control`;
    const body = { securityHeaders: { nosniff: true } };
    const readOnly = await api(reader, "PATCH", path, body);
    expect([readOnly.status, readOnly.json.code]).toEqual([403, "ACCESS_KEY_READ_ONLY"]);
    const refusedKey = await api(key, "PATCH", path, body);
    expect([refusedKey.status, refusedKey.json.code]).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    expect((await admin.accessControl.get({ id: siteId })).securityHeaders.nosniff).toBe(false);
    const written = await api(writer, "PATCH", path, body);
    expect(written.status).toBe(200);
    expect((written.json.securityHeaders as { nosniff: boolean }).nosniff).toBe(true);
  });
});
