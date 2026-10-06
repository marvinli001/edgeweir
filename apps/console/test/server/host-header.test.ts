import { readFileSync } from "node:fs";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { MAX_HOST_HEADER_LENGTH } from "@edgeweir/rule-engine";
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

/** The Host header vectors edgeweir-node shares (internal/configir/testdata). */
const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../../packages/rule-engine/test/host_header_vectors.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: { value: string; valid: boolean }[] }
).cases.filter(
  // The schema trims and bounds the length in UTF-16 units first; the vectors check that part
  // of validHostHeader on its own (packages/rule-engine/test/host-header.test.ts).
  (c) => c.value !== "" && c.value.trim() === c.value && c.value.length <= MAX_HOST_HEADER_LENGTH,
);

type RuleSave = Parameters<ApiClient["rules"]["save"]>[0]["rules"];

const originRule = (hostHeader: string): RuleSave[number] => ({
  name: "host",
  phase: "origin",
  enabled: true,
  expression: 'http.request.uri.path eq "/api"',
  action: { kind: "origin", hostHeader },
});

describe("Host headers of origins and origin rules as nodes accept them", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const compiledOrigin = async () =>
    (await config()).sites.find((site) => site.id === siteId)?.originPool?.origins[0];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "hosts",
        domains: ["hosts.example.test"],
        origins: [{ address: "origin.internal.test", hostHeader: "shop.example.test" }],
      })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("refuses a Host header nodes would skip when creating or updating a site, over /rpc and /api/v1", async () => {
    const created = await rpcError(
      admin.sites.create({
        domains: ["bad.example.test"],
        origins: [{ address: "origin.internal.test", hostHeader: "bad host" }],
      }),
    );
    expect(created).toMatchObject({
      code: "ORIGIN_HOST_HEADER_INVALID",
      status: 400,
      data: { hostHeader: "bad host" },
    });
    expect((await admin.sites.list({})).items.map((s) => s.name)).toEqual(["hosts"]);

    const before = (await config()).revision;
    const updated = await rpcError(
      admin.sites.update({
        id: siteId,
        origins: [
          { address: "origin.internal.test" },
          { address: "origin-b.internal.test", hostHeader: "example.test/path" },
        ],
      }),
    );
    expect(updated).toMatchObject({
      code: "ORIGIN_HOST_HEADER_INVALID",
      data: { hostHeader: "example.test/path" },
    });
    expect((await config()).revision).toBe(before);
    expect((await admin.sites.get({ id: siteId })).origins).toMatchObject([
      { address: "origin.internal.test", hostHeader: "shop.example.test" },
    ]);

    const writer = await admin.accessKeys.create({ name: "hosts-write", scope: "write" });
    const res = await api(writer.key, "POST", "/sites", {
      domains: ["v6.example.test"],
      origins: [{ address: "origin.internal.test", hostHeader: "[2001:db8::1]" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "ORIGIN_HOST_HEADER_INVALID",
      data: { hostHeader: "[2001:db8::1]" },
    });
    const ok = await api(writer.key, "POST", "/sites", {
      domains: ["v6.example.test"],
      origins: [{ address: "origin.internal.test", hostHeader: "[2001:db8::1]:8443" }],
    });
    expect(ok.status).toBe(201);
    const { site } = (await ok.json()) as { site: { id: string } };
    await admin.sites.delete({ id: site.id });
  });

  it("accepts exactly the shared vectors' valid Host headers and compiles them unchanged", async () => {
    expect(vectors.length).toBeGreaterThan(50);
    for (const { value, valid } of vectors) {
      const save = admin.sites.update({
        id: siteId,
        origins: [{ address: "origin.internal.test", hostHeader: value }],
      });
      if (valid) {
        await save;
        expect((await compiledOrigin())?.hostHeader, JSON.stringify(value)).toBe(value);
      } else {
        expect(await rpcError(save), JSON.stringify(value)).toMatchObject({
          code: "ORIGIN_HOST_HEADER_INVALID",
          data: { hostHeader: value },
        });
      }
    }
  });

  it("checks the Host header of origin rules the same way, for sites and the platform", async () => {
    for (const { value, valid } of vectors) {
      const save = admin.rules.save({ id: siteId, rules: [originRule(value)] });
      if (valid) await save;
      else
        expect(await rpcError(save), JSON.stringify(value)).toMatchObject({
          code: "ORIGIN_HOST_HEADER_INVALID",
          status: 400,
        });
    }
    const saved = await admin.rules.save({
      id: siteId,
      rules: [originRule("API.Example.test:8443")],
    });
    expect(saved[0]?.action).toMatchObject({ hostHeader: "api.example.test:8443" });
    expect(
      await rpcError(admin.platformRules.save({ rules: [originRule("[2001:db8::1]")] })),
    ).toMatchObject({ code: "ORIGIN_HOST_HEADER_INVALID", data: { hostHeader: "[2001:db8::1]" } });
    await admin.platformRules.save({ rules: [originRule("192.0.2.10:8080")] });
    expect((await admin.platformRules.get())[0]?.action).toMatchObject({
      hostHeader: "192.0.2.10:8080",
    });
    await admin.platformRules.save({ rules: [] });
  });

  it("still reads a site whose saved Host header nodes skip, and lets other changes through", async () => {
    await admin.sites.update({
      id: siteId,
      origins: [{ address: "origin.internal.test", hostHeader: "shop.example.test" }],
    });
    await ctx.db.update(schema.origin).set({ hostHeader: "bad host" });
    const site = await admin.sites.get({ id: siteId });
    expect(site.origins[0]?.hostHeader).toBe("bad host");
    await admin.sites.update({ id: siteId, name: "hosts renamed" });
    expect(
      await rpcError(
        admin.sites.update({
          id: siteId,
          origins: site.origins.map(({ address, port, scheme, hostHeader }) => ({
            address,
            port,
            scheme,
            hostHeader,
          })),
        }),
      ),
    ).toMatchObject({ code: "ORIGIN_HOST_HEADER_INVALID" });
    const [row] = await ctx.db
      .select()
      .from(schema.origin)
      .where(eq(schema.origin.address, "origin.internal.test"));
    expect(row?.hostHeader).toBe("bad host");
  });
});
