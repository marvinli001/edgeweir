import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { type Client, Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  compileNodeConfig,
  decodeNodeConfig,
  EXTENSIONS_FEATURE,
  EXTENSIONS_V2_FEATURE,
} from "@edgeweir/config-compiler";
import { EXTENSIONS_NODE_FEATURE } from "@edgeweir/contract";
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
import { extensionSecretBinding, loadExtensionInput } from "../../src/server/services/extensions";
import { latestRevision } from "../../src/server/services/revisions";
import { currentStable } from "../../src/server/services/rollback";
import { PACKAGE, PUBLIC_JWK, SIGNATURE, signPackage, ustar } from "./extension-fixtures";
import { seedNodeExtension } from "./extension-node-fixtures";
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
  let nodeBId = "";
  let secondClusterId = "";
  let nodePackages: Awaited<ReturnType<typeof seedNodeExtension>>;
  // The sidecar package: a binary over 4 MiB, so that it travels in parts.
  const sidecar = build(sidecarManifest, {
    "sidecar/linux-amd64/runtime": elf(62, 5 * MiB + 123),
  });

  const ir = async (cluster = clusterId) => {
    const row = await latestRevision(ctx.db, cluster);
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
    secondClusterId = other.id;
    const b = await enroll(other.id, "edge-b");
    nodeB = b.client;
    nodeBId = b.id;
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

  const nodeId = "node-control";
  const nodeFeatures = [
    "tls-v1",
    "rules-v1",
    EXTENSIONS_FEATURE,
    EXTENSIONS_V2_FEATURE,
    EXTENSIONS_NODE_FEATURE,
  ];
  const nodeBinding = {
    status: { port: 9700, bind: "127.0.0.1", allow: ["::1/128", "127.0.0.1/32"] },
  };

  it("delivers an effective node package and secret to a zero-site cluster, with no binding", async () => {
    nodePackages = await seedNodeExtension(ctx.db, nodeId, [
      { secret: true },
      {
        secret: true,
        listeners: [{ name: "status", default_port: 9145, methods: ["HEAD", "GET"] }],
      },
      {
        secret: true,
        listeners: [{ name: "changed", default_port: 9145, methods: ["GET"] }],
      },
      {
        secret: false,
        listeners: [{ name: "status", default_port: 9145, methods: ["HEAD"] }],
      },
    ]);
    await admin.extensions.updateNodeSettings({
      id: nodeId,
      settings: { clusterIds: [secondClusterId], listeners: { status: null } },
    });
    await admin.extensions.rotateSecret({ id: nodeId });
    const revisions = await ctx.db.select().from(schema.configRevision);
    const audits = await ctx.db.select().from(schema.auditLog);
    expect(await rpcError(admin.extensions.update({ id: nodeId, enabled: true }))).toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      data: { features: EXTENSIONS_NODE_FEATURE },
    });
    expect(await ctx.db.select().from(schema.configRevision)).toEqual(revisions);
    expect(await ctx.db.select().from(schema.auditLog)).toEqual(audits);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: nodeFeatures })
      .where(eq(schema.node.id, nodeBId));
    await admin.extensions.update({ id: nodeId, enabled: true });
    const config = await ir(secondClusterId);
    expect(config.sites).toEqual([]);
    expect(config.extensions).toMatchObject([
      {
        id: nodeId,
        scope: "node",
        configJson: '{"label":"status"}',
        listeners: [],
        secretVersion: 1,
      },
    ]);
    expect(config.requiredFeatures).toContain(EXTENSIONS_NODE_FEATURE);
    const received = await nodeB.getConfig({});
    expect(received.payload.case).toBe("snapshot");
    if (received.payload.case === "snapshot") expect(received.payload.value).toEqual(config);
    await ctx.db
      .update(schema.node)
      .set({
        supportedFeatures: nodeFeatures.filter((feature) => feature !== EXTENSIONS_NODE_FEATURE),
      })
      .where(eq(schema.node.id, nodeBId));
    expect(await connectCode(nodeB.getConfig({}))).toBe("FailedPrecondition");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: nodeFeatures })
      .where(eq(schema.node.id, nodeBId));
    const detail = await admin.extensions.get({ id: nodeId });
    expect(detail).toMatchObject({
      sites: 0,
      nodesLoaded: 0,
      nodes: [{ nodeId: nodeBId, state: "pending" }],
    });
    const digest = nodePackages[0]?.sha256 ?? "";
    const part = await nodeB.getExtensionPackage({ sha256: digest, offset: 17n });
    expect(Buffer.from(part.package)).toEqual(nodePackages[0]?.package.subarray(17));
    expect(part.total).toBe(BigInt(nodePackages[0]?.size ?? 0));
    expect(
      await connectCode(nodeB.getExtensionPackage({ sha256: digest, offset: part.total + 1n })),
    ).toBe("OutOfRange");
    const [secret] = (await nodeB.getExtensionSecrets({ ids: [nodeId] })).secrets;
    expect(secret).toMatchObject({ id: nodeId, version: 1 });
    expect(secret?.current).toHaveLength(32);
    const [stored] = await ctx.db
      .select()
      .from(schema.extension)
      .where(eq(schema.extension.id, nodeId));
    const envelope = JSON.parse(stored?.secretEnvelope ?? "{}") as Envelope;
    expect(ctx.masterKey.open(envelope, extensionSecretBinding(nodeId))).toEqual(
      Buffer.from(secret?.current ?? []),
    );
    expect(() => ctx.masterKey.open(envelope, extensionSecretBinding("other-node"))).toThrow();
    await ctx.db.insert(schema.siteExtension).values({
      siteId,
      extensionId: nodeId,
      enabled: true,
      config: { forged: true },
    });
    expect(await connectCode(nodeA.getExtensionPackage({ sha256: digest }))).toBe("NotFound");
    expect((await nodeA.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
    const legacyInput = await loadExtensionInput(ctx.db, []);
    expect(
      compileNodeConfig({ clusterId: secondClusterId, sites: [], ...legacyInput }, 1n).extensions,
    ).toEqual([]);
  });

  it("uses signed listener limits across upgrade and rollback without changing package bytes", async () => {
    await admin.extensions.updateNodeSettings({
      id: nodeId,
      settings: { clusterIds: [secondClusterId], listeners: nodeBinding },
    });
    const original = await ir(secondClusterId);
    expect(original.extensions[0]?.listeners).toMatchObject([
      { name: "status", port: 9700, methods: ["GET"], maxBody: 0 },
    ]);
    await admin.extensions.activate({ id: nodeId, version: "1.0.1" });
    expect((await ir(secondClusterId)).extensions[0]?.listeners).toMatchObject([
      { methods: ["GET", "HEAD"], maxBody: 4096 },
    ]);
    expect((await ir(secondClusterId)).extensions[0]?.signature).toBe(nodePackages[1]?.signature);
    const rollbackPackage = await nodeB.getExtensionPackage({
      sha256: nodePackages[0]?.sha256 ?? "",
    });
    expect(Buffer.from(rollbackPackage.package)).toEqual(nodePackages[0]?.package);
    await admin.extensions.activate({ id: nodeId, version: "1.0.0" });
    expect((await ir(secondClusterId)).contentHash).toBe(original.contentHash);
    const revisions = await ctx.db.select().from(schema.configRevision);
    const audits = await ctx.db.select().from(schema.auditLog);
    const settings = await admin.extensions.nodeSettings({ id: nodeId });
    expect(
      await rpcError(admin.extensions.activate({ id: nodeId, version: "1.0.2" })),
    ).toMatchObject({ code: "EXTENSION_NODE_SETTINGS_INVALID" });
    expect((await admin.extensions.get({ id: nodeId })).version).toBe("1.0.0");
    expect(await admin.extensions.nodeSettings({ id: nodeId })).toEqual(settings);
    expect(await ctx.db.select().from(schema.configRevision)).toEqual(revisions);
    expect(await ctx.db.select().from(schema.auditLog)).toEqual(audits);
    const stored = await ctx.db
      .select()
      .from(schema.extensionVersion)
      .where(eq(schema.extensionVersion.extensionId, nodeId));
    for (const pkg of nodePackages) {
      const version = stored.find((row) => row.version === pkg.version);
      expect(Buffer.from(version?.package ?? [])).toEqual(pkg.package);
      expect(version).toMatchObject({
        sha256: pkg.sha256,
        signature: pkg.signature,
        manifest: pkg.manifest,
      });
    }
  });

  it("keeps old and new signed node packages distinct through a live canary and safety changes", async () => {
    const stable = await enroll(secondClusterId, "edge-stable");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: nodeFeatures })
      .where(eq(schema.node.id, stable.id));
    const group = await admin.nodeGroups.create({
      clusterId: secondClusterId,
      name: "canary",
      isCanary: true,
    });
    await ctx.db
      .update(schema.node)
      .set({ nodeGroupId: group.id, lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeBId));
    const policy = {
      id: secondClusterId,
      enabled: true,
      windowSeconds: 300,
      autoPromote: false,
      errorRatioMultiplier: 2,
      errorRatioFloor: 0.05,
      minRequests: 10,
    };
    const snapshot = async (node: Client<typeof NodeService>) => {
      const reply = await node.getConfig({});
      if (reply.payload.case !== "snapshot") throw new Error("expected snapshot");
      return reply.payload.value;
    };
    const original = await latestRevision(ctx.db, secondClusterId);
    await admin.clusters.setRolloutPolicy(policy);
    await admin.extensions.activate({ id: nodeId, version: "1.0.1" });
    await admin.extensions.update({ id: nodeId, config: { label: "candidate" } });
    expect((await admin.clusters.rollout({ id: secondClusterId })).state).toBe("canary");
    const candidate = (await snapshot(nodeB)).extensions[0];
    const previous = (await snapshot(stable.client)).extensions[0];
    expect(candidate).toMatchObject({
      sha256: nodePackages[1]?.sha256,
      configJson: '{"label":"candidate"}',
      listeners: [{ methods: ["GET", "HEAD"], maxBody: 4096 }],
    });
    expect(previous).toMatchObject({
      sha256: nodePackages[0]?.sha256,
      configJson: '{"label":"status"}',
      listeners: [{ methods: ["GET"], maxBody: 0 }],
    });
    for (const [node, version] of [
      [nodeB, 1],
      [stable.client, 0],
    ] as const) {
      const part = await node.getExtensionPackage({ sha256: nodePackages[version]?.sha256 ?? "" });
      expect(Buffer.from(part.package)).toEqual(nodePackages[version]?.package);
      expect((await node.getExtensionSecrets({ ids: [nodeId] })).secrets).toMatchObject([
        { id: nodeId, version: 1 },
      ]);
    }
    await admin.extensions.rotateSecret({ id: nodeId });
    const issued = (await stable.client.getExtensionSecrets({ ids: [nodeId] })).secrets[0];
    expect((await snapshot(stable.client)).extensions[0]).toMatchObject({
      sha256: nodePackages[0]?.sha256,
      secretVersion: issued?.version,
    });
    expect(issued?.version).toBe(2);
    const listeners = { status: { ...nodeBinding.status, port: 9701, allow: ["127.0.0.2/32"] } };
    await admin.extensions.updateNodeSettings({
      id: nodeId,
      settings: { clusterIds: [secondClusterId], listeners },
    });
    await admin.clusters.abortRollout({ id: secondClusterId });
    for (const node of [nodeB, stable.client])
      expect((await snapshot(node)).extensions[0]).toMatchObject({
        sha256: nodePackages[0]?.sha256,
        listeners: [{ port: 9701, allow: ["127.0.0.2/32"], methods: ["GET"], maxBody: 0 }],
      });
    await admin.clusters.rollback({ id: secondClusterId, revision: original?.revision ?? 0 });
    expect((await snapshot(stable.client)).extensions[0]).toMatchObject({
      sha256: nodePackages[1]?.sha256,
      listeners: [{ port: 9701, allow: ["127.0.0.2/32"] }],
    });
    await admin.extensions.activate({ id: nodeId, version: "1.0.0" });
    await admin.clusters.promoteRollout({ id: secondClusterId });
    await admin.extensions.activate({ id: nodeId, version: "1.0.3" });
    expect((await snapshot(stable.client)).extensions[0]?.sha256).toBe(nodePackages[0]?.sha256);
    expect((await snapshot(nodeB)).extensions[0]?.sha256).toBe(nodePackages[3]?.sha256);
    expect((await stable.client.getExtensionSecrets({ ids: [nodeId] })).secrets[0]?.version).toBe(
      2,
    );
    await admin.extensions.updateSettings({ disabled: true });
    for (const node of [nodeB, stable.client]) {
      expect((await snapshot(node)).extensions).toEqual([]);
      expect(
        await connectCode(node.getExtensionPackage({ sha256: nodePackages[0]?.sha256 ?? "" })),
      ).toBe("NotFound");
      expect((await node.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
    }
    await admin.extensions.updateSettings({ disabled: false });
    expect((await snapshot(stable.client)).extensions).toEqual([]);
    await admin.clusters.promoteRollout({ id: secondClusterId });
    await admin.extensions.activate({ id: nodeId, version: "1.0.0" });
    await admin.extensions.deleteVersion({ id: nodeId, version: "1.0.3" });
    expect((await snapshot(stable.client)).extensions).toEqual([]);
    expect((await snapshot(nodeB)).extensions[0]?.sha256).toBe(nodePackages[0]?.sha256);
    await admin.extensions.updateNodeSettings({ id: nodeId, settings: { clusterIds: [] } });
    for (const node of [nodeB, stable.client]) {
      expect((await snapshot(node)).extensions).toEqual([]);
      expect((await node.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
    }
    await admin.clusters.setRolloutPolicy({ ...policy, enabled: false });
  });

  it("publishes both old and new targets for null, omitted, subset and empty target sets", async () => {
    const before = await latestRevision(ctx.db, secondClusterId);
    expect(
      await rpcError(
        admin.extensions.updateNodeSettings({ id: nodeId, settings: { clusterIds: null } }),
      ),
    ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
    expect((await latestRevision(ctx.db, secondClusterId))?.revision).toBe(before?.revision);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: nodeFeatures })
      .where(eq(schema.node.id, nodeAId));
    await admin.extensions.updateNodeSettings({ id: nodeId, settings: { clusterIds: null } });
    expect((await ir()).extensions.some((entry) => entry.id === nodeId)).toBe(true);
    expect(
      (await ir()).sites.flatMap((entry) => entry.extensions).some((entry) => entry.id === nodeId),
    ).toBe(false);
    const added = await admin.clusters.create({ name: "node-all-target", description: "" });
    expect((await ir(added.id)).extensions).toMatchObject([{ id: nodeId, listeners: [] }]);
    await admin.extensions.updateNodeSettings({ id: nodeId, settings: { clusterIds: [] } });
    for (const cluster of [clusterId, secondClusterId, added.id])
      expect((await ir(cluster)).extensions.some((entry) => entry.id === nodeId)).toBe(false);
    for (const node of [nodeA, nodeB]) {
      expect(
        await connectCode(node.getExtensionPackage({ sha256: nodePackages[0]?.sha256 ?? "" })),
      ).toBe("NotFound");
      expect((await node.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
    }
    await admin.extensions.updateNodeSettings({ id: nodeId, settings: {} });
    expect((await ir(secondClusterId)).extensions).toMatchObject([{ id: nodeId, listeners: [] }]);
    await admin.extensions.updateNodeSettings({
      id: nodeId,
      settings: { clusterIds: [secondClusterId] },
    });
    expect((await ir()).extensions.some((entry) => entry.id === nodeId)).toBe(false);
    expect((await ir(added.id)).extensions).toEqual([]);
  });

  it("withdraws node descriptors and fetch access on kill/disable, and rotates through the existing envelope", async () => {
    await admin.extensions.updateNodeSettings({
      id: nodeId,
      settings: { clusterIds: [secondClusterId], listeners: nodeBinding },
    });
    for (const change of ["kill", "disable"] as const) {
      const active = await latestRevision(ctx.db, secondClusterId);
      if (change === "kill") await admin.extensions.updateSettings({ disabled: true });
      else await admin.extensions.update({ id: nodeId, enabled: false });
      expect((await ir(secondClusterId)).extensions).toEqual([]);
      expect(
        await connectCode(nodeB.getExtensionPackage({ sha256: nodePackages[0]?.sha256 ?? "" })),
      ).toBe("NotFound");
      expect((await nodeB.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
      const stable = await ctx.db.transaction((tx) =>
        currentStable(tx, secondClusterId, decodeNodeConfig(active?.ir ?? new Uint8Array())),
      );
      expect(stable.extensions).toEqual([]);
      await admin.clusters.rollback({ id: secondClusterId, revision: active?.revision ?? 0 });
      expect((await ir(secondClusterId)).extensions).toEqual([]);
      if (change === "kill") await admin.extensions.updateSettings({ disabled: false });
      else await admin.extensions.update({ id: nodeId, enabled: true });
      expect((await ir(secondClusterId)).extensions).toMatchObject([{ id: nodeId }]);
    }
    const [before] = (await nodeB.getExtensionSecrets({ ids: [nodeId] })).secrets;
    await admin.extensions.rotateSecret({ id: nodeId });
    const [after] = (await nodeB.getExtensionSecrets({ ids: [nodeId] })).secrets;
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.previous).toEqual(before?.current);
    expect(after?.current).not.toEqual(before?.current);
    expect((await ir(secondClusterId)).extensions[0]?.secretVersion).toBe(after?.version);
    await admin.extensions.uninstall({ id: nodeId });
    expect((await ir(secondClusterId)).extensions).toEqual([]);
    expect((await nodeB.getExtensionSecrets({ ids: [nodeId] })).secrets).toEqual([]);
  });
});
