import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { checkNodeChannel } from "../../src/server/services/node-channel-check";
import { nodeChannelNames } from "../../src/server/services/node-channel-url";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("node channel URL in system settings", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let channel: NodeChannel;
  let port: number;

  /** The certificate a node connecting with `servername` receives, verified like a node. */
  const presented = (servername: string) =>
    new Promise<PeerCertificate>((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername,
        ca: ctx.nodeCa.certificatePem,
      });
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        resolve(socket.getPeerCertificate());
        socket.end();
      });
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    port = address.port;
  });
  afterAll(async () => {
    await channel.close();
    await client.close();
  });

  it("falls back to EDGEWEIR_NODE_API_URL, then to the console's host", async () => {
    expect(await admin.settings.nodeChannel()).toEqual({
      url: "",
      effectiveUrl: "https://localhost:8443",
      source: "environment",
    });
    const env = ctx.env.EDGEWEIR_NODE_API_URL;
    ctx.env.EDGEWEIR_NODE_API_URL = undefined;
    try {
      expect((await admin.settings.nodeChannel()).source).toBe("default");
    } finally {
      ctx.env.EDGEWEIR_NODE_API_URL = env;
    }
  });

  it("refuses anything but https://host[:port] and keeps the URL in effect", async () => {
    for (const url of [
      "http://nodes.example.test:8443",
      "https://nodes.example.test:8443/channel",
      "https://nodes.example.test:8443/?x=1",
      "https://user:secret@nodes.example.test:8443",
      "https://nodes.example.test:8443#x",
      "nodes.example.test:8443",
      "https://",
    ]) {
      expect((await rpcError(admin.settings.setNodeChannel({ url }))).status, url).toBe(400);
    }
    expect((await admin.settings.nodeChannel()).source).toBe("environment");
  });

  it("gives new install commands the saved URL and the certificate its name at once", async () => {
    const saved = await admin.settings.setNodeChannel({ url: " https://Nodes.Example.test:9443/" });
    expect(saved).toEqual({
      url: "https://nodes.example.test:9443",
      effectiveUrl: "https://nodes.example.test:9443",
      source: "setting",
    });
    expect((await admin.settings.get()).nodeApiUrl).toBe("https://nodes.example.test:9443");
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-1" });
    expect(token.serverUrl).toBe("https://nodes.example.test:9443");
    expect(token.installCommand).toContain("--server https://nodes.example.test:9443");
    expect(token.warnings).not.toContain("node_api_url_local");
    const regionId = (await admin.regions.create({ name: "East", code: "east" })).id;
    const probe = await admin.probes.createToken({ name: "probe-1", regionId });
    expect(probe.serverUrl).toBe("https://nodes.example.test:9443");
    expect((await checkNodeChannel(ctx)).url).toBe("https://nodes.example.test:9443");

    // Without a restart: the next handshake for the new name verifies.
    await vi.waitFor(() => expect(channel.certificate.names).toContain("nodes.example.test"));
    const certificate = await presented("nodes.example.test");
    expect(certificate.subjectaltname).toContain("DNS:nodes.example.test");
    expect(checkServerIdentity("nodes.example.test", certificate)).toBeUndefined();
    // Nodes enrolled with the URL of the environment keep verifying it.
    expect(certificate.subjectaltname).toContain("DNS:localhost");
  });

  it("keeps the names of earlier URLs for the nodes enrolled with them", async () => {
    await admin.settings.setNodeChannel({ url: "https://[2001:db8::7]:8443" });
    await vi.waitFor(() => expect(channel.certificate.names).toContain("2001:db8::7"));
    const certificate = await presented("nodes.example.test");
    expect(checkServerIdentity("2001:db8::7", certificate)).toBeUndefined();
    expect(checkServerIdentity("nodes.example.test", certificate)).toBeUndefined();

    // Clearing it: the environment applies again, the saved names stay.
    expect(await admin.settings.setNodeChannel({ url: "" })).toEqual({
      url: "",
      effectiveUrl: "https://localhost:8443",
      source: "environment",
    });
    const names = await nodeChannelNames(ctx);
    expect(names).toEqual(expect.arrayContaining(["nodes.example.test", "2001:db8::7"]));
    expect(new Set(names).size).toBe(names.length);
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-2" });
    expect(token.installCommand).toContain("--server https://localhost:8443");
  });

  it("checks a saved URL under the outbound policy, the environment's as it is", async () => {
    // Long after any cached result.
    let clock = Date.now() + 3_600_000;
    const later = () => (clock += 60_000);
    // EDGEWEIR_NODE_API_URL names the operator's own loopback channel: checked as before.
    ctx.env.EDGEWEIR_NODE_API_URL = `https://127.0.0.1:${port}`;
    ctx.env.nodeApiUrl = `https://127.0.0.1:${port}`;
    try {
      expect(await checkNodeChannel(ctx, later)).toMatchObject({ result: "ok" });
      // Saved from a web session, the same loopback address is refused without connecting...
      await admin.settings.setNodeChannel({ url: `https://localhost:${port}` });
      expect(await checkNodeChannel(ctx, later)).toMatchObject({
        url: `https://localhost:${port}`,
        result: "refused",
      });
      // ...unless the operator allows the range.
      ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "127.0.0.0/8,::1/128";
      expect(await checkNodeChannel(ctx, later)).toMatchObject({ result: "ok" });
    } finally {
      ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "";
      ctx.env.EDGEWEIR_NODE_API_URL = "https://localhost:8443";
      ctx.env.nodeApiUrl = "https://localhost:8443";
      await admin.settings.setNodeChannel({ url: "" });
    }
  });

  it("audits every change from the saved URL to the next one", async () => {
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.node_channel_update"));
    expect(audits.map((a) => a.metadata).slice(0, 3)).toEqual([
      { before: "", after: "https://nodes.example.test:9443" },
      { before: "https://nodes.example.test:9443", after: "https://[2001:db8::7]:8443" },
      { before: "https://[2001:db8::7]:8443", after: "" },
    ]);
    expect(audits.every((a) => a.targetId === "node_channel_url")).toBe(true);
  });
});
