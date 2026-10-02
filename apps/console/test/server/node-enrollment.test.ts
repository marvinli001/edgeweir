import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { NodeService } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { warnConsoleUrls } from "../../src/server/bootstrap";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

async function nodeKeyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=edge-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem, keys };
}

describe("following an enrollment from the add-node dialog", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let channel: NodeChannel;
  let baseUrl: string;

  const anonymous = () =>
    createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });
  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("warns about URLs other networks cannot reach, without refusing", async () => {
    // The tests' node channel URL is https://localhost:8443; the console URL is a public name.
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-w" });
    expect(token.warnings).toEqual(["node_api_url_local"]);
    expect(token.installCommand).toContain("--server https://localhost:8443");

    const logged: string[] = [];
    const log = { warn: (msg: string) => void logged.push(msg) };
    expect(
      warnConsoleUrls(log, {
        EDGEWEIR_PUBLIC_URL: "http://localhost:3000",
        nodeApiUrl: "https://10.0.0.2:8443",
      }),
    ).toEqual(["console_url_local", "node_api_url_private"]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("EDGEWEIR_PUBLIC_URL");
    expect(logged[1]).toContain("EDGEWEIR_NODE_API_URL");
    logged.length = 0;
    warnConsoleUrls(log, {
      EDGEWEIR_PUBLIC_URL: "https://cdn-admin.example.com",
      nodeApiUrl: "https://cdn-admin.example.com:8443",
    });
    expect(logged).toEqual([]);
  });

  it("reports whether the token enrolled a node, and that node", async () => {
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-s" });
    const waiting = await admin.clusters.getEnrollmentToken({ id: token.tokenId });
    expect(waiting).toEqual({
      tokenId: token.tokenId,
      expiresAt: token.expiresAt,
      usedAt: null,
      node: null,
    });
    // The status never carries the token.
    expect(JSON.stringify(waiting)).not.toContain(token.token);

    const { csrPem } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({
      token: token.token,
      csrPem,
      info: { hostname: "edge-host", ipAddresses: ["203.0.114.7"], supportedFeatures: [] },
    });
    const used = await admin.clusters.getEnrollmentToken({ id: token.tokenId });
    expect(used.usedAt).not.toBeNull();
    expect(used.node).toMatchObject({
      id: enrolled.nodeId,
      name: "edge-s",
      clusterId,
      online: false,
      appliedRevision: 0,
      schedulingAddresses: [expect.objectContaining({ address: "203.0.114.7" })],
    });

    // A deleted node leaves the token used, without a node.
    await admin.nodes.delete({ id: enrolled.nodeId });
    const gone = await admin.clusters.getEnrollmentToken({ id: token.tokenId });
    expect(gone.usedAt).toBe(used.usedAt);
    expect(gone.node).toBeNull();

    const missing = await rpcError(
      admin.clusters.getEnrollmentToken({ id: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(missing).toMatchObject({ code: "ENROLLMENT_TOKEN_NOT_FOUND", status: 404 });
  });
});
