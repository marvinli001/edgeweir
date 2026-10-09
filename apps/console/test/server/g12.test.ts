import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ACCESS_AUTH_FEATURE, decodeNodeConfig } from "@edgeweir/config-compiler";
import type { SiteAuthRulesInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { AuthKind, NodeService } from "@edgeweir/proto";
import { checkSignedUri } from "@edgeweir/rule-engine";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  accessAuthSecretBinding,
  BASIC_HASH_ITERATIONS,
  verifyBasicPassword,
} from "../../src/server/lib/access-auth-secrets";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { signAuthUrl, updateAuthRules } from "../../src/server/services/auth-rules";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { latestRevision } from "../../src/server/services/revisions";
import { ingestMinuteStats } from "../../src/server/services/stats";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const service = {
  actor: { type: "service_account" as const, id: "service-account-g12", name: "integration" },
};
const PASSWORD = "correct horse battery";
const KEY = "url-signing-key-0123456789";
const BACKUP = "backup-signing-key-abcdefghij";
const scope = (extra: Partial<Record<string, string[]>> = {}) => ({
  domains: [],
  pathPrefixes: [],
  extensions: [],
  excludePathPrefixes: [],
  ...extra,
});
type Rules = SiteAuthRulesInput["rules"];
const basic = (users: { name: string; password?: string }[], extra = {}): Rules[number] => ({
  kind: "basic",
  enabled: true,
  scope: scope({ pathPrefixes: ["/admin"] }),
  basic: { realm: "Shop admin", keepAuthorization: false, userHeader: true, users },
  ...extra,
});
const url = (
  kind: "url_a" | "url_b" | "url_c" | "url_d",
  keys: object,
  extra = {},
): Rules[number] => ({
  kind,
  enabled: true,
  scope: scope({ extensions: ["mp4"] }),
  url: { validitySeconds: 1800, skewSeconds: 300, signParam: "sign", timeParam: "t", ...keys },
  ...extra,
});
const forward = (address: string, extra = {}): Rules[number] => ({
  kind: "forward",
  enabled: true,
  scope: scope({ pathPrefixes: ["/app/"] }),
  forward: {
    url: `https://${address}/verify`,
    method: "GET",
    timeoutMs: 2000,
    requestHeaders: ["cookie", "authorization", "x-token"],
    responseHeaders: ["x-auth-user"],
    cacheSeconds: 30,
    passRedirects: true,
    allowUnavailable: false,
  },
  ...extra,
});

async function nodeKeyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=edge-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem };
}

