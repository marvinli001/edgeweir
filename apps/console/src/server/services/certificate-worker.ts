import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { schema } from "@edgeweir/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { recordAudit, systemActor } from "./audit";
import {
  acmeAccountBinding,
  certificateAccountBinding,
  certificateKeyBinding,
  findDnsCredential,
  inspectCertificate,
  openDnsCredential,
} from "./certificates";
import { withLease } from "./dns-lease";
import { certdDns, outboundAllowCidrs } from "./dns-providers";
import { publishClusters, rolloutTargets, targetFor } from "./revisions";

type HttpToken = { domain?: unknown; token?: unknown; keyAuthorization?: unknown };
type HelperEvent = {
  event: string;
  record?: { name: string; type: string; data: string; ttl: number };
  domain?: string;
  token?: string;
  /** All HTTP-01 challenges of an order (http01.present, http01.cleanup). */
  challenges?: HttpToken[];
  account?: AcmeAccount;
};
/** What certd needs to use or register an ACME account. */
type AcmeAccount = {
  privateKeyPem?: string;
  registration?: { uri?: string };
  eabKid?: string;
  eabHmacKey?: string;
};
type CertificateRow = typeof schema.certificate.$inferSelect;
/** An issuance attempt: the claimed row and the CA directory it uses. */
type Issuance = { row: CertificateRow; directoryUrl: string };

/** A failed helper command; `code` classifies DNS provider errors (dns_auth_failed, …). */
export class CertdError extends Error {
  constructor(
    command: string,
    readonly code: string,
  ) {
    super(`certificate helper ${command} failed`);
  }
}

