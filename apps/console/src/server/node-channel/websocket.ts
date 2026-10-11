import type { IncomingMessage, Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  formatIp,
  NODE_CHANNEL_WEBSOCKET_PATH,
  NODE_CHANNEL_WEBSOCKET_PROTOCOL,
  parseCidr,
} from "@edgeweir/contract";
import { createWebSocketStream, type WebSocket, WebSocketServer } from "ws";
import { resolveClientIp } from "../lib/client-ip";
import type { AppContext } from "../lib/context";
import { nodeChannelWebSocketOpen } from "../services/node-channel-url";
import type { NodeChannel } from "./server";

/**
 * Largest WebSocket message taken. Nodes send TLS records, at most 16 KiB of
 * payload each, one or a few per message.
 */
export const MAX_MESSAGE_BYTES = 64 << 10;

/**
 * Bounds of the entry. Upgrades are not authenticated (the node channel's
 * TLS inside is), so the bridges open at once, in all and from one client
 * address (an IPv6 client: its /64), are capped (503 beyond); the
 * per-address cap applies only with EDGEWEIR_TRUSTED_PROXIES (behind a
 * platform proxy without it every client has the proxy's address, and an
 * attacker would lock the nodes out); a bridge whose node channel
 * connection has not presented a verified client certificate within
 * authenticateMs is closed (without one, a connection can only enroll);
 * a bridge with no bytes either way for
 * idleMs is closed (nodes keep their streams busy every 15 seconds); whether
 * the entry is open is kept for openCacheMs and forgotten when the node
 * channel settings change.
 */
export interface WebSocketEntryLimits {
  bridges: number;
  bridgesPerClient: number;
  authenticateMs: number;
  idleMs: number;
  openCacheMs: number;
}
export const WEBSOCKET_ENTRY_LIMITS: WebSocketEntryLimits = {
  bridges: 1024,
  bridgesPerClient: 64,
  authenticateMs: 30_000,
  idleMs: 120_000,
  openCacheMs: 5_000,
};

/**
 * What the per-address cap counts a client as: an IPv4 address, or the /64
 * of an IPv6 one (a single host usually holds a whole /64).
 */
export function clientBucket(client: string): string {
  const prefix = parseCidr(`${client}/64`);
  return prefix?.version === 6 ? `${formatIp(prefix)}/64` : client;
}

/**
 * An upgrade to the node channel's WebSocket entry: GET with
 * `Upgrade: websocket` on NODE_CHANNEL_WEBSOCKET_PATH exactly. Other upgrade
 * requests are none of the entry's business.
 */
export function isNodeChannelUpgrade(req: IncomingMessage): boolean {
  return (
    req.method === "GET" &&
    /(?:^|,)\s*websocket\s*(?:,|$)/i.test(req.headers.upgrade ?? "") &&
    req.url === NODE_CHANNEL_WEBSOCKET_PATH
  );
}

