import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { schema } from "@edgeweir/db";
import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { recordAudit, systemActor } from "./audit";
import {
  certificateAccountBinding,
  certificateKeyBinding,
  dnsCredentialBinding,
  findDnsCredential,
  inspectCertificate,
} from "./certificates";
import { publishRevision } from "./revisions";

type HelperEvent = {
  event: string;
  record?: { name: string; type: string; data: string; ttl: number };
  domain?: string;
  token?: string;
  keyAuthorization?: string;
  account?: Record<string, unknown>;
};

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
  const timer = setTimeout(stop, 5 * 60_000);
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > (command.startsWith("dns.") ? 16 : 2) * 1024 * 1024) stop();
  });
  child.stderr.resume(); // dependency diagnostics may quote credentials
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ command, params })}\n`);
  let result: { ok?: boolean; result?: T } | undefined;
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
    if (code !== 0 || !result?.ok) throw new Error(`certificate helper ${command} failed`);
    return result.result as T;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function assertIssuanceNames(
  db: AppContext["db"],
  certificate: typeof schema.certificate.$inferSelect,
) {
  const rows = await db
    .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(
      and(
        eq(schema.site.organizationId, certificate.organizationId),
        eq(schema.siteDomain.verified, true),
        eq(schema.site.enabled, true),
      ),
    );
  const names = new Set(rows.map((d) => `${d.wildcard ? "*." : ""}${d.name}`));
  if (certificate.names.some((name) => !names.has(name)))
    throw new Error("certificate domains are no longer assigned to this organization");
}
function attempt(certificate: typeof schema.certificate.$inferSelect) {
  if (!certificate.operationStartedAt) throw new Error("missing issuance attempt");
  return and(
    eq(schema.certificate.id, certificate.id),
    eq(schema.certificate.operationStartedAt, certificate.operationStartedAt),
    eq(schema.certificate.status, "issuing"),
  );
}

async function challengeEvent(
  app: AppContext,
  certificate: typeof schema.certificate.$inferSelect,
  event: HelperEvent,
) {
  if (event.event === "dns01.prepare" || event.event === "dns01.cleanup") {
    if (
      !event.token ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(event.token) ||
      !certificate.operationStartedAt
    )
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
      await assertIssuanceNames(tx as AppContext["db"], certificate);
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
    if (!event.account) throw new Error("invalid account event");
    const updated = await app.db
      .update(schema.certificate)
      .set({
        accountEnvelope: JSON.stringify(
          app.masterKey.seal(
            JSON.stringify(event.account),
            certificateAccountBinding(certificate.id),
          ),
        ),
      })
      .where(attempt(certificate))
      .returning({ id: schema.certificate.id });
    if (!updated.length) throw new Error("stale issuance attempt");
    return;
  }
  if (
    !["http01.present", "http01.cleanup"].includes(event.event) ||
    !event.domain ||
    !certificate.names.includes(event.domain) ||
    !event.token ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(event.token)
  )
    throw new Error("invalid challenge event");
  const domain = event.domain;
  const token = event.token;
  if (
    event.event === "http01.present" &&
    (!event.keyAuthorization || !/^[A-Za-z0-9_.-]{1,512}$/.test(event.keyAuthorization))
  )
    throw new Error("invalid key authorization");
  const revisions = await app.db.transaction(async (tx) => {
    if (event.event === "http01.present") {
      const active = await tx
        .select({ id: schema.certificate.id })
        .from(schema.certificate)
        .where(attempt(certificate))
        .for("update");
      if (!active.length) throw new Error("stale issuance attempt");
      await assertIssuanceNames(tx as AppContext["db"], certificate);
    }
    await tx
      .delete(schema.acmeChallenge)
      .where(
        and(
          eq(schema.acmeChallenge.certificateId, certificate.id),
          eq(schema.acmeChallenge.token, token),
          eq(schema.acmeChallenge.operationStartedAt, certificate.operationStartedAt as Date),
        ),
      );
    if (event.event === "http01.present")
      await tx.insert(schema.acmeChallenge).values({
        certificateId: certificate.id,
        domain,
        token,
        keyAuthorization: event.keyAuthorization ?? "",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        operationStartedAt: certificate.operationStartedAt as Date,
      });
    const sites = await tx
      .selectDistinct({ clusterId: schema.site.clusterId })
      .from(schema.site)
      .innerJoin(schema.siteDomain, eq(schema.siteDomain.siteId, schema.site.id))
      .where(
        and(
          eq(schema.site.organizationId, certificate.organizationId),
          eq(schema.siteDomain.verified, true),
          eq(schema.siteDomain.name, domain),
          eq(schema.siteDomain.wildcard, false),
          eq(schema.site.enabled, true),
        ),
      );
    const out: { clusterId: string; revision: number }[] = [];
    for (const { clusterId } of sites) {
      const { row } = await publishRevision(tx, {
        clusterId,
        reason: { code: "acme_challenge_updated", params: {} },
      });
      out.push({ clusterId, revision: row.revision });
    }
    return out;
  });
  if (event.event === "http01.cleanup") return;
  if (!revisions.length) throw new Error("no cluster serves this challenge domain");
  const nodes = await app.db
    .select({
      id: schema.node.id,
      clusterId: schema.node.clusterId,
      features: schema.node.supportedFeatures,
    })
    .from(schema.node)
    .where(
      and(
        inArray(
          schema.node.clusterId,
          revisions.map((r) => r.clusterId),
        ),
        eq(schema.node.status, "active"),
        gt(schema.node.lastSeenAt, new Date(Date.now() - 45_000)),
      ),
    );
  if (!nodes.length || nodes.some((n) => !n.features.includes("http01-v1")))
    throw new Error("online ACME-capable nodes are required");
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
            s.appliedRevision >=
              (revisions.find((r) => r.clusterId === node.clusterId)?.revision ?? Infinity),
        ),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("nodes did not apply the HTTP challenge before its deadline");
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

export async function issueCertificate(app: AppContext, id: string) {
  const [row] = await app.db
    .update(schema.certificate)
    .set({ status: "issuing", operationStartedAt: new Date() })
    .where(and(eq(schema.certificate.id, id), eq(schema.certificate.source, "acme"), due()))
    .returning();
  if (!row) return;
  try {
    await assertIssuanceNames(app.db, row);
    const account = row.accountEnvelope
      ? JSON.parse(
          app.masterKey
            .open(JSON.parse(row.accountEnvelope), certificateAccountBinding(id))
            .toString("utf8"),
        )
      : {};
    let dns: Record<string, unknown> | undefined;
    if (row.acme.dnsCredentialId) {
      const credential = await findDnsCredential(app.db, row.acme.dnsCredentialId, {
        all: false,
        organizationId: row.organizationId,
      });
      dns = {
        provider: credential.provider,
        zone: `${credential.zone}.`,
        credentials: JSON.parse(
          app.masterKey
            .open(JSON.parse(credential.credentialEnvelope), dnsCredentialBinding(credential.id))
            .toString("utf8"),
        ),
      };
    }
    const result = await runCertd(
      app,
      row.chainPem ? "renew" : "obtain",
      {
        email: row.acme.email,
        domains: row.names,
        challenge: row.acme.challenge,
        account,
        dns,
        directoryUrl:
          app.env.EDGEWEIR_ACME_DIRECTORY ||
          (row.acme.ca === "zerossl"
            ? "https://acme.zerossl.com/v2/DV90"
            : "https://acme-v02.api.letsencrypt.org/directory"),
        rootCa: app.env.EDGEWEIR_ACME_CA_FILE
          ? await readFile(app.env.EDGEWEIR_ACME_CA_FILE, "utf8")
          : undefined,
        previousCertificate: row.chainPem,
      },
      (event) => challengeEvent(app, row, event),
    );
    if (typeof result.chainPem !== "string" || typeof result.privateKeyPem !== "string")
      throw new Error("invalid certificate response");
    const inspected = inspectCertificate(result.chainPem, result.privateKeyPem);
    if (
      row.names.some((name) =>
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
      await assertIssuanceNames(tx as AppContext["db"], row);
      const updated = await tx
        .update(schema.certificate)
        .set({
          chainPem: result.chainPem as string,
          privateKeyEnvelope: JSON.stringify(
            app.masterKey.seal(result.privateKeyPem as string, certificateKeyBinding(id)),
          ),
          accountEnvelope: JSON.stringify(
            app.masterKey.seal(
              JSON.stringify(result.account ?? account),
              certificateAccountBinding(id),
            ),
          ),
          names: inspected.names,
          fingerprint: inspected.fingerprint,
          notBefore: inspected.notBefore,
          notAfter: inspected.notAfter,
          renewAt,
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
      for (const site of sites)
        await publishRevision(tx, {
          clusterId: site.clusterId,
          reason: { code: "certificate_updated", params: { site: row.name } },
        });
      await recordAudit(tx, systemActor, {
        action: "certificate.issued",
        organizationId: row.organizationId,
        targetType: "certificate",
        targetId: id,
        targetName: row.name,
        metadata: { fingerprint: inspected.fingerprint, ari: result.ari === true },
      });
    });
  } catch {
    await app.db
      .update(schema.certificate)
      .set({
        status: "error",
        lastError: "certificate_operation_failed",
        operationStartedAt: null,
        renewAt: new Date(Date.now() + 3_600_000),
      })
      .where(attempt(row));
    app.log.warn("certificate operation failed", { certificateId: id });
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
    const challenges = await app.db
      .select()
      .from(schema.acmeChallenge)
      .where(
        and(
          eq(schema.acmeChallenge.certificateId, id),
          eq(schema.acmeChallenge.operationStartedAt, row.operationStartedAt as Date),
        ),
      );
    for (const challenge of challenges)
      await challengeEvent(app, row, {
        event: "http01.cleanup",
        domain: challenge.domain,
        token: challenge.token,
      });
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
    await runCertd(app, "dns.cleanup", {
      provider: credential.provider,
      zone: credential.zone,
      credentials: JSON.parse(
        app.masterKey
          .open(JSON.parse(credential.credentialEnvelope), dnsCredentialBinding(credential.id))
          .toString("utf8"),
      ),
      records: [lease.record],
    });
    await app.db.delete(schema.dnsChallengeLease).where(eq(schema.dnsChallengeLease.id, lease.id));
  } catch {
    app.log.warn("DNS challenge cleanup pending", { certificateId: lease.certificateId });
  }
}

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
  const pending = await app.db
    .select({ id: schema.certificate.id })
    .from(schema.certificate)
    .where(and(eq(schema.certificate.source, "acme"), due()))
    .limit(10);
  for (const certificate of pending) await issueCertificate(app, certificate.id);
}