/** Secrets travel over stdin/stdout only, never shell arguments or logs. */
export async function runCertd<T = Record<string, unknown>>(
  app: AppContext,
  command: string,
  params: unknown,
  onEvent?: (event: HelperEvent) => Promise<void>,
): Promise<T> {
  const child = spawn(app.env.EDGEWEIR_CERTD_BIN, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, EDGEWEIR_DNS_TEST_ENDPOINT: app.env.EDGEWEIR_DNS_TEST_ENDPOINT },
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void exit.catch(() => {});
  let killed = false;
  let bytes = 0;
  const stop = () => {
    killed = true;
    child.kill("SIGKILL");
  };
  // An issuance ends before a stuck one may be taken over (due(): 10 minutes).
  const timer = setTimeout(stop, (command.startsWith("dns.") ? 5 : 8) * 60_000);
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > (command.startsWith("dns.") ? 16 : 2) * 1024 * 1024) stop();
  });
  child.stderr.resume(); // dependency diagnostics may quote credentials
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ command, params })}\n`);
  let result: { ok?: boolean; result?: T; code?: string } | undefined;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (typeof message.event === "string") {
        if (!onEvent) throw new Error("unexpected helper event");
        await onEvent(message);
        child.stdin.write('{"ok":true}\n');
      } else result = message;
    }
    const code = await exit;
    if (killed) throw new Error("certificate helper exceeded its time or output limit");
    if (code !== 0 || !result?.ok)
      throw new CertdError(
        command,
        typeof result?.code === "string" && /^[a-z0-9_]{1,40}$/.test(result.code)
          ? result.code
          : "certd_failed",
      );
    return result.result as T;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/**
 * The names to ask the CA for. A renewal by HTTP-01 drops names no site has
 * any more (no cluster would serve their challenge), as long as one is left:
 * sites that use the certificate only have names it still covers, so they
 * stay covered and the remaining names keep renewing.
 */
async function issuanceNames(
  db: AppContext["db"],
  certificate: typeof schema.certificate.$inferSelect,
): Promise<string[]> {
  if (!certificate.chainPem || certificate.acme.challenge !== "http01") return certificate.names;
  const rows = await db
    .selectDistinct({ name: schema.siteDomain.name })
    .from(schema.siteDomain)
    .where(
      and(
        inArray(schema.siteDomain.name, certificate.names),
        eq(schema.siteDomain.wildcard, false),
      ),
    );
  const served = certificate.names.filter((name) => rows.some((row) => row.name === name));
  return served.length ? served : certificate.names;
}
function attempt(certificate: CertificateRow) {
  if (!certificate.operationStartedAt) throw new Error("missing issuance attempt");
  return and(
    eq(schema.certificate.id, certificate.id),
    eq(schema.certificate.operationStartedAt, certificate.operationStartedAt),
    eq(schema.certificate.status, "issuing"),
  );
}

/** The ACME directory of a certificate's CA (EDGEWEIR_ACME_DIRECTORY replaces every CA). */
export function acmeDirectory(app: AppContext, ca: string | undefined) {
  return (
    app.env.EDGEWEIR_ACME_DIRECTORY ||
    (ca === "zerossl"
      ? "https://acme.zerossl.com/v2/DV90"
      : "https://acme-v02.api.letsencrypt.org/directory")
  );
}
const acmeRootCa = async (app: AppContext) =>
  app.env.EDGEWEIR_ACME_CA_FILE ? await readFile(app.env.EDGEWEIR_ACME_CA_FILE, "utf8") : undefined;

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};
/** Keeps a registered account for every later certificate with its directory, EAB key id and email. */
async function storeAccount(
  app: AppContext,
  issuance: Issuance,
  eabKid: string,
  account: AcmeAccount,
) {
  const id = randomUUID();
  const sealed = JSON.stringify({
    privateKeyPem: account.privateKeyPem,
    registration: account.registration,
    eabKid,
  });
  await app.db
    .insert(schema.acmeAccount)
    .values({
      id,
      directoryUrl: issuance.directoryUrl,
      eabKid,
      email: issuance.row.acme.email ?? "",
      accountEnvelope: JSON.stringify(app.masterKey.seal(sealed, acmeAccountBinding(id))),
    })
    // Registered meanwhile by another issuance: that one is kept, this one is not used again.
    .onConflictDoNothing();
}
/**
 * The account an issuance uses: the one shared by its directory, EAB key id
 * and email; else the certificate's own account from before accounts were
 * shared (same CA), which becomes the shared one; else just the EAB key, and
 * certd registers a new account (its account event stores it).
 */
async function issuanceAccount(
  app: AppContext,
  issuance: Issuance,
  request: AcmeAccount,
): Promise<AcmeAccount> {
  const eabKid = request.eabKid ?? "";
  const [shared] = await app.db
    .select()
    .from(schema.acmeAccount)
    .where(
      and(
        eq(schema.acmeAccount.directoryUrl, issuance.directoryUrl),
        eq(schema.acmeAccount.eabKid, eabKid),
        eq(schema.acmeAccount.email, issuance.row.acme.email ?? ""),
      ),
    );
  if (shared)
    return JSON.parse(
      app.masterKey
        .open(JSON.parse(shared.accountEnvelope), acmeAccountBinding(shared.id))
        .toString("utf8"),
    );
  if (
    request.privateKeyPem &&
    request.registration?.uri &&
    sameOrigin(request.registration.uri, issuance.directoryUrl)
  ) {
    await storeAccount(app, issuance, eabKid, request);
    return request;
  }
  return { eabKid: request.eabKid, eabHmacKey: request.eabHmacKey };
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
/** The HTTP-01 challenges of an event, each for a name of the certificate. */
function httpTokens(certificate: CertificateRow, event: HelperEvent) {
  const challenges = event.challenges;
  if (!Array.isArray(challenges) || !challenges.length || challenges.length > 100)
    throw new Error("invalid challenge event");
  return challenges.map(({ domain, token, keyAuthorization }) => {
    if (
      typeof domain !== "string" ||
      !certificate.names.includes(domain) ||
      typeof token !== "string" ||
      !TOKEN.test(token)
    )
      throw new Error("invalid challenge event");
    if (
      event.event === "http01.present" &&
      (typeof keyAuthorization !== "string" || !/^[A-Za-z0-9_.-]{1,512}$/.test(keyAuthorization))
    )
      throw new Error("invalid key authorization");
    return {
      domain,
      token,
      keyAuthorization: typeof keyAuthorization === "string" ? keyAuthorization : "",
    };
  });
}
const attemptChallenges = (certificate: CertificateRow, tokens?: string[]) =>
  and(
    eq(schema.acmeChallenge.certificateId, certificate.id),
    eq(schema.acmeChallenge.operationStartedAt, certificate.operationStartedAt as Date),
    tokens ? inArray(schema.acmeChallenge.token, tokens) : undefined,
  );

/**
 * Publishes all HTTP-01 challenges of an order: one revision for each
 * cluster serving their names, then waits until the clusters' online nodes
 * run it. Each node is compared with its own target: with a canary, the
 * stable and the candidate revision both carry the challenges.
 */
async function presentHttpChallenges(
  app: AppContext,
  certificate: CertificateRow,
  tokens: ReturnType<typeof httpTokens>,
) {
  const domains = [...new Set(tokens.map((t) => t.domain))];
  const clusterIds = await app.db.transaction(async (tx) => {
    const active = await tx
      .select({ id: schema.certificate.id })
      .from(schema.certificate)
      .where(attempt(certificate))
      .for("update");
    if (!active.length) throw new Error("stale issuance attempt");
    await tx.delete(schema.acmeChallenge).where(
      attemptChallenges(
        certificate,
        tokens.map((t) => t.token),
      ),
    );
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await tx.insert(schema.acmeChallenge).values(
      tokens.map((t) => ({
        ...t,
        certificateId: certificate.id,
        expiresAt,
        operationStartedAt: certificate.operationStartedAt as Date,
      })),
    );
    const served = await tx
      .selectDistinct({ clusterId: schema.site.clusterId, name: schema.siteDomain.name })
      .from(schema.site)
      .innerJoin(schema.siteDomain, eq(schema.siteDomain.siteId, schema.site.id))
      .where(and(inArray(schema.siteDomain.name, domains), eq(schema.siteDomain.wildcard, false)));
    if (domains.some((domain) => !served.some((s) => s.name === domain)))
      throw new Error("no cluster serves this challenge domain");
    const published = await publishClusters(
      tx,
      served.map((s) => s.clusterId),
      { reason: { code: "acme_challenge_updated", params: {} } },
    );
    return [...published.keys()];
  });
  const nodes = await app.db
    .select({
      id: schema.node.id,
      clusterId: schema.node.clusterId,
      nodeGroupId: schema.node.nodeGroupId,
      features: schema.node.supportedFeatures,
    })
    .from(schema.node)
    .where(
      and(
        inArray(schema.node.clusterId, clusterIds),
        eq(schema.node.status, "active"),
        gt(schema.node.lastSeenAt, new Date(Date.now() - 45_000)),
      ),
    );
  if (!nodes.length || nodes.some((n) => !n.features.includes("http01-v1")))
    throw new Error("online ACME-capable nodes are required");
  const targets = new Map<string, number>();
  for (const clusterId of new Set(nodes.map((n) => n.clusterId))) {
    const clusterTargets = await rolloutTargets(app.db, clusterId);
    for (const node of nodes.filter((n) => n.clusterId === clusterId)) {
      const target = targetFor(node, clusterTargets);
      if (target) targets.set(node.id, target.revision);
    }
  }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const status = await app.db
      .select()
      .from(schema.nodeConfigStatus)
      .where(
        inArray(
          schema.nodeConfigStatus.nodeId,
          nodes.map((n) => n.id),
        ),
      );
    if (
      nodes.every((node) =>
        status.some(
          (s) =>
            s.nodeId === node.id &&
            s.state === "applied" &&
            s.appliedRevision >= (targets.get(node.id) ?? Infinity),
        ),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("nodes did not apply the HTTP challenge before its deadline");
}

async function challengeEvent(app: AppContext, issuance: Issuance, event: HelperEvent) {
  const certificate = issuance.row;
  if (event.event === "dns01.prepare" || event.event === "dns01.cleanup") {
    if (!event.token || !TOKEN.test(event.token) || !certificate.operationStartedAt)
      throw new Error("invalid DNS challenge event");
    const scope = and(
      eq(schema.dnsChallengeLease.certificateId, certificate.id),
      eq(schema.dnsChallengeLease.operationStartedAt, certificate.operationStartedAt),
      eq(schema.dnsChallengeLease.token, event.token),
    );
    if (event.event === "dns01.cleanup") {
      await app.db.delete(schema.dnsChallengeLease).where(scope);
      return;
    }
    const record = event.record;
    if (
      !certificate.acme.dnsCredentialId ||
      !record ||
      record.type !== "TXT" ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(record.data) ||
      !/^_acme-challenge(?:\.[a-z0-9.-]+)?$/.test(record.name) ||
      record.ttl !== 60
    )
      throw new Error("invalid DNS challenge intent");
    await app.db.transaction(async (tx) => {
      const active = await tx
        .select({ id: schema.certificate.id })
        .from(schema.certificate)
        .where(attempt(certificate))
        .for("update");
      if (!active.length) throw new Error("stale issuance attempt");
      await tx
        .insert(schema.dnsChallengeLease)
        .values({
          certificateId: certificate.id,
          credentialId: certificate.acme.dnsCredentialId as string,
          operationStartedAt: certificate.operationStartedAt as Date,
          token: event.token as string,
          record,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        })
        .onConflictDoNothing();
    });
    return;
  }
  if (event.event === "account") {
    const account = event.account;
    if (!account || typeof account.privateKeyPem !== "string" || !account.registration?.uri)
      throw new Error("invalid account event");
    const active = await app.db
      .select({ id: schema.certificate.id })
      .from(schema.certificate)
      .where(attempt(certificate));
    if (!active.length) throw new Error("stale issuance attempt");
    const request = openRequest(app, certificate);
    await storeAccount(app, issuance, request.eabKid ?? "", account);
    return;
  }
  if (event.event === "http01.present") {
    await presentHttpChallenges(app, certificate, httpTokens(certificate, event));
    return;
  }
  if (event.event === "http01.cleanup") {
    // No revision: nodes stop answering a challenge when it expires, and the
    // next revision leaves out those of ended attempts (loadHttpChallenges).
    const tokens = httpTokens(certificate, event).map((t) => t.token);
    await app.db.delete(schema.acmeChallenge).where(attemptChallenges(certificate, tokens));
    return;
  }
  throw new Error("invalid challenge event");
}

/** The certificate's request: its EAB key, or (from before shared accounts) its own account. */
function openRequest(app: AppContext, certificate: CertificateRow): AcmeAccount {
  if (!certificate.accountEnvelope) return {};
  return JSON.parse(
    app.masterKey
      .open(JSON.parse(certificate.accountEnvelope), certificateAccountBinding(certificate.id))
      .toString("utf8"),
  );
}

const due = () =>
  or(
    eq(schema.certificate.status, "pending"),
    and(
      inArray(schema.certificate.status, ["ready", "error"]),
      eq(schema.certificate.autoRenew, true),
      lt(schema.certificate.renewAt, new Date()),
    ),
    and(
      eq(schema.certificate.status, "issuing"),
      lt(schema.certificate.operationStartedAt, new Date(Date.now() - 10 * 60_000)),
    ),
  );

/**
 * How long a failed issuance waits: a tenth of the certificate's remaining
 * validity, from 10 minutes to 12 hours (a renewal with weeks left does not
 * retry every hour, one about to expire retries often); a first issuance
 * waits an hour.
 */
export function retryDelay(notAfter: Date | null, now = Date.now()) {
  if (!notAfter) return 3_600_000;
  return Math.min(12 * 3_600_000, Math.max(10 * 60_000, (notAfter.getTime() - now) / 10));
}

/**
 * Issues or renews a due ACME certificate. DNS-01 runs under the lease of its
 * DNS credential, so two console processes never rewrite the same
 * `_acme-challenge` record set at once (a busy credential waits for the next
 * sweep).
 */
export async function issueCertificate(app: AppContext, id: string) {
  const [row] = await app.db
    .select({ acme: schema.certificate.acme })
    .from(schema.certificate)
    .where(eq(schema.certificate.id, id));
  const credentialId = row?.acme.challenge === "dns01" ? row.acme.dnsCredentialId : undefined;
  if (!credentialId) return issueNow(app, id);
  await withLease(app.db, `credential:${credentialId}`, 10 * 60, () => issueNow(app, id));
}
async function issueNow(app: AppContext, id: string) {
  const [row] = await app.db
    .update(schema.certificate)
    .set({ status: "issuing", operationStartedAt: new Date() })
    .where(and(eq(schema.certificate.id, id), eq(schema.certificate.source, "acme"), due()))
    .returning();
  if (!row) return;
  const issuance: Issuance = { row, directoryUrl: acmeDirectory(app, row.acme.ca) };
  try {
    const names = await issuanceNames(app.db, row);
    const request = openRequest(app, row);
    const account = await issuanceAccount(app, issuance, request);
    let dns: Record<string, unknown> | undefined;
    if (row.acme.dnsCredentialId) {
      const credential = await findDnsCredential(app.db, row.acme.dnsCredentialId);
      dns = {
        provider: credential.provider,
        zone: `${credential.zone}.`,
        credentials: openDnsCredential(app, credential),
        outbound: { allowCidrs: outboundAllowCidrs(app) },
      };
    }
    const result = await runCertd(
      app,
      row.chainPem ? "renew" : "obtain",
      {
        email: row.acme.email,
        domains: names,
        challenge: row.acme.challenge,
        account,
        dns,
        directoryUrl: issuance.directoryUrl,
        rootCa: await acmeRootCa(app),
        previousCertificate: row.chainPem,
      },
      (event) => challengeEvent(app, issuance, event),
    );
    if (typeof result.chainPem !== "string" || typeof result.privateKeyPem !== "string")
      throw new Error("invalid certificate response");
    const inspected = inspectCertificate(result.chainPem, result.privateKeyPem);
    if (
      names.some((name) =>
        name.startsWith("*.") ? !inspected.names.includes(name) : !inspected.leaf.checkHost(name),
      )
    )
      throw new Error("issued certificate does not cover the requested names");
    const fallback =
      inspected.notBefore.getTime() +
      ((inspected.notAfter.getTime() - inspected.notBefore.getTime()) * 2) / 3;
    const proposed = typeof result.renewAt === "string" ? Date.parse(result.renewAt) : fallback;
    const renewAt = new Date(
      Number.isFinite(proposed)
        ? Math.min(proposed, inspected.notAfter.getTime() - 60_000)
        : fallback,
    );
    await app.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.certificate)
        .set({
          chainPem: inspected.chainPem,
          privateKeyEnvelope: JSON.stringify(
            app.masterKey.seal(inspected.privateKeyPem, certificateKeyBinding(id)),
          ),
          // Only the request stays with the certificate; the account is shared.
          accountEnvelope: JSON.stringify(
            app.masterKey.seal(
              JSON.stringify({ eabKid: request.eabKid, eabHmacKey: request.eabHmacKey }),
              certificateAccountBinding(id),
            ),
          ),
          names: inspected.names,
          fingerprint: inspected.fingerprint,
          notBefore: inspected.notBefore,
          notAfter: inspected.notAfter,
          renewAt,
          renewalInfoAt: new Date(Date.now() + RENEWAL_INFO_INTERVAL),
          status: "ready",
          operationStartedAt: null,
          lastError: "",
          updatedAt: new Date(),
        })
        .where(attempt(row))
        .returning({ id: schema.certificate.id });
      if (!updated.length) throw new Error("stale issuance attempt");
      const sites = await tx
        .selectDistinct({ clusterId: schema.site.clusterId })
        .from(schema.site)
        .where(eq(schema.site.certificateId, id));
      await publishClusters(
        tx,
        sites.map((s) => s.clusterId),
        { reason: { code: "certificate_updated", params: { site: row.name } } },
      );
      await recordAudit(tx, systemActor, {
        action: "certificate.issued",
        targetType: "certificate",
        targetId: id,
        targetName: row.name,
        metadata: { fingerprint: inspected.fingerprint, ari: result.ari === true },
      });
    });
  } catch (error) {
    await app.db
      .update(schema.certificate)
      .set({
        status: "error",
        lastError: "certificate_operation_failed",
        operationStartedAt: null,
        renewAt: new Date(Date.now() + retryDelay(row.notAfter)),
      })
      .where(attempt(row));
    // Never the helper's output, which may quote credentials or keys (a
    // JSON.parse error would quote the line it failed on).
    app.log.warn("certificate operation failed", {
      certificateId: id,
      reason:
        error instanceof SyntaxError
          ? "invalid helper output"
          : error instanceof Error
            ? error.message
            : "unknown",
    });
  } finally {
    const leases = await app.db
      .select()
      .from(schema.dnsChallengeLease)
      .where(
        and(
          eq(schema.dnsChallengeLease.certificateId, id),
          eq(schema.dnsChallengeLease.operationStartedAt, row.operationStartedAt as Date),
        ),
      );
    for (const lease of leases) await cleanupDnsLease(app, lease);
    await app.db.delete(schema.acmeChallenge).where(attemptChallenges(row));
  }
}

async function cleanupDnsLease(
  app: AppContext,
  lease: typeof schema.dnsChallengeLease.$inferSelect,
) {
  const [credential] = await app.db
    .select()
    .from(schema.dnsCredential)
    .where(eq(schema.dnsCredential.id, lease.credentialId));
  if (!credential) return;
  try {
    const cleaned = await withLease(app.db, `credential:${credential.id}`, 10 * 60, () =>
      certdDns(app, "dns.cleanup", {
        provider: credential.provider,
        zone: credential.zone,
        credentials: openDnsCredential(app, credential),
        records: [lease.record],
      }),
    );
    if (!cleaned.ran) return;
    await app.db.delete(schema.dnsChallengeLease).where(eq(schema.dnsChallengeLease.id, lease.id));
  } catch {
    app.log.warn("DNS challenge cleanup pending", { certificateId: lease.certificateId });
  }
}

/** How often a CA's suggested renewal window is read when it sets no Retry-After. */
const RENEWAL_INFO_INTERVAL = 6 * 3_600_000;
type RenewalWindow = { start: number; end: number; retryAfter: number };
function renewalWindow(value: unknown): RenewalWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { start, end, retryAfter } = value as Record<string, unknown>;
  const from = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const to = typeof end === "string" ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  return { start: from, end: to, retryAfter: typeof retryAfter === "number" ? retryAfter : 0 };
}
/**
 * The next renewal of a certificate given its CA's window (RFC 9773 §4.2): a
 * planned renewal after the window moves to a random time in it (now, if it
 * has passed); an earlier one stays.
 */
export function rescheduledRenewal(renewAt: Date, window: RenewalWindow, now = Date.now()) {
  if (renewAt.getTime() <= window.end) return renewAt;
  return new Date(Math.max(now, window.start + Math.random() * (window.end - window.start)));
}

/**
 * Reads the suggested renewal windows (ARI) of issued certificates, each
 * again after its CA's Retry-After (1 to 24 hours, 6 without one): a CA
 * that is going to revoke certificates early moves their windows forward,
 * and their renewals follow.
 */
export async function checkRenewalInfo(app: AppContext, now = Date.now()) {
  const rows = await app.db
    .select()
    .from(schema.certificate)
    .where(
      and(
        eq(schema.certificate.source, "acme"),
        eq(schema.certificate.status, "ready"),
        eq(schema.certificate.autoRenew, true),
        ne(schema.certificate.chainPem, ""),
        gt(schema.certificate.renewAt, new Date(now)),
        or(
          isNull(schema.certificate.renewalInfoAt),
          lt(schema.certificate.renewalInfoAt, new Date(now)),
        ),
      ),
    )
    .orderBy(sql`${schema.certificate.renewalInfoAt} asc nulls first`)
    .limit(50);
  const directories = Map.groupBy(rows, (row) => acmeDirectory(app, row.acme.ca));
  for (const [directoryUrl, group] of directories) {
    let windows: unknown;
    try {
      windows = await runCertd(app, "renewal-info", {
        directoryUrl,
        rootCa: await acmeRootCa(app),
        certificates: group.map((row) => row.chainPem),
      });
    } catch {
      app.log.warn("certificate renewal info unavailable", { directoryUrl });
    }
    for (const [index, row] of group.entries()) {
      const window = renewalWindow(Array.isArray(windows) ? windows[index] : undefined);
      const retry =
        windows === undefined
          ? 3_600_000
          : Math.min(
              24 * 3_600_000,
              Math.max(3_600_000, (window?.retryAfter ?? 0) * 1000 || RENEWAL_INFO_INTERVAL),
            );
      const renewAt = row.renewAt && window ? rescheduledRenewal(row.renewAt, window, now) : null;
      await app.db.transaction(async (tx) => {
        const moved = renewAt && renewAt !== row.renewAt;
        const updated = await tx
          .update(schema.certificate)
          .set({ renewalInfoAt: new Date(now + retry), ...(moved ? { renewAt } : {}) })
          .where(and(eq(schema.certificate.id, row.id), eq(schema.certificate.status, "ready")))
          .returning({ id: schema.certificate.id });
        if (moved && updated.length)
          await recordAudit(tx, systemActor, {
            action: "certificate.renewal_rescheduled",
            targetType: "certificate",
            targetId: row.id,
            targetName: row.name,
            metadata: { from: row.renewAt?.toISOString(), to: renewAt.toISOString() },
          });
      });
    }
  }
}

/** The certificates a sweep issues: requests and manual renewals first, then the longest overdue. */
export async function dueCertificates(app: AppContext, limit = 10) {
  const rows = await app.db
    .select({ id: schema.certificate.id })
    .from(schema.certificate)
    .where(and(eq(schema.certificate.source, "acme"), due()))
    .orderBy(desc(eq(schema.certificate.status, "pending")), asc(schema.certificate.renewAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Issuances a sweep runs at once: a slow CA or DNS provider holds back no more than these. */
const SWEEP_CONCURRENCY = 3;

export async function sweepCertificates(app: AppContext) {
  const leases = await app.db
    .select({ lease: schema.dnsChallengeLease, certificate: schema.certificate })
    .from(schema.dnsChallengeLease)
    .innerJoin(
      schema.certificate,
      eq(schema.certificate.id, schema.dnsChallengeLease.certificateId),
    )
    .limit(100);
  for (const { lease, certificate } of leases) {
    if (
      lease.expiresAt.getTime() < Date.now() ||
      certificate.status !== "issuing" ||
      certificate.operationStartedAt?.getTime() !== lease.operationStartedAt.getTime()
    )
      await cleanupDnsLease(app, lease);
  }
  // HTTP-01 challenges an attempt left behind when its process died.
  await app.db.delete(schema.acmeChallenge).where(lt(schema.acmeChallenge.expiresAt, new Date()));
  const queue = await dueCertificates(app);
  await Promise.all(
    Array.from({ length: SWEEP_CONCURRENCY }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          await issueCertificate(app, id);
        } catch (error) {
          app.log.warn("certificate sweep failed", {
            certificateId: id,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    }),
  );
  await checkRenewalInfo(app);
}
