import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type DnsResolvers,
  type DnsResolversInput,
  dnsResolver,
  parseDnsResolver,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { outboundAddress, withinDeadline } from "../lib/outbound";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

const DNS_RESOLVERS_KEY = "dns_resolvers";

async function savedServers(db: Executor): Promise<string[]> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, DNS_RESOLVERS_KEY));
  const servers = Array.isArray(row?.value.servers) ? row.value.servers : [];
  return servers.filter((server): server is string => dnsResolver.safeParse(server).success);
}

/**
 * Saved setting, then EDGEWEIR_DNS_RESOLVERS, then the operating system's
 * resolver. Only saved servers came from a web session; the variable is the
 * operator's and keeps its old, unchecked path.
 */
export async function getDnsResolvers(app: AppContext): Promise<DnsResolvers> {
  const servers = await savedServers(app.db);
  if (servers.length) return { servers, effectiveServers: servers, source: "setting" };
  const env = app.env.EDGEWEIR_DNS_RESOLVERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length) return { servers, effectiveServers: env, source: "environment" };
  return { servers, effectiveServers: [], source: "default" };
}

const withPort = (address: string, port: number | string) =>
  `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;

/**
 * Addresses for `Resolver.setServers`; empty keeps the system resolver. A
 * saved server's name is resolved once and its address checked against the
 * outbound policy, and the resolver then queries that pinned address.
 */
export async function resolverAddresses(app: AppContext): Promise<string[]> {
  const { effectiveServers, source } = await getDnsResolvers(app);
  return Promise.all(
    effectiveServers.map(async (server) => {
      if (source === "setting") {
        const parsed = parseDnsResolver(server);
        if (!parsed) throw new Error("invalid DNS server");
        const signal = AbortSignal.timeout(5000);
        const address = await withinDeadline(outboundAddress(app, parsed.host), signal);
        return withPort(address.address, parsed.port);
      }
      if (isIP(server)) return server;
      const url = new URL(`dns://${server}`),
        host = url.hostname.replace(/^\[|\]$/g, "");
      const address = isIP(host) ? host : (await lookup(host)).address;
      return withPort(address, url.port || "53");
    }),
  );
}

export async function setDnsResolvers(
  app: AppContext,
  input: DnsResolversInput,
  actor: Actor,
): Promise<DnsResolvers> {
  const servers = [...new Set(input.servers)];
  for (const server of servers) {
    const parsed = parseDnsResolver(server);
    try {
      if (!parsed) throw new Error("invalid DNS server");
      await withinDeadline(outboundAddress(app, parsed.host), AbortSignal.timeout(10000));
    } catch {
      fail("DNS_RESOLVER_REFUSED", `DNS server ${server} must resolve to an allowed address`);
    }
  }
  await app.db.transaction(async (tx) => {
    const before = await savedServers(tx);
    if (servers.length) {
      const value = { servers };
      await tx
        .insert(schema.systemSetting)
        .values({ key: DNS_RESOLVERS_KEY, value })
        .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
    } else {
      await tx.delete(schema.systemSetting).where(eq(schema.systemSetting.key, DNS_RESOLVERS_KEY));
    }
    await recordAudit(tx, actor, {
      action: "system.dns_resolvers_update",
      targetType: "system_setting",
      targetId: DNS_RESOLVERS_KEY,
      metadata: { before, after: servers },
    });
  });
  return getDnsResolvers(app);
}
