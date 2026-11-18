import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { API_SECURITY_DEFAULTS, API_SECURITY_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("API security control plane", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  let admin: ApiClient;
  let siteId: string;
  let clusterId: string;
  let nodeId: string;
  const settings = () => structuredClone(API_SECURITY_DEFAULTS);
  const compiled = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(
      app,
      ctx.env.EDGEWEIR_PUBLIC_URL,
      await signIn(app, ctx.env.EDGEWEIR_PUBLIC_URL, "admin@example.com"),
    );
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "api",
        domains: ["api.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        name: "legacy-api",
        clusterId,
        status: "active",
        supportedFeatures: [],
      })
      .returning();
    nodeId = node?.id ?? "";
  });
  afterAll(() => client.close());

  it("allows all-off saves and reports legacy nodes without implying protection", async () => {
    const before = await admin.apiSecurity.get({ id: siteId });
    expect(before.settings).toEqual(API_SECURITY_DEFAULTS);
    expect(before.unsupportedNodes).toBe(1);
    expect((await admin.sites.features({ id: siteId })).apiSecurity.available).toBe(false);
    const after = await admin.apiSecurity.update({
      id: siteId,
      settings: settings(),
      expectedUpdatedAt: before.updatedAt,
    });
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect((await compiled()).requiredFeatures).not.toContain(API_SECURITY_FEATURE);
    for (const field of ["discovery", "schema", "graphql"] as const) {
      const value = settings();
      if (field === "discovery") value.discovery.enabled = true;
      else value[field].mode = "observe";
      expect(
        (
          await rpcError(
            admin.apiSecurity.update({
              id: siteId,
              settings: value,
              expectedUpdatedAt: after.updatedAt,
            }),
          )
        ).code,
      ).toBe("NODE_CAPABILITY_REQUIRED");
    }
    expect((await admin.apiSecurity.get({ id: siteId })).updatedAt).toBe(after.updatedAt);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: [API_SECURITY_FEATURE] })
      .where(eq(schema.node.id, nodeId));
  });

  it("publishes supported settings and rejects stale edits", async () => {
    const before = await admin.apiSecurity.get({ id: siteId });
    const value = settings();
    value.discovery.enabled = true;
    value.graphql.mode = "observe";
    const saved = await admin.apiSecurity.update({
      id: siteId,
      settings: value,
      expectedUpdatedAt: before.updatedAt,
    });
    expect(saved.unsupportedNodes).toBe(0);
    expect((await admin.sites.features({ id: siteId })).apiSecurity.available).toBe(true);
    const config = await compiled();
    expect(config.requiredFeatures).toContain(API_SECURITY_FEATURE);
    expect(
      JSON.parse(config.sites.find((site) => site.id === siteId)?.apiSecurityJson ?? "{}"),
    ).toEqual(value);
    expect(
      (
        await rpcError(
          admin.apiSecurity.update({
            id: siteId,
            settings: settings(),
            expectedUpdatedAt: before.updatedAt,
          }),
        )
      ).code,
    ).toBe("UPDATED_AT_MISMATCH");
  });

  it("supports exception creation, replacement, disabling and deletion with bounded audit metadata", async () => {
    const before = await admin.apiSecurity.get({ id: siteId });
    const exception = {
      id: crypto.randomUUID(),
      enabled: true,
      method: "*" as const,
      path: "/api/users/{id}",
      check: "graphql" as const,
      reason: "sensitive exception reason",
    };
    const value = before.settings;
    value.exceptions = [exception];
    await admin.apiSecurity.update({
      id: siteId,
      settings: value,
      expectedUpdatedAt: before.updatedAt,
    });
    const disabled = await admin.apiSecurity.get({ id: siteId });
    disabled.settings.exceptions = [{ ...exception, enabled: false, reason: "edited reason" }];
    expect(
      (
        await admin.apiSecurity.update({
          id: siteId,
          settings: disabled.settings,
          expectedUpdatedAt: disabled.updatedAt,
        })
      ).settings.exceptions[0]?.enabled,
    ).toBe(false);
    const deleted = await admin.apiSecurity.get({ id: siteId });
    deleted.settings.exceptions = [];
    await admin.apiSecurity.update({
      id: siteId,
      settings: deleted.settings,
      expectedUpdatedAt: deleted.updatedAt,
    });
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "site.api_security_update"));
    expect(JSON.stringify(audits)).not.toContain("sensitive exception reason");
    expect(JSON.stringify(audits)).not.toContain("edited reason");
    expect(
      audits.some((row) => (row.metadata.removedExceptionIds as string[]).includes(exception.id)),
    ).toBe(true);
  });

  it("rolls back enforcement content while keeping current discovery privacy", async () => {
    const value = settings();
    value.discovery.enabled = true;
    value.schema.mode = "enforce";
    value.schema.endpoints = [{ method: "GET", path: "/api/users", parameters: [] }];
    await admin.apiSecurity.update({ id: siteId, settings: value });
    const target = await latestRevision(ctx.db, clusterId);
    await admin.apiSecurity.update({ id: siteId, settings: settings() });
    await admin.clusters.rollback({ id: clusterId, revision: target?.revision ?? 0 });
    const policy = JSON.parse(
      (await compiled()).sites.find((site) => site.id === siteId)?.apiSecurityJson ?? "{}",
    );
    expect(policy.schema.mode).toBe("enforce");
    expect(policy.schema.endpoints).toHaveLength(1);
    expect(policy.discovery.enabled).toBe(false);
  });

  it("rolls back both settings and revision when auditing fails", async () => {
    const before = await admin.apiSecurity.get({ id: siteId });
    const revision = await latestRevision(ctx.db, clusterId);
    await client.exec(`create function test_api_audit_fail() returns trigger language plpgsql as $$
      begin if new.action = 'site.api_security_update' then raise exception 'audit unavailable'; end if; return new; end $$;
      create trigger test_api_audit_fail before insert on audit_log for each row execute function test_api_audit_fail();`);
    try {
      const value = settings();
      value.graphql.mode = "observe";
      await rpcError(
        admin.apiSecurity.update({
          id: siteId,
          settings: value,
          expectedUpdatedAt: before.updatedAt,
        }),
      );
      expect(await admin.apiSecurity.get({ id: siteId })).toEqual(before);
      expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(revision?.revision);
    } finally {
      await client.exec(
        "drop trigger test_api_audit_fail on audit_log; drop function test_api_audit_fail();",
      );
    }
  });

  it("exposes imports only for existing sites and can generate the public API document", async () => {
    const document = JSON.stringify({ openapi: "3.1.0", paths: { "/api/users": { get: {} } } });
    expect(
      (await admin.apiSecurity.importOpenApi({ id: siteId, document })).endpoints,
    ).toHaveLength(1);
    expect(
      (await rpcError(admin.apiSecurity.importOpenApi({ id: crypto.randomUUID(), document }))).code,
    ).toBe("SITE_NOT_FOUND");
    const response = await app.request(`${ctx.env.EDGEWEIR_PUBLIC_URL}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("/sites/{id}/api-security");
  });
});
