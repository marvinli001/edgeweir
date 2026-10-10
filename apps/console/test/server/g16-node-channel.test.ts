import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { schema } from "@edgeweir/db";
import { NodeService } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { queryLogs } from "../../src/server/services/access-logs";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { statsDimensions } from "../../src/server/services/stats-dimensions";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };
const MINUTE = 60_000;

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
  return { csrPem: csr.toString("pem"), keyPem };
}

describe("G16 over the node channel: statistics dimensions and log fields", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let siteId = "";
  let mtls: ReturnType<typeof createClient<typeof NodeService>>;
  const minute = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 2 * MINUTE);

  beforeAll(async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    const [site] = await ctx.db
      .insert(schema.site)
      .values({
        name: "g16",
        clusterId: cluster.id,
        cnamePrefix: "g16",
        logSampleRate: 0,
        logBlocked: true,
        logHeaders: ["x-trace-id"],
      })
      .returning();
    siteId = site?.id ?? "";
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const baseUrl = `https://localhost:${address.port}`;
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId: cluster.id, nodeName: "edge-1", ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const anonymous = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );
    const enrolled = await anonymous.enroll({ token: token.token, csrPem });
    mtls = createClient(
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
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("stores MinuteStats 14-24 as the node reports them", async () => {
    const response = await mtls.reportStatsV2({
      batchSequence: 1n,
      stats: [
        {
          minute: timestampFromDate(minute),
          siteId,
          requests: 9n,
          bytesSent: 900n,
          statusCodes: { 200: 6n, 403: 3n },
          countries: [
            { country: "FR", requests: 6n, bytesSent: 800n },
            { country: "", requests: 3n, bytesSent: 100n },
          ],
          asns: [{ asn: 3215, name: "Orange S.A.", requests: 6n }],
          referers: [{ value: "news.example", count: 2n }],
          browsers: { firefox: 5n, crawler: 1n, tool: 3n },
          operatingSystems: { linux: 5n, other: 4n },
          devices: { desktop: 5n, crawler: 1n, other: 3n },
          httpVersions: { "1.1": 3n, "2": 6n },
          tlsVersions: { "1.3": 6n, none: 3n },
          blockReasons: { ip_banned: 2n, challenge: 1n },
          challengesIssued: 1n,
          challengesPassed: 1n,
        },
      ],
    });
    expect(response.accepted).toBe(1);
    const dims = await statsDimensions(ctx.db, { siteId, range: "1h" });
    expect(dims).toMatchObject({
      countries: [
        { country: "FR", requests: 6, bytesSent: 800 },
        { country: "", requests: 3, bytesSent: 100 },
      ],
      asns: [{ asn: 3215, name: "Orange S.A.", requests: 6 }],
      referers: [{ host: "news.example", requests: 2 }],
      browsers: [
        { key: "firefox", requests: 5 },
        { key: "tool", requests: 3 },
        { key: "crawler", requests: 1 },
      ],
      oses: [
        { key: "linux", requests: 5 },
        { key: "other", requests: 4 },
      ],
      httpVersions: [
        { key: "2", requests: 6 },
        { key: "1.1", requests: 3 },
      ],
      tlsVersions: [
        { key: "1.3", requests: 6 },
        { key: "none", requests: 3 },
      ],
      blockReasons: [
        { key: "ip_banned", requests: 2 },
        { key: "challenge", requests: 1 },
      ],
      challenges: { issued: 1, passed: 1 },
    });
    const [name] = await ctx.db.select().from(schema.asnName).where(eq(schema.asnName.asn, 3215));
    expect(name?.name).toBe("Orange S.A.");
  });

  it("stores the new AccessLog fields of a blocked request on a site that logs blocked requests", async () => {
    const response = await mtls.reportLogs({
      batchSequence: 1n,
      logs: [
        {
          time: timestampFromDate(new Date()),
          siteId,
          clientIp: "198.51.100.9",
          method: "GET",
          host: "g16.test",
          path: "/admin",
          status: 403,
          bytesSent: 230n,
          durationMs: 1,
          sampleRate: 10000,
          requestId: "g16-channel",
          userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
          referer: "https://news.example/a",
          httpVersion: "3",
          scheme: "https",
          country: "FR",
          asn: 3215,
          asName: "Orange S.A.",
          requestBytes: 412n,
          contentType: "text/html",
          tlsVersion: "1.3",
          blockReason: "ip_banned",
          headers: { "x-trace-id": "t-1" },
          query: "a=1",
        },
      ],
    });
    expect(response.accepted).toBe(1);
    const { entries } = await queryLogs(ctx, {
      siteId,
      from: new Date(Date.now() - MINUTE).toISOString(),
      to: new Date(Date.now() + MINUTE).toISOString(),
      ip: "",
      path: "",
      limit: 10,
      blockReason: "ip_banned",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: "g16-channel",
      userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
      httpVersion: "3",
      country: "FR",
      asn: 3215,
      requestBytes: 412,
      blockReason: "ip_banned",
      headers: { "x-trace-id": "t-1" },
      // The site does not record query strings.
      query: "",
    });
  });
});
