import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { forbiddenOriginRange, normalizeCidr } from "@edgeweir/contract";
import type { AppContext } from "./context";

/** Resolve once, reject special-purpose answers, then connect to the pinned IP. */
export async function outboundAddress(app: AppContext, host: string) {
  const name = host.replace(/^\[|\]$/g, "");
  const allowed = app.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS.split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => {
      const cidr = normalizeCidr(value);
      if (!cidr) throw new Error("invalid outbound allow list");
      return cidr;
    });
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
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("invalid notification URL");
  const address = await outboundAddress(app, url.hostname);
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
