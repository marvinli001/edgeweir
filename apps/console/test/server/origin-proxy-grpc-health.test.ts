import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { siteUpdateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ActiveHealthCheckType } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
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

const BASE = ["rules-v1", "tls-v1", "access-logs-v1", "active-health-v1"];
const FEATURES = [...BASE, "origin-proxy-protocol-v1", "active-health-grpc-v1"];

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-pp", name: "integration" },
};

describe("PROXY protocol to origins and gRPC health checks on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
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
        name: "pp",
        domains: ["pp.example.test"],
        origins: [{ address: "app.internal.test", port: 8080 }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-pp",
        supportedFeatures: FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("sends no PROXY protocol and probes over HTTP by default, compiling nothing for either", async () => {
    const site = await admin.sites.get({ id: siteId });
    expect(site.origins[0]?.proxyProtocolVersion).toBe(0);
    expect(site.originSettings.activeHealthCheck).toMatchObject({ type: "http", grpcService: "" });
    expect((await pool())?.origins[0]?.proxyProtocolVersion).toBe(0);
    const { requiredFeatures } = await config();
    expect(requiredFeatures).not.toContain("origin-proxy-protocol-v1");
    expect(requiredFeatures).not.toContain("active-health-grpc-v1");
    const features = await admin.sites.features({ id: siteId });
    expect(features.originProxyProtocol).toEqual({ available: true, reason: null });
    expect(features.activeHealthGrpc).toEqual({ available: true, reason: null });
  });

  it("stores the version per origin and compiles it with origin-proxy-protocol-v1", async () => {
    const { site } = await admin.sites.update({
      id: siteId,
      origins: [
        { address: "app.internal.test", port: 8080, proxyProtocolVersion: 2 },
        { address: "legacy.internal.test", port: 8080, group: "legacy", proxyProtocolVersion: 1 },
        { address: "plain.internal.test", port: 8080 },
      ],
    });
    expect(site.origins.map((o) => o.proxyProtocolVersion)).toEqual([2, 1, 0]);
    // Compiled origins are in canonical (id) order.
    const origins = [...((await pool())?.origins ?? [])].sort((a, b) =>
      a.address.localeCompare(b.address),
    );
    expect(origins.map((o) => [o.address, o.proxyProtocolVersion])).toEqual([
      ["app.internal.test", 2],
      ["legacy.internal.test", 1],
      ["plain.internal.test", 0],
    ]);
    expect((await config()).requiredFeatures).toContain("origin-proxy-protocol-v1");
    const stored = await ctx.db
      .select({ address: schema.origin.address, pp: schema.origin.proxyProtocolVersion })
      .from(schema.origin)
      .orderBy(schema.origin.createdAt);
    expect(stored.filter((o) => o.pp !== 0)).toEqual([
      { address: "app.internal.test", pp: 2 },
      { address: "legacy.internal.test", pp: 1 },
    ]);
  });

  it("refuses versions other than 0-2 and PROXY protocol to S3 origins", async () => {
    const before = (await config()).revision;
    expect(
      siteUpdateInput.safeParse({
        id: siteId,
        origins: [{ address: "app.internal.test", proxyProtocolVersion: 3 }],
      }).success,
    ).toBe(false);
    const error = await rpcError(
      admin.sites.update({
        id: siteId,
        origins: [
          {
            address: "s3.example.test",
            scheme: "https",
            proxyProtocolVersion: 1,
            s3: {
              region: "us-east-1",
              accessKeyId: "AKIDEXAMPLE",
              secretAccessKey: "not-a-secret",
            },
          },
        ],
      }),
    );
    expect(error).toMatchObject({ code: "ORIGIN_PROXY_PROTOCOL_S3", status: 400 });
    expect((await config()).revision).toBe(before);
  });

  it("stores a gRPC health check and compiles it with active-health-grpc-v1", async () => {
    const current = (await admin.sites.get({ id: siteId })).originSettings;
    const { site } = await admin.sites.update({
      id: siteId,
      originSettings: {
        ...current,
        activeHealthCheck: {
          ...current.activeHealthCheck,
          enabled: true,
          type: "grpc",
          grpcService: "e2e.Echo",
        },
      },
    });
    expect(site.originSettings.activeHealthCheck).toMatchObject({
      enabled: true,
      type: "grpc",
      grpcService: "e2e.Echo",
    });
    expect((await pool())?.activeHealthCheck).toMatchObject({
      type: ActiveHealthCheckType.GRPC,
      grpcService: "e2e.Echo",
    });
    const { requiredFeatures } = await config();
    expect(requiredFeatures).toContain("active-health-v1");
    expect(requiredFeatures).toContain("active-health-grpc-v1");
    // Back to HTTP: the type stays unset, as before proto v1.6.0.
    await admin.sites.update({
      id: siteId,
      originSettings: {
        activeHealthCheck: { ...site.originSettings.activeHealthCheck, type: "http" },
      },
    });
    const http = (await pool())?.activeHealthCheck;
    expect(http?.type).toBe(ActiveHealthCheckType.UNSPECIFIED);
    expect(http?.grpcService).toBe("");
    expect((await config()).requiredFeatures).not.toContain("active-health-grpc-v1");
  });

  it("refuses gRPC service names with spaces or over 255 bytes", () => {
    for (const grpcService of ["e2e Echo", "x".repeat(256), "é"])
      expect(
        siteUpdateInput.safeParse({
          id: siteId,
          originSettings: { activeHealthCheck: { type: "grpc", grpcService } },
        }).success,
      ).toBe(false);
  });

  it("holds both for changes without the operator while the nodes lack them", async () => {
    await setNodeFeatures(BASE);
    const features = await admin.sites.features({ id: siteId });
    expect(features.originProxyProtocol).toEqual({ available: false, reason: "nodes" });
    expect(features.activeHealthGrpc).toEqual({ available: false, reason: "nodes" });
    await admin.sites.update({ id: siteId, origins: [{ address: "app.internal.test" }] });
    const before = (await config()).revision;
    await expect(
      updateSite(
        ctx.db,
        siteUpdateInput.parse({
          id: siteId,
          origins: [{ address: "app.internal.test", proxyProtocolVersion: 1 }],
        }),
        { ...service, masterKey: ctx.masterKey },
      ),
    ).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      data: { features: "origin-proxy-protocol-v1" },
    });
    await expect(
      updateSite(
        ctx.db,
        siteUpdateInput.parse({
          id: siteId,
          originSettings: { activeHealthCheck: { enabled: true, type: "grpc" } },
        }),
        { ...service, masterKey: ctx.masterKey },
      ),
    ).rejects.toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      data: { features: "active-health-grpc-v1" },
    });
    expect((await config()).revision).toBe(before);
    await setNodeFeatures(FEATURES);
  });
});