describe("access authentication (G12)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const config = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return { row, ir: decodeNodeConfig(row.ir) };
  };
  const siteRules = async (id = siteId) =>
    (await config()).ir.sites.find((s) => s.id === id)?.authRules ?? [];
  const rows = (id = siteId) =>
    ctx.db
      .select()
      .from(schema.siteAuthRule)
      .where(eq(schema.siteAuthRule.siteId, id))
      .orderBy(schema.siteAuthRule.position);
  const secretOf = (row: { id: string; secretEnvelope: string | null }) =>
    JSON.parse(
      ctx.masterKey
        .open(JSON.parse(row.secretEnvelope ?? "null"), accessAuthSecretBinding(row.id))
        .toString("utf8"),
    );
  const save = async (rules: Rules) =>
    admin.authRules.update({
      id: siteId,
      rules,
      expectedUpdatedAt: (await admin.authRules.get({ id: siteId })).updatedAt ?? undefined,
    });
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  /** Every place a password, hash or key could leak to: the IR, revisions, audits. */
  const leaks = async (secrets: string[]) => {
    const { row } = await config();
    const revisions = await ctx.db.select().from(schema.configRevision);
    const audit = await ctx.db.select().from(schema.auditLog);
    const text = [
      Buffer.from(row.ir).toString("latin1"),
      ...revisions.map((r) => Buffer.from(r.ir).toString("latin1")),
      JSON.stringify(audit),
    ].join("\n");
    return secrets.filter((s) => text.includes(s));
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.g12.test", "*.cdn.g12.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    otherSiteId = (
      await admin.sites.create({
        name: "other",
        domains: ["other.g12.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g12",
        lastSeenAt: new Date(),
        supportedFeatures: ["tls-v1", ACCESS_AUTH_FEATURE],
      })
      .returning();
    nodeId = node?.id ?? "";
  });

  afterAll(() => pglite.close());

  describe("validation (6.1-6.4)", () => {
    it("refuses rules that nodes could not use", async () => {
      const refused = async (rules: unknown) =>
        (await rpcError(admin.authRules.update({ id: siteId, rules: rules as Rules }))).code;
      expect(
        await refused(Array.from({ length: 17 }, () => basic([{ name: "a", password: PASSWORD }]))),
      ).toBe("BAD_REQUEST");
      // A kind with another kind's settings, or none.
      expect(await refused([{ kind: "basic", scope: scope(), url: { primaryKey: KEY } }])).toBe(
        "BAD_REQUEST",
      );
      expect(await refused([{ kind: "url_b", scope: scope() }])).toBe("BAD_REQUEST");
      // Users: names without ":", 1-64 characters; passwords 8-128 characters; at most 100.
      expect(await refused([basic([{ name: "a:b", password: PASSWORD }])])).toBe("BAD_REQUEST");
      expect(await refused([basic([{ name: "a".repeat(65), password: PASSWORD }])])).toBe(
        "BAD_REQUEST",
      );
      expect(await refused([basic([{ name: "a", password: "short" }])])).toBe("BAD_REQUEST");
      expect(await refused([basic([{ name: "a", password: "x".repeat(129) }])])).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused([
          basic(Array.from({ length: 101 }, (_, i) => ({ name: `u${i}`, password: PASSWORD }))),
        ]),
      ).toBe("BAD_REQUEST");
      expect(
        await refused([
          basic([
            { name: "a", password: PASSWORD },
            { name: "a", password: PASSWORD },
          ]),
        ]),
      ).toBe("BAD_REQUEST");
      // Realm without quotes; scope lists bounded.
      expect(
        await refused([
          {
            ...basic([{ name: "a", password: PASSWORD }]),
            basic: { realm: 'a"b', users: [{ name: "a", password: PASSWORD }] },
          },
        ]),
      ).toBe("BAD_REQUEST");
      expect(
        await refused([
          url(
            "url_a",
            { primaryKey: KEY },
            { scope: scope({ pathPrefixes: Array.from({ length: 33 }, (_, i) => `/p${i}`) }) },
          ),
        ]),
      ).toBe("BAD_REQUEST");
      expect(
        await refused([
          url(
            "url_a",
            { primaryKey: KEY },
            { scope: scope({ extensions: Array.from({ length: 65 }, (_, i) => `e${i}`) }) },
          ),
        ]),
      ).toBe("BAD_REQUEST");
      // Keys 16-128 printable characters; parameter names; D's two names differ.
      expect(await refused([url("url_a", { primaryKey: "short" })])).toBe("BAD_REQUEST");
      expect(await refused([url("url_a", { primaryKey: KEY, signParam: "a b" })])).toBe(
        "BAD_REQUEST",
      );
      expect(
        await refused([url("url_d", { primaryKey: KEY, signParam: "s", timeParam: "s" })]),
      ).toBe("BAD_REQUEST");
      expect(await refused([url("url_a", { primaryKey: KEY, validitySeconds: 31_536_001 })])).toBe(
        "BAD_REQUEST",
      );
      expect(await refused([url("url_a", { primaryKey: KEY, skewSeconds: 601 })])).toBe(
        "BAD_REQUEST",
      );
      // Forward authentication: http(s) URL without credentials, timeout 0.1-10 s, headers.
      for (const address of ["user:pw@auth.test", "auth.test/x#frag", "auth.test:70000"])
        expect(await refused([forward(address)])).toBe("BAD_REQUEST");
      expect(
        await refused([
          { ...forward("auth.test"), forward: { ...forward("auth.test").forward, timeoutMs: 99 } },
        ]),
      ).toBe("BAD_REQUEST");
      expect(
        await refused([
          {
            ...forward("auth.test"),
            forward: { ...forward("auth.test").forward, requestHeaders: ["host"] },
          },
        ]),
      ).toBe("BAD_REQUEST");
      expect(
        await refused([
          {
            ...forward("auth.test"),
            forward: { ...forward("auth.test").forward, responseHeaders: ["set-cookie"] },
          },
        ]),
      ).toBe("BAD_REQUEST");
      // Rules are not saved by a refused call.
      expect(await rows()).toEqual([]);
    });

    it("checks scope domains, new users' passwords, keys and the authentication service's address", async () => {
      expect(
        (
          await rpcError(
            save([
              url("url_a", { primaryKey: KEY }, { scope: scope({ domains: ["other.g12.test"] }) }),
            ]),
          )
        ).code,
      ).toBe("AUTH_DOMAIN_UNKNOWN");
      expect((await rpcError(save([basic([{ name: "alice" }])]))).code).toBe(
        "AUTH_PASSWORD_REQUIRED",
      );
      expect((await rpcError(save([url("url_b", {})]))).code).toBe("AUTH_KEY_REQUIRED");
      expect((await rpcError(save([forward("127.0.0.1:8080")]))).code).toBe(
        "ORIGIN_ADDRESS_FORBIDDEN",
      );
      expect((await rpcError(save([forward("[::1]")]))).code).toBe("ORIGIN_ADDRESS_FORBIDDEN");
      const unknown = "00000000-0000-4000-8000-000000000000";
      expect(
        (await rpcError(save([{ ...basic([{ name: "a", password: PASSWORD }]), id: unknown }])))
          .code,
      ).toBe("AUTH_RULE_NOT_FOUND");
    });
  });

  describe("Basic (6.2)", () => {
    it("stores salted PBKDF2 hashes sealed with the master key, never in the IR, audit or response", async () => {
      const saved = await save([
        basic([
          { name: "alice", password: PASSWORD },
          { name: "bob", password: `${PASSWORD}!` },
        ]),
      ]);
      expect(saved.rules).toEqual([
        {
          id: expect.any(String),
          kind: "basic",
          enabled: true,
          scope: scope({ pathPrefixes: ["/admin"] }),
          basic: {
            realm: "Shop admin",
            keepAuthorization: false,
            userHeader: true,
            users: [{ name: "alice" }, { name: "bob" }],
          },
          forward: null,
          url: null,
        },
      ]);
      expect(JSON.stringify(saved)).not.toMatch(/pbkdf2|horse/);
      const [row] = await rows();
      if (!row) throw new Error("rule missing");
      expect(row.secretEnvelope).not.toContain("horse");
      const secret = secretOf(row);
      expect(secret.users.map((u: { name: string }) => u.name)).toEqual(["alice", "bob"]);
      const hash = secret.users[0].hash as string;
      expect(hash).toMatch(
        new RegExp(`^pbkdf2-sha256\\$${BASIC_HASH_ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`),
      );
      expect(await verifyBasicPassword(PASSWORD, hash)).toBe(true);
      expect(await verifyBasicPassword(`${PASSWORD}!`, hash)).toBe(false);
      // Another salt for another user with a similar password.
      expect(secret.users[1].hash.split("$")[2]).not.toBe(hash.split("$")[2]);
      // The envelope is bound to the rule: another row's id does not open it.
      expect(() =>
        ctx.masterKey.open(
          JSON.parse(row.secretEnvelope ?? ""),
          accessAuthSecretBinding(otherSiteId),
        ),
      ).toThrow();

      const [rule] = await siteRules();
      expect(rule).toMatchObject({
        id: row.id,
        kind: AuthKind.BASIC,
        pathPrefixes: ["/admin"],
        credentialId: row.id,
        credentialVersion: 1n,
        basic: { realm: "Shop admin", keepAuthorization: false, userHeader: true },
      });
      const { ir, row: revision } = await config();
      expect(ir.requiredFeatures).toContain(ACCESS_AUTH_FEATURE);
      expect(revision.reasonCode).toBe("site_auth_updated");
      expect(await leaks([PASSWORD, hash, hash.split("$")[3] as string, "alice"])).toEqual([]);
      const [audit] = (await audits("site.auth_update")).slice(-1);
      expect(audit?.metadata).toMatchObject({
        from: [],
        to: [{ id: row.id, kind: "basic", enabled: true, users: 2, secretChanged: true }],
      });
    });

    it("keeps hashes for users saved without a password and bumps the version on any change", async () => {
      const [before] = await rows();
      if (!before) throw new Error("rule missing");
      const revision = (await config()).row.revision;
      // Same users, no passwords: nothing changes (no new revision either).
      await save([basic([{ name: "alice" }, { name: "bob" }], { id: before.id })]);
      const [kept] = await rows();
      expect([kept?.secretEnvelope, kept?.secretVersion]).toEqual([before.secretEnvelope, 1]);
      expect((await config()).row.revision).toBe(revision);
      // A new password: another hash, version 2, nodes fetch it again.
      await save([
        basic([{ name: "alice", password: "another password" }, { name: "bob" }], {
          id: before.id,
        }),
      ]);
      const [changed] = await rows();
      expect(changed?.secretVersion).toBe(2);
      const users = secretOf(changed as never).users;
      expect(await verifyBasicPassword("another password", users[0].hash)).toBe(true);
      expect(users[1].hash).toBe(secretOf(before as never).users[1].hash);
      expect((await siteRules())[0]?.credentialVersion).toBe(2n);
      // Removing a user is a change too; a renamed user needs a password.
      await save([basic([{ name: "alice" }], { id: before.id })]);
      expect((await rows())[0]?.secretVersion).toBe(3);
      expect((await rpcError(save([basic([{ name: "carol" }], { id: before.id })]))).code).toBe(
        "AUTH_PASSWORD_REQUIRED",
      );
      // A stale read is refused.
      expect(
        (
          await rpcError(
            admin.authRules.update({
              id: siteId,
              rules: [],
              expectedUpdatedAt: new Date(0).toISOString(),
            }),
          )
        ).code,
      ).toBe("UPDATED_AT_MISMATCH");
    });
  });

  describe("URL authentication A-D (6.4)", () => {
    it("seals primary and backup keys, keeps them when left out and removes the backup on null", async () => {
      const saved = await save([url("url_b", { primaryKey: KEY, backupKey: BACKUP })]);
      const id = saved.rules[0]?.id ?? "";
      expect(saved.rules[0]?.url).toEqual({
        validitySeconds: 1800,
        skewSeconds: 300,
        signParam: "sign",
        timeParam: "t",
        backupKey: true,
      });
      expect(JSON.stringify(saved)).not.toContain(KEY);
      const [row] = await rows();
      expect(secretOf(row as never)).toEqual({ keys: [KEY, BACKUP] });
      // The Basic rule it replaced is gone, with its secret.
      expect(await rows()).toHaveLength(1);
      await save([url("url_b", {}, { id })]);
      expect((await rows())[0]?.secretVersion).toBe(1);
      await save([url("url_b", { backupKey: null }, { id })]);
      const [removed] = await rows();
      expect([secretOf(removed as never), removed?.secretVersion]).toEqual([{ keys: [KEY] }, 2]);
      expect((await admin.authRules.get({ id: siteId })).rules[0]?.url?.backupKey).toBe(false);
      // Changing the kind keeps a URL key; Basic needs passwords again.
      await save([url("url_d", {}, { id })]);
      expect((await rows())[0]?.kind).toBe("url_d");
      expect((await rpcError(save([basic([{ name: "alice" }], { id })]))).code).toBe(
        "AUTH_PASSWORD_REQUIRED",
      );
      const rule = (await siteRules())[0];
      expect(rule?.kind).toBe(AuthKind.URL_D);
      expect(rule?.url).toMatchObject({
        validitySeconds: 1800,
        skewSeconds: 300,
        signParam: "sign",
        timeParam: "t",
      });
      expect(await leaks([KEY, BACKUP])).toEqual([]);
    });

    it("signs URLs with the primary key for at most the rule's validity, without storing them", async () => {
      const now = Date.UTC(2026, 9, 9, 12, 0, 0);
      const saved = await save([
        url("url_a", { primaryKey: KEY, validitySeconds: 600 }),
        url("url_c", { primaryKey: BACKUP }),
        basic([{ name: "alice", password: PASSWORD }]),
      ]);
      const [a, c, b] = saved.rules;
      if (!a || !c || !b) throw new Error("rules missing");
      const signed = await signAuthUrl(
        ctx.db,
        ctx.masterKey,
        { id: siteId, ruleId: a.id, url: "/videos/a b.mp4?w=1", validitySeconds: 60 },
        { actor: { type: "user", id: "user_admin" } },
        now,
      );
      // Valid for 60 s: ts = now - (600 - 60).
      const ts = now / 1000 - 540;
      expect(signed.expiresAt).toBe(new Date((ts + 600) * 1000).toISOString());
      expect(signed.url).toMatch(
        new RegExp(`^/videos/a%20b\\.mp4\\?w=1&sign=${ts}-[0-9a-f]{16}-[0-9a-f]{32}$`),
      );
      const check = {
        keys: [KEY],
        validitySeconds: 600,
        skewSeconds: 300,
        signParam: "sign",
        timeParam: "t",
      };
      expect(checkSignedUri("url_a", signed.url, { ...check, now: now / 1000 })).toEqual({
        outcome: "ok",
        stripped: "/videos/a%20b.mp4?w=1",
      });
      expect(
        checkSignedUri("url_a", signed.url, { ...check, skewSeconds: 0, now: now / 1000 + 61 })
          .outcome,
      ).toBe("expired");
      // Absolute URLs of the site's domains (wildcards included) keep their origin.
      const absolute = await admin.authRules.signUrl({
        id: siteId,
        ruleId: c.id,
        url: "https://img.cdn.g12.test/p.jpg",
      });
      expect(absolute.url).toMatch(/^https:\/\/img\.cdn\.g12\.test\/[0-9a-f]{32}\/[0-9]+\/p\.jpg$/);
      expect(
        checkSignedUri("url_c", new URL(absolute.url).pathname, {
          ...check,
          keys: [BACKUP],
          validitySeconds: 1800,
          now: Math.floor(Date.now() / 1000),
        }).outcome,
      ).toBe("ok");
      for (const bad of [
        "https://other.g12.test/a",
        "ftp://shop.g12.test/a",
        "//shop.g12.test/a",
        "a.mp4",
        "https://u:p@shop.g12.test/a",
      ])
        expect(
          (await rpcError(admin.authRules.signUrl({ id: siteId, ruleId: a.id, url: bad }))).code,
          bad,
        ).toBe("AUTH_SIGN_URL_INVALID");
      expect(
        (
          await rpcError(
            admin.authRules.signUrl({ id: siteId, ruleId: a.id, url: "/a", validitySeconds: 601 }),
          )
        ).code,
      ).toBe("AUTH_SIGN_VALIDITY");
      expect(
        (await rpcError(admin.authRules.signUrl({ id: siteId, ruleId: b.id, url: "/a" }))).code,
      ).toBe("AUTH_RULE_NOT_URL");
      expect(
        (await rpcError(admin.authRules.signUrl({ id: otherSiteId, ruleId: a.id, url: "/a" })))
          .code,
      ).toBe("AUTH_RULE_NOT_FOUND");
      // Audited without the signature or the key.
      const entries = await audits("site.auth_sign_url");
      expect(entries.at(-1)?.metadata).toMatchObject({ ruleId: c.id, path: "/p.jpg" });
      expect(JSON.stringify(entries)).not.toMatch(/sign=|[0-9a-f]{32}\/[0-9]+/);
      expect(await leaks([KEY, BACKUP])).toEqual([]);
    });
  });

  describe("forward authentication (6.3)", () => {
    it("compiles the settings without a secret; private addresses need the origin allow list", async () => {
      expect((await rpcError(save([forward("10.20.0.5:9000")]))).code).toBe(
        "ORIGIN_ADDRESS_FORBIDDEN",
      );
      await admin.settings.setOriginAllowList({ cidrs: ["10.20.0.0/16"] });
      const saved = await save([
        forward("10.20.0.5:9000"),
        forward("auth.example.com", { enabled: false }),
      ]);
      expect(saved.rules[0]?.forward).toMatchObject({
        url: "https://10.20.0.5:9000/verify",
        requestHeaders: ["authorization", "cookie", "x-token"],
        responseHeaders: ["x-auth-user"],
      });
      const [row] = await rows();
      expect([row?.secretEnvelope, row?.secretVersion]).toEqual([null, 0]);
      // Disabled rules are not shipped.
      const rules = await siteRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        kind: AuthKind.FORWARD,
        credentialId: "",
        forward: {
          url: "https://10.20.0.5:9000/verify",
          head: false,
          timeoutMs: 2000,
          cacheSeconds: 30,
          passRedirects: true,
          allowUnavailable: false,
        },
      });
      await admin.settings.setOriginAllowList({ cidrs: [] });
    });

    it("drops scope domains the site no longer has (the rule then covers every domain)", async () => {
      await save([
        url(
          "url_a",
          { primaryKey: KEY },
          { scope: scope({ domains: ["*.cdn.g12.test", "shop.g12.test"] }) },
        ),
      ]);
      expect((await siteRules())[0]?.domains).toEqual(["*.cdn.g12.test", "shop.g12.test"]);
      await admin.sites.update({ id: siteId, domains: ["shop.g12.test"] });
      expect((await siteRules())[0]?.domains).toEqual(["shop.g12.test"]);
      await admin.sites.update({ id: siteId, domains: ["shop.g12.test", "*.cdn.g12.test"] });
    });
  });

  describe("nodes (0.4, 0.5)", () => {
    it("holds rules for changes without the operator while a node lacks access-auth-v1", async () => {
      await setNodeFeatures(["tls-v1"]);
      try {
        expect((await admin.sites.features({ id: siteId })).accessAuth).toEqual({
          available: false,
          reason: "nodes",
        });
        await save([]);
        const before = (await config()).row.revision;
        expect(
          await rpcError(
            updateAuthRules(
              ctx.db,
              ctx.masterKey,
              { id: siteId, rules: [url("url_a", { primaryKey: KEY }) as never] },
              service,
            ),
          ),
        ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
        expect((await config()).row.revision).toBe(before);
        expect((await config()).ir.requiredFeatures).not.toContain(ACCESS_AUTH_FEATURE);
      } finally {
        await setNodeFeatures(["tls-v1", ACCESS_AUTH_FEATURE]);
      }
      expect((await admin.sites.features({ id: siteId })).accessAuth).toEqual({
        available: true,
        reason: null,
      });
    });

    it("hands the secrets to nodes of the site's cluster only, over the node channel", async () => {
      const own = await save([
        basic([{ name: "alice", password: PASSWORD }]),
        url("url_a", { primaryKey: KEY }),
      ]);
      const otherCluster = await admin.clusters.create({ name: "elsewhere" });
      const foreign = (
        await admin.sites.create({
          name: "far",
          domains: ["far.g12.test"],
          clusterId: otherCluster.id,
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      const far = await admin.authRules.update({
        id: foreign,
        rules: [url("url_b", { primaryKey: BACKUP })],
      });
      const channel: NodeChannel = await startNodeChannel(ctx);
      try {
        const address = channel.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const baseUrl = `https://localhost:${address.port}`;
        const [user] = await ctx.db.select({ id: schema.user.id }).from(schema.user);
        const token = await createEnrollmentToken(
          ctx.db,
          { clusterId, nodeName: "edge-g12-channel", ttlMinutes: 10 },
          {
            actor: { type: "user", id: user?.id ?? "" },
            consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
            serverUrl: ctx.env.nodeApiUrl,
            caSha256: ctx.nodeCa.fingerprintSha256,
          },
        );
        const { csrPem, keyPem } = await nodeKeyAndCsr();
        const enrolled = await createClient(
          NodeService,
          createConnectTransport({
            baseUrl,
            httpVersion: "2",
            nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
          }),
        ).enroll({
          token: token.token,
          csrPem,
          info: { supportedFeatures: ["tls-v1", ACCESS_AUTH_FEATURE] },
        });
        const mtls = createClient(
          NodeService,
          createConnectTransport({
            baseUrl,
            httpVersion: "2",
            nodeOptions: {
              ca: enrolled.caCertificatePem,
              cert: enrolled.certificatePem,
              key: keyPem,
              servername: "localhost",
            },
          }),
        );
        const ids = [...own.rules.map((r) => r.id), ...far.rules.map((r) => r.id)];
        const { credentials } = await mtls.getOriginCredentials({ ids });
        expect(credentials.map((c) => c.id).sort()).toEqual(own.rules.map((r) => r.id).sort());
        const byId = new Map(credentials.map((c) => [c.id, c]));
        const users = JSON.parse(byId.get(own.rules[0]?.id ?? "")?.secretAccessKey ?? "{}").users;
        expect(users[0].name).toBe("alice");
        expect(await verifyBasicPassword(PASSWORD, users[0].hash)).toBe(true);
        expect(byId.get(own.rules[1]?.id ?? "")).toMatchObject({
          version: 1n,
          accessKeyId: "",
          secretAccessKey: JSON.stringify({ keys: [KEY] }),
        });
      } finally {
        await channel.close();
      }
    });
  });

  it("counts failures per site and range from the nodes' minute statistics", async () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const bucket = (site: string, authFailures: number) => ({
      minute,
      siteId: site,
      requests: 20,
      bytesSent: 0,
      bytesReceived: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: { "401": authFailures },
      authFailures,
    });
    await ingestMinuteStats(ctx.db, { id: nodeId, clusterId }, [
      bucket(siteId, 4),
      bucket(otherSiteId, 9),
    ]);
    await ingestMinuteStats(ctx.db, { id: nodeId, clusterId }, [bucket(siteId, 3)]);
    expect(await admin.authRules.failures({ id: siteId, range: "1h" })).toEqual({
      requests: 7,
      unsupportedNodes: 0,
    });
    expect((await admin.authRules.failures({ id: otherSiteId })).requests).toBe(9);
    // Long ranges read the hourly rollups, before and after they are built.
    expect((await admin.authRules.failures({ id: siteId, range: "7d" })).requests).toBe(7);
    await rollupTraffic(ctx.db, new Date(minute.getTime() + 2 * 3600_000));
    expect((await admin.authRules.failures({ id: siteId, range: "7d" })).requests).toBe(7);
    // A negative or unsafe count drops the bucket.
    await ingestMinuteStats(ctx.db, { id: nodeId, clusterId }, [bucket(siteId, -1)]);
    expect((await admin.authRules.failures({ id: siteId, range: "1h" })).requests).toBe(7);
    await setNodeFeatures(["tls-v1"]);
    expect((await admin.authRules.failures({ id: siteId })).unsupportedNodes).toBe(1);
    await setNodeFeatures(["tls-v1", ACCESS_AUTH_FEATURE]);
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const rule = (await admin.authRules.get({ id: siteId })).rules.find((r) => r.kind === "url_a");
    if (!rule) throw new Error("rule missing");
    const reads: [string, string][] = [
      ["GET", `/sites/${siteId}/auth-rules`],
      ["GET", `/sites/${siteId}/auth-rules/failures`],
    ];
    const writes: [string, string, unknown][] = [
      ["PUT", `/sites/${siteId}/auth-rules`, { rules: [] }],
      ["POST", `/sites/${siteId}/auth-rules/${rule.id}/sign`, { url: "/a.mp4" }],
    ];
    for (const [method, path] of reads) {
      expect((await api(reader, method, path)).status, `${method} ${path}`).toBe(200);
      const refused = await api(key, method, path);
      expect([refused.status, refused.json.code], `${method} ${path}`).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect([readOnly.status, readOnly.json.code], `${method} ${path}`).toEqual([
        403,
        "ACCESS_KEY_READ_ONLY",
      ]);
      const refused = await api(key, method, path, body);
      expect([refused.status, refused.json.code], `${method} ${path}`).toEqual([
        403,
        "SERVICE_ACCOUNT_FORBIDDEN",
      ]);
    }
    // Nothing changed; a write key reaches them. The API never returns a key.
    const listed = await api(writer, "GET", `/sites/${siteId}/auth-rules`);
    expect(JSON.stringify(listed.json)).not.toContain(KEY);
    expect((await rows()).length).toBeGreaterThan(0);
    const signed = await api(writer, "POST", `/sites/${siteId}/auth-rules/${rule.id}/sign`, {
      url: "/a.mp4",
    });
    expect(signed.status).toBe(200);
    expect(String(signed.json.url)).toMatch(/^\/a\.mp4\?sign=/);
    expect((await api(writer, "PUT", `/sites/${siteId}/auth-rules`, { rules: [] })).status).toBe(
      200,
    );
    expect(await rows()).toEqual([]);
  });
});
