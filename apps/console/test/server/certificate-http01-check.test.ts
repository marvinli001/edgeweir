import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { type AddressResolver, pointing } from "../../src/server/lib/dns-check";
import { issueCertificate } from "../../src/server/services/certificate-worker";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// HTTP-01 requests and issuances check that the nodes can answer and that
// the names point to them, before the CA is asked (audit U-4).

/** A resolver answering from a table; "timeout" fails like a lookup that timed out. */
function fakeResolver(table: Record<string, { v4?: string[]; v6?: string[] } | "timeout">) {
  const lookup = (family: "v4" | "v6") => async (name: string) => {
    const entry = table[name];
    if (entry === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const answer = entry?.[family];
    if (!answer?.length)
      throw Object.assign(new Error("no data"), { code: entry ? "ENODATA" : "ENOTFOUND" });
    return answer;
  };
  return { resolve4: lookup("v4"), resolve6: lookup("v6") } satisfies AddressResolver;
}

describe("where a name points", () => {
  const nodes = ["203.0.113.10", "2001:db8::10"];
  const resolver = fakeResolver({
    "ok.test": { v4: ["203.0.113.10"], v6: ["2001:0db8:0:0:0:0:0:10"] },
    "v4only.test": { v4: ["203.0.113.10"] },
    "origin.test": { v4: ["198.51.100.7"] },
    "mixed.test": { v4: ["203.0.113.10", "198.51.100.7"] },
    "slow.test": "timeout",
  });
  it("compares every address with the nodes'", async () => {
    expect(await pointing(resolver, "ok.test", nodes)).toBe("ok");
    expect(await pointing(resolver, "v4only.test", nodes)).toBe("ok");
    expect(await pointing(resolver, "origin.test", nodes)).toBe("elsewhere");
    expect(await pointing(resolver, "mixed.test", nodes)).toBe("elsewhere");
    expect(await pointing(resolver, "missing.test", nodes)).toBe("unresolved");
  });
  it("never decides without an answer or a node address", async () => {
    expect(await pointing(resolver, "slow.test", nodes)).toBe("unknown");
    expect(await pointing(resolver, "origin.test", [])).toBe("unknown");
  });
});

/** A stand-in for edgeweir-certd that records its requests and fails. */
function fakeCertd(dir: string) {
  const requests = join(dir, "requests.jsonl");
  const bin = join(dir, "certd");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  fs.appendFileSync(${JSON.stringify(requests)}, input.split("\\n")[0] + "\\n");
  process.stdout.write(JSON.stringify({ ok: false, code: "acme_unauthorized" }) + "\\n");
  process.exit(1);
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(requests, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    },
  };
}

describe("HTTP-01 preconditions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-certd-"));
  const certd = fakeCertd(dir);
  const directory = "https://ca.internal.test/directory";
  const { ctx, client } = await createTestContext({
    EDGEWEIR_CERTD_BIN: certd.bin,
    EDGEWEIR_ACME_DIRECTORY: directory,
  });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const table: Parameters<typeof fakeResolver>[0] = {};
  ctx.resolver = fakeResolver(table);
  let api: ApiClient;
  let clusterId = "";
  let nodeId = "";

  const request = (names: string[], extra: Record<string, unknown> = {}) =>
    api.certificates.request({
      name: names[0] ?? "",
      names,
      email: "ops@example.com",
      autoRenew: true,
      ...extra,
    });
  const node = (set: Partial<typeof schema.node.$inferInsert>) =>
    ctx.db.update(schema.node).set(set).where(eq(schema.node.id, nodeId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const cluster = (await api.clusters.list())[0];
    clusterId = cluster?.id ?? "";
    await api.sites.create({
      name: "check",
      domains: ["a.check.test", "b.check.test"],
      origins: [{ address: "origin.example.com" }],
    });
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        nodeGroupId: (await api.nodeGroups.list({ clusterId }))[0]?.id ?? "",
        name: "edge-1",
        supportedFeatures: ["tls-v1"],
      })
      .returning();
    nodeId = row?.id ?? "";
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("needs an online node in the cluster, and every online node with http01-v1", async () => {
    expect(await rpcError(request(["a.check.test"]))).toMatchObject({
      code: "CERTIFICATE_NODES_OFFLINE",
      data: { clusters: "default" },
    });
    await node({ lastSeenAt: new Date() });
    expect(await rpcError(request(["a.check.test"]))).toMatchObject({
      code: "NODE_CAPABILITY_REQUIRED",
      data: { features: "http01-v1", nodes: "edge-1" },
    });
    await node({ supportedFeatures: ["tls-v1", "http01-v1"] });
    // No public address known for the node: nothing is looked up, nothing refused.
    expect((await request(["a.check.test"])).status).toBe("pending");
  });

  it("refuses names that do not resolve to the cluster's nodes, unless asked not to check", async () => {
    await node({ lastSeenAt: new Date() });
    await ctx.db
      .insert(schema.nodeIp)
      .values({ nodeId, address: "203.0.113.10", source: "configured" });
    table["a.check.test"] = { v4: ["203.0.113.10"] };
    table["b.check.test"] = { v4: ["198.51.100.7"] };
    expect((await request(["a.check.test"])).status).toBe("pending");
    expect(await rpcError(request(["a.check.test", "b.check.test"]))).toMatchObject({
      code: "CERTIFICATE_DNS_NOT_POINTING",
      data: { names: "b.check.test" },
    });
    delete table["b.check.test"];
    expect((await rpcError(request(["b.check.test"]))).code).toBe("CERTIFICATE_DNS_NOT_POINTING");
    // A lookup that times out does not refuse.
    table["b.check.test"] = "timeout";
    expect((await request(["b.check.test"])).status).toBe("pending");
    table["b.check.test"] = { v4: ["198.51.100.7"] };
    const skipped = await request(["b.check.test"], { skipDnsCheck: true });
    const [row] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, skipped.id));
    expect(row?.acme.skipDnsCheck).toBe("true");
  });

  it("fails an issuance before asking the CA when a name points elsewhere", async () => {
    await node({ lastSeenAt: new Date() });
    table["a.check.test"] = { v4: ["203.0.113.10"] };
    const { id } = await request(["a.check.test"]);
    table["a.check.test"] = { v4: ["198.51.100.7"] };
    const calls = certd.calls();
    await issueCertificate(ctx, id);
    const [failed] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, id));
    expect(failed).toMatchObject({ status: "error", lastError: "http01_dns_not_pointing" });
    expect(failed?.renewAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(certd.calls()).toBe(calls);
    // Skipped checks go to the CA (which refuses here).
    const skipped = await request(["a.check.test"], { skipDnsCheck: true });
    await issueCertificate(ctx, skipped.id);
    expect(certd.calls()).toBe(calls + 1);
    const [refused] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, skipped.id));
    expect(refused?.lastError).toBe("acme_unauthorized");
  });

  it("shows the directory EDGEWEIR_ACME_DIRECTORY sets and keeps the one an attempt used", async () => {
    expect(await api.certificates.settings()).toEqual({ acmeDirectory: directory });
    const used = await ctx.db
      .select({ acme: schema.certificate.acme, lastError: schema.certificate.lastError })
      .from(schema.certificate)
      .where(eq(schema.certificate.lastError, "acme_unauthorized"));
    expect(used.map((row) => row.acme.directoryUrl)).toEqual([directory]);
  });
});
