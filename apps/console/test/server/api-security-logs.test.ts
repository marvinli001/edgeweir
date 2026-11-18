import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { API_SECURITY_DEFAULTS, type ApiSecuritySettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestLogs, maintainLogs } from "../../src/server/services/access-logs";
import {
  apiSecurityResults,
  confirmApiEndpoint,
  parseApiSecurityLog,
} from "../../src/server/services/api-security";
import { createClusterTx } from "../../src/server/services/clusters";
import { latestRevision } from "../../src/server/services/revisions";
import { createTestContext, seedOperator } from "./helpers";

const policy = (): ApiSecuritySettings => {
  const value = structuredClone(API_SECURITY_DEFAULTS);
  value.discovery.enabled = true;
  value.schema.mode = "observe";
  return value;
};

describe("API security access log ingestion", async () => {
  const { ctx, client } = await createTestContext();
  let node: { id: string; clusterId: string };
  let siteId: string;
  const now = Date.now();
  const actor = { type: "user" as const, id: "user_admin" };
  let sequence = 0n;
  const detail = () => ({
    template: "/api/users/privatetoken",
    source: "traffic",
    issues: [{ check: "schema", code: "endpoint-unknown", mode: "observe" }],
    exceptionIds: [],
  });
  const entry = (extra: Record<string, unknown> = {}) =>
    create(AccessLogSchema, {
      siteId,
      time: timestampFromDate(new Date(now)),
      clientIp: "192.0.2.1",
      method: "GET",
      host: "api.test",
      path: "/api/users/privatetoken?secret=hidden",
      status: 200,
      bytesSent: 32n,
      durationMs: 1,
      sampleRate: 1000,
      apiSecurityJson: JSON.stringify(detail()),
      ...extra,
    });
  beforeAll(async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "api-logs", description: "" }, actor),
    );
    const [site] = await ctx.db
      .insert(schema.site)
      .values({
        name: "api-logs",
        cnamePrefix: "api-logs",
        clusterId: cluster.id,
        apiSecurity: policy(),
        logSampleRate: 0,
      })
      .returning();
    siteId = site?.id ?? "";
    const [createdNode] = await ctx.db
      .insert(schema.node)
      .values({ name: "api-node", clusterId: cluster.id })
      .returning();
    if (!createdNode) throw new Error("node missing");
    node = createdNode;
  });
  afterAll(() => client.close());

  it("uses the existing cursor for exactly-once counters and returns no raw request secrets", async () => {
    const batch = ++sequence;
    expect(await ingestLogs(ctx, node, batch, [entry()], now)).toBe(1);
    expect(await ingestLogs(ctx, node, batch, [entry()], now)).toBe(0);
    const results = await apiSecurityResults(ctx, siteId, now);
    expect(results.endpoints).toHaveLength(1);
    expect(results.endpoints[0]).toMatchObject({
      path: "/api/users/{segment3}",
      sampledRequests: 1,
      violations: 1,
      confirmed: false,
    });
    expect(results.events).toHaveLength(1);
    expect(JSON.stringify(results)).not.toMatch(/privatetoken|secret|hidden|192\.0\.2\.1/);
  });

  it("confirms a corrected template without publishing or changing settings and preserves it on later reports", async () => {
    const before = await latestRevision(ctx.db, node.clusterId);
    const [candidate] = (await apiSecurityResults(ctx, siteId, now)).endpoints;
    const confirmed = await confirmApiEndpoint(
      ctx.db,
      {
        id: siteId,
        endpointId: candidate?.id ?? "",
        path: "/api/users/{userId}",
      },
      actor,
    );
    expect(confirmed).toMatchObject({
      confirmed: true,
      source: "manual",
      path: "/api/users/{userId}",
    });
    expect((await latestRevision(ctx.db, node.clusterId))?.revision).toBe(before?.revision);
    expect(
      (await ctx.db.select().from(schema.site).where(eq(schema.site.id, siteId)))[0]?.apiSecurity,
    ).toEqual(policy());
    await ingestLogs(ctx, node, ++sequence, [entry()], now);
    expect((await apiSecurityResults(ctx, siteId, now)).endpoints[0]).toMatchObject({
      path: "/api/users/{userId}",
      confirmed: true,
      sampledRequests: 2,
    });
    await expect(
      confirmApiEndpoint(
        ctx.db,
        {
          id: siteId,
          endpointId: crypto.randomUUID(),
          path: "/api/users",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "API_ENDPOINT_NOT_FOUND" });
  });

  it("bounds endpoints to 500 and events to 100, and physically prunes expired candidates", async () => {
    const words = [
      "orders",
      "products",
      "items",
      "posts",
      "comments",
      "events",
      "files",
      "reports",
      "teams",
      "projects",
    ];
    const logs = Array.from({ length: 600 }, (_, i) =>
      entry({
        apiSecurityJson: JSON.stringify({
          ...detail(),
          template: `/api/${words[Math.floor(i / 100)]}/${words[Math.floor(i / 10) % 10]}/${words[i % 10]}`,
        }),
      }),
    );
    expect(await ingestLogs(ctx, node, ++sequence, logs, now)).toBe(600);
    const results = await apiSecurityResults(ctx, siteId, now);
    expect(results.endpoints).toHaveLength(500);
    expect(results.events).toHaveLength(100);
    await maintainLogs(ctx.db, now + 8 * 86400000);
    expect(await ctx.db.select().from(schema.siteApiEndpoint)).toHaveLength(0);
  });

  it("keeps check events with discovery off without collecting candidates", async () => {
    const value = policy();
    value.discovery.enabled = false;
    await ctx.db.update(schema.site).set({ apiSecurity: value }).where(eq(schema.site.id, siteId));
    await ingestLogs(ctx, node, ++sequence, [entry()], now);
    const results = await apiSecurityResults(ctx, siteId, now);
    expect(results.endpoints).toHaveLength(0);
    expect(results.events).toHaveLength(1);
  });

  it("uses ClickHouse for events, and neither acknowledges failures nor double-counts a retry", async () => {
    await ctx.db
      .update(schema.site)
      .set({ apiSecurity: policy() })
      .where(eq(schema.site.id, siteId));
    ctx.env.EDGEWEIR_ANALYTICS = "clickhouse";
    const writes: string[] = [];
    let failInsert = true;
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = String(init?.body ?? "");
      if (body.startsWith("INSERT INTO access_log")) {
        writes.push(body);
        if (failInsert) return new Response("unavailable", { status: 503 });
      }
      if (body.includes("api_security_json AS detail"))
        return new Response(
          JSON.stringify({
            time: new Date(now).toISOString(),
            requestId: "",
            method: "GET",
            status: 200,
            detail: JSON.stringify({ ...detail(), template: "/api/users/{segment3}" }),
          }),
        );
      return new Response("");
    });
    const batch = ++sequence;
    try {
      await expect(ingestLogs(ctx, node, batch, [entry()], now)).rejects.toThrow(
        "ClickHouse request failed",
      );
      expect(await ctx.db.select().from(schema.siteApiEndpoint)).toHaveLength(0);
      failInsert = false;
      expect(await ingestLogs(ctx, node, batch, [entry()], now)).toBe(1);
      expect(await ingestLogs(ctx, node, batch, [entry()], now)).toBe(0);
      const results = await apiSecurityResults(ctx, siteId, now);
      expect(results.endpoints[0]?.sampledRequests).toBe(1);
      expect(results.events[0]?.detail.template).toBe("/api/users/{segment3}");
      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain("api_security_json");
      expect(writes[1]).toBe(writes[0]);
    } finally {
      mock.mockRestore();
      ctx.env.EDGEWEIR_ANALYTICS = "lite";
    }
  });

  it("rejects unbounded or unknown fields and redacts arbitrary issue codes", () => {
    expect(
      parseApiSecurityLog(JSON.stringify({ ...detail(), body: "private" }), policy()),
    ).toBeNull();
    expect(parseApiSecurityLog("x".repeat(4097), policy())).toBeNull();
    expect(
      parseApiSecurityLog(
        JSON.stringify({
          ...detail(),
          issues: [{ check: "schema", mode: "observe", code: "private-token" }],
        }),
        policy(),
      )?.issues[0]?.code,
    ).toBe("check-invalid");
    expect(parseApiSecurityLog(JSON.stringify(detail()), API_SECURITY_DEFAULTS)).toBeNull();
  });
});
