import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { clientIpSettings, listenPortsInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ListenerProtocol } from "@edgeweir/proto";
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

const missing = "00000000-0000-4000-8000-000000000000";
const origins = [{ address: "origin.example.com" }];

describe("listener ports, client address, HTTPS redirect and layer-4 additions (G9)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let certificateId = "";
  let nodeId = "";
  /** The latest revision before the layer-4 applications. */
  let beforeL4 = 0;
  const material = await ctx.nodeCa.issueServerCertificate(["shop.g9.test", "*.g9.test"]);

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async (cluster = clusterId) => {
    const row = await latestRevision(ctx.db, cluster);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir);
  };
  const site = async (id = siteId) => (await config()).sites.find((s) => s.id === id);
  const audits = async (action: string) =>
    (await admin.auditLogs.list({ action })).items.map((item) => item.metadata);

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.g9.test", "a.g9.test", "*.g9.test"],
        origins,
      })
    ).site.id;
    certificateId = (
      await admin.certificates.upload({
        name: "g9",
        chainPem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
      })
    ).id;
    // An active node with every G9 feature; tests take features away from it.
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g9",
        supportedFeatures: ["edge-ports-v1", "client-ip-v1", "l4-v1", "l4-v2", "tls-v1"],
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("validates listener port lists: 1-65535 without 80 and 443, at most 16, sorted sets", () => {
    const parse = (httpPorts: number[], httpsPorts: number[] = []) =>
      listenPortsInput.safeParse({ clusterId: missing, httpPorts, httpsPorts });
    expect(parse([8081, 8080, 8081]).data?.httpPorts).toEqual([8080, 8081]);
    expect(parse([1, 65535]).success).toBe(true);
    for (const ports of [[80], [443], [0], [65536], [8080.5]])
      expect(parse(ports).success).toBe(false);
    expect(parse([], [443]).success).toBe(false);
    expect(parse(Array.from({ length: 17 }, (_, i) => 9000 + i)).success).toBe(false);
    expect(parse(Array.from({ length: 16 }, (_, i) => 9000 + i)).success).toBe(true);
  });

  it("validates the client address setting by mode", () => {
    const ok = clientIpSettings.parse({
      mode: "header",
      trustedCidrs: ["192.0.2.7", "10.1.2.3/8", "2001:DB8::/32", "10.0.0.0/8"],
      header: " X-Forwarded-For ",
    });
    expect(ok).toEqual({
      mode: "header",
      trustedCidrs: ["10.0.0.0/8", "192.0.2.7/32", "2001:db8::/32"],
      header: "x-forwarded-for",
      dropForwardedFor: false,
    });
    expect(clientIpSettings.parse({}).mode).toBe("direct");
    for (const bad of [
      { mode: "header", trustedCidrs: [], header: "x-real-ip" },
      { mode: "header", trustedCidrs: ["10.0.0.0/8"], header: "" },
      { mode: "header", trustedCidrs: ["not-an-ip"], header: "x-real-ip" },
      { mode: "header", trustedCidrs: ["::ffff:10.0.0.0/104"], header: "x-real-ip" },
      {
        mode: "header",
        trustedCidrs: Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`),
        header: "x-a",
      },
      { mode: "header", trustedCidrs: ["10.0.0.0/8"], header: "x_real_ip" },
      { mode: "header", trustedCidrs: ["10.0.0.0/8"], header: "x-edgeweir-site" },
      { mode: "header", trustedCidrs: ["10.0.0.0/8"], header: "host" },
      { mode: "proxy_protocol", dropForwardedFor: true },
      { mode: "magic" },
    ])
      expect(clientIpSettings.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });

  it("saves extra listener ports, audits and publishes them; pools and listener ports never overlap", async () => {
    expect(await admin.clusters.listenPorts({ clusterId })).toEqual({
      clusterId,
      httpPorts: [],
      httpsPorts: [],
      nodesWithout: [],
    });
    const before = (await config()).listeners.map((l) => l.port);
    expect(before).toEqual([80]);
    const saved = await admin.clusters.setListenPorts({
      clusterId,
      httpPorts: [8081],
      httpsPorts: [9443, 8443],
    });
    expect(saved).toMatchObject({ httpPorts: [8081], httpsPorts: [8443, 9443] });
    const listeners = (await config()).listeners.map((l) => [l.port, l.protocol]);
    expect(listeners).toEqual([
      [80, ListenerProtocol.HTTP],
      [8081, ListenerProtocol.HTTP],
      [8443, ListenerProtocol.HTTPS],
      [9443, ListenerProtocol.HTTPS],
    ]);
    expect((await config()).requiredFeatures).toContain("edge-ports-v1");
    expect(await audits("cluster.listen_ports_update")).toEqual([
      {
        from: { httpPorts: [], httpsPorts: [] },
        to: { httpPorts: [8081], httpsPorts: [8443, 9443] },
        revision: expect.any(Number),
      },
    ]);
    // Saving the same ports publishes nothing.
    const revision = (await latestRevision(ctx.db, clusterId))?.revision;
    await admin.clusters.setListenPorts({ clusterId, httpPorts: [8081], httpsPorts: [8443, 9443] });
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(revision);
    // A port is HTTP or HTTPS.
    expect(
      await rpcError(
        admin.clusters.setListenPorts({ clusterId, httpPorts: [8081], httpsPorts: [8081] }),
      ),
    ).toMatchObject({ code: "LISTEN_PORT_CONFLICT", status: 400, data: { port: 8081 } });
    // Listener ports stay out of port pools, both ways.
    expect(
      await rpcError(
        admin.clusters.setPortPools({
          clusterId,
          pools: [{ protocol: "udp", from: 9000, to: 9500 }],
        }),
      ),
    ).toMatchObject({ code: "L4_PORT_RESERVED", data: { port: 9443 } });
    await admin.clusters.setPortPools({
      clusterId,
      pools: [{ protocol: "tcp", from: 20000, to: 21000 }],
    });
    expect((await admin.clusters.portPools({ clusterId })).reservedPorts).toEqual([
      80, 443, 8081, 8443, 9443,
    ]);
    expect(
      await rpcError(
        admin.clusters.setListenPorts({ clusterId, httpPorts: [8081, 20500], httpsPorts: [] }),
      ),
    ).toMatchObject({
      code: "LISTEN_PORT_IN_POOL",
      data: { port: 20500, pools: "20000-21000/tcp" },
    });
  });

  it("binds a site to ports: defaults, listener ports only, HTTPS ones with a certificate, at least one", async () => {
    expect((await admin.sites.get({ id: siteId })).ports).toEqual({ http: [80], https: [443] });
    // The cluster has extra ports: every site names its ports in the configuration.
    expect((await site())?.ports).toEqual([80]);
    for (const [ports, code] of [
      [{ http: [8082], https: [] }, "SITE_PORT_UNAVAILABLE"],
      [{ http: [80], https: [8081] }, "SITE_PORT_UNAVAILABLE"],
      [{ http: [9443], https: [] }, "SITE_PORT_UNAVAILABLE"],
      [{ http: [80], https: [9443] }, "SITE_HTTPS_PORT_NEEDS_CERTIFICATE"],
      [{ http: [], https: [443] }, "SITE_PORTS_EMPTY"],
    ] as const)
      expect(
        (
          await rpcError(
            admin.sites.update({
              id: siteId,
              ports: { http: [...ports.http], https: [...ports.https] },
            }),
          )
        ).code,
        JSON.stringify(ports),
      ).toBe(code);
    await admin.https.update({ id: siteId, settings: { certificateId } });
    expect((await site())?.ports).toEqual([80, 443]);
    const { site: updated } = await admin.sites.update({
      id: siteId,
      ports: { http: [8081, 80], https: [9443] },
    });
    expect(updated.ports).toEqual({ http: [80, 8081], https: [9443] });
    expect((await site())?.ports).toEqual([80, 8081, 9443]);
    // Without a site on 443 the cluster stops listening there.
    expect((await config()).listeners.map((l) => l.port)).toEqual([80, 8081, 8443, 9443]);
    // A listener port a site uses stays.
    expect(
      await rpcError(
        admin.clusters.setListenPorts({ clusterId, httpPorts: [], httpsPorts: [8443, 9443] }),
      ),
    ).toMatchObject({
      code: "LISTEN_PORT_IN_USE",
      status: 409,
      data: { port: 8081, sites: "shop" },
    });
    // Without the certificate the site keeps an HTTP port.
    await admin.sites.update({ id: siteId, ports: { http: [], https: [9443] } });
    expect(
      (await rpcError(admin.https.update({ id: siteId, settings: { certificateId: null } }))).code,
    ).toBe("SITE_PORTS_EMPTY");
    await admin.sites.update({ id: siteId, ports: { http: [80, 8081], https: [9443] } });
  });

  it("saves the HTTPS redirect's status, port and excluded domains", async () => {
    const saved = await admin.https.update({
      id: siteId,
      settings: {
        certificateId,
        forceHttps: true,
        redirectStatus: 308,
        redirectPort: 9443,
        redirectExcludedDomains: ["*.G9.test", "a.g9.test"],
      },
    });
    expect(saved).toMatchObject({
      redirectStatus: 308,
      redirectPort: 9443,
      redirectExcludedDomains: ["*.g9.test", "a.g9.test"],
    });
    expect((await site())?.tls).toMatchObject({
      forceHttps: true,
      redirectStatus: 308,
      redirectPort: 9443,
      redirectExcludedDomains: ["*.g9.test", "a.g9.test"],
    });
    const refused: [{ redirectPort?: number; redirectExcludedDomains?: string[] }, string][] = [
      [{ redirectPort: 8443 }, "HTTPS_REDIRECT_PORT_INVALID"],
      [{ redirectExcludedDomains: ["other.test"] }, "HTTPS_REDIRECT_DOMAIN_INVALID"],
    ];
    for (const [settings, code] of refused)
      expect(
        (
          await rpcError(
            admin.https.update({
              id: siteId,
              settings: { certificateId, forceHttps: true, ...settings },
            }),
          )
        ).code,
      ).toBe(code);
    expect(
      (
        await rpcError(
          admin.https.update({
            id: siteId,
            settings: { certificateId, redirectStatus: 304 as never },
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    // A site may not drop the HTTPS port its redirect goes to.
    expect(
      (await rpcError(admin.sites.update({ id: siteId, ports: { http: [80], https: [443] } })))
        .code,
    ).toBe("HTTPS_REDIRECT_PORT_INVALID");
    // 443 is always a valid target, and the defaults stay out of the configuration.
    await admin.https.update({ id: siteId, settings: { certificateId, forceHttps: true } });
    expect((await site())?.tls).toMatchObject({
      redirectStatus: 0,
      redirectPort: 0,
      redirectExcludedDomains: [],
    });
  });

  it("saves the client address setting, audits and publishes it; the cluster list shows its mode", async () => {
    expect((await admin.clusters.clientIp({ clusterId })).settings).toEqual({
      mode: "direct",
      trustedCidrs: [],
      header: "",
      dropForwardedFor: false,
    });
    await admin.clusters.setClientIp({
      clusterId,
      settings: {
        mode: "header",
        trustedCidrs: ["10.0.0.0/8", "192.0.2.0/24"],
        header: "x-forwarded-for",
      },
    });
    let compiled = await config();
    expect(compiled.clientAddress).toMatchObject({
      mode: "header",
      trustedCidrs: ["10.0.0.0/8", "192.0.2.0/24"],
      header: "x-forwarded-for",
    });
    expect(compiled.listeners.some((l) => l.proxyProtocol)).toBe(false);
    expect(compiled.requiredFeatures).toContain("client-ip-v1");
    expect((await admin.clusters.list()).find((c) => c.id === clusterId)?.clientIpMode).toBe(
      "header",
    );
    await admin.clusters.setClientIp({ clusterId, settings: { mode: "proxy_protocol" } });
    compiled = await config();
    expect(compiled.clientAddress?.mode).toBe("proxy_protocol");
    expect(compiled.listeners.every((l) => l.proxyProtocol)).toBe(true);
    await admin.clusters.setClientIp({
      clusterId,
      settings: { mode: "direct", dropForwardedFor: true },
    });
    expect((await config()).clientAddress).toMatchObject({
      mode: "direct",
      dropForwardedFor: true,
    });
    await admin.clusters.setClientIp({ clusterId, settings: { mode: "direct" } });
    compiled = await config();
    expect(compiled.clientAddress).toBeUndefined();
    expect(compiled.requiredFeatures).not.toContain("client-ip-v1");
    const [stored] = await ctx.db
      .select({ clientIp: schema.cluster.clientIp })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    expect(stored?.clientIp).toBeNull();
    expect(
      (await audits("cluster.client_ip_update")).map((m) => (m.to as { mode: string }).mode),
    ).toEqual(["direct", "direct", "proxy_protocol", "header"]);
  });

  it("forwards port ranges, origins on the arriving port and TLS of TCP applications", async () => {
    beforeL4 = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    const { app: range } = await admin.l4Apps.create({
      clusterId,
      name: "range",
      protocol: "tcp",
      port: 20100,
      portEnd: 20199,
      originPortMode: "same",
      origins: [{ address: "range.example.com" }],
    });
    expect(range).toMatchObject({ portEnd: 20199, originPortMode: "same", origins: [{ port: 0 }] });
    const { app: tls } = await admin.l4Apps.create({
      clusterId,
      name: "tls",
      protocol: "tcp",
      port: 20300,
      certificateId,
      tlsMinimumVersion: "1.3",
      origins: [{ address: "tls.example.com", port: 7000 }],
    });
    expect(tls).toMatchObject({ certificateId, certificateName: "g9", tlsMinimumVersion: "1.3" });
    const compiled = await config();
    expect(compiled.l4Apps.find((a) => a.id === range.id)).toMatchObject({
      port: 20100,
      portEnd: 20199,
      origins: [{ port: 0 }],
    });
    expect(compiled.l4Apps.find((a) => a.id === tls.id)).toMatchObject({
      certificateId,
      tlsMinimumVersion: "1.3",
    });
    expect(compiled.certificates.map((c) => c.id)).toContain(certificateId);
    expect(compiled.requiredFeatures).toContain("l4-v2");
    // Ranges overlap like ports; they must sit inside the pools and stay below the limits.
    for (const [input, code] of [
      [{ port: 20150 }, "L4_PORT_IN_USE"],
      [{ port: 20050, portEnd: 20100 }, "L4_PORT_IN_USE"],
      [{ port: 20900, portEnd: 21100 }, "L4_PORT_OUTSIDE_POOL"],
      [{ port: 20400, portEnd: 20400 }, "L4_PORT_RANGE_INVALID"],
      [{ port: 20400, portEnd: 20399 }, "L4_PORT_RANGE_INVALID"],
      [{ port: 20000, portEnd: 21000 }, "L4_PORT_RANGE_INVALID"],
    ] as const)
      expect(
        (
          await rpcError(
            admin.l4Apps.create({
              clusterId,
              name: "x",
              protocol: "tcp",
              origins: [{ address: "a.test", port: 1 }],
              ...input,
            }),
          )
        ).code,
        JSON.stringify(input),
      ).toBe(code);
    expect(
      (
        await rpcError(
          admin.l4Apps.create({
            clusterId,
            name: "x",
            protocol: "tcp",
            port: 20500,
            origins: [{ address: "a.test" }],
          }),
        )
      ).code,
    ).toBe("L4_ORIGIN_PORT_REQUIRED");
    await admin.clusters.setPortPools({
      clusterId,
      pools: [{ protocol: "both", from: 20000, to: 21000 }],
    });
    expect(
      (
        await rpcError(
          admin.l4Apps.create({
            clusterId,
            name: "x",
            protocol: "udp",
            port: 20600,
            certificateId,
            origins: [{ address: "a.test", port: 1 }],
          }),
        )
      ).code,
    ).toBe("L4_TLS_UNSUPPORTED");
    expect(
      (
        await rpcError(
          admin.l4Apps.create({
            clusterId,
            name: "x",
            protocol: "tcp",
            port: 20600,
            certificateId: missing,
            origins: [{ address: "a.test", port: 1 }],
          }),
        )
      ).code,
    ).toBe("CERTIFICATE_NOT_FOUND");
    // Changing the mode back needs ports again.
    expect(
      (await rpcError(admin.l4Apps.update({ id: range.id, originPortMode: "fixed" }))).code,
    ).toBe("L4_ORIGIN_PORT_REQUIRED");
    const fixed = await admin.l4Apps.update({
      id: range.id,
      originPortMode: "fixed",
      origins: [{ address: "range.example.com", port: 7100 }],
    });
    expect(fixed.app.origins[0]?.port).toBe(7100);
    // The certificate stays while an application terminates TLS with it.
    await admin.sites.update({ id: siteId, ports: { http: [80, 8081], https: [443] } });
    await admin.https.update({ id: siteId, settings: { certificateId: null } });
    expect(await rpcError(admin.certificates.delete({ id: certificateId }))).toMatchObject({
      code: "CERTIFICATE_IN_USE_BY_L4",
      data: { apps: "tls" },
    });
    await admin.l4Apps.delete({ id: tls.id });
    await admin.l4Apps.delete({ id: range.id });
  });

  it("caps the ports of a cluster's layer-4 applications", async () => {
    await admin.clusters.setPortPools({
      clusterId,
      pools: [{ protocol: "both", from: 30000, to: 33000 }],
    });
    await admin.l4Apps.create({
      clusterId,
      name: "r1",
      protocol: "udp",
      port: 30000,
      portEnd: 30999,
      origins: [{ address: "a.test", port: 1 }],
    });
    await admin.l4Apps.create({
      clusterId,
      name: "r2",
      protocol: "tcp",
      port: 30000,
      portEnd: 30999,
      origins: [{ address: "a.test", port: 1 }],
    });
    expect(
      await rpcError(
        admin.l4Apps.create({
          clusterId,
          name: "r3",
          protocol: "tcp",
          port: 31000,
          portEnd: 31048,
          origins: [{ address: "a.test", port: 1 }],
        }),
      ),
    ).toMatchObject({ code: "L4_PORT_LIMIT", data: { limit: 2048 } });
    await admin.l4Apps.create({
      clusterId,
      name: "r3",
      protocol: "tcp",
      port: 31000,
      portEnd: 31047,
      origins: [{ address: "a.test", port: 1 }],
    });
    for (const app of await admin.l4Apps.list({ clusterId }))
      await admin.l4Apps.delete({ id: app.id });
  });

  it("reports nodes without the capabilities; rollback keeps the current ports and setting", async () => {
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1"] })
      .where(eq(schema.node.id, nodeId));
    expect((await admin.clusters.listenPorts({ clusterId })).nodesWithout).toEqual([
      { id: nodeId, name: "edge-g9" },
    ]);
    expect((await admin.clusters.clientIp({ clusterId })).nodesWithout).toEqual([
      { id: nodeId, name: "edge-g9" },
    ]);
    expect((await admin.clusters.portPools({ clusterId })).nodesWithoutL4V2).toEqual([
      { id: nodeId, name: "edge-g9" },
    ]);
    const features = await admin.sites.features({ id: siteId });
    expect([features.edgePorts.available, features.clientIp.available]).toEqual([false, false]);
    await admin.clusters.setClientIp({
      clusterId,
      settings: { mode: "header", trustedCidrs: ["10.0.0.0/8"], header: "x-real-ip" },
    });
    await admin.clusters.setListenPorts({
      clusterId,
      httpPorts: [8081, 8082],
      httpsPorts: [8443, 9443],
    });
    // Roll back to a revision without the setting and with fewer ports.
    await admin.clusters.rollback({ id: clusterId, revision: beforeL4 });
    const compiled = await config();
    expect(compiled.clientAddress?.header).toBe("x-real-ip");
    // The revision had the site's certificate: its current HTTPS port 443 serves again.
    expect(compiled.listeners.map((l) => l.port)).toEqual([80, 443, 8081, 8082, 8443, 9443]);
    expect(compiled.sites.find((s) => s.id === siteId)?.ports).toEqual([80, 443, 8081]);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["edge-ports-v1", "client-ip-v1", "l4-v1", "l4-v2", "tls-v1"] })
      .where(eq(schema.node.id, nodeId));
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const reads: [string, string][] = [
      ["GET", `/clusters/${clusterId}/listen-ports`],
      ["GET", `/clusters/${clusterId}/client-ip`],
    ];
    const writes: [string, string, unknown][] = [
      ["PUT", `/clusters/${clusterId}/listen-ports`, { httpPorts: [], httpsPorts: [] }],
      ["PUT", `/clusters/${clusterId}/client-ip`, { settings: { mode: "proxy_protocol" } }],
    ];
    for (const [method, path] of reads) {
      expect((await api(reader, method, path)).status, `${method} ${path}`).toBe(200);
      const refused = await api(key, method, path);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect(readOnly.status, `${method} ${path}`).toBe(403);
      expect(readOnly.json.code, `${method} ${path}`).toBe("ACCESS_KEY_READ_ONLY");
      const refused = await api(key, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
    // Nothing changed; a write key reaches them.
    expect((await admin.clusters.clientIp({ clusterId })).settings.mode).toBe("header");
    const written = await api(writer, "PUT", `/clusters/${clusterId}/client-ip`, {
      settings: { mode: "direct" },
    });
    expect(written.status).toBe(200);
    expect((await api(writer, "GET", `/clusters/${missing}/listen-ports`)).json.code).toBe(
      "CLUSTER_NOT_FOUND",
    );
    // Site ports change through sites.update, which service accounts cannot call.
    const ports = await api(key, "PATCH", `/sites/${siteId}`, {
      ports: { http: [80], https: [443] },
    });
    expect([ports.status, ports.json.code]).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    const readOnlyPorts = await api(reader, "PATCH", `/sites/${siteId}`, {
      ports: { http: [80], https: [443] },
    });
    expect([readOnlyPorts.status, readOnlyPorts.json.code]).toEqual([403, "ACCESS_KEY_READ_ONLY"]);
  });
});
