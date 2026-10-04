import { createHash } from "node:crypto";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { connect, type DetailedPeerCertificate, type TLSSocket } from "node:tls";
import {
  NODE_CHANNEL_WEBSOCKET_PATH,
  NODE_CHANNEL_WEBSOCKET_PROTOCOL,
  type NodeChannelCheck,
} from "@edgeweir/contract";
import WebSocket, { createWebSocketStream } from "ws";
import type { AppContext } from "../lib/context";
import { OutboundRefusedError, outboundAddress, withinDeadline } from "../lib/outbound";
import { getNodeChannel } from "./node-channel-url";

/** One handshake: the check is advisory and must not hold up a page. */
export const NODE_CHANNEL_CHECK_TIMEOUT_MS = 3000;
/** Pages and dialogs ask again; a result is reused for this long. */
const CACHE_MS = 30_000;

/** SHA-256 of each certificate the server presented (DER, lowercase hex), leaf first. */
function presentedFingerprints(leaf: DetailedPeerCertificate): string[] {
  const out: string[] = [];
  const seen = new Set<DetailedPeerCertificate>();
  for (
    let cert: DetailedPeerCertificate | undefined = leaf;
    cert?.raw && !seen.has(cert);
    cert = cert.issuerCertificate
  ) {
    seen.add(cert);
    out.push(createHash("sha256").update(cert.raw).digest("hex"));
  }
  return out;
}

/**
 * Connects to the node channel URL the way a node does (a TLS handshake, no
 * client certificate, no request) and tells whether it presents the
 * console's node CA: "ok"; "unreachable" when no handshake completes within
 * the deadline; "mismatch" when another certificate chain answers, i.e.
 * something in front of the console terminates TLS. Advisory: the console
 * reaching its own address does not prove that nodes on other networks do.
 */
export function checkNodeChannelUrl(
  url: string,
  caSha256: string,
  timeoutMs = NODE_CHANNEL_CHECK_TIMEOUT_MS,
  /** The address to connect to, resolved already (the URL's host otherwise). */
  address?: string,
): Promise<NodeChannelCheck["result"]> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve("unreachable");
  }
  if (target.protocol === "wss:" || target.protocol === "ws:")
    return checkWebSocketEntry(target, caSha256, timeoutMs, address);
  if (target.protocol !== "https:") return Promise.resolve("mismatch");
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || 443);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: NodeChannelCheck["result"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = connect({
      host: address ?? host,
      port,
      // SNI carries names only.
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      ALPNProtocols: ["h2", "http/1.1"],
    });
    const timer = setTimeout(() => finish("unreachable"), timeoutMs);
    socket.once("secureConnect", () => {
      const presented = presentedFingerprints(socket.getPeerCertificate(true));
      finish(presented.includes(caSha256.toLowerCase()) ? "ok" : "mismatch");
    });
    socket.once("error", () => finish("unreachable"));
  });
}

/** Resolves every name to `address` (already resolved and allowed). */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * The same check through the WebSocket entry of a wss:// or ws:// URL: the
 * WebSocket handshake at NODE_CHANNEL_WEBSOCKET_PATH (a wss:// URL's own TLS
 * is verified as usual), then the node channel's TLS handshake inside it.
 * An HTTP answer other than the upgrade means something else answers there
 * (or the entry is closed): mismatch.
 */
function checkWebSocketEntry(
  target: URL,
  caSha256: string,
  timeoutMs: number,
  address?: string,
): Promise<NodeChannelCheck["result"]> {
  const host = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    let settled = false;
    let tls: TLSSocket | undefined;
    const ws = new WebSocket(
      new URL(NODE_CHANNEL_WEBSOCKET_PATH, target),
      NODE_CHANNEL_WEBSOCKET_PROTOCOL,
      {
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        ...(address ? { lookup: pinnedLookup(address) } : {}),
      },
    );
    const finish = (result: NodeChannelCheck["result"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tls?.destroy();
      ws.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish("unreachable"), timeoutMs);
    ws.once("unexpected-response", () => finish("mismatch"));
    ws.once("error", () => finish("unreachable"));
    ws.once("open", () => {
      const socket = connect({
        socket: createWebSocketStream(ws),
        // SNI carries names only.
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        ALPNProtocols: ["h2", "http/1.1"],
      });
      tls = socket;
      socket.once("secureConnect", () => {
        const presented = presentedFingerprints(socket.getPeerCertificate(true));
        finish(presented.includes(caSha256.toLowerCase()) ? "ok" : "mismatch");
      });
      socket.once("error", () => finish("mismatch"));
    });
  });
}

/**
 * A URL saved in system settings came from a web session: like the other targets saved there,
 * it is resolved once and refused when special-purpose, and the handshake goes to that address.
 * EDGEWEIR_NODE_API_URL and the default are the operator's and are checked as they are.
 */
async function checkSavedUrl(app: AppContext, url: string): Promise<NodeChannelCheck["result"]> {
  let address: string;
  try {
    const signal = AbortSignal.timeout(NODE_CHANNEL_CHECK_TIMEOUT_MS);
    address = (await withinDeadline(outboundAddress(app, new URL(url).hostname), signal)).address;
  } catch (error) {
    return error instanceof OutboundRefusedError ? "refused" : "unreachable";
  }
  return checkNodeChannelUrl(url, app.nodeCa.fingerprintSha256, undefined, address);
}

let cached: { key: string; at: number; value: NodeChannelCheck } | undefined;

/** The console's check of its own node channel URL, reused for 30 seconds. */
export async function checkNodeChannel(
  app: AppContext,
  now = () => Date.now(),
): Promise<NodeChannelCheck> {
  const { effectiveUrl: url, source } = await getNodeChannel(app);
  const key = `${source} ${url}`;
  if (cached && cached.key === key && now() - cached.at < CACHE_MS) return cached.value;
  const result =
    source === "setting"
      ? await checkSavedUrl(app, url)
      : await checkNodeChannelUrl(url, app.nodeCa.fingerprintSha256);
  const value = { url, result, checkedAt: new Date(now()).toISOString() };
  cached = { key, at: now(), value };
  return value;
}
