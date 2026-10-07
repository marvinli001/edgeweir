import { certificateUnloadable, type HttpsBlocker, type HttpsCheck } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import { certificateName, uncoveredDomains } from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { CAA_ISSUERS, caaPermits, defaultResolver } from "../lib/dns-check";
import { fail } from "../lib/errors";
import { outsideZone, testDnsCredential } from "./certificates";
import { http01Pointing, http01Readiness } from "./http01-check";
import type { Executor } from "./revisions";

/**
 * The contact email of a new ACME request: the last ACME account's, else
 * the last request's, else the operator's.
 */
export async function defaultAcmeEmail(db: Executor): Promise<string> {
  const [account] = await db
    .select({ email: schema.acmeAccount.email })
    .from(schema.acmeAccount)
    .where(ne(schema.acmeAccount.email, ""))
    .orderBy(desc(schema.acmeAccount.createdAt))
    .limit(1);
  if (account) return account.email;
  const email = sql<string>`${schema.certificate.acme}->>'email'`;
  const [request] = await db
    .select({ email })
    .from(schema.certificate)
    .where(sql`coalesce(${email}, '') <> ''`)
    .orderBy(desc(schema.certificate.createdAt))
    .limit(1);
  if (request) return request.email;
  const [operator] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .orderBy(asc(schema.user.createdAt))
    .limit(1);
  return operator?.email ?? "";
}

/**
 * What a one-click certificate for the site would request, and every
 * blocker the request or its issuance would meet (https.check). Read only:
 * the DNS-01 credential test asks the provider, nothing is written.
 */
export async function checkHttps(
  app: AppContext,
  id: string,
  ca: keyof typeof CAA_ISSUERS = "letsencrypt",
): Promise<HttpsCheck> {
  const [site] = await app.db
    .select({ id: schema.site.id, name: schema.site.name })
    .from(schema.site)
    .where(eq(schema.site.id, id));
  if (!site) fail("SITE_NOT_FOUND", "site not found");
  const stored = await app.db
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, id))
    .orderBy(asc(schema.siteDomain.name), asc(schema.siteDomain.kind));
  // Patterns name no host to issue for; a suffix domain asks for its wildcard.
  const domains = stored
    .filter((d) => d.kind !== "regex")
    .map((d) => (d.kind === "suffix" ? { ...d, kind: "wildcard" } : d));
  const names = [...new Set(domains.map(certificateName))];
  // HTTP-01 cannot validate wildcards.
  const challenge = domains.some((d) => d.kind !== "exact") ? "dns01" : "http01";
  const credential =
    challenge === "dns01"
      ? (
          await app.db
            .select({
              id: schema.dnsCredential.id,
              name: schema.dnsCredential.name,
              zone: schema.dnsCredential.zone,
            })
            .from(schema.dnsCredential)
            .orderBy(asc(schema.dnsCredential.name))
        ).find((c) => names.every((name) => !outsideZone(name, c.zone)))
      : undefined;
  const resolver = app.resolver ?? defaultResolver();
  // A directory set for every certificate is no CA the CAA records can name.
  const issuers = app.env.EDGEWEIR_ACME_DIRECTORY ? undefined : CAA_ISSUERS[ca];
  const method = challenge === "http01" ? "http-01" : "dns-01";

  const nodeBlockers = async (): Promise<HttpsBlocker[]> => {
    if (challenge !== "http01") return [];
    const { offline, lacking } = await http01Readiness(app.db, names);
    return [
      ...offline.map((cluster) => ({ code: "nodes_offline" as const, cluster })),
      ...(lacking.length ? [{ code: "nodes_lack_http01" as const, nodes: lacking }] : []),
    ];
  };
  const dnsBlockers = async (): Promise<HttpsBlocker[]> => {
    if (challenge === "http01")
      return [...(await http01Pointing(app, app.db, names))].flatMap(([name, pointing]) =>
        pointing === "unresolved" || pointing === "elsewhere"
          ? [{ code: "dns_not_pointing" as const, name, pointing }]
          : [],
      );
    if (!credential) return [{ code: "dns_credential_missing", names }];
    try {
      await testDnsCredential(app, { id: credential.id });
      return [];
    } catch (error) {
      const code = error instanceof ORPCError ? String(error.code) : "DNS_PROVIDER_FAILED";
      return [{ code: "dns_credential_failed", credential: credential.name, error: code }];
    }
  };
  const caaBlockers = async (): Promise<HttpsBlocker[]> => {
    if (!issuers) return [];
    const results = await Promise.all(
      names.map(async (name) => ({
        name,
        result: await caaPermits(resolver, name, issuers, method),
      })),
    );
    return results.flatMap(({ name, result }) =>
      result === "forbidden" ? [{ code: "caa_forbidden" as const, name }] : [],
    );
  };
  const [nodes, dns, caa] = names.length
    ? await Promise.all([nodeBlockers(), dnsBlockers(), caaBlockers()])
    : [[{ code: "no_certificate_names" as const }], [], []];

  const issued = await app.db
    .select({
      id: schema.certificate.id,
      name: schema.certificate.name,
      chainPem: schema.certificate.chainPem,
      status: schema.certificate.status,
      lastError: schema.certificate.lastError,
    })
    .from(schema.certificate)
    .where(and(ne(schema.certificate.chainPem, ""), gt(schema.certificate.notAfter, new Date())))
    .orderBy(asc(schema.certificate.name));
  const covering = issued.filter((cert) => {
    if (!domains.length) return false;
    if (certificateUnloadable(cert)) return false;
    try {
      return uncoveredDomains(cert.chainPem, domains).length === 0;
    } catch {
      return false;
    }
  });

  return {
    request: {
      name: site.name,
      names,
      email: await defaultAcmeEmail(app.db),
      challenge,
      dnsCredentialId: credential?.id ?? null,
    },
    blockers: [...nodes, ...dns, ...caa],
    certificates: covering.map(({ id, name }) => ({ id, name })),
  };
}