const requestsProtocol = (req: IncomingMessage) =>
  (req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .some((protocol) => protocol.trim() === NODE_CHANNEL_WEBSOCKET_PROTOCOL);

/**
 * Loopback connections opened for WebSocket clients, by "local address|local
 * port": the client IP and whether the node channel verified a client
 * certificate on the connection.
 */
const bridged = new Map<string, { client: string; authorized: boolean }>();

const loopbackKey = (address: string | undefined, port: number | undefined) =>
  address && port ? `${address.replace(/^::ffff:/i, "")}|${port}` : undefined;

/**
 * The address a node channel connection came from through the WebSocket
 * entry: the client of the upgrade request as the web port resolves it
 * (resolveClientIp, so a trusted proxy's forwarding headers count).
 * Undefined for connections made to the node channel port directly.
 */
export function bridgedClientAddress(
  remoteAddress: string | undefined,
  remotePort: number | undefined,
): string | undefined {
  const key = loopbackKey(remoteAddress, remotePort);
  return key === undefined ? undefined : bridged.get(key)?.client;
}

/**
 * Called by the node channel once a TLS handshake completes: a bridged
 * connection with a verified client certificate keeps its bridge past
 * authenticateMs.
 */
export function noteBridgedHandshake(socket: TLSSocket): void {
  const key = loopbackKey(socket.remoteAddress, socket.remotePort);
  const entry = key === undefined ? undefined : bridged.get(key);
  if (entry && socket.authorized === true) entry.authorized = true;
}

/** The node channel's own address, seen from this process. */
function loopbackHost(listenHost: string): string {
  if (listenHost === "" || listenHost === "0.0.0.0") return "127.0.0.1";
  if (listenHost === "::") return "::1";
  return listenHost;
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

/** Answers and closes: the client gets the status, the socket is destroyed once it is written. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
}

/**
 * Serves the node channel's WebSocket entry on the web port: each WebSocket
 * carries one connection to the node channel, which this process opens on
 * loopback. The node runs the node channel's TLS inside the WebSocket, so
 * the node channel terminates it and requires mTLS exactly as on its own
 * port; whatever is in front of the web port only sees the TLS records.
 *
 * The entry answers while nodeChannelWebSocketOpen says so (404 otherwise)
 * and never to browsers (they send Origin).
 */
export function attachNodeChannelWebSocket(
  server: Server,
  app: AppContext,
  channel: NodeChannel,
  limits: WebSocketEntryLimits = WEBSOCKET_ENTRY_LIMITS,
): void {
  const log = app.log.child({ component: "node-channel-websocket" });
  let open: { value: boolean; until: number } | undefined;
  const forget = () => {
    open = undefined;
  };
  app.events.on("node-channel", forget);
  app.events.on("reconnected", forget);
  const entryOpen = async () => {
    if (open && open.until > Date.now()) return open.value;
    const value = await nodeChannelWebSocketOpen(app);
    open = { value, until: Date.now() + limits.openCacheMs };
    return value;
  };
  let active = 0;
  let fullLoggedAt = 0;
  const perClient = new Map<string, number>();
  /** Takes one of the bridges for a client bucket; the returned function gives it back (once). */
  const reserve = (bucket: string) => {
    active++;
    perClient.set(bucket, (perClient.get(bucket) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      active--;
      const left = (perClient.get(bucket) ?? 1) - 1;
      if (left > 0) perClient.set(bucket, left);
      else perClient.delete(bucket);
    };
  };
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) =>
      protocols.has(NODE_CHANNEL_WEBSOCKET_PROTOCOL) ? NODE_CHANNEL_WEBSOCKET_PROTOCOL : false,
  });

  const bridge = (ws: WebSocket, client: string, release: () => void) => {
    const address = channel.server.address() as AddressInfo | null;
    if (!address) {
      release();
      ws.close(1011);
      return;
    }
    const stream = createWebSocketStream(ws);
    const tcp = connect({ host: loopbackHost(app.env.nodeApiHost), port: address.port });
    let key: string | undefined;
    // Without a verified client certificate a connection can only enroll:
    // it gets authenticateMs for that, then gives its bridge back.
    const unauthenticated = setTimeout(() => {
      if (key !== undefined && bridged.get(key)?.authorized) return;
      log.debug("node channel WebSocket without a client certificate, closed", { client });
      close();
    }, limits.authenticateMs);
    const close = () => {
      clearTimeout(unauthenticated);
      if (key !== undefined) bridged.delete(key);
      key = undefined;
      release();
      tcp.destroy();
      stream.destroy();
    };
    // No bytes either way: a dead or idling client gives its bridge back.
    tcp.setTimeout(limits.idleMs, () => {
      log.debug("node channel WebSocket idle, closed", { client });
      close();
    });
    // Recorded before the first byte reaches the node channel: piping starts here.
    tcp.once("connect", () => {
      key = loopbackKey(tcp.localAddress, tcp.localPort);
      if (key !== undefined) bridged.set(key, { client, authorized: false });
      stream.pipe(tcp).pipe(stream);
    });
    tcp.on("error", (error) => {
      log.debug("node channel loopback connection failed", { client, error });
      close();
    });
    stream.on("error", (error) => {
      log.debug("node channel WebSocket failed", { client, error });
      close();
    });
    tcp.once("close", close);
    stream.once("close", close);
  };

  const handle = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    // Browsers always send Origin with a WebSocket handshake; nodes never do.
    if (req.headers.origin !== undefined) return refuse(socket, 403, "Forbidden");
    if (!requestsProtocol(req)) return refuse(socket, 400, "Bad Request");
    let isOpen: boolean;
    try {
      isOpen = await entryOpen();
    } catch (error) {
      log.warn("cannot tell whether the node channel WebSocket entry is open", { error });
      return refuse(socket, 503, "Service Unavailable");
    }
    if (!isOpen) return refuse(socket, 404, "Not Found");
    const client = resolveClientIp(
      req.socket.remoteAddress ?? "",
      headersOf(req),
      app.env.trustedProxies,
    );
    // A client gone while the entry was being checked never upgrades: nothing to hold.
    if (socket.destroyed || !socket.readable || !socket.writable) {
      socket.destroy();
      return;
    }
    const perClientCap =
      app.env.trustedProxies.size > 0 ? limits.bridgesPerClient : Number.POSITIVE_INFINITY;
    const bucket = clientBucket(client);
    if (active >= limits.bridges || (perClient.get(bucket) ?? 0) >= perClientCap) {
      // Once a minute at most: refusals can come in floods.
      if (Date.now() - fullLoggedAt > 60_000) {
        fullLoggedAt = Date.now();
        log.warn("node channel WebSocket entry full", { client, active });
      }
      return refuse(socket, 503, "Service Unavailable");
    }
    // Counted from here: handshakes in flight hold their place too.
    const release = reserve(bucket);
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) release();
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      bridge(ws, client, release);
    });
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Another listener's request (Vite's HMR in development).
    if (!isNodeChannelUpgrade(req)) return;
    void handle(req, socket, head);
  });
}
