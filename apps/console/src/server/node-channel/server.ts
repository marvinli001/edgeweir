import http2 from "node:http2";
import type { SecureContextOptions, TLSSocket } from "node:tls";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { NodeService, ProbeService } from "@edgeweir/proto";
import type { AppContext } from "../lib/context";
import { type IssuedServerCertificate, SERVER_CERT_LIFETIME_DAYS } from "../pki/ca";
import { nodeChannelNames, nodeChannelUrl } from "../services/node-channel-url";
import { createProbeService, type ProbeServiceOptions } from "./probe-service";
import {
  clientCertificateError,
  createNodeService,
  peerContextValues,
  peerKey,
  recordRefusedCertificate,
} from "./service";

/** Reissue the server certificate once less than a third of its lifetime remains. */
const RENEW_BEFORE_MS = (SERVER_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;
const ROTATION_CHECK_MS = 3600 * 1000;
/**
 * Largest request message after decompression (Connect allows 4 GiB). The
 * largest messages nodes send, 1000 access logs with paths of up to 2 KiB,
 * stay below a quarter of it.
 */
export const READ_MAX_BYTES = 16 << 20;
/** Enroll and EnrollProbe, the RPCs without a client certificate, carry a token, a CSR and host facts. */
export const ENROLL_READ_MAX_BYTES = 64 << 10;
/** Sessions without traffic are closed; watch streams send a keepalive every 15 s. */
const IDLE_TIMEOUT_MS = 120_000;
/** How long requests in flight get to finish when the channel closes. */
export const CLOSE_GRACE_MS = 3000;

export interface NodeChannelOptions {
  /** Clock for issuing and rotating the server certificate. */
  now?: () => Date;
  /** How often the remaining lifetime of the server certificate is checked. */
  rotationCheckMs?: number;
  /** How long a connection may stay without traffic. */
  idleTimeoutMs?: number;
  /** ProbeService hooks (tests). */
  probes?: ProbeServiceOptions;
}

/**
 * Runs before the body is read: without a client certificate only the
 * enrollments are served. A node's own certificate the TLS layer refused
 * (e.g. expired) is recorded on the node.
 */
function clientCertificateGate(app: AppContext) {
  return async (ctx: HandlerContext) => {
    const peer = ctx.values.get(peerKey);
    if (
      ctx.method === NodeService.method.enroll ||
      ctx.method === ProbeService.method.enrollProbe ||
      peer.authorized
    )
      return;
    await recordRefusedCertificate(app, peer);
    throw new ConnectError(clientCertificateError(peer), Code.Unauthenticated);
  };
}

export interface NodeChannel {
  server: http2.Http2SecureServer;
  /** The server certificate that new handshakes receive. */
  readonly certificate: { serialNumber: string; notAfter: Date; names: readonly string[] };
  /**
   * Stops certificate rotation and the listener, ends the watch streams and
   * closes every session; connections still open after `graceMs` are destroyed.
   */
  close(graceMs?: number): Promise<void>;
}

/** setSecureContext resets every option it is not given, so both paths use this. */
function secureContext(app: AppContext, cert: IssuedServerCertificate): SecureContextOptions {
  return {
    key: cert.privateKeyPem,
    cert: cert.certificatePem + app.nodeCa.certificatePem,
    ca: [app.nodeCa.certificatePem],
    minVersion: "TLSv1.2",
  };
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Starts the node channel: Connect-RPC over HTTPS on its own port. TLS is
 * terminated here with a server certificate issued by the internal CA for
 * the names of nodeChannelNames, reissued in-process before it expires and
 * when the node channel URL in system settings changes (on every instance,
 * through the event bus). Client certificates are requested but not
 * required at the TLS layer, so that Enroll can run with a token; every
 * other RPC checks the verified peer, before reading the request.
 */
export async function startNodeChannel(
  app: AppContext,
  options: NodeChannelOptions = {},
): Promise<NodeChannel> {
  const now = options.now ?? (() => new Date());
  const issue = async (names: string[]) => ({
    ...(await app.nodeCa.issueServerCertificate(names, now())),
    names,
  });
  /** The names to issue for; `fallback` while the database does not answer. */
  const names = (fallback: readonly string[]) =>
    nodeChannelNames(app).catch((error: unknown) => {
      app.log.warn("node channel certificate names unavailable", { error });
      return [...fallback];
    });
  let current = await issue(await names(app.env.nodeApiHostnames));
  const closing = new AbortController();
  const handler = connectNodeAdapter({
    routes: (router) => {
      const service = createNodeService(app, { closing: closing.signal });
      const probes = createProbeService(app, options.probes);
      // The adapter serves the last handler registered for a path.
      router
        .service(NodeService, service)
        .rpc(NodeService.method.enroll, service.enroll, { readMaxBytes: ENROLL_READ_MAX_BYTES })
        .service(ProbeService, probes)
        .rpc(ProbeService.method.enrollProbe, probes.enrollProbe, {
          readMaxBytes: ENROLL_READ_MAX_BYTES,
        });
    },
    contextValues: peerContextValues,
    readMaxBytes: READ_MAX_BYTES,
    requestGate: clientCertificateGate(app),
    // The node channel serves nothing but NodeService and ProbeService.
    fallback: (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    },
  });
  const server = http2.createSecureServer(
    {
      ...secureContext(app, current),
      requestCert: true,
      rejectUnauthorized: false,
      allowHTTP1: true,
    },
    handler,
  );
  server.on("sessionError", (error) => app.log.debug("node channel session error", { error }));
  server.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  // server.close() waits for every connection, and nodes keep theirs open.
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<TLSSocket>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("secureConnection", (socket: TLSSocket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.env.NODE_API_PORT, app.env.nodeApiHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  app.log.info("node channel listening", {
    port: typeof address === "object" && address ? address.port : app.env.NODE_API_PORT,
    url: await nodeChannelUrl(app).catch(() => app.env.nodeApiUrl),
    caSha256: app.nodeCa.fingerprintSha256,
    sans: current.names,
    certificateNotAfter: current.notAfter,
  });

  /**
   * Issues the certificate again when it expires soon or misses a name, one
   * check at a time. New handshakes get the new certificate; established
   * sessions keep theirs.
   */
  const reissueIfDue = async () => {
    // Rotation goes on with the names in use until the database answers.
    const wanted = await names(current.names);
    const renamed = !sameNames(wanted, current.names);
    if (!renamed && current.notAfter.getTime() - now().getTime() >= RENEW_BEFORE_MS) return;
    try {
      const next = await issue(wanted);
      server.setSecureContext(secureContext(app, next));
      app.log.info(
        renamed ? "node channel certificate names changed" : "node channel certificate rotated",
        {
          serialNumber: next.serialNumber,
          notAfter: next.notAfter,
          previousSerialNumber: current.serialNumber,
          ...(renamed ? { sans: wanted } : {}),
        },
      );
      current = next;
    } catch (error) {
      app.log.error("node channel certificate rotation failed", { error });
    }
  };
  let pending: Promise<void> = Promise.resolve();
  const check = () => {
    pending = pending.then(reissueIfDue);
    return pending;
  };
  const timer = setInterval(() => void check(), options.rotationCheckMs ?? ROTATION_CHECK_MS);
  timer.unref();
  // Saved on this instance or another one; after a reconnect, in case a notification was lost.
  const unsubscribe = [
    app.events.on("node-channel", () => void check()),
    app.events.on("reconnected", () => void check()),
  ];

  return {
    server,
    get certificate() {
      return {
        serialNumber: current.serialNumber,
        notAfter: current.notAfter,
        names: current.names,
      };
    },
    close: (graceMs = CLOSE_GRACE_MS) => {
      clearInterval(timer);
      for (const off of unsubscribe) off();
      closing.abort();
      return new Promise<void>((resolve) => {
        const deadline = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, graceMs);
        server.close(() => {
          clearTimeout(deadline);
          resolve();
        });
        // GOAWAY: no new streams; open ones (now ending) may finish.
        for (const session of sessions) session.close();
      });
    },
  };
}
