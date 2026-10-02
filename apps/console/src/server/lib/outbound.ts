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
    throw new Error("notification destination refused");
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
  const body = Buffer.from(JSON.stringify(payload));
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
        headers: {
          host: url.host,
          "content-type": "application/json",
          "content-length": body.length,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
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
        response.once("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error("notification destination rejected request"));
            return;
          }
          const text = Buffer.concat(chunks).toString();
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
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
