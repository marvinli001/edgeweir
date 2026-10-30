import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { type Client, Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  decodeNodeConfig,
  EXTENSIONS_FEATURE,
  EXTENSIONS_V2_FEATURE,
} from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService } from "@edgeweir/proto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedBodyLimit,
  createApp,
  MAX_AUTHENTICATED_BODY_BYTES,
} from "../../src/server/app";
import type { Envelope } from "../../src/server/lib/envelope";
import { readArchive } from "../../src/server/lib/extension-package";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { extensionSecretBinding } from "../../src/server/services/extensions";
import { latestRevision } from "../../src/server/services/revisions";
import { PACKAGE, PUBLIC_JWK, SIGNATURE, signPackage, ustar } from "./extension-fixtures";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";
import { nodeKeyAndCsr } from "./node-csr";

type Manifest = Record<string, unknown> & { capabilities: string[] };

const MiB = 1024 * 1024;
const ID = "hello-sidecar";

/** A 64-bit (or 32-bit) little-endian ELF header for e_machine, padded with random bytes. */
function elf(machine: number, size = 64, elfClass = 2): Buffer {
  const bytes = randomBytes(size);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1], 0);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

/** The example package with a changed manifest and extra files, signed by the test key. */
function build(change: (manifest: Manifest) => void, extra: Record<string, Buffer> = {}) {
  const files = Object.fromEntries(readArchive(PACKAGE).map((f) => [f.path, Buffer.from(f.data)]));
  const manifest = JSON.parse(files["manifest.json"]?.toString() ?? "{}") as Manifest;
  change(manifest);
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  const bytes = ustar({ ...files, ...extra });
  return {
    package: bytes.toString("base64"),
    signature: signPackage(bytes, manifest as never),
    bytes,
  };
}

