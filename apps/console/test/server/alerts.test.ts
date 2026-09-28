import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer } from "node:tls";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { postNotification } from "../../src/server/lib/outbound";
import { sweepAlerts } from "../../src/server/services/alerts";
import { deliverNotification } from "../../src/server/services/notification-delivery";
import {
  type ApiClient,
  approveSiteDomains,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("M5 notification delivery and subscription authorization", async () => {
  const deliveries: Record<string, unknown>[] = [];
  const sink = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    deliveries.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const address = sink.address();
  if (!address || typeof address === "string") throw new Error("sink not listening");
  const endpoint = `http://127.0.0.1:${address.port}/webhook`;
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient,
    tenant: ApiClient,
    other: ApiClient,
    siteId: string,
    otherSite: string,
    channelId: string,
    nodeId: string,
    orgId: string,
    tenantUser: string;
  const received = () => deliveries.filter((d) => d.kind !== "test");
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const cluster = (await admin.clusters.list())[0];
    if (!cluster) throw new Error("cluster missing");
    const org = await admin.organizations.create({
      name: "Alerts tenant",
      defaultClusterId: cluster.id,
    });
    orgId = org.id;
    const created = await admin.users.create({
      name: "Tenant",
      email: "tenant@alert.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenantUser = created.id;
    await admin.users.create({
      name: "Other",
      email: "other@alert.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tenant@alert.test"));
    other = rpcClient(app, origin, await signIn(app, origin, "other@alert.test"));
    siteId = (
      await tenant.sites.create({
        name: "Alert tenant",
        domains: ["alert-customer.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    await approveSiteDomains(admin, siteId);
    otherSite = (
      await admin.sites.create({
        name: "Private platform",
        domains: ["private-alert.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: cluster.id,
        name: "offline",
        enrolledAt: new Date(Date.now() - 86400000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await db.close();
  });
  it("encrypts channel credentials and requires explicit tenant visibility", async () => {
    const channel = await admin.alerts.createChannel({
      name: "Tenant webhook",
      availableToTenants: true,
      config: { kind: "webhook", url: endpoint, bearer: "private-test-bearer" },
    });
    channelId = channel.id;
    expect(channel.platform).toBe(false);
    const stored = (await ctx.db.select().from(schema.alertChannel))[0];
    expect(stored?.configEnvelope).not.toContain("private-test-bearer");
    expect(JSON.stringify(await admin.alerts.channels())).not.toContain(endpoint);
    expect((await tenant.alerts.availableChannels()).map((c) => c.id)).toEqual([channelId]);
    expect(
      (
        await rpcError(
          tenant.alerts.subscribe({ siteId: otherSite, channelId, kinds: ["node_offline"] }),
        )
      ).code,
    ).toBe("SITE_NOT_FOUND");
    await admin.alerts.testChannel({ id: channelId });
    expect(deliveries[0]?.kind).toBe("test");
    await admin.alerts.updateChannel({ id: channelId, name: "Updated webhook" });
    expect((await admin.alerts.channels())[0]?.name).toBe("Updated webhook");
  });
  it("notifies once per transition and exposes only the tenant's events", async () => {
    const sub = await tenant.alerts.subscribe({ siteId, channelId, kinds: ["node_offline"] });
    expect(await tenant.alerts.subscriptions()).toHaveLength(1);
    expect((await rpcError(other.alerts.unsubscribe({ id: sub.id }))).code).toBe(
      "ALERT_SUBSCRIPTION_NOT_FOUND",
    );
    await admin.alerts.setPolicy({ nodeOfflineSeconds: 45 });
    expect((await admin.alerts.policy()).nodeOfflineSeconds).toBe(45);
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(1);
    expect(received()[0]).toMatchObject({ siteId, kind: "node_offline", status: "firing" });
    expect(JSON.stringify(received())).not.toContain("Private platform");
    const events = await tenant.alerts.events({});
    expect(events.every((e) => e.siteId === siteId)).toBe(true);
    expect((await rpcError(tenant.alerts.events({ siteId: otherSite }))).code).toBe(
      "SITE_NOT_FOUND",
    );
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(2);
    expect(received()[1]?.status).toBe("resolved");
  });
  it("stops delivery after membership is removed even if the subscription still exists", async () => {
    await ctx.db
      .delete(schema.member)
      .where(and(eq(schema.member.userId, tenantUser), eq(schema.member.organizationId, orgId)));
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(2);
    await admin.organizations.addMember({
      organizationId: orgId,
      userId: tenantUser,
      role: "member",
    });
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(3);
    const [sub] = await tenant.alerts.subscriptions();
    if (!sub) throw new Error("subscription missing");
    await tenant.alerts.unsubscribe({ id: sub.id });
    expect(await tenant.alerts.subscriptions()).toEqual([]);
  });
  it("refuses private endpoints unless the operator explicitly allows them and never follows redirects", async () => {
    const allow = ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS;
    ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "";
    await expect(postNotification(ctx, endpoint, {})).rejects.toThrow("refused");
    ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = allow;
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { location: endpoint });
      res.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const bound = redirect.address();
    if (!bound || typeof bound === "string") throw new Error("redirect server missing");
    const before = deliveries.length;
    await expect(postNotification(ctx, `http://127.0.0.1:${bound.port}/`, {})).rejects.toThrow(
      "rejected",
    );
    expect(deliveries).toHaveLength(before);
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
  });
  it("delivers real SMTP over verified TLS and never returns the password", async () => {
    const folder = await mkdtemp(join(tmpdir(), "edgeweir-smtp-"));
    const ca = join(folder, "ca.pem");
    await writeFile(ca, ctx.nodeCa.certificatePem, { mode: 0o600 });
    ctx.env.EDGEWEIR_SMTP_CA_FILE = ca;
    const cert = await ctx.nodeCa.issueServerCertificate(["127.0.0.1"]);
    const messages: string[] = [];
    let authenticated = false;
    const smtp = tlsServer({ cert: cert.certificatePem, key: cert.privateKeyPem }, (socket) => {
      socket.setEncoding("utf8");
      socket.write("220 fixture ESMTP\r\n");
      let pending = "",
        inData = false,
        body: string[] = [];
      socket.on("data", (chunk) => {
        pending += chunk;
        for (;;) {
          const end = pending.indexOf("\r\n");
          if (end < 0) break;
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (inData) {
            if (line === ".") {
              messages.push(body.join("\r\n"));
              body = [];
              inData = false;
              socket.write("250 accepted\r\n");
            } else body.push(line);
            continue;
          }
          if (line.startsWith("EHLO"))
            socket.write("250-fixture\r\n250-AUTH PLAIN\r\n250 SIZE 65536\r\n");
          else if (line.startsWith("AUTH PLAIN ")) {
            const fields = Buffer.from(line.slice(11), "base64").toString().split("\0");
            authenticated = fields[1] === "fixture" && fields[2] === "smtp-test-secret";
            socket.write(authenticated ? "235 authenticated\r\n" : "535 denied\r\n");
          } else if (line === "DATA") {
            inData = true;
            socket.write("354 data\r\n");
          } else if (line === "QUIT") {
            socket.end("221 bye\r\n");
          } else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    const bound = smtp.address();
    if (!bound || typeof bound === "string") throw new Error("SMTP missing");
    try {
      await admin.alerts.setSmtp({
        host: "127.0.0.1",
        port: bound.port,
        secure: true,
        from: "alerts@example.test",
        username: "fixture",
        password: "smtp-test-secret",
      });
      expect(JSON.stringify(await admin.alerts.smtp())).not.toContain("smtp-test-secret");
      const row = await ctx.db
        .select()
        .from(schema.systemSetting)
        .where(eq(schema.systemSetting.key, "notification_smtp"));
      expect(JSON.stringify(row)).not.toContain("smtp-test-secret");
      expect(
        (
          await rpcError(
            admin.alerts.setSmtp({
              host: "other.example.test",
              port: 465,
              secure: true,
              from: "alerts@example.test",
              username: "fixture",
            }),
          )
        ).code,
      ).toBe("SMTP_PASSWORD_REQUIRED");
      const channel = await admin.alerts.createChannel({
        name: "SMTP fixture",
        config: { kind: "email", to: ["ops@example.test"] },
      });
      const [rawChannel] = await ctx.db
        .select()
        .from(schema.alertChannel)
        .where(eq(schema.alertChannel.id, channel.id));
      if (!rawChannel) throw new Error("channel missing");
      await deliverNotification(ctx, rawChannel, {
        id: crypto.randomUUID(),
        siteId: null,
        siteName: "SMTP test",
        kind: "test",
        status: "firing",
        occurredAt: new Date().toISOString(),
      });
      expect(authenticated).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Message-ID:");
      const notify = () =>
        deliverNotification(ctx, rawChannel, {
          id: crypto.randomUUID(),
          siteId: null,
          siteName: "SMTP test",
          kind: "test",
          status: "firing",
          occurredAt: new Date().toISOString(),
        });
      // The CA saved with the SMTP settings replaces the operator's file.
      ctx.env.EDGEWEIR_SMTP_CA_FILE = "";
      const destination = {
        host: "127.0.0.1",
        port: bound.port,
        secure: true,
        from: "alerts@example.test",
        username: "fixture",
      };
      await expect(notify()).rejects.toThrow();
      expect(
        (await rpcError(admin.alerts.setSmtp({ ...destination, ca: "not a certificate" }))).code,
      ).toBe("SMTP_CA_INVALID");
      expect(
        (await rpcError(admin.alerts.setSmtp({ ...destination, ca: ctx.nodeCa.certificatePem })))
          .code,
      ).toBe("SMTP_PASSWORD_REQUIRED");
      await admin.alerts.setSmtp({
        ...destination,
        password: "smtp-test-secret",
        ca: ctx.nodeCa.certificatePem,
      });
      expect(await admin.alerts.smtp()).toMatchObject({
        ca: ctx.nodeCa.certificatePem.trim(),
        caFile: false,
      });
      await notify();
      expect(messages).toHaveLength(2);
      await admin.alerts.deleteChannel({ id: channel.id });
    } finally {
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
      ctx.env.EDGEWEIR_SMTP_CA_FILE = "";
    }
  });
});
