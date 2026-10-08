import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import type { CaaRecord } from "node:dns";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_CERT_FEATURE,
  decodeNodeConfig,
  MULTI_CERTIFICATE_FEATURE,
} from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { ClientCertificateMode } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { AddressResolver } from "../../src/server/lib/dns-check";
import { generateCa } from "../../src/server/pki/ca";
import { reconcileAcmeCertificates } from "../../src/server/services/acme-accounts";
import { issueCertificate } from "../../src/server/services/certificate-worker";
import { certificateAccountBinding } from "../../src/server/services/certificates";
import { checkHttps } from "../../src/server/services/https-check";
import { latestRevision } from "../../src/server/services/revisions";
import {
  rotateSessionTicketKeys,
  SESSION_TICKET_KEY_BYTES,
  sessionTicketKeySecrets,
} from "../../src/server/services/session-ticket-keys";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";
import { leafFor } from "./key-types";

const missing = "00000000-0000-4000-8000-000000000000";
const origins = [{ address: "origin.example.com" }];

/** A resolver answering A and CAA lookups from a table. */
function fakeResolver(table: Record<string, { v4?: string[]; caa?: CaaRecord[] }>) {
  const fail = (name: string) => {
    throw Object.assign(new Error("no data"), { code: table[name] ? "ENODATA" : "ENOTFOUND" });
  };
  return {
    resolve4: async (name: string) => table[name]?.v4 ?? fail(name),
    resolve6: async (name: string) => fail(name),
    resolveCaa: async (name: string) => table[name]?.caa ?? fail(name),
  } satisfies AddressResolver;
}

