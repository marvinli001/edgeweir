import "reflect-metadata";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  decodeNodeConfig,
  EXTENSIONS_FEATURE,
  EXTENSIONS_V2_FEATURE,
} from "@edgeweir/config-compiler";
import type { RuleInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { desc, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { readArchive } from "../../src/server/lib/extension-package";
import { packageForNode } from "../../src/server/services/extensions";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Vectors written by edgeweir-node (internal/extension, go test -update):
// the example extension packed and signed with the key derived below.
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/extensions/${name}`, import.meta.url));
const PACKAGE = fixture("hello-header-1.0.0.ewx");
const SIGNATURE = fixture("hello-header-1.0.0.ewx.sig").toString().trim();
const PUBLIC_JWK = fixture("test-key.pub.jwk").toString().trim();

const seed = createHash("sha256").update("edgeweir extension test key").digest();
// PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410).
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const kid = (x: string) =>
  b64url(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());

/** A minimal ustar writer for test packages (regular files only). */
function ustar(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function signPackage(bytes: Buffer, manifest: { id: string; version: string; publisher: string }) {
  const x = JSON.parse(PUBLIC_JWK).x as string;
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: kid(x), typ: "edgeweir-ext+jws" }));
  const payload = b64url(
    JSON.stringify({
      format: "edgeweir-node-extension-v1",
      ...manifest,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      iat: 1,
    }),
  );
  return `${header}.${payload}.${b64url(sign(null, Buffer.from(`${header}.${payload}`), privateKey))}`;
}

/** The example with another version and a changed field list, signed by the test key. */
function exampleVersion(
  version: string,
  change: (manifest: Record<string, unknown>) => void = () => {},
) {
  const files = Object.fromEntries(readArchive(PACKAGE).map((f) => [f.path, Buffer.from(f.data)]));
  const manifest = JSON.parse(files["manifest.json"]?.toString() ?? "{}");
  manifest.version = version;
  change(manifest);
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  const bytes = ustar(files);
  return { package: bytes.toString("base64"), signature: signPackage(bytes, manifest) };
}

describe("node extensions", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let nodeId = "";
  const input = { package: PACKAGE.toString("base64"), signature: SIGNATURE };
  const ir = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir);
  };
  const rule = (expression: string) =>
    ({
      name: "greeted",
      phase: "waf-custom",
      expression,
      enabled: true,
      action: { kind: "block" },
    }) as RuleInput;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "hello",
        domains: ["hello.ext.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-ext",
        lastSeenAt: new Date(),
        supportedFeatures: ["tls-v1", "rules-v1"],
      })
      .returning();
    nodeId = row?.id ?? "";
  });
  afterAll(() => pglite.close());

  it("trusts no key by default", async () => {
    expect(await admin.extensionKeys.list()).toEqual([]);
    const error = await rpcError(admin.extensions.verify(input));
    expect(error.code).toBe("EXTENSION_KEY_UNTRUSTED");
  });

  it("adds a publisher key and verifies the shared vector", async () => {
    const key = await admin.extensionKeys.add({
      publisher: "example.org",
      key: PUBLIC_JWK,
      label: "test",
    });
    expect(key.kid).toBe(kid(JSON.parse(PUBLIC_JWK).x));
    expect(
      (
        await rpcError(
          admin.extensionKeys.add({ publisher: "example.org", key: PUBLIC_JWK, label: "" }),
        )
      ).code,
    ).toBe("EXTENSION_KEY_EXISTS");
    const verified = await admin.extensions.verify(input);
    expect(verified).toMatchObject({
      manifest: { id: "hello-header", version: "1.0.0", publisher: "example.org" },
      sha256: createHash("sha256").update(PACKAGE).digest("hex"),
      key: { publisher: "example.org" },
      installedVersion: null,
      stored: false,
    });
  });

  it("rejects tampered packages, signatures and publishers", async () => {
    const tampered = Buffer.from(PACKAGE);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 1;
    expect(
      (
        await rpcError(
          admin.extensions.verify({ package: tampered.toString("base64"), signature: SIGNATURE }),
        )
      ).data,
    ).toMatchObject({ reason: "digest" });
    const [h, p, s] = SIGNATURE.split(".");
    const flipped = `${s?.[0] === "A" ? "B" : "A"}${s?.slice(1)}`;
    expect(
      (await rpcError(admin.extensions.verify({ ...input, signature: `${h}.${p}.${flipped}` })))
        .data,
    ).toMatchObject({
      reason: "signature",
    });
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "x", typ: "edgeweir-ext+jws" }))}.${p}.`;
    expect((await rpcError(admin.extensions.verify({ ...input, signature: none }))).code).toBe(
      "EXTENSION_SIGNATURE_INVALID",
    );
    // Signed by the trusted key, but claiming another publisher.
    const other = exampleVersion("1.0.0", (m) => {
      m.publisher = "other.example";
    });
    expect((await rpcError(admin.extensions.verify(other))).code).toBe(
      "EXTENSION_PUBLISHER_MISMATCH",
    );
    // A native library is refused even when signed.
    const files = Object.fromEntries(
      readArchive(PACKAGE).map((f) => [f.path, Buffer.from(f.data)]),
    );
    const native = ustar({ ...files, "assets/x.so": "ELF" });
    const manifest = JSON.parse(files["manifest.json"]?.toString() ?? "{}");
    const error = await rpcError(
      admin.extensions.verify({
        package: native.toString("base64"),
        signature: signPackage(native, manifest),
      }),
    );
    expect(error.data).toMatchObject({ reason: "entry" });
  });

  it("installs disabled and delivers nothing until a site turns it on", async () => {
    const installed = await admin.extensions.install(input);
    expect(installed).toMatchObject({
      id: "hello-header",
      version: "1.0.0",
      enabled: false,
      sites: 0,
    });
    expect(installed.config).toEqual({ greeting: "hello" });
    expect((await ir()).extensions).toEqual([]);
    expect(await packageForNode(ctx.db, clusterId, installed.sha256)).toBeNull();
  });

  it("needs extensions-v1 on the cluster's nodes to turn a site on", async () => {
    const error = await rpcError(
      admin.extensions.updateSite({ siteId, id: "hello-header", enabled: true, config: {} }),
    );
    expect(error.code).toBe("NODE_CAPABILITY_REQUIRED");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1", "rules-v1", EXTENSIONS_FEATURE] })
      .where(eq(schema.node.id, nodeId));
  });

  it("validates the site configuration against the schema", async () => {
    const error = await rpcError(
      admin.extensions.updateSite({
        siteId,
        id: "hello-header",
        enabled: true,
        config: { header: "bad header" },
      }),
    );
    expect(error.code).toBe("EXTENSION_CONFIG_INVALID");
    expect(error.data).toMatchObject({ scope: "site", path: "header", issue: "pattern" });
    expect(
      (
        await rpcError(
          admin.extensions.updateSite({
            siteId,
            id: "hello-header",
            enabled: true,
            config: { nope: 1 },
          }),
        )
      ).data,
    ).toMatchObject({ issue: "unknown" });
  });

  it("publishes the package and the site's configuration", async () => {
    const view = await admin.extensions.updateSite({
      siteId,
      id: "hello-header",
      enabled: true,
      config: { header: "X-Greeting" },
    });
    expect(view).toMatchObject({
      enabled: true,
      config: { header: "X-Greeting", deny_path: "", inject: false, fail: false },
    });
    const config = await ir();
    expect(config.requiredFeatures).toContain(EXTENSIONS_FEATURE);
    expect(config.extensions).toHaveLength(1);
    expect(config.extensions[0]).toMatchObject({
      id: "hello-header",
      version: "1.0.0",
      publisher: "example.org",
      enabled: false,
      failureMode: "open",
      configJson: '{"greeting":"hello"}',
      sharedDicts: [{ name: "state", sizeKb: 64 }],
    });
    expect(config.extensions[0]?.signature).toBe(SIGNATURE);
    expect(JSON.parse(config.extensions[0]?.publicKey ?? "{}")).toEqual(JSON.parse(PUBLIC_JWK));
    const site = config.sites.find((s) => s.id === siteId);
    expect(site?.extensions).toEqual([
      expect.objectContaining({
        id: "hello-header",
        configJson: '{"deny_path":"","fail":false,"header":"X-Greeting","inject":false}',
      }),
    ]);
    const bytes = await packageForNode(ctx.db, clusterId, config.extensions[0]?.sha256 ?? "");
    expect(Buffer.from(bytes ?? []).equals(PACKAGE)).toBe(true);
  });

  it("enables, configures and switches the failure mode globally", async () => {
    const detail = await admin.extensions.update({
      id: "hello-header",
      enabled: true,
      failureMode: "closed",
      config: { greeting: "hi" },
    });
    expect(detail).toMatchObject({
      enabled: true,
      failureMode: "closed",
      config: { greeting: "hi" },
      sites: 1,
    });
    expect((await ir()).extensions[0]).toMatchObject({
      enabled: true,
      failureMode: "closed",
      configJson: '{"greeting":"hi"}',
    });
    expect(detail.nodes).toEqual([
      expect.objectContaining({ nodeName: "edge-ext", state: "pending" }),
    ]);
  });

  it("lets rules read the fields and refuses to uninstall while they do", async () => {
    await admin.rules.save({ id: siteId, rules: [rule("ext.hello-header.greeted eq true")] });
    const error = await rpcError(admin.extensions.uninstall({ id: "hello-header" }));
    expect(error.code).toBe("EXTENSION_IN_USE");
    expect(error.data).toMatchObject({ rules: "greeted" });
    // An unknown field of an installed extension is still unknown.
    expect(
      (
        await rpcError(
          admin.rules.save({ id: siteId, rules: [rule("ext.hello-header.nope eq true")] }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
  });

  it("upgrades, refuses to drop a field rules read, and rolls back", async () => {
    const dropped = exampleVersion("1.1.0", (m) => {
      m.fields = [];
    });
    expect((await rpcError(admin.extensions.install(dropped))).code).toBe("EXTENSION_IN_USE");
    const upgraded = await admin.extensions.install(exampleVersion("1.1.0"));
    expect(upgraded.version).toBe("1.1.0");
    expect(upgraded.versions.map((v) => [v.version, v.active])).toEqual([
      ["1.1.0", true],
      ["1.0.0", false],
    ]);
    expect((await ir()).extensions[0]?.version).toBe("1.1.0");
    expect(
      (await rpcError(admin.extensions.deleteVersion({ id: "hello-header", version: "1.1.0" })))
        .code,
    ).toBe("EXTENSION_VERSION_ACTIVE");
    const rolledBack = await admin.extensions.activate({ id: "hello-header", version: "1.0.0" });
    expect(rolledBack.version).toBe("1.0.0");
    expect((await ir()).extensions[0]?.sha256).toBe(
      createHash("sha256").update(PACKAGE).digest("hex"),
    );
    // The same version with other bytes is refused.
    expect(
      (
        await rpcError(
          admin.extensions.install(
            exampleVersion("1.0.0", (m) => {
              m.license = "MIT";
            }),
          ),
        )
      ).code,
    ).toBe("EXTENSION_VERSION_EXISTS");
  });

  it("delivers Lua API 2 packages to extensions-v2 nodes only", async () => {
    const counters = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const api1 = exampleVersion("1.2.0", (m) => {
      m.counters = counters;
    });
    expect((await rpcError(admin.extensions.install(api1))).code).toBe("EXTENSION_PACKAGE_INVALID");
    const api2 = exampleVersion("1.2.0", (m) => {
      m.requires = { lua_api: 2 };
      m.counters = counters;
    });
    expect((await rpcError(admin.extensions.install(api2))).code).toBe("NODE_CAPABILITY_REQUIRED");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1", "rules-v1", EXTENSIONS_FEATURE, EXTENSIONS_V2_FEATURE] })
      .where(eq(schema.node.id, nodeId));
    expect((await admin.extensions.install(api2)).version).toBe("1.2.0");
    expect((await ir()).requiredFeatures).toContain(EXTENSIONS_V2_FEATURE);
    await admin.extensions.activate({ id: "hello-header", version: "1.0.0" });
    expect((await ir()).requiredFeatures).not.toContain(EXTENSIONS_V2_FEATURE);
    await admin.extensions.deleteVersion({ id: "hello-header", version: "1.2.0" });
  });

  it("stores what nodes report", async () => {
    const sha256 = createHash("sha256").update(PACKAGE).digest("hex");
    await ctx.db
      .update(schema.node)
      .set({
        extensionStatus: [
          {
            id: "hello-header",
            version: "1.0.0",
            sha256,
            state: "loaded",
            message: "",
            faults: 2,
            trips: 0,
          },
        ],
      })
      .where(eq(schema.node.id, nodeId));
    const detail = await admin.extensions.get({ id: "hello-header" });
    expect(detail.nodes[0]).toMatchObject({ state: "loaded", faults: 2 });
    expect(detail.nodesLoaded).toBe(1);
  });

  it("stops every extension with the kill switch", async () => {
    expect(await admin.extensions.updateSettings({ disabled: true })).toEqual({ disabled: true });
    expect((await ir()).extensionsDisabled).toBe(true);
    await admin.extensions.updateSettings({ disabled: false });
    expect((await ir()).extensionsDisabled).toBe(false);
  });

  it("keeps keys that sign stored versions, then uninstalls cleanly", async () => {
    const key = (await admin.extensionKeys.list())[0];
    expect(key?.versions).toBe(2);
    expect((await rpcError(admin.extensionKeys.remove({ kid: key?.kid ?? "" }))).code).toBe(
      "EXTENSION_KEY_IN_USE",
    );
    await admin.rules.save({ id: siteId, rules: [] });
    expect(await admin.extensions.uninstall({ id: "hello-header" })).toEqual({ ok: true });
    const config = await ir();
    expect(config.extensions).toEqual([]);
    expect(config.requiredFeatures).not.toContain(EXTENSIONS_FEATURE);
    expect(config.sites.find((s) => s.id === siteId)?.extensions).toEqual([]);
    expect(await admin.extensionKeys.remove({ kid: key?.kid ?? "" })).toEqual({ ok: true });
  });

  it("audits every change", async () => {
    const actions = (
      await ctx.db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(like(schema.auditLog.action, "%extension%"))
        .orderBy(desc(schema.auditLog.id))
    ).map((row) => row.action);
    for (const action of [
      "extension_key.add",
      "extension.install",
      "site.extension_update",
      "extension.update",
      "extension.upgrade",
      "extension.activate",
      "extension.settings_update",
      "extension.uninstall",
      "extension_key.remove",
    ])
      expect(actions).toContain(action);
  });
});
