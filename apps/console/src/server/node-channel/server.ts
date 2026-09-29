import http2 from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { NodeService } from "@edgeweir/proto";
import type { AppContext } from "../lib/context";
import { createNodeService, peerContextValues } from "./service";

/**
 * Starts the node channel: Connect-RPC over HTTPS on its own port. TLS is
 * terminated here with a server certificate issued by the internal CA.
 * Client certificates are requested but not required at the TLS layer, so
 * that Enroll can run with a token; every other RPC checks the verified peer.
 */
export async function startNodeChannel(app: AppContext): Promise<http2.Http2SecureServer> {
  const serverCert = await app.nodeCa.issueServerCertificate(app.env.nodeApiHostnames);
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
      key: serverCert.privateKeyPem,
      cert: serverCert.certificatePem + app.nodeCa.certificatePem,
      ca: [app.nodeCa.certificatePem],
      requestCert: true,
      rejectUnauthorized: false,
      allowHTTP1: true,
      minVersion: "TLSv1.2",
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
  });
  return server;
}
