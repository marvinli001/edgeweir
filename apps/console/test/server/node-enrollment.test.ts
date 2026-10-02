import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { warnConsoleUrls } from "../../src/server/bootstrap";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  normalizeRemoteAddress,
  recordRefusedCertificate,
} from "../../src/server/node-channel/service";
import { CertificateAuthority, generateCa, NODE_ORGANIZATION } from "../../src/server/pki/ca";
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
  // A CA whose key the tests hold, to issue a certificate that already expired.
  const caMaterial = await generateCa("Test CA");
  ctx.nodeCa = await CertificateAuthority.load(caMaterial);
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

  /** The node's mTLS client. */
  const mtls = (enrolled: { caCertificatePem: string; certificatePem: string }, keyPem: string) =>
    createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: {
          ca: enrolled.caCertificatePem,
          cert: enrolled.certificatePem,
          key: keyPem,
          servername: "localhost",
        },
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

  it("normalizes connection source addresses", () => {
    expect(normalizeRemoteAddress("::ffff:203.0.114.7")).toBe("203.0.114.7");
    expect(normalizeRemoteAddress("2001:DB8:0:0::1")).toBe("2001:db8::1");
    expect(normalizeRemoteAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeRemoteAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress(undefined)).toBeNull();
    expect(normalizeRemoteAddress("not-an-ip")).toBeNull();
  });

  it("records where a node connects from and flags nodes without a public address", async () => {
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-nat" });
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    // Behind NAT the host only has private addresses.
    const enrolled = await anonymous().enroll({
      token: token.token,
      csrPem,
      info: { ipAddresses: ["10.0.0.5", "fd00::5"], supportedFeatures: [] },
    });
    let node = await admin.nodes.get({ id: enrolled.nodeId });
    expect(node).toMatchObject({
      remoteAddress: "127.0.0.1",
      ipAddresses: ["10.0.0.5", "fd00::5"],
      schedulingAddresses: [],
      dnsIssue: "no_public_address",
    });

    // Every heartbeat records the address of its connection.
    await ctx.db
      .update(schema.node)
      .set({ remoteAddress: "198.51.100.1" })
      .where(eq(schema.node.id, enrolled.nodeId));
    await mtls(enrolled, keyPem).reportStatus({
      appliedRevision: 0n,
      state: ApplyState.APPLYING,
      info: { ipAddresses: ["10.0.0.5"], supportedFeatures: [] },
    });
    node = await admin.nodes.get({ id: enrolled.nodeId });
    expect(node.remoteAddress).toBe("127.0.0.1");
    expect(node.online).toBe(true);
    // The source address is only an offer: DNS still has nothing to answer with.
    expect(node.schedulingAddresses).toEqual([]);

    // A configured scheduling address (e.g. the NAT's public address) clears the issue.
    node = await admin.nodes.setAddresses({
      id: enrolled.nodeId,
      addresses: [{ address: "203.0.114.9", level: 0 }],
    });
    expect(node.dnsIssue).toBeNull();
    expect(node.schedulingAddresses.map((a) => a.address)).toEqual(["203.0.114.9"]);
  });

  it("names an expired client certificate and records it on its node", async () => {
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-old" });
    const { csrPem, keyPem, keys } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({ token: token.token, csrPem, info: {} });
    await mtls(enrolled, keyPem).reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING });

    // The node stayed offline past its certificate's lifetime: the CA's own
    // certificate for the node's key, valid until yesterday.
    const day = 24 * 3600 * 1000;
    const signingKey = await webcrypto.subtle.importKey(
      "pkcs8",
      caMaterial.privateKeyPkcs8Der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const expired = await x509.X509CertificateGenerator.create({
      serialNumber: "0badc0de01",
      subject: `CN=${enrolled.nodeId}, O=${NODE_ORGANIZATION}`,
      issuer: new x509.X509Certificate(caMaterial.certificatePem).subject,
      notBefore: new Date(Date.now() - 31 * day),
      notAfter: new Date(Date.now() - day),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: keys.publicKey as never,
      signingKey: signingKey as never,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
      ],
    });
    const fingerprint = createHash("sha256").update(Buffer.from(expired.rawData)).digest("hex");
    await ctx.db
      .update(schema.node)
      .set({ certSerial: expired.serialNumber, certFingerprint: fingerprint })
      .where(eq(schema.node.id, enrolled.nodeId));

    const refused = await mtls(
      { caCertificatePem: enrolled.caCertificatePem, certificatePem: expired.toString("pem") },
      keyPem,
    )
      .reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).code).toBe(Code.Unauthenticated);
    expect((refused as ConnectError).rawMessage).toBe(
      "client certificate has expired (CERT_HAS_EXPIRED); re-enroll with `edgeweir-node enroll --force`",
    );
    const node = await admin.nodes.get({ id: enrolled.nodeId });
    expect(node.authError).toBe("CERT_HAS_EXPIRED");

    // Without a certificate the message stays as it was.
    const anonymousError = await anonymous()
      .getConfig({})
      .catch((e: unknown) => e);
    expect((anonymousError as ConnectError).rawMessage).toBe(
      "client certificate required (mutual TLS); enroll first",
    );

    // Recorded once a minute at most, only for the node's own (current) certificate.
    const peer = {
      authorized: false,
      authorizationError: "CERT_HAS_EXPIRED",
      commonName: enrolled.nodeId,
      organization: NODE_ORGANIZATION,
      fingerprintSha256: fingerprint,
    };
    expect(await recordRefusedCertificate(ctx, peer)).toBe(false);
    const later = new Date(Date.now() + 61_000);
    expect(
      await recordRefusedCertificate(ctx, { ...peer, fingerprintSha256: "f".repeat(64) }, later),
    ).toBe(false);
    expect(await recordRefusedCertificate(ctx, { ...peer, organization: "Edgeweir Probe" })).toBe(
      false,
    );
    expect(await recordRefusedCertificate(ctx, peer, new Date(Date.now() + 2 * 61_000))).toBe(true);

    // A heartbeat that gets through clears it.
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(Date.now() + 3 * 61_000) })
      .where(eq(schema.node.id, enrolled.nodeId));
    expect((await admin.nodes.get({ id: enrolled.nodeId })).authError).toBeNull();
  });
});
