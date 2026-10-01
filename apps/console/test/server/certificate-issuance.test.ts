import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

// How issuance publishes HTTP-01 challenges, which ACME account it uses,
// when it runs and retries, and how it follows the CA's renewal windows
// (audit 2026-10-01 P1-26, P1-27, P1-29).

type Plan = {
  /** Issued material by requested names ("a,b"). */
  issued: Record<string, { chainPem: string; privateKeyPem: string }>;
  fail: string[];
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
  if (plan.fail.includes(names)) return done({ ok: false });
  const challenges = p.domains.map((domain, i) => ({ domain, token: "t" + process.pid + "-" + i + "-abcdefghijklmnop", keyAuthorization: "t" + process.pid + "-" + i + ".thumbprint" }));
  await send({ event: "http01.present", challenges });
  await send({ event: "http01.cleanup", challenges: challenges.map(({ domain, token }) => ({ domain, token })) });
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
    expect((failed.renewAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(2.3 * hour);
    expect((failed.renewAt?.getTime() ?? 0) - Date.now()).toBeLessThan(2.4 * hour);
    certd.plan({ fail: [] });
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
});
