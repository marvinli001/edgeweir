import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer } from "node:tls";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { postNotification } from "../../src/server/lib/outbound";
import {
  sweepAlerts,
  unsubscribeAlerts,
  updateAlertSubscription,
} from "../../src/server/services/alerts";
import { deliverNotification } from "../../src/server/services/notification-delivery";
import {
  type ApiClient,
  createTestContext,
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
  let admin: ApiClient, siteId: string, otherSiteId: string, channelId: string, nodeId: string;
  const received = () => deliveries.filter((d) => d.kind !== "test");
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const cluster = (await admin.clusters.list())[0];
    if (!cluster) throw new Error("cluster missing");
    siteId = (
      await admin.sites.create({
        name: "Alerted site",
        domains: ["alert-customer.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    // A site of the same cluster that no channel is subscribed to.
    otherSiteId = (
      await admin.sites.create({
        name: "Unsubscribed site",
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
  it("encrypts channel credentials and never returns them", async () => {
    const channel = await admin.alerts.createChannel({
      name: "Site webhook",
      config: { kind: "webhook", url: endpoint, bearer: "private-test-bearer" },
    });
    channelId = channel.id;
    expect(channel.platform).toBe(false);
    const stored = (await ctx.db.select().from(schema.alertChannel))[0];
    expect(stored?.configEnvelope).not.toContain("private-test-bearer");
    expect(JSON.stringify(await admin.alerts.channels())).not.toContain(endpoint);
    expect((await admin.alerts.channels()).map((c) => c.id)).toEqual([channelId]);
    await admin.alerts.testChannel({ id: channelId });
    expect(deliveries[0]?.kind).toBe("test");
    await admin.alerts.updateChannel({ id: channelId, name: "Updated webhook" });
    expect((await admin.alerts.channels())[0]?.name).toBe("Updated webhook");
  });
  it("notifies a channel once per transition of the sites subscribed to it", async () => {
    const sub = await admin.alerts.subscribe({
      channelId,
      kinds: ["node_offline"],
      siteIds: [siteId],
    });
    expect(await admin.alerts.subscriptions()).toEqual([
      {
        id: sub.id,
        channelId,
        channelName: "Updated webhook",
        kinds: ["node_offline"],
        enabled: true,
        allSites: false,
        sites: [{ id: siteId, name: "Alerted site" }],
      },
    ]);
    // Subscriptions belong to the account that made them.
    await expect(
      unsubscribeAlerts(ctx, sub.id, {
        actor: { type: "user", id: "someone-else", name: "Someone else" },
        userId: "someone-else",
      }),
    ).rejects.toMatchObject({ code: "ALERT_SUBSCRIPTION_NOT_FOUND" });
    await admin.alerts.setPolicy({ nodeOfflineSeconds: 45 });
    expect((await admin.alerts.policy()).nodeOfflineSeconds).toBe(45);
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(1);
    // One alert for the node, through the subscription of a site in its cluster.
    expect(received()[0]).toMatchObject({
      siteId: null,
      siteName: "offline",
      resourceId: nodeId,
      kind: "node_offline",
      status: "firing",
    });
    expect((await admin.alerts.events({ siteId })).map((e) => [e.kind, e.status])).toEqual([
      ["node_offline", "firing"],
    ]);
    expect(JSON.stringify(received())).not.toContain("Unsubscribed site");
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    expect(received()).toHaveLength(2);
    expect(received()[1]?.status).toBe("resolved");
  });
  it("removes a subscription", async () => {
    const [sub] = await admin.alerts.subscriptions();
    if (!sub) throw new Error("subscription missing");
    await admin.alerts.unsubscribe({ id: sub.id });
    expect(await admin.alerts.subscriptions()).toEqual([]);
  });
  it("sends a platform channel one node_offline per node, whatever the sites it serves", async () => {
    const platform = await admin.alerts.createChannel({
      name: "Everything",
      platform: true,
      config: { kind: "webhook", url: endpoint },
    });
    const before = received().length;
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    await sweepAlerts(ctx);
    // Two sites in the node's cluster, one notification.
    expect(received().slice(before)).toMatchObject([
      { kind: "node_offline", status: "firing", resourceId: nodeId, siteId: null },
    ]);
    await ctx.db.delete(schema.node).where(eq(schema.node.id, nodeId));
    await sweepAlerts(ctx);
    // A deleted node's alert ends without a recovery notice.
    expect(received().slice(before)).toHaveLength(1);
    await admin.alerts.deleteChannel({ id: platform.id });
  });
  it("covers a set of sites or all sites with one subscription per channel", async () => {
    const third = (
      await admin.sites.create({
        name: "Third site",
        domains: ["third-alert.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: (await admin.clusters.list())[0]?.id ?? "",
        name: "all-sites node",
        enrolledAt: new Date(Date.now() - 86400000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    // A site set or all sites, exactly one of them; every site must exist.
    for (const input of [
      { channelId, kinds: ["high_5xx" as const], siteIds: [] },
      { channelId, kinds: ["high_5xx" as const], allSites: true, siteIds: [siteId] },
    ])
      expect((await rpcError(admin.alerts.subscribe(input))).code).toBe("BAD_REQUEST");
    expect(
      (
        await rpcError(
          admin.alerts.subscribe({
            channelId,
            kinds: ["high_5xx"],
            siteIds: [siteId, crypto.randomUUID()],
          }),
        )
      ).code,
    ).toBe("SITE_NOT_FOUND");
    expect(await admin.alerts.subscriptions()).toEqual([]);
    const first = await admin.alerts.subscribe({
      channelId,
      kinds: ["node_offline"],
      siteIds: [third],
    });
    // Subscribing the channel again replaces its subscription.
    const sub = await admin.alerts.subscribe({
      channelId,
      kinds: ["high_5xx", "high_5xx"],
      siteIds: [third, siteId, third],
    });
    expect(sub).toMatchObject({
      id: first.id,
      kinds: ["high_5xx"],
      allSites: false,
      sites: [
        { id: siteId, name: "Alerted site" },
        { id: third, name: "Third site" },
      ],
    });
    expect(await admin.alerts.subscriptions()).toHaveLength(1);
    await expect(
      updateAlertSubscription(
        ctx,
        { id: sub.id, kinds: ["high_5xx"], allSites: true, siteIds: [], enabled: true },
        {
          actor: { type: "user", id: "someone-else", name: "Someone else" },
          userId: "someone-else",
        },
      ),
    ).rejects.toMatchObject({ code: "ALERT_SUBSCRIPTION_NOT_FOUND" });
    // Every site's 5xx ratio is high: only the sites in the set notify.
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await ctx.db.insert(schema.nodeMinuteStats).values(
      [siteId, otherSiteId, third].map((site) => ({
        minute,
        nodeId: node.id,
        siteId: site,
        requests: 200,
        statusCodes: { "500": 100, "200": 100 },
      })),
    );
    const before = received().length;
    const fivexx = () =>
      received()
        .slice(before)
        .filter((d) => d.kind === "high_5xx")
        .map((d) => `${d.siteName} ${d.status}`)
        .sort();
    await sweepAlerts(ctx);
    expect(fivexx()).toEqual(["Alerted site firing", "Third site firing"]);
    // All sites, present and future: the firing alert of the third site is sent next.
    const all = await admin.alerts.updateSubscription({
      id: sub.id,
      kinds: ["high_5xx", "node_offline"],
      allSites: true,
    });
    expect(all).toMatchObject({ allSites: true, sites: [], kinds: ["high_5xx", "node_offline"] });
    await sweepAlerts(ctx);
    expect(fivexx()).toEqual([
      "Alerted site firing",
      "Third site firing",
      "Unsubscribed site firing",
    ]);
    // A paused subscription sends nothing.
    await admin.alerts.updateSubscription({
      id: sub.id,
      kinds: ["high_5xx"],
      allSites: true,
      enabled: false,
    });
    await ctx.db.delete(schema.nodeMinuteStats);
    await sweepAlerts(ctx);
    expect(fivexx()).toHaveLength(3);
    // node_offline of a node serving any site reaches an all-sites subscription.
    await admin.alerts.updateSubscription({ id: sub.id, kinds: ["node_offline"], allSites: true });
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, node.id));
    await sweepAlerts(ctx);
    expect(
      received()
        .slice(before)
        .filter((d) => d.kind === "node_offline"),
    ).toMatchObject([{ resourceId: node.id, siteName: "all-sites node", status: "firing" }]);
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node.id));
    await sweepAlerts(ctx);
    await admin.alerts.unsubscribe({ id: sub.id });
  });
  it("drops a deleted site out of subscriptions and removes those left without sites", async () => {
    const doomed = (
      await admin.sites.create({
        name: "Doomed site",
        domains: ["doomed-alert.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const second = await admin.alerts.createChannel({
      name: "Second webhook",
      config: { kind: "webhook", url: endpoint },
    });
    const kept = await admin.alerts.subscribe({
      channelId,
      kinds: ["high_5xx"],
      siteIds: [siteId, doomed],
    });
    const only = await admin.alerts.subscribe({
      channelId: second.id,
      kinds: ["high_5xx"],
      siteIds: [doomed],
    });
    await admin.sites.delete({ id: doomed });
    const left = await admin.alerts.subscriptions();
    expect(left.map((s) => [s.id, s.sites.map((site) => site.name)])).toEqual([
      [kept.id, ["Alerted site"]],
    ]);
    expect(left.some((s) => s.id === only.id)).toBe(false);
    await admin.alerts.unsubscribe({ id: kept.id });
    await admin.alerts.deleteChannel({ id: second.id });
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
