import "reflect-metadata";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  IMAGE_CONVERT_DEFAULTS,
  SITE_COPY_PARTS,
  type SiteCopyPart,
  type SiteCreateInput,
  tlsSettings,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { accessAuthSecretBinding } from "../../src/server/lib/access-auth-secrets";
import { PURGE_KEY, siteSecretBinding } from "../../src/server/lib/site-secrets";
import { latestRevision } from "../../src/server/services/revisions";
import {
  COMPRESSION_KEYS,
  COPY_PARTS,
  clonePorts,
  HTTPS_KEYS,
  stableJson,
  TLS_KEPT_KEYS,
} from "../../src/server/services/site-copy";
import { findSite, s3SecretBinding } from "../../src/server/services/sites";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const BASIC_PASSWORD = "g17 basic password";
const URL_KEY = "g17-url-signing-key-0123";
const PURGE = "g17-purge-key-0123456789";
const S3_SECRET = "g17-s3-secret-value";

describe("site tags, batch operations, copying settings and cloning (G17)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let otherClusterId = "";
  let sourceId = "";
  let certificate = "";
  let lists: { block: string; allow: string; bots: string };
  let counter = 0;

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const audits = (action: string, targetId?: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, action),
          targetId ? eq(schema.auditLog.targetId, targetId) : undefined,
        ),
      )
      .orderBy(schema.auditLog.id);
  const revisionOf = async (cluster = clusterId) =>
    (await latestRevision(ctx.db, cluster))?.revision;
  const compiled = async (siteId: string, cluster = clusterId) => {
    const row = await latestRevision(ctx.db, cluster);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir).sites.find((site) => site.id === siteId);
  };
  /** A part of a site's settings as the copy reads it. */
  const read = async (part: SiteCopyPart, siteId: string) =>
    stableJson(
      await COPY_PARTS[part].read(ctx.db, await findSite(ctx.db, siteId), {
        masterKey: ctx.masterKey,
      }),
    );
  const readAll = async (siteId: string) =>
    Object.fromEntries(
      await Promise.all(SITE_COPY_PARTS.map(async (part) => [part, await read(part, siteId)])),
    ) as Record<SiteCopyPart, string>;
  const newSite = async (input: Partial<SiteCreateInput> = {}) => {
    counter += 1;
    return (
      await admin.sites.create({
        name: `site-${counter}`,
        domains: [`site-${counter}.g17.test`],
        origins: [{ address: "origin.example.com" }, { address: "eu.example.com", group: "eu" }],
        ...input,
      })
    ).site;
  };
  const withCertificate = async (siteId: string, domain: string) => {
    const pem = await ctx.nodeCa.issueServerCertificate([domain]);
    const cert = await admin.certificates.upload({
      name: domain,
      chainPem: pem.certificatePem,
      privateKeyPem: pem.privateKeyPem,
    });
    await admin.https.update({
      id: siteId,
      settings: tlsSettings.parse({ certificateId: cert.id }),
    });
    return cert.id;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    otherClusterId = (await admin.clusters.create({ name: "eu" })).id;
    lists = {
      block: (await admin.ipLists.create({ name: "g17_block", entries: ["203.0.113.0/24"] })).id,
      allow: (await admin.ipLists.create({ name: "g17_allow", entries: ["198.51.100.7"] })).id,
      bots: (await admin.ipLists.create({ name: "g17_bots", entries: ["192.0.2.0/24"] })).id,
    };

    // The source: every part away from its defaults.
    const source = await admin.sites.create({
      name: "source",
      domains: ["source.g17.test"],
      origins: [{ address: "origin.example.com" }, { address: "eu.example.com", group: "eu" }],
      cacheRules: [
        { pathPrefixes: ["/static/"], edgeTtlSeconds: 86_400, staleIfErrorSeconds: 600 },
        { expression: "ip.src in $g17_bots", action: "bypass" },
      ],
      cacheSettings: {
        cacheKey: { query: "exclude", queryParams: ["utm_*"], sortQuery: true, deviceType: true },
        rangeSlice: true,
        keepCacheTag: true,
        xCache: false,
        purgeMethod: { enabled: true, key: PURGE },
      },
      originSettings: {
        policy: "round_robin",
        maxFails: 5,
        readTimeoutMs: 120_000,
        websocket: false,
        tries: 2,
        statusRetry: false,
        activeHealthCheck: { enabled: true, path: "/healthz" },
        sessionAffinity: { enabled: true, ttlSeconds: 600 },
      },
      contentSettings: {
        charset: { name: "utf-8" },
        requestBodyLimit: 1_048_576,
        rulesBodyLimit: 131_072,
      },
      tags: ["Production", "shop"],
    });
    sourceId = source.site.id;
    certificate = await withCertificate(sourceId, "source.g17.test");
    await admin.https.update({
      id: sourceId,
      settings: tlsSettings.parse({
        certificateId: certificate,
        forceHttps: true,
        hstsMaxAge: 31_536_000,
        minimumVersion: "1.3",
        http3: true,
        ocspStapling: true,
        redirectStatus: 308,
        brotli: true,
        brotliLevel: 5,
        gzipLevel: 6,
        gzipTypes: ["text/html", "application/json"],
        compressMaxLength: 10_485_760,
        redirectExcludedDomains: ["source.g17.test"],
      }),
    });
    await admin.rules.save({
      id: sourceId,
      rules: [
        {
          name: "media",
          phase: "origin",
          enabled: true,
          expression: 'starts_with(http.request.uri.path, "/media/")',
          action: { kind: "origin", originGroup: "eu" },
        },
        {
          name: "bots",
          phase: "waf-custom",
          enabled: true,
          expression: "ip.src in $g17_bots",
          action: { kind: "block" },
        },
      ],
    });
    await admin.bulkRedirects.save({
      id: sourceId,
      redirects: [
        { source: "/old", target: "/new", statusCode: 301 },
        {
          source: "/promo",
          target: "https://promo.example.com/",
          statusCode: 302,
          preserveQuery: true,
        },
      ],
    });
    await admin.errorPages.update({
      id: sourceId,
      pages: [
        { status: 404, template: "<h1>gone {{path}}</h1>" },
        { status: "5xx", redirectUrl: "https://status.example.com/" },
      ],
      interceptOriginErrors: true,
    });
    await admin.waf.update({ id: sourceId, mode: "block", paranoiaLevel: 2, anomalyThreshold: 7 });
    await admin.protection.update({
      id: sourceId,
      underAttackChallenge: "pow",
      passTtlSeconds: 3600,
      powDifficulty: 18,
      powHighDifficulty: 22,
      cc: { enabled: true, followTemplate: false },
      allowVerifiedBots: true,
      challengeText: { titleZh: "请稍候", hintZh: "", titleEn: "One moment", hintEn: "" },
      failureBan: { enabled: true, threshold: 5, banSeconds: 900 },
      logJa4: true,
    });
    await admin.accessControl.update({
      id: sourceId,
      siteLists: { blockListIds: [lists.block], allowListIds: [lists.allow] },
      cors: { enabled: true, allowedOrigins: ["https://app.example.com"] },
      securityHeaders: { nosniff: true, frameOptions: "DENY" },
    });
    await admin.authRules.update({
      id: sourceId,
      rules: [
        {
          kind: "basic",
          scope: { domains: [], pathPrefixes: ["/admin"], extensions: [], excludePathPrefixes: [] },
          basic: { realm: "Admin", users: [{ name: "ops", password: BASIC_PASSWORD }] },
        },
        { kind: "url_a", url: { primaryKey: URL_KEY } },
      ],
    });
    await admin.logs.configure({
      siteId: sourceId,
      sampleRate: 250,
      logBlocked: true,
      logQuery: true,
      logHeaders: ["x-request-source"],
      logPeer: true,
    });
    await admin.imageConvert.update({
      id: sourceId,
      ...IMAGE_CONVERT_DEFAULTS,
      enabled: true,
      avif: true,
      maxPixels: 4_000_000,
    });
  });

  afterAll(() => pglite.close());

  describe("tags (11.1)", () => {
    it("keeps a site's tags trimmed, one per name whatever its case, at most 10", async () => {
      const site = await newSite();
      const { tags } = await admin.sites.setTags({
        id: site.id,
        tags: ["  web ", "WEB", "Café", "café", "zh-标签"],
      });
      expect(tags.map((tag) => tag.name)).toEqual(["Café", "web", "zh-标签"]);
      expect((await admin.sites.get({ id: site.id })).tags).toEqual(tags);
      for (const bad of ["", "   ", "x".repeat(33), "tab\there"])
        expect((await rpcError(admin.sites.setTags({ id: site.id, tags: [bad] }))).status).toBe(
          400,
        );
      expect(
        (
          await rpcError(
            admin.sites.setTags({
              id: site.id,
              tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
            }),
          )
        ).status,
      ).toBe(400);
      // 32 characters is the limit, counted in characters rather than bytes.
      await admin.sites.setTags({ id: site.id, tags: ["标".repeat(32)] });
    });

    it("names a tag as first written and finds it again in any case", async () => {
      const a = await newSite();
      const b = await newSite();
      await admin.sites.setTags({ id: a.id, tags: ["Edge-Beta"] });
      const { tags } = await admin.sites.setTags({ id: b.id, tags: ["edge-beta"] });
      expect(tags).toEqual((await admin.sites.get({ id: a.id })).tags);
      expect(tags[0]?.name).toBe("Edge-Beta");
      const listed = (await admin.siteTags.list()).find((tag) => tag.id === tags[0]?.id);
      expect(listed?.sites).toBe(2);
    });

    it("audits tag changes and never publishes them", async () => {
      const site = await newSite();
      const revision = await revisionOf();
      const hash = (await latestRevision(ctx.db, clusterId))?.contentHash;
      await admin.sites.setTags({ id: site.id, tags: ["audit-me"] });
      await admin.sites.setTags({ id: site.id, tags: ["audit-me"] });
      expect(await revisionOf()).toBe(revision);
      expect((await latestRevision(ctx.db, clusterId))?.contentHash).toBe(hash);
      const entries = await audits("site.tags_update", site.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.metadata).toMatchObject({
        added: ["audit-me"],
        removed: [],
        tags: ["audit-me"],
      });
    });

    it("filters the site list by any or all of some tags and searches tag names", async () => {
      const both = await newSite({ tags: ["filter-a", "filter-b"] });
      const onlyA = await newSite({ tags: ["filter-a"] });
      await newSite({ tags: ["filter-c"] });
      const tagId = async (name: string) =>
        (await admin.siteTags.list()).find((tag) => tag.name === name)?.id ?? "";
      const [a, b] = [await tagId("filter-a"), await tagId("filter-b")];
      const ids = async (input: Parameters<ApiClient["sites"]["list"]>[0]) =>
        (await admin.sites.list(input)).items.map((site) => site.id).sort();
      expect(await ids({ tagIds: [a, b], pageSize: 100 })).toEqual([both.id, onlyA.id].sort());
      expect(await ids({ tagIds: [a, b], tagMatch: "all", pageSize: 100 })).toEqual([both.id]);
      expect(await ids({ search: "filter-b", pageSize: 100 })).toEqual([both.id]);
      // The same through /api/v1: bracket notation, or a single value.
      const key = (await admin.accessKeys.create({ name: "g17-list", scope: "read" })).key;
      const all = await api(key, "GET", `/sites?tagIds[]=${a}&tagIds[]=${b}&tagMatch=all`);
      expect((all.json.items as { id: string }[]).map((site) => site.id)).toEqual([both.id]);
      const one = await api(key, "GET", `/sites?tagIds=${b}`);
      expect((one.json.items as { id: string }[]).map((site) => site.id)).toEqual([both.id]);
    });

    it("renames a tag on every site, merging it into a tag that has the new name", async () => {
      const a = await newSite({ tags: ["rename-me"] });
      const b = await newSite({ tags: ["rename-me", "merge-target"] });
      const c = await newSite({ tags: ["Merge-Target"] });
      const tags = await admin.siteTags.list();
      const from = tags.find((tag) => tag.name === "rename-me");
      const into = tags.find((tag) => tag.name === "merge-target");
      if (!from || !into) throw new Error("tags missing");
      // A change of case is a rename.
      expect((await admin.siteTags.rename({ id: from.id, name: "Rename-Me" })).name).toBe(
        "Rename-Me",
      );
      const merged = await admin.siteTags.rename({ id: from.id, name: "MERGE-target" });
      expect(merged).toEqual({ id: into.id, name: "MERGE-target", sites: 3 });
      for (const site of [a, b, c])
        expect((await admin.sites.get({ id: site.id })).tags).toEqual([
          { id: into.id, name: "MERGE-target" },
        ]);
      expect((await admin.siteTags.list()).some((tag) => tag.id === from.id)).toBe(false);
      expect((await rpcError(admin.siteTags.rename({ id: from.id, name: "x" }))).code).toBe(
        "SITE_TAG_NOT_FOUND",
      );
      expect((await audits("site_tag.rename", into.id)).at(-1)?.metadata).toMatchObject({
        from: "Rename-Me",
        to: "MERGE-target",
        mergedInto: "merge-target",
        sites: 2,
      });
    });

    it("deletes a tag from every site and keeps unused tags until deleted", async () => {
      const site = await newSite({ tags: ["short-lived", "kept"] });
      await admin.sites.setTags({ id: site.id, tags: ["short-lived"] });
      const kept = (await admin.siteTags.list()).find((tag) => tag.name === "kept");
      expect(kept?.sites).toBe(0);
      const doomed = (await admin.siteTags.list()).find((tag) => tag.name === "short-lived");
      await admin.siteTags.delete({ id: doomed?.id ?? "" });
      expect((await admin.sites.get({ id: site.id })).tags).toEqual([]);
      expect((await audits("site_tag.delete", doomed?.id)).at(-1)?.metadata).toEqual({ sites: 1 });
    });
  });

  describe("batch operations (11.2)", () => {
    it("turns sites on and off: one revision per cluster, an audit entry per changed site", async () => {
      const a = await newSite();
      const b = await newSite();
      const c = await newSite({ clusterId: otherClusterId });
      const disabled = await newSite();
      await admin.sites.setEnabled({ id: disabled.id, enabled: false });
      const before = { main: await revisionOf(), other: await revisionOf(otherClusterId) };
      const result = await admin.sites.batchSetEnabled({
        ids: [a.id, b.id, c.id, disabled.id],
        enabled: false,
      });
      expect(result.changed.map((site) => site.id).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(result.revisions).toHaveLength(2);
      const main = result.revisions.find((r) => r.clusterId === clusterId);
      expect(main?.revision).toBe((before.main ?? 0) + 1);
      expect(await revisionOf(otherClusterId)).toBe((before.other ?? 0) + 1);
      const row = await latestRevision(ctx.db, clusterId);
      expect([row?.reasonCode, row?.reasonParams]).toEqual(["sites_disabled", { count: 2 }]);
      const other = await latestRevision(ctx.db, otherClusterId);
      expect([other?.reasonCode, other?.reasonParams]).toEqual(["site_disabled", { site: c.name }]);
      for (const site of [a, b, c]) {
        expect((await admin.sites.get({ id: site.id })).enabled).toBe(false);
        expect((await audits("site.disable", site.id)).at(-1)?.metadata).toMatchObject({
          batch: 4,
        });
        expect(await compiled(site.id, site.clusterId)).toBeUndefined();
      }
      expect(await audits("site.disable", disabled.id)).toHaveLength(1);
      await admin.sites.batchSetEnabled({ ids: [a.id, b.id], enabled: true });
      expect(await compiled(a.id)).toBeDefined();
      expect((await latestRevision(ctx.db, clusterId))?.reasonCode).toBe("sites_enabled");
    });

    it("adds and removes tags on several sites; a site over 10 tags fails the batch", async () => {
      const a = await newSite({ tags: ["old", "keep"] });
      const b = await newSite({ tags: ["OLD"] });
      const revision = await revisionOf();
      const result = await admin.sites.batchTags({
        ids: [a.id, b.id],
        add: ["new"],
        remove: ["Old"],
      });
      expect(result.changed).toHaveLength(2);
      expect(result.revisions).toEqual([]);
      expect(await revisionOf()).toBe(revision);
      expect((await admin.sites.get({ id: a.id })).tags.map((t) => t.name)).toEqual([
        "keep",
        "new",
      ]);
      expect((await admin.sites.get({ id: b.id })).tags.map((t) => t.name)).toEqual(["new"]);
      const full = await newSite({ tags: Array.from({ length: 10 }, (_, i) => `full-${i}`) });
      const error = await rpcError(
        admin.sites.batchTags({ ids: [b.id, full.id], add: ["eleventh"] }),
      );
      expect([error.code, error.data]).toEqual(["SITE_TAG_LIMIT", { site: full.name, limit: 10 }]);
      // Nothing of the batch was saved.
      expect((await admin.sites.get({ id: b.id })).tags.map((t) => t.name)).toEqual(["new"]);
      expect(
        (await rpcError(admin.sites.batchTags({ ids: [a.id], add: ["x"], remove: ["X"] }))).status,
      ).toBe(400);
    });

    it("deletes sites: each audited, each cluster published once", async () => {
      const a = await newSite();
      const b = await newSite({ clusterId: otherClusterId });
      const c = await newSite();
      const before = await revisionOf();
      const result = await admin.sites.batchDelete({ ids: [a.id, b.id, c.id] });
      expect(result.changed).toHaveLength(3);
      expect(await revisionOf()).toBe((before ?? 0) + 1);
      expect((await latestRevision(ctx.db, clusterId))?.reasonCode).toBe("sites_deleted");
      for (const site of [a, b, c]) {
        expect((await rpcError(admin.sites.get({ id: site.id }))).code).toBe("SITE_NOT_FOUND");
        expect(await audits("site.delete", site.id)).toHaveLength(1);
      }
    });

    it("fails the whole batch when a site does not exist", async () => {
      const a = await newSite();
      const missing = "00000000-0000-4000-8000-000000000000";
      // One at a time: a rejection must not arrive before it is awaited.
      for (const call of [
        () => admin.sites.batchSetEnabled({ ids: [a.id, missing], enabled: false }),
        () => admin.sites.batchDelete({ ids: [a.id, missing] }),
        () => admin.sites.batchTags({ ids: [a.id, missing], add: ["x"] }),
      ])
        expect((await rpcError(call())).code).toBe("SITE_NOT_FOUND");
      const kept = await admin.sites.get({ id: a.id });
      expect([kept.enabled, kept.tags]).toEqual([true, []]);
    });

    it("purges several sites with one whole-site task", async () => {
      const a = await newSite();
      const b = await newSite();
      const task = await admin.cacheTasks.create({ type: "site", siteIds: [a.id, b.id] });
      expect(task.sites.map((site) => site.id).sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe("copying settings (11.3)", () => {
    /** A target that has what the source's settings name: the eu group and a certificate. */
    const target = async () => {
      const site = await newSite();
      await withCertificate(site.id, site.domains[0] ?? "");
      return site;
    };

    it.each(SITE_COPY_PARTS.map((part) => [part]))("copies %s and nothing else", async (part) => {
      const site = await target();
      const before = await readAll(site.id);
      expect(before[part]).not.toBe(await read(part, sourceId));
      const result = await admin.sites.copySettings({
        id: sourceId,
        targetIds: [site.id],
        parts: [part],
      });
      expect(result.targets).toMatchObject([
        { id: site.id, ok: true, changed: [part], error: null },
      ]);
      const after = await readAll(site.id);
      for (const other of SITE_COPY_PARTS)
        expect(after[other], other).toBe(
          other === part ? await read(part, sourceId) : before[other],
        );
    });

    it("keeps what the parts leave out: certificates, redirect exclusions, origins, domains, PURGE key", async () => {
      const site = await target();
      const before = await admin.sites.get({ id: site.id });
      const httpsBefore = await admin.https.get({ id: site.id });
      await admin.sites.copySettings({
        id: sourceId,
        targetIds: [site.id],
        parts: [...SITE_COPY_PARTS],
      });
      const after = await admin.sites.get({ id: site.id });
      const https = await admin.https.get({ id: site.id });
      expect(https.certificateId).toBe(httpsBefore.certificateId);
      expect(https.redirectExcludedDomains).toEqual([]);
      expect([https.forceHttps, https.http3, https.brotli]).toEqual([true, true, true]);
      expect(after.origins).toEqual(before.origins);
      expect(after.domains).toEqual(before.domains);
      expect(after.cacheSettings.purgeMethod).toEqual(before.cacheSettings.purgeMethod);
      expect(after.cacheSettings.xCache).toBe(true);
      expect(after.contentSettings.requestBodyLimit).toBe(before.contentSettings.requestBodyLimit);
      // Rules body limit goes with the rules.
      expect(after.contentSettings.rulesBodyLimit).toBe(131_072);
    });

    it("seals the access authentication secrets anew for the target", async () => {
      const site = await target();
      await admin.sites.copySettings({ id: sourceId, targetIds: [site.id], parts: ["authRules"] });
      const rows = (siteId: string) =>
        ctx.db
          .select()
          .from(schema.siteAuthRule)
          .where(eq(schema.siteAuthRule.siteId, siteId))
          .orderBy(schema.siteAuthRule.position);
      const source = await rows(sourceId);
      const copied = await rows(site.id);
      expect(copied).toHaveLength(2);
      for (const [i, row] of copied.entries()) {
        const original = source[i];
        if (!original?.secretEnvelope || !row.secretEnvelope) throw new Error("no secret");
        expect(row.id).not.toBe(original.id);
        expect(row.secretEnvelope).not.toBe(original.secretEnvelope);
        expect(row.secretVersion).toBe(1);
        const open = (envelope: string, ruleId: string) =>
          ctx.masterKey
            .open(JSON.parse(envelope), accessAuthSecretBinding(ruleId))
            .toString("utf8");
        expect(open(row.secretEnvelope, row.id)).toBe(open(original.secretEnvelope, original.id));
        // Bound to its own rule: the envelope does not open as the source's.
        expect(() => open(row.secretEnvelope ?? "", original.id)).toThrow();
      }
      expect(
        JSON.parse(
          ctx.masterKey
            .open(
              JSON.parse(copied[1]?.secretEnvelope ?? ""),
              accessAuthSecretBinding(copied[1]?.id ?? ""),
            )
            .toString("utf8"),
        ),
      ).toEqual({ keys: [URL_KEY] });
      // The target's compiled rules name the new ids.
      const auth = (await compiled(site.id))?.authRules ?? [];
      expect(auth.map((rule) => rule.id)).toEqual(copied.map((row) => row.id));
    });

    it("previews each target's changes and failures without saving anything", async () => {
      const ready = await target();
      const bare = await newSite({ origins: [{ address: "origin.example.com" }] });
      const before = { ready: await readAll(ready.id), bare: await readAll(bare.id) };
      const revision = await revisionOf();
      const auditCount = (await audits("site.settings_copied")).length;
      const preview = await admin.sites.copySettingsPreview({
        id: sourceId,
        targetIds: [ready.id, bare.id],
        parts: ["rules", "cacheRules", "compression", "cacheTag"],
      });
      expect(preview.source).toEqual({ id: sourceId, name: "source" });
      const [first, second] = preview.targets;
      expect(first?.error).toBeNull();
      expect(first?.changes).toEqual([
        { part: "cacheRules", changed: true, before: 0, after: 2, fields: null },
        { part: "cacheTag", changed: true, before: null, after: null, fields: 1 },
        { part: "compression", changed: true, before: null, after: null, fields: 5 },
        { part: "rules", changed: true, before: 0, after: 2, fields: null },
      ]);
      expect(second?.error).toMatchObject({
        code: "ORIGIN_GROUP_UNKNOWN",
        data: { group: "eu", rule: "media" },
      });
      expect(await readAll(ready.id)).toEqual(before.ready);
      expect(await readAll(bare.id)).toEqual(before.bare);
      expect(await revisionOf()).toBe(revision);
      expect(await audits("site.settings_copied")).toHaveLength(auditCount);
    });

    it("fails a target that lacks what the settings name and copies to the others", async () => {
      const ready = await target();
      const noGroup = await newSite({ origins: [{ address: "origin.example.com" }] });
      await withCertificate(noGroup.id, noGroup.domains[0] ?? "");
      const noCertificate = await newSite();
      const before = {
        noGroup: await readAll(noGroup.id),
        noCertificate: await readAll(noCertificate.id),
      };
      const result = await admin.sites.copySettings({
        id: sourceId,
        targetIds: [noGroup.id, ready.id, noCertificate.id],
        parts: ["rules", "https", "waf"],
      });
      expect(result.targets.map((t) => [t.id, t.ok, t.error?.code ?? null])).toEqual([
        [noGroup.id, false, "ORIGIN_GROUP_UNKNOWN"],
        [ready.id, true, null],
        [noCertificate.id, false, "HTTPS_REQUIRES_CERTIFICATE"],
      ]);
      expect(result.targets[0]?.error?.data).toEqual({ group: "eu", rule: "media" });
      // The failed targets keep every setting, also the parts before the one that failed.
      expect(await readAll(noGroup.id)).toEqual(before.noGroup);
      expect(await readAll(noCertificate.id)).toEqual(before.noCertificate);
      expect(await read("waf", ready.id)).toBe(await read("waf", sourceId));
      expect(await audits("site.settings_copied", noGroup.id)).toEqual([]);
    });

    it("fails where the settings name the source's domains (redirect hosts, authentication scopes)", async () => {
      const scoped = await newSite({ domains: ["scoped.g17.test"] });
      await admin.bulkRedirects.save({
        id: scoped.id,
        redirects: [{ source: "scoped.g17.test/old", target: "/new" }],
      });
      await admin.authRules.update({
        id: scoped.id,
        rules: [
          {
            kind: "url_b",
            scope: {
              domains: ["scoped.g17.test"],
              pathPrefixes: [],
              extensions: [],
              excludePathPrefixes: [],
            },
            url: { primaryKey: URL_KEY },
          },
        ],
      });
      const other = await newSite();
      const result = await admin.sites.copySettings({
        id: scoped.id,
        targetIds: [other.id],
        parts: ["bulkRedirects"],
      });
      expect(result.targets[0]?.error).toMatchObject({
        code: "BULK_REDIRECT_HOST_UNKNOWN",
        data: { hosts: "scoped.g17.test" },
      });
      const auth = await admin.sites.copySettings({
        id: scoped.id,
        targetIds: [other.id],
        parts: ["authRules"],
      });
      expect(auth.targets[0]?.error).toMatchObject({
        code: "AUTH_DOMAIN_UNKNOWN",
        data: { domain: "scoped.g17.test" },
      });
    });

    it("publishes each target's cluster, audits the copy and serves the copied settings", async () => {
      const a = await target();
      const b = await newSite({ clusterId: otherClusterId });
      await withCertificate(b.id, b.domains[0] ?? "");
      const result = await admin.sites.copySettings({
        id: sourceId,
        targetIds: [a.id, b.id],
        parts: ["cacheRules", "waf", "cacheKey"],
      });
      expect(result.targets.every((t) => t.ok)).toBe(true);
      const revision = await latestRevision(ctx.db, otherClusterId);
      expect(result.targets[1]?.revision?.revision).toBe(revision?.revision);
      expect([revision?.reasonCode, revision?.reasonParams]).toEqual([
        "site_settings_copied",
        { site: b.name, source: "source" },
      ]);
      expect((await audits("site.settings_copied", b.id))[0]?.metadata).toEqual({
        source: { id: sourceId, name: "source" },
        parts: ["cacheRules", "cacheKey", "waf"],
        changed: ["cacheRules", "cacheKey", "waf"],
        revision: revision?.revision,
      });
      const site = await compiled(b.id, otherClusterId);
      expect(site?.cacheRules).toHaveLength(2);
      expect(site?.waf?.mode).toBe("block");
      expect(site?.cacheKey?.sortQuery).toBe(true);
      // Copying the same parts again changes nothing and publishes nothing new.
      const again = await admin.sites.copySettings({
        id: sourceId,
        targetIds: [b.id],
        parts: ["cacheRules", "waf", "cacheKey"],
      });
      expect(again.targets[0]).toMatchObject({ ok: true, changed: [] });
      expect(again.targets[0]?.revision?.revision).toBe(revision?.revision);
    });

    it("marks the target's WAF settings as saved anew, so that an editor holding the old ones is refused", async () => {
      const site = await target();
      await admin.waf.update({ id: site.id, paranoiaLevel: 3 });
      const before = (await admin.waf.get({ id: site.id })).updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await admin.sites.copySettings({ id: sourceId, targetIds: [site.id], parts: ["waf"] });
      const after = await admin.waf.get({ id: site.id });
      expect(after.mode).toBe("block");
      expect(Date.parse(after.updatedAt ?? "")).toBeGreaterThan(Date.parse(before ?? ""));
    });

    it("refuses a copy to the source itself and unknown targets", async () => {
      expect(
        (
          await rpcError(
            admin.sites.copySettings({ id: sourceId, targetIds: [sourceId], parts: ["waf"] }),
          )
        ).status,
      ).toBe(400);
      const missing = "00000000-0000-4000-8000-000000000001";
      const result = await admin.sites.copySettings({
        id: sourceId,
        targetIds: [missing],
        parts: ["waf"],
      });
      expect(result.targets[0]).toMatchObject({ ok: false, error: { code: "SITE_NOT_FOUND" } });
    });

    it("assigns every HTTPS setting and every site and pool column to a part or leaves it out on purpose", () => {
      const tlsKeys = Object.keys(tlsSettings.parse({})).sort();
      expect([...COMPRESSION_KEYS, ...HTTPS_KEYS, ...TLS_KEPT_KEYS].sort()).toEqual(tlsKeys);
      // Columns of the site row: copied by a part, taken by a clone only, or never copied.
      const parts = [
        "logSampleRate",
        "logBlocked",
        "logQuery",
        "logHeaders",
        "logPeer",
        "imageConvert",
        "cacheKey",
        "rangeSlice",
        "keepCacheTag",
        "websocket",
        "interceptOriginErrors",
        "errorPagesUpdatedAt",
        "tlsSettings",
        "authUpdatedAt",
        "accessControl",
        "blockListIds",
        "allowListIds",
        "accessControlUpdatedAt",
        "rulesBodyLimit",
      ];
      const cloneOnly = [
        "httpPorts",
        "httpsPorts",
        "hideXCache",
        "purgeMethod",
        "maintenance",
        "maintenanceUpdatedAt",
        "charset",
        "requestBodyLimit",
      ];
      const never = [
        "id",
        "clusterId",
        "name",
        "enabled",
        "cacheGeneration",
        "certificateId",
        "cnamePrefix",
        "createdAt",
        "updatedAt",
      ];
      expect([...parts, ...cloneOnly, ...never].sort()).toEqual(
        Object.keys(getTableColumns(schema.site)).sort(),
      );
    });
  });

  describe("cloning (11.4)", () => {
    it("creates a site with every setting, origin and tag of the source under its own name and domains", async () => {
      const result = await admin.sites.clone({
        id: sourceId,
        name: "copy",
        domains: ["copy.g17.test"],
      });
      const clone = result.site;
      const source = await admin.sites.get({ id: sourceId });
      expect([clone.name, clone.domains, clone.clusterId]).toEqual([
        "copy",
        ["copy.g17.test"],
        clusterId,
      ]);
      expect(clone.cnamePrefix).not.toBe(source.cnamePrefix);
      expect(clone.tags).toEqual(source.tags);
      expect(clone.origins.map(({ id: _id, ...o }) => o)).toEqual(
        source.origins.map(({ id: _id, ...o }) => o),
      );
      expect(clone.cacheSettings).toEqual(source.cacheSettings);
      expect(clone.contentSettings).toEqual(source.contentSettings);
      expect(clone.originSettings).toEqual(source.originSettings);
      // Everything but the HTTPS options that need a certificate.
      for (const part of SITE_COPY_PARTS.filter((p) => p !== "https"))
        expect(await read(part, clone.id), part).toBe(await read(part, sourceId));
      const https = await admin.https.get({ id: clone.id });
      expect([
        https.certificateId,
        https.forceHttps,
        https.hstsMaxAge,
        https.minimumVersion,
      ]).toEqual([null, false, 0, "1.3"]);
      expect(clone.ports).toEqual({ http: [80], https: [443] });
      expect(result.revision.reasonCode).toBe("site_cloned");
      expect((await audits("site.clone", clone.id))[0]?.metadata).toMatchObject({
        source: { id: sourceId, name: "source" },
        name: "copy",
        domains: ["copy.g17.test"],
        tags: ["Production", "shop"],
      });
      expect(await compiled(clone.id)).toBeDefined();
    });

    it("seals the PURGE key and S3 credentials anew for the clone", async () => {
      const s3 = await admin.sites.create({
        name: "bucket",
        domains: ["bucket.g17.test"],
        origins: [
          {
            address: "s3.example.com",
            scheme: "https",
            port: 443,
            s3: {
              region: "us-east-1",
              bucket: "assets",
              accessKeyId: "g17-access",
              secretAccessKey: S3_SECRET,
            },
          },
        ],
        cacheSettings: { purgeMethod: { enabled: true, key: PURGE } },
      });
      const clone = (
        await admin.sites.clone({ id: s3.site.id, domains: ["bucket-copy.g17.test"], tags: ["s3"] })
      ).site;
      expect(clone.name).toBe("bucket-copy.g17.test");
      expect(clone.tags.map((t) => t.name)).toEqual(["s3"]);
      const credentials = await ctx.db
        .select()
        .from(schema.originCredential)
        .where(inArray(schema.originCredential.siteId, [s3.site.id, clone.id]));
      const copied = credentials.find((c) => c.siteId === clone.id);
      const original = credentials.find((c) => c.siteId === s3.site.id);
      if (!copied || !original) throw new Error("credentials missing");
      expect(copied.id).not.toBe(original.id);
      expect(
        ctx.masterKey
          .open(JSON.parse(copied.secretEnvelope), s3SecretBinding(copied.id))
          .toString("utf8"),
      ).toBe(S3_SECRET);
      const [origin] = await ctx.db
        .select()
        .from(schema.origin)
        .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
        .where(eq(schema.originPool.siteId, clone.id));
      expect(origin?.origin.credentialId).toBe(copied.id);
      const [secret] = await ctx.db
        .select()
        .from(schema.siteSecret)
        .where(and(eq(schema.siteSecret.siteId, clone.id), eq(schema.siteSecret.kind, PURGE_KEY)));
      expect(
        ctx.masterKey
          .open(JSON.parse(secret?.secretEnvelope ?? ""), siteSecretBinding(secret?.id ?? ""))
          .toString("utf8"),
      ).toBe(PURGE);
    });

    it("keeps HTTP ports and only 443 of the HTTPS ports: a clone has no certificate", () => {
      expect(clonePorts({ http: [80, 8080], https: [443, 8443] })).toEqual({
        http: [80, 8080],
        https: [443],
      });
      expect(clonePorts({ http: [], https: [8443] })).toEqual({ http: [80], https: [] });
    });

    it("checks the source's origins against the origin allow list as creating a site does", async () => {
      await admin.settings.setOriginAllowList({ cidrs: ["10.17.0.0/16"] });
      const internal = await newSite({ origins: [{ address: "10.17.0.5" }] });
      await admin.settings.setOriginAllowList({ cidrs: [] });
      const error = await rpcError(
        admin.sites.clone({ id: internal.id, domains: ["internal-copy.g17.test"] }),
      );
      expect([error.code, error.data]).toEqual([
        "ORIGIN_ADDRESS_FORBIDDEN",
        expect.objectContaining({ address: "10.17.0.5" }),
      ]);
    });

    it("fails when the source's settings name its domains or the domains are taken", async () => {
      const scoped = await newSite({ domains: ["clone-scoped.g17.test"] });
      await admin.authRules.update({
        id: scoped.id,
        rules: [
          {
            kind: "url_a",
            scope: {
              domains: ["clone-scoped.g17.test"],
              pathPrefixes: [],
              extensions: [],
              excludePathPrefixes: [],
            },
            url: { primaryKey: URL_KEY },
          },
        ],
      });
      const count = (await admin.sites.list({ pageSize: 100 })).total;
      expect(
        (await rpcError(admin.sites.clone({ id: scoped.id, domains: ["clone-copy.g17.test"] })))
          .code,
      ).toBe("AUTH_DOMAIN_UNKNOWN");
      expect(
        (await rpcError(admin.sites.clone({ id: sourceId, domains: ["source.g17.test"] }))).code,
      ).toBe("DOMAIN_IN_USE");
      expect((await admin.sites.list({ pageSize: 100 })).total).toBe(count);
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get none of it", async () => {
    const reader = (await admin.accessKeys.create({ name: "g17-ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "g17-rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "g17",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const service = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const a = await newSite();
    const b = await newSite();
    const tag = (await admin.siteTags.list())[0]?.id ?? "";
    const preview = `/sites/${sourceId}/copy-settings?targetIds[]=${a.id}&parts[]=cacheTag`;
    for (const path of [preview, "/site-tags"]) {
      expect((await api(reader, "GET", path)).status, path).toBe(200);
      const refused = await api(service, "GET", path);
      expect([refused.status, refused.json.code], path).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    }
    const writes: [string, string, unknown][] = [
      ["PUT", `/sites/${a.id}/tags`, { tags: ["matrix"] }],
      ["POST", "/sites/batch/enabled", { ids: [a.id], enabled: false }],
      ["POST", "/sites/batch/tags", { ids: [a.id], add: ["matrix"] }],
      ["POST", `/sites/${sourceId}/copy-settings`, { targetIds: [a.id], parts: ["cacheTag"] }],
      ["POST", `/sites/${sourceId}/clone`, { domains: ["matrix.g17.test"] }],
      ["PATCH", `/site-tags/${tag}`, { name: "matrix-renamed" }],
      ["DELETE", `/site-tags/${tag}`, undefined],
      ["POST", "/sites/batch/delete", { ids: [b.id] }],
    ];
    for (const [method, path, body] of writes) {
      const readOnly = await api(reader, method, path, body);
      expect([readOnly.status, readOnly.json.code], path).toEqual([403, "ACCESS_KEY_READ_ONLY"]);
      const refused = await api(service, method, path, body);
      expect([refused.status, refused.json.code], path).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    }
    expect((await admin.sites.get({ id: a.id })).tags).toEqual([]);
    for (const [method, path, body] of writes) {
      const written = await api(writer, method, path, body);
      expect(written.status, `${method} ${path}`).toBeLessThan(300);
    }
    expect((await admin.sites.get({ id: a.id })).enabled).toBe(false);
    expect((await rpcError(admin.sites.get({ id: b.id }))).code).toBe("SITE_NOT_FOUND");
  });
});
