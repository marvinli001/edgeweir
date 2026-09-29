import http2 from "node:http2";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { SERVER_CERT_LIFETIME_DAYS } from "../../src/server/pki/ca";
import { createTestContext } from "./helpers";

const DAY = 24 * 3600 * 1000;

describe("node channel server certificate", async () => {
  const { ctx, client: pglite } = await createTestContext();
  // The console started 61 days ago: less than a third of 90 days is left.
  let offset = -61 * DAY;
  let channel: NodeChannel;
  let port: number;

  /** Handshakes like a node: verifies the chain against the internal CA and the name. */
  const handshake = () =>
    new Promise<{
      serial: string;
      validTo: Date;
      sans: string;
      alpn: tls.TLSSocket["alpnProtocol"];
    }>((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: ctx.nodeCa.certificatePem,
        ALPNProtocols: ["h2"],
      });
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate();
        resolve({
          serial: peer.serialNumber.toLowerCase(),
          validTo: new Date(peer.valid_to),
          sans: peer.subjectaltname ?? "",
          alpn: socket.alpnProtocol,
        });
        socket.end();
      });
    });

  const get = (session: http2.ClientHttp2Session) =>
    new Promise<number>((resolve, reject) => {
      const req = session.request({ ":path": "/" });
      req.once("response", (headers) => resolve(Number(headers[":status"])));
      req.once("error", reject);
      req.resume();
      req.end();
    });

  beforeAll(async () => {
    channel = await startNodeChannel(ctx, {
      now: () => new Date(Date.now() + offset),
      rotationCheckMs: 20,
    });
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("serves a fresh certificate to new handshakes before the old one expires", async () => {
    const first = await handshake();
    expect(first.serial).toBe(channel.certificate.serialNumber.toLowerCase());
    expect(first.validTo.getTime() - Date.now()).toBeLessThan(
      (SERVER_CERT_LIFETIME_DAYS * DAY) / 3,
    );
    expect(first.alpn).toBe("h2");
    const session = http2.connect(`https://localhost:${port}`, {
      ca: ctx.nodeCa.certificatePem,
    });
    expect(await get(session)).toBe(404);

    offset = 0;
    await vi.waitFor(() => expect(channel.certificate.serialNumber).not.toBe(first.serial), {
      timeout: 5000,
      interval: 20,
    });

    const second = await handshake();
    expect(second.serial).toBe(channel.certificate.serialNumber.toLowerCase());
    expect(second.serial).not.toBe(first.serial);
    expect(second.validTo.getTime() - first.validTo.getTime()).toBeGreaterThan(60 * DAY);
    expect(second.sans).toBe(first.sans);
    expect(second.sans).toContain("DNS:localhost");
    expect(second.alpn).toBe("h2");

    // The session opened before the rotation keeps working on its certificate.
    expect(await get(session)).toBe(404);
    const kept = (session.socket as tls.TLSSocket).getPeerCertificate();
    expect(kept.serialNumber.toLowerCase()).toBe(first.serial);
    session.close();

    // A fresh certificate is not rotated again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(channel.certificate.serialNumber).toBe(second.serial);
  });
});
