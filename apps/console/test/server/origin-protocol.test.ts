import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { siteUpdateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { OriginProtocol } from "@edgeweir/proto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import { updateSite } from "../../src/server/services/sites";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const FEATURES = ["rules-v1", "tls-v1", "access-logs-v1", "origin-http2-v1"];

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-h2", name: "integration" },
};

describe("HTTP/2 and gRPC towards the origins on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const pool = async () => (await config()).sites.find((site) => site.id === siteId)?.originPool;
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "rpc",
        domains: ["rpc.example.test"],
        origins: [{ address: "grpc.internal.test", port: 50051 }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-h2",
        supportedFeatures: FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("reads HTTP/1.1 without gRPC by default and compiles nothing for it", async () => {
    const site = await admin.sites.get({ id: siteId });
    expect(site.originSettings).toMatchObject({ protocol: "http1", grpc: false });
    expect((await pool())?.protocol).toBe(OriginProtocol.UNSPECIFIED);
    expect((await pool())?.grpc).toBe(false);
    expect((await config()).requiredFeatures).not.toContain("origin-http2-v1");
    expect((await admin.sites.features({ id: siteId })).originHttp2).toEqual({
      available: true,
      reason: null,
    });
  });

  it("stores HTTP/2 and gRPC, compiles them with origin-http2-v1 and keeps them when an update omits them", async () => {
    const current = (await admin.sites.get({ id: siteId })).originSettings;
    const { site } = await admin.sites.update({
      id: siteId,
      originSettings: { ...current, protocol: "http2", grpc: true },
    });
    expect(site.originSettings).toMatchObject({ protocol: "http2", grpc: true });
    expect(await pool()).toMatchObject({ protocol: OriginProtocol.HTTP2, grpc: true });
    expect((await config()).requiredFeatures).toContain("origin-http2-v1");
    const [stored] = await ctx.db
      .select({ protocol: schema.originPool.protocol, grpc: schema.originPool.grpc })
      .from(schema.originPool)
      .where(eq(schema.originPool.siteId, siteId));
    expect(stored).toEqual({ protocol: "http2", grpc: true });
    const [audit] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "site.update"), eq(schema.auditLog.targetId, siteId)))
      .orderBy(schema.auditLog.id);
    expect(audit?.metadata).toMatchObject({ originSettings: { protocol: "http2", grpc: true } });
    // Clients that predate these settings send pool settings without them.
    const kept = await admin.sites.update({
      id: siteId,
      originSettings: { policy: "round_robin" },
    });
    expect(kept.site.originSettings).toMatchObject({
      policy: "round_robin",
      protocol: "http2",
      grpc: true,
    });
    // gRPC off keeps HTTP/2.
    await admin.sites.update({ id: siteId, originSettings: { grpc: false } });
    expect(await pool()).toMatchObject({ protocol: OriginProtocol.HTTP2, grpc: false });
  });

  it("refuses gRPC without HTTP/2, against the stored settings too", async () => {
    await admin.sites.update({ id: siteId, originSettings: { protocol: "http2", grpc: true } });
    const before = (await config()).revision;
    for (const originSettings of [
      { protocol: "http1" as const },
      { protocol: "http1" as const, grpc: true },
    ]) {
      const error = await rpcError(admin.sites.update({ id: siteId, originSettings }));
      expect(error).toMatchObject({ code: "ORIGIN_GRPC_REQUIRES_HTTP2", status: 400 });
    }
    expect((await config()).revision).toBe(before);
    // Both at once is a valid way back to HTTP/1.1.
    await admin.sites.update({ id: siteId, originSettings: { protocol: "http1", grpc: false } });
    expect(await pool()).toMatchObject({ protocol: OriginProtocol.UNSPECIFIED, grpc: false });
    expect(
      await rpcError(admin.sites.update({ id: siteId, originSettings: { grpc: true } })),
    ).toMatchObject({ code: "ORIGIN_GRPC_REQUIRES_HTTP2" });
    const writer = await admin.accessKeys.create({ name: "h2-write", scope: "write" });
    const res = await api(writer.key, "POST", "/sites", {
      domains: ["rpc2.example.test"],
      origins: [{ address: "grpc.internal.test" }],
      originSettings: { grpc: true },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "ORIGIN_GRPC_REQUIRES_HTTP2" });
    const created = await api(writer.key, "POST", "/sites", {
      domains: ["rpc2.example.test"],
      origins: [{ address: "grpc.internal.test" }],
      originSettings: { protocol: "http2", grpc: true },
    });
    expect(created.status).toBe(201);
    const { site } = (await created.json()) as { site: { id: string; originSettings: unknown } };
    expect(site.originSettings).toMatchObject({ protocol: "http2", grpc: true });
    await admin.sites.delete({ id: site.id });
  });

  it("holds HTTP/2 the cluster's nodes lack for changes without the operator; the operator may require it", async () => {
    await setNodeFeatures(["rules-v1", "tls-v1", "access-logs-v1"]);
    expect((await admin.sites.features({ id: siteId })).originHttp2).toEqual({
      available: false,
      reason: "nodes",
    });
    const before = (await config()).revision;
    await expect(
      updateSite(
        ctx.db,
        siteUpdateInput.parse({ id: siteId, originSettings: { protocol: "http2" } }),
        { ...service, masterKey: ctx.masterKey },
      ),
    ).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      status: 409,
      data: { features: "origin-http2-v1" },
    });
    expect((await config()).revision).toBe(before);
    expect((await admin.sites.get({ id: siteId })).originSettings.protocol).toBe("http1");
    // The operator may deliberately require the upgrade.
    await admin.sites.update({ id: siteId, originSettings: { protocol: "http2" } });
    expect((await config()).requiredFeatures).toContain("origin-http2-v1");
    await admin.sites.update({ id: siteId, originSettings: { protocol: "http1" } });
    expect((await config()).requiredFeatures).not.toContain("origin-http2-v1");
    await setNodeFeatures(FEATURES);
  });
});
