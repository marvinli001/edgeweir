import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput, siteUpdateInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ApplyState, NodeService, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../../src/server/lib/context";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { createNodeGroup } from "../../src/server/services/node-groups";
import {
  getRevision,
  latestRevision,
  nodeTarget,
  rolloutTargets,
} from "../../src/server/services/revisions";
import { getRollout, setRolloutPolicy } from "../../src/server/services/rollout";
import { createSite, updateSite } from "../../src/server/services/sites";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };

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

/**
 * Heartbeats and watch streams compare revision numbers and content hashes
 * only: the configuration (`ir`) is read where it is shipped (GetConfig).
 */
describe("revision reads of the node channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  // The node channel runs on a database handle that records every statement.
  const queries: string[] = [];
  const db = drizzle({
    client: pglite,
    schema,
    casing: "snake_case",
    logger: { logQuery: (query) => queries.push(query) },
  }) as unknown as Database;
  const app: AppContext = { ...ctx, db };
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let canaryGroup: string;

  /** Reads of config_revision since `from`. */
  const revisionReads = (from: number) =>
    queries.slice(from).filter((q) => /^select .* from "config_revision"/s.test(q));
  /** Reads since `from` that load a configuration. */
  const configReads = (from: number) => revisionReads(from).filter((q) => q.includes('"ir"'));

  beforeAll(async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    clusterId = cluster.id;
    canaryGroup = (
      await createNodeGroup(
        ctx.db,
        { clusterId, name: "canary", regionId: null, isCanary: true },
        actor,
      )
    ).id;
    channel = await startNodeChannel(app);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("reads a revision's head without its configuration", async () => {
    const head = await latestRevision(ctx.db, clusterId, "head");
    expect(head && Object.keys(head).sort()).toEqual(["contentHash", "createdAt", "revision"]);
    const row = await latestRevision(ctx.db, clusterId);
    expect(row?.ir.length).toBeGreaterThan(0);
    expect(row).toMatchObject(head ?? {});
    expect(await getRevision(ctx.db, clusterId, row?.revision ?? 0, "head")).toEqual(head);
    const node = { id: "00000000-0000-4000-8000-000000000000", clusterId };
    expect(await nodeTarget(ctx.db, node, "head")).toEqual(head);
    expect((await rolloutTargets(ctx.db, clusterId, "head")).stable).toEqual(head);
    expect((await nodeTarget(ctx.db, node))?.ir).toEqual(row?.ir);
  });

  it("serves heartbeats and the watch stream from revision heads, GetConfig with the configuration", async () => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeGroupId: canaryGroup, nodeName: "edge-canary", ttlMinutes: 10 },
      {
        actor,
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
    ).enroll({ token: token.token, csrPem, info: { supportedFeatures: ["tls-v1"] } });
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
    const services = { actor, masterKey: ctx.masterKey };
    const { site, revision: created } = await createSite(
      ctx.db,
      siteCreateInput.parse({ name: "shop", domains: ["shop.test"], origins: [{ address: "o" }] }),
      services,
    );
    const heartbeat = (revision: { revision: number; contentHash: string }) =>
      mtls.reportStatus({
        appliedRevision: BigInt(revision.revision),
        appliedContentHash: revision.contentHash,
        state: ApplyState.APPLIED,
        dataPlaneHealthy: true,
      });
    await heartbeat(created);
    // With the canary on, the node (canary group, online) gets candidates:
    // its target differs from the latest and the stable revision.
    await setRolloutPolicy(
      ctx.db,
      {
        id: clusterId,
        enabled: true,
        windowSeconds: 300,
        autoPromote: true,
        errorRatioMultiplier: 2,
        errorRatioFloor: 0.05,
        minRequests: 100,
      },
      actor,
    );
    const rename = async (name: string) =>
      (await updateSite(ctx.db, siteUpdateInput.parse({ id: site.id, name }), services)).revision;
    const candidate = await rename("shop-2");
    expect(await getRollout(ctx.db, clusterId)).toMatchObject({
      state: "canary",
      stableRevision: created.revision,
      candidateRevision: candidate.revision,
    });

    const start = queries.length;
    const abort = new AbortController();
    const stream = mtls
      .watchConfig({ knownRevision: BigInt(created.revision) }, { signal: abort.signal })
      [Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({
      event: WatchEvent.REVISION,
      latestRevision: BigInt(candidate.revision),
      contentHash: candidate.contentHash,
    });
    const replaced = await rename("shop-3");
    ctx.events.emitLocal({
      clusterId,
      revision: replaced.revision,
      contentHash: replaced.contentHash,
    });
    expect((await stream.next()).value).toMatchObject({
      event: WatchEvent.REVISION,
      latestRevision: BigInt(replaced.revision),
    });
    expect((await heartbeat(replaced)).latestRevision).toBe(BigInt(replaced.revision));
    abort.abort();
    // The canary was evaluated after the heartbeat and keeps running.
    expect((await getRollout(ctx.db, clusterId)).state).toBe("canary");
    // Latest, stable and candidate revisions were read, never their configuration.
    expect(revisionReads(start).length).toBeGreaterThanOrEqual(6);
    expect(configReads(start)).toEqual([]);

    let from = queries.length;
    const full = await mtls.getConfig({});
    expect(full.payload.case).toBe("snapshot");
    if (full.payload.case === "snapshot") {
      expect(full.payload.value.revision).toBe(BigInt(replaced.revision));
      expect(full.payload.value.sites.map((s) => s.name)).toEqual(["shop-3"]);
    }
    expect(configReads(from)).toHaveLength(1);

    from = queries.length;
    const diff = await mtls.getConfig({ baseRevision: BigInt(created.revision) });
    expect(diff.payload.case).toBe("diff");
    if (diff.payload.case === "diff") {
      expect(diff.payload.value.upsertedSites.map((s) => s.name)).toEqual(["shop-3"]);
      expect(diff.payload.value.contentHash).toBe(replaced.contentHash);
    }
    // The target's configuration and the base's.
    expect(configReads(from)).toHaveLength(2);
  });
});