/** Lua API 2 with a secret, a sidecar and per-site data. */
const sidecarManifest = (manifest: Manifest) => {
  manifest.id = ID;
  manifest.requires = { lua_api: 2 };
  manifest.capabilities = [...manifest.capabilities, "sidecar"];
  manifest.sidecar = { binary: "runtime", args: ["--socket", "{socket}"], memory_mb: 64 };
  manifest.secret = true;
  manifest.data = { max_bytes: 16, max_items: 2, max_total_bytes: 24 };
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("node extensions 1.1: sidecars, secrets and site data", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let channel: NodeChannel;
  let baseUrl = "";
  let clusterId = "";
  let siteId = "";
  let actor = { type: "user" as const, id: "", name: "Admin" };
  let nodeA: Client<typeof NodeService>;
  let nodeB: Client<typeof NodeService>;
  let nodeAId = "";
  // The sidecar package: a binary over 4 MiB, so that it travels in parts.
  const sidecar = build(sidecarManifest, {
    "sidecar/linux-amd64/runtime": elf(62, 5 * MiB + 123),
  });

  const ir = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir);
  };
  const connectCode = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: unknown) => (error instanceof ConnectError ? Code[error.code] : String(error)),
    );

  /** Enrolls a node in the cluster with extensions-v1 and -v2 and returns its mTLS client. */
  const enroll = async (cluster: string, nodeName: string) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId: cluster, nodeName, ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const anonymous = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );
    const enrolled = await anonymous.enroll({
      token: token.token,
      csrPem,
      info: {
        hostname: nodeName,
        agentVersion: "test",
        supportedFeatures: ["tls-v1", "rules-v1", EXTENSIONS_FEATURE, EXTENSIONS_V2_FEATURE],
      },
    });
    return {
      id: enrolled.nodeId,
      client: createClient(
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
      ),
    };
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const [user] = await ctx.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, "admin@example.com"));
    actor = { ...actor, id: user?.id ?? "" };
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "functions",
        domains: ["functions.ext.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    await admin.extensionKeys.add({ publisher: "example.org", key: PUBLIC_JWK, label: "" });
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
    const a = await enroll(clusterId, "edge-a");
    nodeA = a.client;
    nodeAId = a.id;
    const other = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "other", description: "" }, actor),
    );
    nodeB = (await enroll(other.id, "edge-b")).client;
  });
  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("accepts a sidecar binary per architecture as a 64-bit ELF of it", async () => {
    const verified = await admin.extensions.verify(
      build(sidecarManifest, {
        "sidecar/linux-amd64/runtime": elf(62),
        "sidecar/linux-arm64/runtime": elf(183),
      }),
    );
    expect(verified.manifest.capabilities).toContain("sidecar");
    expect(verified.manifest.sidecar).toEqual({
      binary: "runtime",
      args: ["--socket", "{socket}"],
      env: {},
      memory_mb: 64,
      tasks_max: 256,
      health_path: "/healthz",
      connect_timeout_ms: 1000,
      timeout_s: 30,
      max_body: 10485760,
    });
    expect(verified.manifest.data).toEqual({ max_bytes: 16, max_items: 2, max_total_bytes: 24 });
    // One architecture is enough.
    expect(
      (
        await admin.extensions.verify(
          build(sidecarManifest, { "sidecar/linux-arm64/runtime": elf(183) }),
        )
      ).manifest.id,
    ).toBe(ID);
  });

  it("refuses other native files and sidecar manifests that break the rules", async () => {
    const reason = async (input: { package: string; signature: string }) =>
      (await rpcError(admin.extensions.verify(input))).data as { reason: string; detail: string };
    // The wrong architecture, 32-bit, not ELF, another name, another directory.
    const broken: Record<string, Buffer>[] = [
      { "sidecar/linux-amd64/runtime": elf(183) },
      { "sidecar/linux-amd64/runtime": elf(62, 64, 1) },
      { "sidecar/linux-amd64/runtime": Buffer.from(`#!/bin/sh\n${" ".repeat(64)}`) },
      { "sidecar/linux-amd64/runtime": elf(62), "sidecar/linux-amd64/helper": elf(62) },
      { "sidecar/linux-386/runtime": elf(62) },
      { "sidecar/runtime": elf(62) },
    ];
    for (const extra of broken)
      expect(await reason(build(sidecarManifest, extra))).toMatchObject({ reason: "entry" });
    // The manifest's binary is missing.
    expect(await reason(build(sidecarManifest))).toMatchObject({ reason: "manifest" });
    // Native code without a manifest sidecar.
    expect(await reason(build(() => {}, { "sidecar/linux-amd64/runtime": elf(62) }))).toMatchObject(
      { reason: "entry", detail: expect.stringContaining("native code") },
    );
    const binary = { "sidecar/linux-amd64/runtime": elf(62) };
    for (const change of [
      // API 2 members with lua_api 1.
      (m: Manifest) => {
        sidecarManifest(m);
        m.requires = { lua_api: 1 };
      },
      (m: Manifest) => {
        m.secret = true;
      },
      // The capability and the member go together; data needs a sidecar.
      (m: Manifest) => {
        sidecarManifest(m);
        m.capabilities = m.capabilities.filter((c) => c !== "sidecar");
      },
      (m: Manifest) => {
        m.requires = { lua_api: 2 };
        m.capabilities = [...m.capabilities, "sidecar"];
      },
      (m: Manifest) => {
        m.requires = { lua_api: 2 };
        m.data = { max_bytes: 16, max_items: 2, max_total_bytes: 24 };
      },
      // Field rules.
      (m: Manifest) => {
        sidecarManifest(m);
        m.sidecar = { binary: "runtime", memory_mb: 64, env: { EDGEWEIR_X: "1" } };
      },
      (m: Manifest) => {
        sidecarManifest(m);
        m.sidecar = { binary: "runtime", memory_mb: 8 };
      },
      (m: Manifest) => {
        sidecarManifest(m);
        m.data = { max_bytes: 25165825, max_items: 2, max_total_bytes: 24 };
      },
    ])
      expect(await reason(build(change, binary))).toMatchObject({ reason: "manifest" });
  });

  it("allows the larger sizes only to packages with a sidecar", async () => {
    const big = { "assets/big.dat": randomBytes(5 * MiB) };
    expect((await rpcError(admin.extensions.verify(build(() => {}, big)))).data).toMatchObject({
      reason: "size",
    });
    expect((await admin.extensions.verify(sidecar)).size).toBe(sidecar.bytes.length);
    expect(sidecar.bytes.length).toBeGreaterThan(5 * MiB);
  });

  it("takes extension uploads up to their own body limits", () => {
    expect(authenticatedBodyLimit("POST", "/api/v1/extensions")).toBe(96 * MiB);
    expect(authenticatedBodyLimit("POST", "/api/v1/extensions/verify")).toBe(96 * MiB);
    expect(authenticatedBodyLimit("POST", "/rpc/extensions/install")).toBe(96 * MiB);
    expect(authenticatedBodyLimit("POST", "/rpc/extensions/verify")).toBe(96 * MiB);
    expect(authenticatedBodyLimit("PUT", `/api/v1/sites/${siteId}/extensions/${ID}/data/a`)).toBe(
      34 * MiB,
    );
    expect(authenticatedBodyLimit("POST", "/rpc/extensions/putSiteData")).toBe(34 * MiB);
    expect(authenticatedBodyLimit("POST", "/api/v1/sites")).toBe(MAX_AUTHENTICATED_BODY_BYTES);
    expect(authenticatedBodyLimit("PUT", "/api/v1/extensions/settings")).toBe(
      MAX_AUTHENTICATED_BODY_BYTES,
    );
  });

  it("generates the secret when a version with secret: true becomes active", async () => {
    const installed = await admin.extensions.install(sidecar);
    expect(installed).toMatchObject({ id: ID, secretVersion: 1, manifest: { secret: true } });
    const [row] = await ctx.db.select().from(schema.extension).where(eq(schema.extension.id, ID));
    const envelope = JSON.parse(row?.secretEnvelope ?? "{}") as Envelope;
    expect(envelope.purpose).toBe("extension.secret_envelope");
    expect(ctx.masterKey.open(envelope, extensionSecretBinding(ID))).toHaveLength(32);
    // An extension without a secret has none to rotate.
    const plain = await admin.extensions.install({
      package: PACKAGE.toString("base64"),
      signature: SIGNATURE,
    });
    expect(plain.secretVersion).toBe(0);
    expect((await rpcError(admin.extensions.rotateSecret({ id: plain.id }))).code).toBe(
      "EXTENSION_SECRET_NOT_SUPPORTED",
    );
  });

  it("gives secrets only to nodes whose cluster gets the extension", async () => {
    expect((await nodeA.getExtensionSecrets({})).secrets).toEqual([]);
    await admin.extensions.updateSite({ siteId, id: ID, enabled: true, config: {} });
    const extension = (await ir()).extensions.find((e) => e.id === ID);
    expect(extension).toMatchObject({ luaApi: 2, secretVersion: 1 });
    const [secret] = (await nodeA.getExtensionSecrets({})).secrets;
    expect(secret).toMatchObject({ id: ID, version: 1 });
    expect(secret?.current).toHaveLength(32);
    expect(secret?.previous).toHaveLength(0);
    expect((await nodeA.getExtensionSecrets({ ids: [ID] })).secrets).toHaveLength(1);
    expect((await nodeA.getExtensionSecrets({ ids: ["hello-header"] })).secrets).toEqual([]);
    expect((await nodeB.getExtensionSecrets({})).secrets).toEqual([]);
  });

  it("rotates: a new current secret, the old one as previous, the next version", async () => {
    const [before] = (await nodeA.getExtensionSecrets({})).secrets;
    const revision = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    expect((await admin.extensions.rotateSecret({ id: ID })).secretVersion).toBe(2);
    const [after] = (await nodeA.getExtensionSecrets({})).secrets;
    expect(after?.version).toBe(2);
    expect(Buffer.from(after?.previous ?? []).equals(Buffer.from(before?.current ?? []))).toBe(
      true,
    );
    expect(Buffer.from(after?.current ?? []).equals(Buffer.from(before?.current ?? []))).toBe(
      false,
    );
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBeGreaterThan(revision);
    expect((await ir()).extensions.find((e) => e.id === ID)?.secretVersion).toBe(2);
  });

  it("serves packages over 4 MiB in parts", async () => {
    const digest = sha256(sidecar.bytes);
    const first = await nodeA.getExtensionPackage({ sha256: digest, offset: 0n });
    expect(first.package).toHaveLength(4 * MiB);
    expect(first.total).toBe(BigInt(sidecar.bytes.length));
    const rest = await nodeA.getExtensionPackage({ sha256: digest, offset: BigInt(4 * MiB) });
    expect(rest.package).toHaveLength(sidecar.bytes.length - 4 * MiB);
    expect(Buffer.concat([first.package, rest.package]).equals(sidecar.bytes)).toBe(true);
    expect(
      await connectCode(
        nodeA.getExtensionPackage({ sha256: digest, offset: BigInt(sidecar.bytes.length + 1) }),
      ),
    ).toBe("OutOfRange");
    expect(await connectCode(nodeB.getExtensionPackage({ sha256: digest, offset: 0n }))).toBe(
      "NotFound",
    );
  });

  it("keeps site data within the manifest's limits", async () => {
    const put = (name: string, content: Buffer, id = ID) =>
      admin.extensions.putSiteData({ siteId, id, name, content: content.toString("base64") });
    expect((await rpcError(put("a", Buffer.from("x"), "hello-header"))).code).toBe(
      "EXTENSION_DATA_NOT_SUPPORTED",
    );
    const main = Buffer.from("0123456789");
    expect(await put("fn.wasm", main)).toMatchObject({
      name: "fn.wasm",
      sha256: sha256(main),
      size: 10,
    });
    const tooLarge = async (promise: Promise<unknown>) => {
      const error = await rpcError(promise);
      expect(error.code).toBe("EXTENSION_DATA_TOO_LARGE");
      return error.data;
    };
    expect(await tooLarge(put("big", Buffer.alloc(17)))).toMatchObject({
      limit: "max_bytes",
      max: 16,
    });
    await put("b", Buffer.alloc(14, 1));
    expect(await tooLarge(put("c", Buffer.alloc(1)))).toMatchObject({ limit: "max_items", max: 2 });
    expect(await tooLarge(put("b", Buffer.alloc(15)))).toMatchObject({
      limit: "max_total_bytes",
      max: 24,
    });
    expect((await rpcError(put("Bad", Buffer.alloc(1)))).code).toBe("BAD_REQUEST");
    expect(
      (await rpcError(admin.extensions.putSiteData({ siteId, id: ID, name: "x", content: "abc" })))
        .code,
    ).toBe("BAD_REQUEST");
    const list = await admin.extensions.listSiteData({ siteId, id: ID });
    expect(list.map((item) => [item.name, item.size])).toEqual([
      ["b", 14],
      ["fn.wasm", 10],
    ]);
    const site = (await ir()).sites.find((s) => s.id === siteId);
    expect(site?.extensions.find((e) => e.id === ID)?.data).toEqual([
      expect.objectContaining({ name: "b", sha256: sha256(Buffer.alloc(14, 1)), size: 14n }),
      expect.objectContaining({ name: "fn.wasm", sha256: sha256(main), size: 10n }),
    ]);
    const view = (await admin.extensions.forSite({ siteId })).find((e) => e.id === ID);
    expect(view?.dataLimits).toEqual({ maxBytes: 16, maxItems: 2, maxTotalBytes: 24 });
  });

  it("serves data items to nodes of a cluster whose site turns the extension on", async () => {
    const main = Buffer.from("0123456789");
    const item = { extensionId: ID, siteId, sha256: sha256(main) };
    const whole = await nodeA.getExtensionData({ ...item, offset: 0n });
    expect(Buffer.from(whole.data).equals(main)).toBe(true);
    expect(whole.total).toBe(10n);
    expect(Buffer.from((await nodeA.getExtensionData({ ...item, offset: 4n })).data)).toEqual(
      main.subarray(4),
    );
    expect(await connectCode(nodeA.getExtensionData({ ...item, offset: 11n }))).toBe("OutOfRange");
    expect(await connectCode(nodeB.getExtensionData({ ...item, offset: 0n }))).toBe("NotFound");
    expect(
      await connectCode(nodeA.getExtensionData({ ...item, sha256: "0".repeat(64), offset: 0n })),
    ).toBe("NotFound");
    expect(await connectCode(nodeA.getExtensionData({ ...item, siteId: "x", offset: 0n }))).toBe(
      "InvalidArgument",
    );
    await admin.extensions.updateSite({ siteId, id: ID, enabled: false, config: {} });
    expect(await connectCode(nodeA.getExtensionData({ ...item, offset: 0n }))).toBe("NotFound");
    expect((await nodeA.getExtensionSecrets({})).secrets).toEqual([]);
    await admin.extensions.updateSite({ siteId, id: ID, enabled: true, config: {} });
    expect(await connectCode(nodeA.getExtensionData({ ...item, offset: 0n }))).toBe("ok");
  });

  it("keeps the details nodes report when they are a small JSON object", async () => {
    const report = (detailsJson: string) =>
      nodeA.reportStatus({
        appliedRevision: 0n,
        state: ApplyState.APPLIED,
        dataPlaneHealthy: true,
        extensions: [
          {
            id: ID,
            version: "1.0.0",
            sha256: sha256(sidecar.bytes),
            state: "loaded",
            message: "",
            faults: 0n,
            trips: 0n,
            detailsJson,
          },
        ],
      });
    const details = async () =>
      (await admin.extensions.get({ id: ID })).nodes.find((n) => n.nodeId === nodeAId);
    await report(JSON.stringify({ sidecar: { state: "running", restarts: 1 } }));
    expect(await details()).toMatchObject({
      state: "loaded",
      details: { sidecar: { state: "running", restarts: 1 } },
    });
    for (const json of ["[1]", "null", "{", JSON.stringify({ x: "y".repeat(4096) })]) {
      await report(json);
      expect((await details())?.details).toEqual({});
    }
  });

  it("deletes data items, and uninstalling removes the rest", async () => {
    expect(await admin.extensions.deleteSiteData({ siteId, id: ID, name: "b" })).toEqual({
      ok: true,
    });
    expect(
      (await rpcError(admin.extensions.deleteSiteData({ siteId, id: ID, name: "b" }))).code,
    ).toBe("EXTENSION_DATA_NOT_FOUND");
    expect((await admin.extensions.listSiteData({ siteId, id: ID })).map((i) => i.name)).toEqual([
      "fn.wasm",
    ]);
    await admin.extensions.uninstall({ id: ID });
    expect(
      await ctx.db
        .select({ name: schema.siteExtensionData.name })
        .from(schema.siteExtensionData)
        .where(eq(schema.siteExtensionData.extensionId, ID)),
    ).toEqual([]);
  });

  it("audits the rotation and the data changes", async () => {
    const actions = (
      await ctx.db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(like(schema.auditLog.action, "%extension%"))
    ).map((row) => row.action);
    for (const action of [
      "extension.rotate_secret",
      "site.extension_data_put",
      "site.extension_data_delete",
    ])
      expect(actions).toContain(action);
  });
});
