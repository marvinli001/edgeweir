import "reflect-metadata";
import { webcrypto } from "node:crypto";
import http, { type Server } from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { NodeService, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { afterAll, describe, expect, it } from "vitest";
import { closeHttp } from "../../src/server/bootstrap";
import { startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };

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

describe("shutdown", async () => {
  const { ctx, client: pglite } = await createTestContext();
  afterAll(() => pglite.close());

  it("ends the watch streams of connected nodes instead of waiting for them", async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    const channel = await startNodeChannel(ctx);
    const { port } = channel.server.address() as AddressInfo;
    const baseUrl = `https://localhost:${port}`;
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
    const enrolled = await createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    ).enroll({ token: token.token, csrPem });
    const mtls = createClient(
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
    const iterator = mtls.watchConfig({ knownRevision: 0n })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe(WatchEvent.REVISION);

    // A request that never finishes its body is cut once the grace period is over.
    const stuck = http2.connect(baseUrl, {
      ca: ctx.nodeCa.certificatePem,
      servername: "localhost",
    });
    stuck.on("error", () => {});
    const stream = stuck.request({
      ":method": "POST",
      ":path": "/edgeweir.node.v1.NodeService/Enroll",
      "content-type": "application/proto",
    });
    stream.on("error", () => {});
    stream.write(Buffer.alloc(1));
    await new Promise((resolve) => stuck.once("connect", resolve));
    const stuckClosed = new Promise((resolve) => stuck.once("close", resolve));

    const started = Date.now();
    const next = iterator.next();
    await channel.close(300);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
    // The watch stream ended normally: the node reconnects to the next process.
    expect((await next).done).toBe(true);
    await stuckClosed;
  });

  it("lets HTTP requests in flight finish, closes idle connections and cuts the rest", async () => {
    let slow: (() => void) | undefined;
    const server: Server = http.createServer((req, res) => {
      if (req.url === "/slow") {
        slow = () => res.end("done");
        return;
      }
      if (req.url === "/stuck") return;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true });
    const get = (path: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path, agent }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(body));
            res.on("error", reject);
          })
          .on("error", reject);
      });
    // An idle keep-alive connection.
    expect(await get("/")).toBe("ok");
    const inFlight = get("/slow");
    const cut = get("/stuck").catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const closed = closeHttp(server, 400);
    setTimeout(() => slow?.(), 100);
    expect(await inFlight).toBe("done");
    expect(await cut).toBeInstanceOf(Error);
    await closed;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2000);
    agent.destroy();
  });
});
