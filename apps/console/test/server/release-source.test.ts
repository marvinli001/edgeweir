import { createServer, type Server } from "node:http";
import { DEFAULT_NODE_RELEASE_BASE_URL } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { nodeRelease } from "../../src/server/services/upgrades";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const manifest = (version: string) =>
  ["amd64", "arm64"]
    .map((arch) => `${"b".repeat(64)}  edgeweir-node_${version}_linux_${arch}.tar.gz`)
    .join("\n");

describe("node release source in system settings", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let mirror: Server;
  let mirrorUrl: string;
  const requests: string[] = [];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const org = await admin.organizations.create({ name: "Tenant" });
    await admin.users.create({
      name: "Tina",
      email: "tina@tenant.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    mirror = createServer((req, res) => {
      requests.push(req.url ?? "");
      const version = req.url?.match(/^\/releases\/v([^/]+)\/checksums\.txt$/)?.[1];
      if (req.url?.startsWith("/moved/")) {
        res.writeHead(302, { location: `/releases/${req.url.slice("/moved/".length)}` });
        res.end();
      } else if (req.url?.startsWith("/private/")) {
        // A hop into a range the operator did not allow.
        res.writeHead(302, { location: "http://10.255.255.1/releases/v1.0.0/checksums.txt" });
        res.end();
      } else if (version) res.end(manifest(version));
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mirror.listen(0, "127.0.0.1", resolve));
    const bound = mirror.address();
    if (!bound || typeof bound === "string") throw new Error("mirror missing");
    mirrorUrl = `http://127.0.0.1:${bound.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => mirror.close(() => resolve()));
    await client.close();
  });

  it("falls back to the environment, then to the official releases", async () => {
    expect(await admin.settings.releaseSource()).toEqual({
      url: "",
      effectiveUrl: DEFAULT_NODE_RELEASE_BASE_URL,
      source: "default",
    });
    ctx.env.EDGEWEIR_NODE_RELEASE_BASE_URL = "https://mirror.example.test/edgeweir";
    try {
      expect(await admin.settings.releaseSource()).toMatchObject({
        effectiveUrl: "https://mirror.example.test/edgeweir",
        source: "environment",
      });
    } finally {
      ctx.env.EDGEWEIR_NODE_RELEASE_BASE_URL = undefined;
    }
  });

  it("is for platform administrators only", async () => {
    expect((await rpcError(tenant.settings.releaseSource())).code).toBe("FORBIDDEN");
    expect(
      (await rpcError(tenant.settings.setReleaseSource({ url: "https://mirror.example.test" })))
        .code,
    ).toBe("FORBIDDEN");
  });

  it("refuses special-purpose addresses the operator did not allow", async () => {
    for (const url of [`${mirrorUrl}/releases`, "https://169.254.169.254/latest"]) {
      expect((await rpcError(admin.settings.setReleaseSource({ url }))).code, url).toBe(
        "RELEASE_SOURCE_REFUSED",
      );
    }
    expect((await admin.settings.releaseSource()).source).toBe("default");
  });

  it("reads manifests from a saved mirror under the outbound policy", async () => {
    ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "127.0.0.0/8";
    try {
      const saved = await admin.settings.setReleaseSource({ url: `${mirrorUrl}/moved` });
      expect(saved).toEqual({
        url: `${mirrorUrl}/moved`,
        effectiveUrl: `${mirrorUrl}/moved`,
        source: "setting",
      });
      // The redirect is followed after checking the next hop again.
      const release = await nodeRelease(ctx, "1.2.3");
      expect(release.artifacts.map((a) => a.archiveUrl)).toEqual([
        `${mirrorUrl}/moved/v1.2.3/edgeweir-node_1.2.3_linux_amd64.tar.gz`,
        `${mirrorUrl}/moved/v1.2.3/edgeweir-node_1.2.3_linux_arm64.tar.gz`,
      ]);
      expect(requests).toContain("/releases/v1.2.3/checksums.txt");

      await admin.settings.setReleaseSource({ url: `${mirrorUrl}/private` });
      await expect(nodeRelease(ctx, "1.0.0")).rejects.toMatchObject({
        code: "UPGRADE_RELEASE_UNAVAILABLE",
      });
    } finally {
      ctx.env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS = "";
    }
    // Without the allow list the saved loopback mirror is no longer reachable.
    await expect(nodeRelease(ctx, "1.2.3")).rejects.toMatchObject({
      code: "UPGRADE_RELEASE_UNAVAILABLE",
    });
  });

  it("clears back to the fallback and audits every change", async () => {
    expect(await admin.settings.setReleaseSource({ url: "" })).toMatchObject({
      url: "",
      source: "default",
    });
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.release_source_update"));
    expect(audits.map((a) => a.metadata)).toEqual([
      { before: "", after: `${mirrorUrl}/moved` },
      { before: `${mirrorUrl}/moved`, after: `${mirrorUrl}/private` },
      { before: `${mirrorUrl}/private`, after: "" },
    ]);
  });
});