/** A stand-in for edgeweir-certd that records each request and fails it as unauthorized. */
function recordingCertd(dir: string) {
  const requests = join(dir, "requests.jsonl");
  const bin = join(dir, "certd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const lines = require("node:readline").createInterface({ input: process.stdin })[Symbol.asyncIterator]();
(async () => {
  const request = JSON.parse((await lines.next()).value);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(request) + "\\n");
  process.stdout.write(JSON.stringify({ ok: false, code: "acme_unauthorized", error: "no" }) + "\\n");
  process.exit(1);
})();
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    requests: (): { command: string; params: Record<string, unknown> }[] => {
      try {
        return readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

/** An HTTPS ACME directory on localhost, trusted through `caPem`. */
async function acmeDirectoryServer(
  certificatePem: string,
  privateKeyPem: string,
  body: () => unknown,
): Promise<{ server: Server; url: string }> {
  const server = createServer({ cert: certificatePem, key: privateKeyPem }, (req, res) => {
    if (req.url !== "/dir") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `https://localhost:${(server.address() as AddressInfo).port}/dir` };
}

describe("several certificates, client certificates, session tickets and ACME CAs (G11)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-g11-"));
  const certd = recordingCertd(dir);
  const { ctx, client: pglite } = await createTestContext({ EDGEWEIR_CERTD_BIN: certd.bin });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  ctx.resolver = fakeResolver({});
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  /** ECDSA certificate for shop.g11.test; RSA certificate for shop.g11.test; ECDSA one for api.g11.test. */
  const certs = { ec: "", rsa: "", api: "", other: "" };
  const clientCa = await generateCa("G11 client CA");
  let directory: { server: Server; url: string };
  let directoryMeta: Record<string, unknown> = { caaIdentities: ["Ca.Example.Test"] };

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
    return decodeNodeConfig(row.ir);
  };
  const upload = async (name: string, pem: { certificatePem: string; privateKeyPem: string }) =>
    (
      await admin.certificates.upload({
        name,
        chainPem: pem.certificatePem,
        privateKeyPem: pem.privateKeyPem,
      })
    ).id;
  const https = (settings: Record<string, unknown>) =>
    admin.https.update({ id: siteId, settings: settings as never });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.g11.test", "api.g11.test"],
        origins,
      })
    ).site.id;
    certs.ec = await upload("shop ec", await ctx.nodeCa.issueServerCertificate(["shop.g11.test"]));
    certs.rsa = await upload(
      "shop rsa",
      await leafFor(generateKeyPairSync("rsa", { modulusLength: 2048 }), ["shop.g11.test"]),
    );
    certs.api = await upload("api", await ctx.nodeCa.issueServerCertificate(["api.g11.test"]));
    certs.other = await upload("other", await ctx.nodeCa.issueServerCertificate(["x.g11.test"]));
    // An online node that answers HTTP-01 and has the G11 features.
    await ctx.db.insert(schema.node).values({
      clusterId,
      nodeGroupId: (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "",
      name: "edge-g11",
      lastSeenAt: new Date(),
      supportedFeatures: ["tls-v1", "http01-v1", MULTI_CERTIFICATE_FEATURE, CLIENT_CERT_FEATURE],
    });
    const server = await ctx.nodeCa.issueServerCertificate(["localhost"]);
    directory = await acmeDirectoryServer(server.certificatePem, server.privateKeyPem, () => ({
      newNonce: "https://localhost/nonce",
      newAccount: "https://localhost/account",
      newOrder: "https://localhost/order",
      meta: directoryMeta,
    }));
  });

  afterAll(async () => {
    directory?.server.close();
    await pglite.close();
  });

  describe("several certificates per site (5.1)", () => {
    it("needs every domain covered by one of the certificates (their union)", async () => {
      // Neither certificate alone covers both domains.
      expect((await rpcError(https({ certificateId: certs.ec }))).code).toBe(
        "CERTIFICATE_DOMAIN_MISMATCH",
      );
      const uncovered = await rpcError(
        https({ certificateId: certs.ec, additionalCertificateIds: [certs.other] }),
      );
      expect([uncovered.code, (uncovered.data as { domains: string }).domains]).toEqual([
        "CERTIFICATE_DOMAIN_MISMATCH",
        "api.g11.test",
      ]);
      const saved = await https({
        certificateId: certs.ec,
        additionalCertificateIds: [certs.rsa, certs.api],
      });
      expect(saved.additionalCertificateIds).toEqual([certs.rsa, certs.api]);
      // Stored in the site's order, not sorted.
      expect((await admin.https.get({ id: siteId })).additionalCertificateIds).toEqual([
        certs.rsa,
        certs.api,
      ]);
      const rows = await ctx.db
        .select()
        .from(schema.siteCertificate)
        .where(eq(schema.siteCertificate.siteId, siteId));
      expect(rows.map((r) => [r.certificateId, r.position]).sort()).toEqual(
        [
          [certs.rsa, 1],
          [certs.api, 2],
        ].sort(),
      );
      // The certificates stay out of tls_settings.
      const [site] = await ctx.db.select().from(schema.site).where(eq(schema.site.id, siteId));
      expect(site?.tlsSettings).not.toHaveProperty("additionalCertificateIds");
      expect(site?.tlsSettings).not.toHaveProperty("certificateId");
    });

    it("compiles the additional certificates in order with their references and the feature", async () => {
      const compiled = await config();
      const site = compiled.sites.find((s) => s.id === siteId);
      expect(site?.certificateId).toBe(certs.ec);
      expect(site?.additionalCertificateIds).toEqual([certs.rsa, certs.api]);
      expect(compiled.certificates.map((c) => c.id).sort()).toEqual(
        [certs.ec, certs.rsa, certs.api].sort(),
      );
      expect(compiled.requiredFeatures).toContain(MULTI_CERTIFICATE_FEATURE);
    });

    it("refuses duplicate, too many and first-less additional certificates", async () => {
      for (const settings of [
        { certificateId: certs.ec, additionalCertificateIds: [certs.rsa, certs.rsa] },
        { certificateId: certs.ec, additionalCertificateIds: [certs.ec] },
        { certificateId: null, additionalCertificateIds: [certs.rsa] },
        {
          certificateId: certs.ec,
          additionalCertificateIds: [certs.rsa, certs.api, certs.other, missing],
        },
      ])
        expect((await rpcError(https(settings))).code, JSON.stringify(settings)).toBe(
          "BAD_REQUEST",
        );
      expect(
        (await rpcError(https({ certificateId: certs.ec, additionalCertificateIds: [missing] })))
          .code,
      ).toBe("CERTIFICATE_NOT_FOUND");
    });

    it("refuses deleting a certificate a site uses as an additional one", async () => {
      const refused = await rpcError(admin.certificates.delete({ id: certs.api }));
      expect([refused.code, (refused.data as { sites: string }).sites]).toEqual([
        "CERTIFICATE_IN_USE",
        "shop",
      ]);
    });

    it("lets a site's other certificate cover a new domain", async () => {
      // api.g11.test stays covered by the third certificate; shop.g11.test by the first.
      const result = await admin.sites.update({
        id: siteId,
        domains: ["shop.g11.test", "api.g11.test"],
      });
      expect(result.certificateReissue).toBeUndefined();
      const refused = await rpcError(
        admin.sites.update({
          id: siteId,
          domains: ["shop.g11.test", "api.g11.test", "new.g11.test"],
        }),
      );
      expect(refused.code).toBe("CERTIFICATE_DOMAIN_MISMATCH");
    });

    it("reports the union on the launch check", async () => {
      const launch = await admin.sites.launch({ id: siteId });
      expect([
        launch.certificate.state,
        launch.certificate.id,
        launch.certificate.uncovered,
      ]).toEqual(["covered", certs.ec, []]);
    });

    it("drops the further certificates and client certificates together with the first", async () => {
      const cleared = await https({ certificateId: null, additionalCertificateIds: [] });
      expect(cleared.additionalCertificateIds).toEqual([]);
      expect(
        await ctx.db
          .select()
          .from(schema.siteCertificate)
          .where(eq(schema.siteCertificate.siteId, siteId)),
      ).toEqual([]);
      await https({ certificateId: certs.ec, additionalCertificateIds: [certs.rsa, certs.api] });
    });
  });

  describe("client certificates (5.2)", () => {
    it("compiles mode, the re-encoded CA, depth and header forwarding with the feature", async () => {
      const saved = await https({
        certificateId: certs.ec,
        additionalCertificateIds: [certs.api],
        clientCertificate: {
          mode: "required",
          caPem: `# comment\n${clientCa.certificatePem}`,
          depth: 3,
          forwardHeaders: true,
        },
      });
      // Only the certificate is kept.
      expect(saved.clientCertificate.caPem).toBe(clientCa.certificatePem);
      const site = (await config()).sites.find((s) => s.id === siteId);
      expect(site?.clientCertificate?.mode).toBe(ClientCertificateMode.REQUIRED);
      expect(site?.clientCertificate?.caPem).toBe(clientCa.certificatePem);
      expect(site?.clientCertificate?.depth).toBe(3);
      expect(site?.clientCertificate?.forwardHeaders).toBe(true);
      expect((await config()).requiredFeatures).toContain(CLIENT_CERT_FEATURE);
      expect((await admin.https.get({ id: siteId })).clientCertificate.mode).toBe("required");
    });

    it("refuses a CA bundle that is not 1-10 current CA certificates", async () => {
      const leaf = await ctx.nodeCa.issueServerCertificate(["leaf.g11.test"]);
      const tooMany = Array.from({ length: 11 }, () => clientCa.certificatePem).join("");
      for (const caPem of [
        leaf.certificatePem,
        tooMany,
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        `${clientCa.certificatePem}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`,
      ]) {
        const error = await rpcError(
          https({
            certificateId: certs.ec,
            additionalCertificateIds: [certs.api],
            clientCertificate: { mode: "optional", caPem },
          }),
        );
        expect(error.code).toBe("CLIENT_CA_INVALID");
      }
    });

    it("refuses client certificates together with HTTP/3 and without a CA or certificate", async () => {
      const error = await rpcError(
        https({
          certificateId: certs.ec,
          additionalCertificateIds: [certs.api],
          http3: true,
          clientCertificate: { mode: "optional", caPem: clientCa.certificatePem },
        }),
      );
      expect(error.code).toBe("CLIENT_CERTIFICATE_HTTP3");
      expect(
        (
          await rpcError(
            https({
              certificateId: certs.ec,
              additionalCertificateIds: [certs.api],
              clientCertificate: { mode: "required", caPem: "" },
            }),
          )
        ).code,
      ).toBe("BAD_REQUEST");
    });

    it("leaves client certificates out of the configuration when off", async () => {
      await https({
        certificateId: certs.ec,
        additionalCertificateIds: [certs.api],
        clientCertificate: { mode: "off", caPem: clientCa.certificatePem },
      });
      const site = (await config()).sites.find((s) => s.id === siteId);
      expect(site?.clientCertificate).toBeUndefined();
      expect((await config()).requiredFeatures).not.toContain(CLIENT_CERT_FEATURE);
    });
  });

  describe("session ticket keys (5.3)", () => {
    it("carries the cluster's three keys once a site has a certificate", async () => {
      const keys = (await config()).sessionTicketKeys;
      expect(keys.map((k) => k.role).sort()).toEqual(["current", "next", "previous"]);
      expect(keys.map((k) => k.id)).toEqual([...keys.map((k) => k.id)].sort());
      // No node feature: older nodes ignore them.
      expect((await config()).requiredFeatures).not.toContain("tls-session-v1");
    });

    it("hands each key's 80-byte secret to nodes of the cluster only", async () => {
      const ids = (await config()).sessionTicketKeys.map((k) => k.id);
      const first = await sessionTicketKeySecrets(ctx, clusterId, ids);
      expect(first).toHaveLength(3);
      for (const key of first) expect(key.secret).toHaveLength(SESSION_TICKET_KEY_BYTES);
      // The same secrets for every node, and none for another cluster.
      expect(await sessionTicketKeySecrets(ctx, clusterId, ids)).toEqual(first);
      const other = await admin.clusters.create({ name: "elsewhere" });
      expect(await sessionTicketKeySecrets(ctx, other.id, ids)).toEqual([]);
      expect(await sessionTicketKeySecrets(ctx, clusterId, ["not-a-uuid", missing])).toEqual([]);
      const [row] = await ctx.db
        .select()
        .from(schema.sessionTicketKey)
        .where(eq(schema.sessionTicketKey.id, ids[0] ?? ""));
      expect(row?.secret).not.toContain(Buffer.from(first[0]?.secret ?? []).toString("base64"));
    });

    it("rotates twelve-hourly with a new revision and an audit entry", async () => {
      const before = await config();
      expect(await rotateSessionTicketKeys(ctx, new Date(Date.now() + 3_600_000))).toEqual([]);
      const later = new Date(Date.now() + 12 * 3_600_000 + 60_000);
      expect(await rotateSessionTicketKeys(ctx, later)).toEqual([clusterId]);
      const after = await config();
      expect(after.revision).toBeGreaterThan(before.revision);
      const role = (c: typeof before, r: string) =>
        c.sessionTicketKeys.find((k) => k.role === r)?.id;
      expect(role(after, "current")).toBe(role(before, "next"));
      expect(role(after, "previous")).toBe(role(before, "current"));
      expect(after.sessionTicketKeys.map((k) => k.id)).not.toContain(role(before, "previous"));
      const [entry] = (await admin.auditLogs.list({ action: "cluster.session_ticket_keys_rotate" }))
        .items;
      expect(entry?.metadata).toMatchObject({ droppedKeyId: role(before, "previous") });
      // The entry names ids only, never secrets.
      expect(JSON.stringify(entry)).not.toMatch(/secret/i);
    });
  });

  describe("certificate authorities and the custom ACME directory (5.4)", () => {
    it("shows no custom directory by default and refuses requests for one", async () => {
      const setting = await admin.settings.acmeDirectory();
      expect([setting.source, setting.effectiveUrl, setting.caSource]).toEqual([
        "default",
        "",
        "default",
      ]);
      expect(await admin.certificates.settings()).toEqual({
        acmeDirectory: null,
        acmeDirectoryEab: false,
        defaultCa: "letsencrypt",
      });
      const refused = await rpcError(
        admin.certificates.request({
          name: "custom",
          names: ["shop.g11.test"],
          email: "ops@example.com",
          ca: "custom",
          challenge: "http01",
        }),
      );
      expect(refused.code).toBe("ACME_DIRECTORY_NOT_CONFIGURED");
    });

    it("requires EAB for ZeroSSL and Google Trust Services", async () => {
      for (const ca of ["zerossl", "google"] as const)
        expect(
          (
            await rpcError(
              admin.certificates.request({
                name: ca,
                names: ["shop.g11.test"],
                email: "ops@example.com",
                ca,
                challenge: "http01",
              }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
    });

    it("saves a directory after reading it, with its CA certificates and CAA identities", async () => {
      // Untrusted without the CA certificates, and no directory without newOrder.
      expect((await rpcError(admin.settings.setAcmeDirectory({ url: directory.url }))).code).toBe(
        "ACME_DIRECTORY_INVALID",
      );
      expect(
        (
          await rpcError(
            admin.settings.setAcmeDirectory({
              url: directory.url,
              caPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
            }),
          )
        ).code,
      ).toBe("ACME_DIRECTORY_CA_INVALID");
      expect(
        (
          await rpcError(
            admin.settings.setAcmeDirectory({
              url: directory.url,
              caPem: ctx.nodeCa.certificatePem,
              eabKid: "kid-1",
            }),
          )
        ).code,
      ).toBe("ACME_DIRECTORY_EAB_INCOMPLETE");
      const saved = await admin.settings.setAcmeDirectory({
        url: directory.url,
        caPem: ctx.nodeCa.certificatePem,
        eabKid: "kid-1",
        eabHmacKey: "hmac-secret-1",
      });
      expect(saved).toMatchObject({
        url: directory.url,
        effectiveUrl: directory.url,
        source: "setting",
        eabKid: "kid-1",
        eabHmacKeySet: true,
        caPem: ctx.nodeCa.certificatePem,
        caSource: "setting",
        caaIdentities: ["ca.example.test"],
      });
      // Write-only: the HMAC key never comes back, nor lands in the audit log.
      expect(JSON.stringify(saved)).not.toContain("hmac-secret-1");
      const [entry] = (await admin.auditLogs.list({ action: "system.acme_directory_update" }))
        .items;
      expect(JSON.stringify(entry)).not.toContain("hmac-secret-1");
      // Saving again with the same key id keeps the HMAC key.
      const kept = await admin.settings.setAcmeDirectory({
        url: directory.url,
        caPem: ctx.nodeCa.certificatePem,
        eabKid: "kid-1",
      });
      expect(kept.eabHmacKeySet).toBe(true);
      expect(await admin.certificates.settings()).toEqual({
        acmeDirectory: directory.url,
        acmeDirectoryEab: true,
        defaultCa: "letsencrypt",
      });
    });

    it("checks CAA against the chosen CA's issuer domains", async () => {
      const table: Parameters<typeof fakeResolver>[0] = {
        "shop.g11.test": { v4: ["192.0.2.1"], caa: [{ critical: 0, issue: "pki.goog" }] },
      };
      ctx.resolver = fakeResolver(table);
      const blocked = (check: Awaited<ReturnType<typeof checkHttps>>) =>
        check.blockers
          .filter((b) => b.code === "caa_forbidden")
          .map((b) => (b as { name: string }).name);
      expect(blocked(await checkHttps(ctx, siteId, "google"))).toEqual([]);
      expect(blocked(await checkHttps(ctx, siteId, "letsencrypt"))).toContain("shop.g11.test");
      // The custom directory's caaIdentities.
      expect(blocked(await checkHttps(ctx, siteId, "custom"))).toContain("shop.g11.test");
      table["shop.g11.test"] = {
        v4: ["192.0.2.1"],
        caa: [{ critical: 0, issue: "ca.example.test" }],
      };
      expect(blocked(await checkHttps(ctx, siteId, "custom"))).toEqual([]);
      ctx.resolver = fakeResolver({});
    });

    it("issues from the custom directory with its CA, EAB key and the requested key type", async () => {
      const requested = await admin.certificates.request({
        name: "rsa custom",
        names: ["api.g11.test"],
        email: "ops@example.com",
        ca: "custom",
        keyType: "rsa2048",
        challenge: "http01",
        skipDnsCheck: true,
      });
      await issueCertificate(ctx, requested.id);
      const sent = certd.requests().at(-1);
      expect(sent?.params).toMatchObject({
        directoryUrl: directory.url,
        rootCa: ctx.nodeCa.certificatePem,
        keyType: "rsa2048",
        account: { eabKid: "kid-1", eabHmacKey: "hmac-secret-1" },
      });
      const [row] = await ctx.db
        .select()
        .from(schema.certificate)
        .where(eq(schema.certificate.id, requested.id));
      expect([row?.acme.ca, row?.acme.keyType, row?.lastError]).toEqual([
        "custom",
        "rsa2048",
        "acme_unauthorized",
      ]);

      const ec = await admin.certificates.request({
        name: "ec letsencrypt",
        names: ["shop.g11.test"],
        email: "ops@example.com",
        challenge: "http01",
        skipDnsCheck: true,
      });
      await issueCertificate(ctx, ec.id);
      expect(certd.requests().at(-1)?.params).toMatchObject({
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        keyType: "ec256",
      });
      expect(certd.requests().at(-1)?.params.rootCa).toBeUndefined();
    });

    it("falls back to EDGEWEIR_ACME_DIRECTORY and its CA file per value", async () => {
      const caFile = join(dir, "acme-ca.pem");
      writeFileSync(caFile, ctx.nodeCa.certificatePem);
      ctx.env.EDGEWEIR_ACME_DIRECTORY = "https://env.example.test/directory";
      ctx.env.EDGEWEIR_ACME_CA_FILE = caFile;
      try {
        // The saved directory still wins, with its own CA certificates.
        expect((await admin.settings.acmeDirectory()).source).toBe("setting");
        // Cleared: the environment's URL and CA file, no EAB, custom by default.
        await admin.settings.setAcmeDirectory({ url: "" });
        const env = await admin.settings.acmeDirectory();
        expect(env).toMatchObject({
          url: "",
          effectiveUrl: "https://env.example.test/directory",
          source: "environment",
          eabKid: "",
          eabHmacKeySet: false,
          caPem: "",
          caSource: "environment",
          caaIdentities: [],
        });
        expect(await admin.certificates.settings()).toEqual({
          acmeDirectory: "https://env.example.test/directory",
          acmeDirectoryEab: false,
          defaultCa: "custom",
        });
        // A saved URL without CA certificates trusts EDGEWEIR_ACME_CA_FILE's.
        const saved = await admin.settings.setAcmeDirectory({ url: directory.url });
        expect([saved.source, saved.caSource, saved.eabHmacKeySet]).toEqual([
          "setting",
          "environment",
          false,
        ]);
        expect((await admin.certificates.settings()).defaultCa).toBe("letsencrypt");
      } finally {
        ctx.env.EDGEWEIR_ACME_DIRECTORY = "";
        ctx.env.EDGEWEIR_ACME_CA_FILE = "";
      }
    });

    it("reads the CAA identities a directory lists, if any", async () => {
      directoryMeta = {};
      const saved = await admin.settings.setAcmeDirectory({
        url: directory.url,
        caPem: ctx.nodeCa.certificatePem,
      });
      expect(saved.caaIdentities).toEqual([]);
      directoryMeta = { caaIdentities: ["Ca.Example.Test"] };
      await admin.settings.setAcmeDirectory({
        url: directory.url,
        caPem: ctx.nodeCa.certificatePem,
        eabKid: "kid-1",
        eabHmacKey: "hmac-secret-1",
      });
    });
  });

  describe("ACME accounts (5.4)", () => {
    it("lists accounts with their CA and certificates, and deletes only unused ones", async () => {
      const [used] = await ctx.db
        .insert(schema.acmeAccount)
        .values({
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
          email: "used@example.com",
          accountEnvelope: "{}",
        })
        .returning();
      const [unused] = await ctx.db
        .insert(schema.acmeAccount)
        .values({
          directoryUrl: directory.url,
          eabKid: "kid-1",
          email: "unused@example.com",
          accountEnvelope: "{}",
        })
        .returning();
      const [cert] = await ctx.db
        .insert(schema.certificate)
        .values({ name: "linked", source: "acme", acmeAccountId: used?.id })
        .returning();
      const accounts = await admin.acmeAccounts.list();
      expect(accounts.find((a) => a.id === used?.id)).toMatchObject({
        ca: "letsencrypt",
        email: "used@example.com",
        eabKid: "",
        certificates: 1,
      });
      expect(accounts.find((a) => a.id === unused?.id)).toMatchObject({
        ca: "custom",
        eabKid: "kid-1",
        certificates: 0,
      });
      const refused = await rpcError(admin.acmeAccounts.delete({ id: used?.id ?? "" }));
      expect([refused.code, (refused.data as { certificates: string }).certificates]).toEqual([
        "ACME_ACCOUNT_IN_USE",
        "linked",
      ]);
      expect(await admin.acmeAccounts.delete({ id: unused?.id ?? "" })).toEqual({ ok: true });
      expect((await rpcError(admin.acmeAccounts.delete({ id: unused?.id ?? "" }))).code).toBe(
        "ACME_ACCOUNT_NOT_FOUND",
      );
      const [entry] = (await admin.auditLogs.list({ action: "acme_account.delete" })).items;
      expect(entry).toMatchObject({ targetId: unused?.id, targetName: "unused@example.com" });
      await ctx.db.delete(schema.certificate).where(eq(schema.certificate.id, cert?.id ?? ""));
    });

    it("links certificates issued before accounts were linked and marks environment-era ones custom", async () => {
      const [account] = await ctx.db
        .insert(schema.acmeAccount)
        .values({
          directoryUrl: "https://env.example.test/directory",
          eabKid: "k",
          email: "old@example.com",
          accountEnvelope: "{}",
        })
        .returning();
      const id = crypto.randomUUID();
      await ctx.db.insert(schema.certificate).values({
        id,
        name: "old",
        source: "acme",
        acme: {
          ca: "letsencrypt",
          email: "old@example.com",
          challenge: "http01",
          directoryUrl: "https://env.example.test/directory",
        },
        accountEnvelope: JSON.stringify(
          ctx.masterKey.seal(JSON.stringify({ eabKid: "k" }), certificateAccountBinding(id)),
        ),
      });
      const builtIn = crypto.randomUUID();
      await ctx.db.insert(schema.certificate).values({
        id: builtIn,
        name: "le",
        source: "acme",
        acme: {
          ca: "letsencrypt",
          email: "le@example.com",
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        },
      });
      expect(await reconcileAcmeCertificates(ctx)).toBe(2);
      const rows = await ctx.db.select().from(schema.certificate);
      const old = rows.find((r) => r.id === id);
      expect([old?.acme.ca, old?.acmeAccountId]).toEqual(["custom", account?.id]);
      expect(rows.find((r) => r.id === builtIn)?.acme.ca).toBe("letsencrypt");
      // Nothing left to do.
      expect(await reconcileAcmeCertificates(ctx)).toBe(0);
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const reads: [string, string][] = [
      ["GET", "/settings/acme-directory"],
      ["GET", "/acme-accounts"],
      ["GET", `/sites/${siteId}/https`],
      ["GET", "/certificates/settings"],
    ];
    const writes: [string, string, unknown][] = [
      ["PUT", "/settings/acme-directory", { url: "" }],
      ["DELETE", `/acme-accounts/${missing}`, undefined],
      [
        "PUT",
        `/sites/${siteId}/https`,
        { settings: { certificateId: certs.ec, additionalCertificateIds: [certs.api] } },
      ],
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
    // Nothing changed; a write key reaches them.
    expect((await admin.settings.acmeDirectory()).source).toBe("setting");
    expect((await api(writer, "DELETE", `/acme-accounts/${missing}`)).json.code).toBe(
      "ACME_ACCOUNT_NOT_FOUND",
    );
    const written = await api(writer, "PUT", `/sites/${siteId}/https`, {
      settings: { certificateId: certs.ec, additionalCertificateIds: [certs.api] },
    });
    expect(written.status).toBe(200);
  });
});
