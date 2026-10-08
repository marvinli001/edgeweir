import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import {
  checkRenewalInfo,
  dueCertificates,
  issueCertificate,
  retryDelay,
  sweepCertificates,
} from "../../src/server/services/certificate-worker";
import { certificateAccountBinding } from "../../src/server/services/certificates";
import { latestRevision, pruneRevisions } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// How issuance publishes HTTP-01 challenges, which ACME account it uses,
// when it runs and retries, and how it follows the CA's renewal windows
// (audit 2026-10-01 P1-26, P1-27, P1-29).

type Plan = {
  /** Issued material by requested names ("a,b"). */
  issued: Record<string, { chainPem: string; privateKeyPem: string }>;
  fail: string[];
  /** The code a failure answers with. */
  failCode?: string;
  /** While set, the helper waits for this file before it answers (after the challenges). */
  hold?: string;
  /** Renewal windows by chain. */
  windows: Record<string, unknown>;
  failRenewalInfo?: boolean;
};
type Request = {
  command: string;
  params: { domains: string[]; account: Record<string, unknown>; certificates?: string[] };
};

/** A stand-in for edgeweir-certd speaking its protocol, driven by a plan file. */
function fakeCertd(dir: string) {
  const plan = join(dir, "plan.json");
  const requests = join(dir, "requests.jsonl");
  const events = join(dir, "events.jsonl");
  const bin = join(dir, "certd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const lines = require("node:readline").createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const done = (message) => { process.stdout.write(JSON.stringify(message) + "\\n"); process.exit(message.ok ? 0 : 1); };
const send = async (event) => {
  fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n");
  process.stdout.write(JSON.stringify(event) + "\\n");
  if (!JSON.parse((await lines.next()).value).ok) done({ ok: false });
};
(async () => {
  const request = JSON.parse((await lines.next()).value);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(request) + "\\n");
  const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
  const p = request.params;
  if (request.command === "renewal-info") {
    if (plan.failRenewalInfo) return done({ ok: false });
    return done({ ok: true, result: p.certificates.map((c) => plan.windows[c] ?? null) });
  }
  const names = p.domains.join(",");
  if (!p.account.registration)
    await send({ event: "account", account: { privateKeyPem: "account-key-" + names, registration: { uri: "https://acme-v02.api.letsencrypt.org/acme/acct/" + names, body: {} } } });
  if (plan.fail.includes(names)) return done({ ok: false, code: plan.failCode, error: "CA said: ops@example.com is not allowed" });
  const challenges = p.domains.map((domain, i) => ({ domain, token: "t" + process.pid + "-" + i + "-abcdefghijklmnop", keyAuthorization: "t" + process.pid + "-" + i + ".thumbprint" }));
  await send({ event: "http01.present", challenges });
  await send({ event: "http01.cleanup", challenges: challenges.map(({ domain, token }) => ({ domain, token })) });
  while (plan.hold && !fs.existsSync(plan.hold)) await new Promise((r) => setTimeout(r, 20));
  done({ ok: true, result: plan.issued[names] });
})();
`,
  );
  chmodSync(bin, 0o755);
  const read = <T>(file: string) => {
    try {
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  };
  const state: Plan = { issued: {}, fail: [], windows: {} };
  return {
    bin,
    plan: (change: Partial<Plan>) => {
      Object.assign(state, change);
      writeFileSync(plan, JSON.stringify(state));
    },
    requests: () => read<Request>(requests),
    events: () => read<{ event: string; challenges?: unknown[] }>(events),
  };
}

describe("certificate issuance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-certd-"));
  const certd = fakeCertd(dir);
  certd.plan({});
  const { ctx, client } = await createTestContext({ EDGEWEIR_CERTD_BIN: certd.bin });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const names = ["a.issue.test", "b.issue.test", "c.issue.test"];
  let api: ApiClient;
  let clusterId = "";
  let applier: ReturnType<typeof setInterval> | undefined;
  let firstId = "";

  const request = async (domains: string[], email = "ops@example.com") => {
    const material = await ctx.nodeCa.issueServerCertificate(domains);
    certd.plan({
      issued: {
        ...JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).issued,
        [domains.join(",")]: {
          chainPem: material.certificatePem,
          privateKeyPem: material.privateKeyPem,
        },
      },
    });
    return api.certificates.request({
      name: domains[0] ?? "",
      names: domains,
      email,
      autoRenew: true,
    });
  };
  const row = async (id: string) => {
    const [found] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, id));
    if (!found) throw new Error("certificate missing");
    return found;
  };
  const accounts = () => ctx.db.select().from(schema.acmeAccount);

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await api.clusters.list())[0]?.id ?? "";
    await api.sites.create({
      name: "issue",
      domains: names,
      origins: [{ address: "origin.example.com" }],
    });
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        nodeGroupId: (await api.nodeGroups.list({ clusterId }))[0]?.id ?? "",
        name: "edge",
        lastSeenAt: new Date(),
        supportedFeatures: ["tls-v1", "http01-v1"],
      })
      .returning();
    if (!node) throw new Error("node missing");
    await ctx.db.insert(schema.nodeConfigStatus).values({ nodeId: node.id, state: "applied" });
    // The node applies every revision as soon as it is published.
    applier = setInterval(async () => {
      const latest = await latestRevision(ctx.db, clusterId);
      if (!latest) return;
      await ctx.db
        .update(schema.nodeConfigStatus)
        .set({ appliedRevision: latest.revision, appliedContentHash: latest.contentHash })
        .where(eq(schema.nodeConfigStatus.nodeId, node.id));
      await ctx.db
        .update(schema.node)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.node.id, node.id));
    }, 50);
  });
  afterAll(async () => {
    clearInterval(applier);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes all HTTP-01 challenges of an order in one revision and none for their cleanup", async () => {
    const { id } = await request(names);
    firstId = id;
    const before = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await issueCertificate(ctx, id);
    expect(await row(id)).toMatchObject({ status: "ready", names });
    // The CA chosen per certificate: no directory set for all.
    expect(await api.certificates.settings()).toEqual({
      acmeDirectory: null,
      acmeDirectoryEab: false,
      defaultCa: "letsencrypt",
    });
    expect((await row(id)).acme).toMatchObject({
      ca: "letsencrypt",
      directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
    });
    const published = await ctx.db
      .select()
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          gt(schema.configRevision.revision, before),
        ),
      );
    expect(published.map((r) => r.reasonCode)).toEqual(["acme_challenge_updated"]);
    expect(decodeNodeConfig(published[0]?.ir ?? new Uint8Array()).httpChallenges).toHaveLength(3);
    expect(certd.events().filter((e) => e.event.startsWith("http01."))).toEqual([
      expect.objectContaining({ event: "http01.present", challenges: expect.any(Array) }),
      expect.objectContaining({ event: "http01.cleanup" }),
    ]);
    expect(await ctx.db.select().from(schema.acmeChallenge)).toEqual([]);
  });

  it("shares one ACME account between certificates of the same CA, EAB key id and email", async () => {
    const [shared] = await accounts();
    expect(shared).toMatchObject({
      directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      eabKid: "",
      email: "ops@example.com",
    });
    expect(shared?.accountEnvelope).not.toContain("account-key");
    // The certificate keeps only its request, not the account.
    const first = await row(firstId);
    const request0 = ctx.masterKey
      .open(JSON.parse(first.accountEnvelope), certificateAccountBinding(first.id))
      .toString("utf8");
    expect(request0).toBe("{}");

    const second = await request(["a.issue.test"]);
    await issueCertificate(ctx, second.id);
    expect(certd.requests().at(-1)?.params.account).toMatchObject({
      privateKeyPem: `account-key-${names.join(",")}`,
    });
    expect(await accounts()).toHaveLength(1);

    const other = await request(["b.issue.test"], "other@example.com");
    await issueCertificate(ctx, other.id);
    expect(certd.requests().at(-1)?.params.account.registration).toBeUndefined();
    expect((await accounts()).map((a) => a.email).sort()).toEqual([
      "ops@example.com",
      "other@example.com",
    ]);
  });

  it("adopts a certificate's own account from before shared accounts", async () => {
    const legacy = await request(["c.issue.test"], "legacy@example.com");
    const account = {
      privateKeyPem: "legacy-account-key",
      registration: { uri: "https://acme-v02.api.letsencrypt.org/acme/acct/77", body: {} },
    };
    await ctx.db
      .update(schema.certificate)
      .set({
        accountEnvelope: JSON.stringify(
          ctx.masterKey.seal(JSON.stringify(account), certificateAccountBinding(legacy.id)),
        ),
      })
      .where(eq(schema.certificate.id, legacy.id));
    await issueCertificate(ctx, legacy.id);
    expect(certd.requests().at(-1)?.params.account).toMatchObject(account);
    expect((await accounts()).map((a) => a.email)).toContain("legacy@example.com");
    const stored = await row(legacy.id);
    expect(
      ctx.masterKey
        .open(JSON.parse(stored.accountEnvelope), certificateAccountBinding(legacy.id))
        .toString("utf8"),
    ).not.toContain("legacy-account-key");
  });

  it("retries a failed issuance after a tenth of the remaining validity", async () => {
    const hour = 3_600_000;
    const now = Date.now();
    expect(retryDelay(null, now)).toBe(hour);
    expect(retryDelay(new Date(now + 30 * 24 * hour), now)).toBe(12 * hour);
    expect(retryDelay(new Date(now + 24 * hour), now)).toBe(2.4 * hour);
    expect(retryDelay(new Date(now + hour), now)).toBe(10 * 60_000);
    expect(retryDelay(new Date(now - hour), now)).toBe(10 * 60_000);

    const [ready] = await api.certificates.list();
    const id = ready?.id ?? "";
    certd.plan({ fail: [(await row(id)).names.join(",")] });
    await ctx.db
      .update(schema.certificate)
      .set({ notAfter: new Date(Date.now() + 24 * hour), renewAt: new Date(0) })
      .where(eq(schema.certificate.id, id));
    await issueCertificate(ctx, id);
    const failed = await row(id);
    expect(failed.status).toBe("error");
    expect(failed.lastError).toBe("certd_failed");
    expect((failed.renewAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(2.3 * hour);
    expect((failed.renewAt?.getTime() ?? 0) - Date.now()).toBeLessThan(2.4 * hour);
    certd.plan({ fail: [] });
  });

  it("stores why an issuance failed as a code, never the helper's or the CA's text", async () => {
    const { id } = await request(["b.issue.test", "c.issue.test"], "codes@example.com");
    const names = "b.issue.test,c.issue.test";
    certd.plan({ fail: [names], failCode: "acme_caa" });
    await issueCertificate(ctx, id);
    expect(await row(id)).toMatchObject({ status: "error", lastError: "acme_caa" });
    expect((await api.certificates.list()).find((c) => c.id === id)?.lastError).toBe("acme_caa");
    // A code the console does not accept is not stored as it is.
    certd.plan({ failCode: "CA said: no" });
    await api.certificates.renew({ id });
    await issueCertificate(ctx, id);
    expect((await row(id)).lastError).toBe("certd_failed");
    // A manual renewal clears the reason until the next attempt.
    certd.plan({ fail: [], failCode: undefined });
    expect((await api.certificates.renew({ id })).lastError).toBe("");
    await issueCertificate(ctx, id);
    expect(await row(id)).toMatchObject({ status: "ready", lastError: "" });
  });

  it("stores the console's own reason when an HTTP-01 challenge cannot be published", async () => {
    // A name of a site in a cluster without nodes (inserted as the API refuses such a request).
    const lonely = await api.clusters.create({ name: "lonely" });
    await api.sites.create({
      name: "lonely",
      clusterId: lonely.id,
      domains: ["lonely.issue.test"],
      origins: [{ address: "origin.example.com" }],
    });
    const [cert] = await ctx.db
      .insert(schema.certificate)
      .values({
        name: "lonely",
        names: ["lonely.issue.test"],
        source: "acme",
        autoRenew: true,
        acme: { ca: "letsencrypt", challenge: "http01", email: "ops@example.com" },
      })
      .returning();
    if (!cert) throw new Error("certificate missing");
    await issueCertificate(ctx, cert.id);
    expect(await row(cert.id)).toMatchObject({ status: "error", lastError: "http01_no_nodes" });
  });

  it("takes requests and manual renewals first, then the longest overdue renewals", async () => {
    const all = await api.certificates.list();
    const [x, y] = all.filter((c) => c.status === "ready");
    if (!x || !y) throw new Error("certificates missing");
    const at = (id: string, hoursAgo: number) =>
      ctx.db
        .update(schema.certificate)
        .set({ renewAt: new Date(Date.now() - hoursAgo * 3_600_000) })
        .where(eq(schema.certificate.id, id));
    await at(x.id, 1);
    await at(y.id, 2);
    const pending = await request(["a.issue.test"]);
    expect(await dueCertificates(ctx)).toEqual([pending.id, y.id, x.id]);
    expect(await dueCertificates(ctx, 2)).toEqual([pending.id, y.id]);
    await sweepCertificates(ctx);
    expect(await dueCertificates(ctx)).toEqual([]);
  });

  it("moves a renewal into an earlier ARI window and asks again after the CA's Retry-After", async () => {
    const hour = 3_600_000;
    // Three certificates with different chains (the helper answers by chain).
    const rows = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.status, "ready"));
    const [early, later, unknown] = [...new Map(rows.map((r) => [r.chainPem, r])).values()];
    if (!early || !later || !unknown) throw new Error("certificates missing");
    const planned = new Date(Date.now() + 20 * 24 * hour);
    const ids = [early.id, later.id, unknown.id];
    await ctx.db
      .update(schema.certificate)
      .set({ renewAt: planned, renewalInfoAt: null })
      .where(inArray(schema.certificate.id, ids));
    const chain = async (id: string) => (await row(id)).chainPem;
    const window = (from: number, to: number, retryAfter?: number) => ({
      start: new Date(Date.now() + from * hour).toISOString(),
      end: new Date(Date.now() + to * hour).toISOString(),
      retryAfter,
    });
    certd.plan({
      windows: {
        [await chain(early.id)]: window(-1, 1, 2 * 3600),
        [await chain(later.id)]: window(30 * 24, 31 * 24),
      },
    });
    const now = Date.now();
    await checkRenewalInfo(ctx, now);
    const [moved, kept, none] = await Promise.all(ids.map(row));
    expect(moved?.renewAt?.getTime()).toBeGreaterThanOrEqual(now);
    expect(moved?.renewAt?.getTime()).toBeLessThanOrEqual(now + hour + 1000);
    expect(moved?.renewalInfoAt?.getTime()).toBe(now + 2 * hour);
    expect(kept?.renewAt).toEqual(planned);
    expect(kept?.renewalInfoAt?.getTime()).toBe(now + 6 * hour);
    expect(none?.renewAt).toEqual(planned);
    const [entry] = (await api.auditLogs.list({ action: "certificate.renewal_rescheduled" })).items;
    expect(entry).toMatchObject({ targetId: early.id });

    // Read again only when due; a failing helper tries again after an hour.
    const requests = certd.requests().length;
    await checkRenewalInfo(ctx, now + hour);
    expect(certd.requests()).toHaveLength(requests);
    certd.plan({ failRenewalInfo: true });
    await checkRenewalInfo(ctx, now + 7 * hour);
    expect((await row(later.id)).renewalInfoAt?.getTime()).toBe(now + 8 * hour);
    expect((await row(later.id)).renewAt).toEqual(planned);
    certd.plan({ failRenewalInfo: false });
  });

  it("deletes challenges a dead attempt left behind", async () => {
    const [cert] = await api.certificates.list();
    await ctx.db.insert(schema.acmeChallenge).values({
      certificateId: cert?.id ?? "",
      domain: "a.issue.test",
      token: "left-behind",
      keyAuthorization: "left-behind.thumbprint",
      expiresAt: new Date(Date.now() - 1000),
      operationStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    await sweepCertificates(ctx);
    expect(await ctx.db.select().from(schema.acmeChallenge)).toEqual([]);
  });

  it("keeps challenge revisions out of the retention count and deletes them after an hour", async () => {
    const latest = await latestRevision(ctx.db, clusterId);
    if (!latest) throw new Error("revision missing");
    const { id: _id, ...copy } = latest;
    const add = async (offset: number, reasonCode: string, minutesAgo: number) => {
      await ctx.db.insert(schema.configRevision).values({
        ...copy,
        revision: latest.revision + offset,
        reasonCode,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      });
      return latest.revision + offset;
    };
    const site1 = await add(1, "site_updated", 300);
    const challenge1 = await add(2, "acme_challenge_updated", 240);
    const site2 = await add(3, "site_updated", 180);
    const challenge2 = await add(4, "acme_challenge_updated", 120);
    const challenge3 = await add(5, "acme_challenge_updated", 10);
    const site3 = await add(6, "site_updated", 5);
    await pruneRevisions(ctx.db, 2);
    const left = await ctx.db
      .select({ revision: schema.configRevision.revision })
      .from(schema.configRevision)
      .where(eq(schema.configRevision.clusterId, clusterId));
    expect(left.map((r) => r.revision).sort((a, b) => a - b)).toEqual([site2, challenge3, site3]);
    expect([site1, challenge1, challenge2].some((r) => left.some((l) => l.revision === r))).toBe(
      false,
    );
  });

  describe("one-click HTTPS (audit S-2)", () => {
    /** The issued material for these names, as the fake CA answers. */
    const issuable = async (domains: string[]) => {
      const material = await ctx.nodeCa.issueServerCertificate(domains);
      certd.plan({
        issued: {
          ...JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).issued,
          [domains.join(",")]: {
            chainPem: material.certificatePem,
            privateKeyPem: material.privateKeyPem,
          },
        },
      });
      return material;
    };
    const site = async (name: string, domains: string[]) =>
      (await api.sites.create({ name, domains, origins: [{ address: "origin.example.com" }] })).site
        .id;
    const served = async (siteId: string) => {
      const config = decodeNodeConfig(
        (await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array(),
      );
      return config.sites.find((s) => s.id === siteId);
    };

    it("binds the issued certificate to the site, without an HTTPS redirect, and publishes it", async () => {
      const siteId = await site("bind", ["k1.issue.test"]);
      await issuable(["k1.issue.test"]);
      const { id } = await api.certificates.request({
        name: "bind",
        names: ["k1.issue.test"],
        email: "ops@example.com",
        bindSiteId: siteId,
      });
      // A domain added before the certificate is issued.
      await api.sites.update({ id: siteId, domains: ["k1.issue.test", "k2.issue.test"] });
      await issueCertificate(ctx, id);

      expect(await api.https.get({ id: siteId })).toMatchObject({
        certificateId: id,
        forceHttps: false,
      });
      const cert = (await api.certificates.list()).find((c) => c.id === id);
      expect(cert).toMatchObject({ bindSiteId: null, names: ["k1.issue.test", "k2.issue.test"] });
      // Reissued for the domain added meanwhile, which waits for it.
      expect(cert?.status).toBe("pending");
      const [entry] = (await api.auditLogs.list({ action: "site.https_update" })).items;
      expect(entry).toMatchObject({
        actorType: "system",
        targetId: siteId,
        metadata: { certificateId: id, certificate: "bind" },
      });
      const published = await served(siteId);
      expect(published).toMatchObject({ certificateId: id, tls: { forceHttps: false } });
      expect(published?.domains.map((d) => d.name)).toEqual(["k1.issue.test"]);

      await issuable(["k1.issue.test", "k2.issue.test"]);
      await issueCertificate(ctx, id);
      expect((await served(siteId))?.domains.map((d) => d.name)).toEqual([
        "k1.issue.test",
        "k2.issue.test",
      ]);
    });

    it("keeps a usable certificate the site got meanwhile, and a deleted site is skipped", async () => {
      const siteId = await site("keep", ["m1.issue.test"]);
      const uploaded = await issuable(["m1.issue.test"]);
      const own = await api.certificates.upload({
        name: "uploaded",
        chainPem: uploaded.certificatePem,
        privateKeyPem: uploaded.privateKeyPem,
      });
      const { id } = await api.certificates.request({
        name: "keep",
        names: ["m1.issue.test"],
        email: "ops@example.com",
        bindSiteId: siteId,
      });
      await api.https.update({
        id: siteId,
        settings: tlsSettings.parse({ certificateId: own.id }),
      });
      await issueCertificate(ctx, id);
      expect(await api.https.get({ id: siteId })).toMatchObject({
        certificateId: own.id,
        forceHttps: false,
      });
      expect(await row(id)).toMatchObject({ status: "ready" });
      expect((await row(id)).acme.bindSiteId).toBeUndefined();

      const gone = await site("gone", ["n1.issue.test"]);
      await issuable(["n1.issue.test"]);
      const orphan = await api.certificates.request({
        name: "gone",
        names: ["n1.issue.test"],
        email: "ops@example.com",
        bindSiteId: gone,
        skipDnsCheck: true,
      });
      await api.sites.update({ id: gone, domains: ["n1.issue.test", "n2.issue.test"] });
      await ctx.db.delete(schema.site).where(eq(schema.site.id, gone));
      await api.sites.create({
        name: "gone-again",
        domains: ["n1.issue.test"],
        origins: [{ address: "origin.example.com" }],
      });
      await issueCertificate(ctx, orphan.id);
      expect(await row(orphan.id)).toMatchObject({ status: "ready", names: ["n1.issue.test"] });
    });
  });

  describe("a site's new domains and its ACME certificate (audit U-3)", () => {
    let siteId = "";
    let certId = "";
    const servedDomains = async () => {
      const latest = await latestRevision(ctx.db, clusterId);
      const site = decodeNodeConfig(latest?.ir ?? new Uint8Array()).sites.find(
        (s) => s.id === siteId,
      );
      return site?.domains.map((d) => d.name);
    };
    /** The issued material for these names, as the fake CA answers. */
    const issuable = async (domains: string[]) => {
      const material = await ctx.nodeCa.issueServerCertificate(domains);
      certd.plan({
        issued: {
          ...JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).issued,
          [domains.join(",")]: {
            chainPem: material.certificatePem,
            privateKeyPem: material.privateKeyPem,
          },
        },
      });
    };

    it("extends the certificate, reissues it, and serves the new domain once it is covered", async () => {
      siteId = (
        await api.sites.create({
          name: "grow",
          domains: ["g1.issue.test"],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      certId = (await request(["g1.issue.test"], "grow@example.com")).id;
      await issueCertificate(ctx, certId);
      await api.https.update({
        id: siteId,
        settings: tlsSettings.parse({ certificateId: certId }),
      });

      const saved = await api.sites.update({
        id: siteId,
        domains: ["g1.issue.test", "g2.issue.test"],
      });
      expect(saved.certificateReissue).toEqual({ id: certId, name: "g1.issue.test" });
      expect(await row(certId)).toMatchObject({
        names: ["g1.issue.test", "g2.issue.test"],
        status: "pending",
        lastError: "",
      });
      const [entry] = (await api.auditLogs.list({ action: "certificate.names_extended" })).items;
      expect(entry).toMatchObject({
        targetId: certId,
        metadata: { siteId, site: "grow", added: ["g2.issue.test"] },
      });
      // Nodes keep the current chain; the new domain waits for the reissue.
      expect(await servedDomains()).toEqual(["g1.issue.test"]);
      // The site's HTTPS settings can still be saved meanwhile.
      await api.https.update({
        id: siteId,
        settings: tlsSettings.parse({ certificateId: certId, hstsMaxAge: 60 }),
      });
      // Saving again adds nothing.
      expect(
        (await api.sites.update({ id: siteId, domains: ["g1.issue.test", "g2.issue.test"] }))
          .certificateReissue,
      ).toBeUndefined();

      await issuable(["g1.issue.test", "g2.issue.test"]);
      expect(await dueCertificates(ctx)).toContain(certId);
      await issueCertificate(ctx, certId);
      expect(await row(certId)).toMatchObject({
        status: "ready",
        names: ["g1.issue.test", "g2.issue.test"],
      });
      expect(await servedDomains()).toEqual(["g1.issue.test", "g2.issue.test"]);
    });

    it("keeps names added while an attempt runs and reissues right after it", async () => {
      const hold = join(dir, "hold");
      certd.plan({ hold });
      await ctx.db
        .update(schema.certificate)
        .set({ renewAt: new Date(0) })
        .where(eq(schema.certificate.id, certId));
      const running = issueCertificate(ctx, certId);
      await vi.waitFor(async () => expect((await row(certId)).status).toBe("issuing"), {
        timeout: 10_000,
      });
      const saved = await api.sites.update({
        id: siteId,
        domains: ["g1.issue.test", "g2.issue.test", "g3.issue.test"],
      });
      expect(saved.certificateReissue).toEqual({ id: certId, name: "g1.issue.test" });
      // The running attempt is left alone.
      expect((await row(certId)).status).toBe("issuing");
      writeFileSync(hold, "");
      await running;
      certd.plan({ hold: undefined });
      expect(await row(certId)).toMatchObject({
        status: "pending",
        names: ["g1.issue.test", "g2.issue.test", "g3.issue.test"],
      });
      await issuable(["g1.issue.test", "g2.issue.test", "g3.issue.test"]);
      await issueCertificate(ctx, certId);
      expect(await row(certId)).toMatchObject({ status: "ready" });
      expect(await servedDomains()).toEqual(["g1.issue.test", "g2.issue.test", "g3.issue.test"]);
    });

    it("refuses domains the certificate's challenge cannot validate", async () => {
      const refused = await rpcError(
        api.sites.update({
          id: siteId,
          domains: ["g1.issue.test", "g2.issue.test", "g3.issue.test", "*.wild.issue.test"],
        }),
      );
      expect(refused).toMatchObject({
        code: "CERTIFICATE_DOMAIN_MISMATCH",
        data: { domains: "*.wild.issue.test" },
      });
      expect((await row(certId)).names).toEqual([
        "g1.issue.test",
        "g2.issue.test",
        "g3.issue.test",
      ]);
    });

    it("serves new domains over HTTP meanwhile where every node has tls-pending-domains-v1 (audit S-2)", async () => {
      const latest = async () =>
        decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
      const domains = async () =>
        (await latest()).sites
          .find((s) => s.id === siteId)
          ?.domains.map((d) => ({ name: d.name, tlsPending: d.tlsPending }));
      const features = (supportedFeatures: string[]) =>
        ctx.db
          .update(schema.node)
          .set({ supportedFeatures })
          .where(eq(schema.node.clusterId, clusterId));
      await features(["tls-v1", "http01-v1", "tls-pending-domains-v1"]);
      try {
        const all = ["g1.issue.test", "g2.issue.test", "g3.issue.test", "g4.issue.test"];
        await api.sites.update({ id: siteId, domains: all });
        expect(await domains()).toEqual([
          { name: "g1.issue.test", tlsPending: false },
          { name: "g2.issue.test", tlsPending: false },
          { name: "g3.issue.test", tlsPending: false },
          { name: "g4.issue.test", tlsPending: true },
        ]);
        expect((await latest()).requiredFeatures).toContain("tls-pending-domains-v1");
        // A rollback to it needs no cover for the waiting domain.
        const waiting = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
        await api.https.update({
          id: siteId,
          settings: tlsSettings.parse({ certificateId: certId, hstsMaxAge: 120 }),
        });
        await api.clusters.rollback({ id: clusterId, revision: waiting });
        expect((await domains())?.find((d) => d.name === "g4.issue.test")?.tlsPending).toBe(true);
        await issuable(all);
        await issueCertificate(ctx, certId);
        expect(await row(certId)).toMatchObject({ status: "ready", names: all });
        expect((await domains())?.every((d) => !d.tlsPending)).toBe(true);
        expect((await latest()).requiredFeatures).not.toContain("tls-pending-domains-v1");
      } finally {
        await features(["tls-v1", "http01-v1"]);
      }
    });
  });
});
