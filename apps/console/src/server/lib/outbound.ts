import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { forbiddenOriginRange } from "@edgeweir/contract";
import type { AppContext } from "./context";
import { parseOutboundAllowCidrs } from "./env";

/** Bounds resolver/transport promises; their consumers must stop after cancellation. */
export function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("notification deadline exceeded"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** The name resolves to a special-purpose address EDGEWEIR_OUTBOUND_ALLOW_CIDRS does not allow. */
export class OutboundRefusedError extends Error {}

/** Resolve once, reject special-purpose answers, then connect to the pinned IP. */
export async function outboundAddress(app: AppContext, host: string) {
  const name = host.replace(/^\[|\]$/g, "");
  const allowed = parseOutboundAllowCidrs(app.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS);
  const addresses = isIP(name)
    ? [{ address: name, family: isIP(name) }]
    : await lookup(name, { all: true });
  if (
    !addresses.length ||
    addresses.some((entry) => forbiddenOriginRange(entry.address, allowed) !== null)
  )
    throw new OutboundRefusedError("notification destination refused");
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!selected) throw new Error("destination unavailable");
  return { ...selected, servername: name };
}
export async function postNotification(
  app: AppContext,
  target: string,
  payload: unknown,
  bearer?: string,
): Promise<unknown> {
  const response = await outboundPost(app, target, Buffer.from(JSON.stringify(payload)), {
    "content-type": "application/json",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error("notification destination rejected request");
  const text = response.body.toString();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
/**
 * POST a notification body (at most 32 KiB) to a pinned, policy-checked
 * address within 10 seconds and return the status and body (at most 64 KiB)
 * whatever the status: provider APIs explain refusals in the body.
 */
export async function outboundPost(
  app: AppContext,
  target: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: Buffer }> {
  // A socket inactivity timeout alone does not bound a complete delivery.
  const signal = AbortSignal.timeout(10000);
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("invalid notification URL");
  const address = await withinDeadline(outboundAddress(app, url.hostname), signal);
  signal.throwIfAborted();
  // Cleartext HTTP is only permitted for explicitly allowed private fixtures/LAN endpoints.
  if (url.protocol === "http:" && forbiddenOriginRange(address.address, []) === null)
    throw new Error("HTTPS required for public notifications");
  if (body.length > 32768) throw new Error("notification payload too large");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      {
        hostname: address.address,
        family: address.family,
        servername: isIP(address.servername) ? undefined : address.servername,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        headers: { host: url.host, ...headers, "content-length": body.length },
        timeout: 10000,
        signal,
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) response.destroy(new Error("notification response too large"));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.once("error", () => reject(new Error("notification transport failed")));
    request.once("timeout", () => request.destroy(new Error("notification timeout")));
    request.end(body);
  });
}

/**
 * GET a document under the same policy as notifications: every hop (redirects
 * included) is resolved once, checked against the special-purpose ranges and
 * the operator's allow list, and connected by the pinned IP.
 */
export async function outboundGet(
  app: AppContext,
  target: string,
  limits: { maxBytes: number; timeoutMs: number; maxRedirects: number },
): Promise<Buffer> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let url = new URL(target);
  for (let hop = 0; ; hop++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("invalid outbound URL");
    const address = await withinDeadline(outboundAddress(app, url.hostname), signal);
    signal.throwIfAborted();
    if (url.protocol === "http:" && forbiddenOriginRange(address.address, []) === null)
      throw new Error("HTTPS required for public destinations");
    const response = await new Promise<{ status: number; location?: string; body: Buffer }>(
      (resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(
          {
            hostname: address.address,
            family: address.family,
            servername: isIP(address.servername) ? undefined : address.servername,
            port: url.port || undefined,
            path: url.pathname + url.search,
            method: "GET",
            headers: { host: url.host },
            timeout: limits.timeoutMs,
            signal,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              resolve({ status, location: res.headers.location, body: Buffer.alloc(0) });
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limits.maxBytes) res.destroy(new Error("outbound response too large"));
              else chunks.push(chunk);
            });
            res.once("error", reject);
            res.once("end", () => resolve({ status, body: Buffer.concat(chunks) }));
          },
        );
        request.once("error", () => reject(new Error("outbound transport failed")));
        request.once("timeout", () => request.destroy(new Error("outbound timeout")));
        request.end();
      },
    );
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (hop >= limits.maxRedirects) throw new Error("too many redirects");
      url = new URL(response.location, url);
      continue;
    }
    if (response.status !== 200) throw new Error("outbound request rejected");
    return response.body;
  }
}

/**
 * A provider API request (external probe sources) under the same policy:
 * resolved once, special-purpose addresses only when allowed, connected by
 * the pinned IP, HTTPS for public addresses, no redirects. Returns the
 * status and body (at most `maxBytes`) whatever the status.
 */
export async function outboundRequest(
  app: AppContext,
  request: { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: Buffer },
  limits: { maxBytes: number; timeoutMs: number },
): Promise<{ status: number; body: Buffer }> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("invalid outbound URL");
  const address = await withinDeadline(outboundAddress(app, url.hostname), signal);
  signal.throwIfAborted();
  if (url.protocol === "http:" && forbiddenOriginRange(address.address, []) === null)
    throw new Error("HTTPS required for public destinations");
  const body = request.body ?? Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? https : http).request(
      {
        hostname: address.address,
        family: address.family,
        servername: isIP(address.servername) ? undefined : address.servername,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: request.method,
        headers: {
          host: url.host,
          ...request.headers,
          ...(request.method === "POST" ? { "content-length": body.length } : {}),
        },
        timeout: limits.timeoutMs,
        signal,
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limits.maxBytes) response.destroy(new Error("outbound response too large"));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    outgoing.once("error", () => reject(new Error("outbound transport failed")));
    outgoing.once("timeout", () => outgoing.destroy(new Error("outbound timeout")));
    outgoing.end(request.method === "POST" ? body : undefined);
  });
}
