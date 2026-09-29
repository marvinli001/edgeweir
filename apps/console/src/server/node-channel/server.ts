import http2 from "node:http2";
import type { SecureContextOptions } from "node:tls";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { NodeService } from "@edgeweir/proto";
import type { AppContext } from "../lib/context";
import { type IssuedServerCertificate, SERVER_CERT_LIFETIME_DAYS } from "../pki/ca";
import { createNodeService, peerContextValues } from "./service";

/** Reissue the server certificate once less than a third of its lifetime remains. */
const RENEW_BEFORE_MS = (SERVER_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;
const ROTATION_CHECK_MS = 3600 * 1000;

export interface NodeChannelOptions {
  /** Clock for issuing and rotating the server certificate. */
  now?: () => Date;
  /** How often the remaining lifetime of the server certificate is checked. */
  rotationCheckMs?: number;
}

export interface NodeChannel {
  server: http2.Http2SecureServer;
  /** The server certificate that new handshakes receive. */
  readonly certificate: { serialNumber: string; notAfter: Date };
  /** Stops certificate rotation and closes the listener. */
  close(): Promise<void>;
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

/**
 * Starts the node channel: Connect-RPC over HTTPS on its own port. TLS is
 * terminated here with a server certificate issued by the internal CA and
 * reissued in-process before it expires. Client certificates are requested
 * but not required at the TLS layer, so that Enroll can run with a token;
 * every other RPC checks the verified peer.
 */
export async function startNodeChannel(
  app: AppContext,
  options: NodeChannelOptions = {},
): Promise<NodeChannel> {
  const now = options.now ?? (() => new Date());
  const issue = () => app.nodeCa.issueServerCertificate(app.env.nodeApiHostnames, now());
  let current = await issue();
  const handler = connectNodeAdapter({
    routes: (router) => router.service(NodeService, createNodeService(app)),
    contextValues: peerContextValues,
    // The node channel serves nothing but NodeService.
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
    url: app.env.nodeApiUrl,
    caSha256: app.nodeCa.fingerprintSha256,
    sans: app.env.nodeApiHostnames,
    certificateNotAfter: current.notAfter,
  });

  let rotating = false;
  const rotateIfDue = async () => {
    if (rotating || current.notAfter.getTime() - now().getTime() >= RENEW_BEFORE_MS) return;
    rotating = true;
    try {
      const next = await issue();
      // New handshakes get the new certificate; established sessions keep theirs.
      server.setSecureContext(secureContext(app, next));
      app.log.info("node channel certificate rotated", {
        serialNumber: next.serialNumber,
        notAfter: next.notAfter,
        previousSerialNumber: current.serialNumber,
      });
      current = next;
    } catch (error) {
      app.log.error("node channel certificate rotation failed", { error });
    } finally {
      rotating = false;
    }
  };
  const timer = setInterval(() => void rotateIfDue(), options.rotationCheckMs ?? ROTATION_CHECK_MS);
  timer.unref();

  return {
    server,
    get certificate() {
      return { serialNumber: current.serialNumber, notAfter: current.notAfter };
    },
    close: () => {
      clearInterval(timer);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
