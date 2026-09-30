import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { mirrorPath } from "../../src/server/downloads";
import { createTestContext } from "./helpers";

const SHELL = "<!doctype html><title>spa shell</title>";

describe("/downloads release mirror", async () => {
  const base = mkdtempSync(join(tmpdir(), "edgeweir-downloads-"));
  const mirror = join(base, "mirror");
  const web = join(base, "web");
  const version = "0.2.1-snapshot+abc1234";
  const tarball = `edgeweir-node_${version}_linux_amd64.tar.gz`;
  const payload = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  mkdirSync(join(mirror, "edgeweir-node", `v${version}`), { recursive: true });
  mkdirSync(join(mirror, "cosign", "v3.1.3"), { recursive: true });
  mkdirSync(web, { recursive: true });
  writeFileSync(join(mirror, "edgeweir-node", "latest"), `${version}\n`);
  writeFileSync(join(mirror, "edgeweir-node", `v${version}`, tarball), payload);
  writeFileSync(join(mirror, "edgeweir-node", `v${version}`, "checksums.txt"), "abc  x\n");
  writeFileSync(join(mirror, "cosign", "v3.1.3", "cosign-linux-amd64"), "cosign");
  writeFileSync(join(base, "secret.txt"), "outside the mirror");
  symlinkSync(join(base, "secret.txt"), join(mirror, "edgeweir-node", `v${version}`, "escape"));
  writeFileSync(join(web, "index.html"), SHELL);

  const { ctx, client } = await createTestContext({ EDGEWEIR_DOWNLOADS_DIR: mirror });
  const app = createApp(ctx, { webDist: web });
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const get = (path: string, method = "GET") => app.request(`${origin}${path}`, { method });
  afterAll(async () => {
    await client.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("serves the latest version and mirrored release files", async () => {
    const latest = await get("/downloads/edgeweir-node/latest");
    expect(latest.status).toBe(200);
    expect(await latest.text()).toBe(`${version}\n`);
    expect(latest.headers.get("cache-control")).toBe("no-cache");

    const file = await get(`/downloads/edgeweir-node/v${version}/${tarball}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-length")).toBe(String(payload.length));
    expect(Buffer.from(await file.arrayBuffer())).toEqual(payload);

    const head = await get(`/downloads/edgeweir-node/v${version}/${tarball}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(payload.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const checksums = await get(`/downloads/edgeweir-node/v${version}/checksums.txt`);
    expect(checksums.headers.get("content-type")).toContain("text/plain");
    expect((await get("/downloads/cosign/v3.1.3/cosign-linux-amd64")).status).toBe(200);
  });

  it("answers 404 for files that are not mirrored and for traversal attempts", async () => {
    for (const path of [
      "/downloads/edgeweir-node/v0.9.9/checksums.txt",
      `/downloads/edgeweir-node/v${version}/missing.deb`,
      `/downloads/edgeweir-node/v${version}/escape`,
      `/downloads/edgeweir-node/v${version}/..%2f..%2fsecret.txt`,
      `/downloads/edgeweir-node/v${version}/%2e%2e`,
      "/downloads/edgeweir-node/../secret.txt",
      "/downloads/edgeweir-node/%2e%2e/secret.txt",
      "/downloads/edgeweir-node/v1/checksums.txt",
      "/downloads/edgeweir-node/latest/",
      "/downloads/edgeweir-node",
      "/downloads/other-project/latest",
      "/downloads/secret.txt",
      "/downloads",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body, path).not.toContain("spa shell");
      expect(body, path).not.toContain("outside the mirror");
    }
    // URL normalization turns this into /secret.txt, outside /downloads: a client route.
    expect(await (await get("/downloads/%2e%2e/secret.txt")).text()).not.toContain(
      "outside the mirror",
    );
    expect((await get(`/downloads/edgeweir-node/latest`, "POST")).status).toBe(404);
  });

  it("parses only the documented layout", () => {
    expect(mirrorPath("/downloads/edgeweir-node/latest")).toEqual(["edgeweir-node", "latest"]);
    expect(mirrorPath("/downloads/edgeweir-node/v1.2.3/a.deb")).toEqual([
      "edgeweir-node",
      "v1.2.3",
      "a.deb",
    ]);
    // The edgeweir-openresty packages are released next to edgeweir-node.
    for (const file of [
      "edgeweir-openresty_1.31.1.1-1_arm64.deb",
      "edgeweir-openresty-modsecurity-1.31.1.1-1.x86_64.rpm",
    ])
      expect(mirrorPath(`/downloads/edgeweir-node/v0.3.0/${file}`)).toEqual([
        "edgeweir-node",
        "v0.3.0",
        file,
      ]);
    for (const bad of [
      "/downloads/edgeweir-node/v1.2.3/.hidden",
      "/downloads/edgeweir-node/v1.2.3/a/b",
      "/downloads/edgeweir-node/1.2.3/a.deb",
      "/downloads/edgeweir-node/v1.2.3/%E0%A4%A",
      "/downloads/edgeweir-node/v01.2.3/a.deb",
    ]) {
      expect(mirrorPath(bad), bad).toBeNull();
    }
  });

  it("never falls back to the SPA shell for server paths", async () => {
    for (const [method, path] of [
      ["GET", "/api"],
      ["GET", "/api/nope"],
      ["GET", "/api/v1/nope"],
      ["GET", "/rpc"],
      ["GET", "/rpc/nope"],
      ["POST", "/rpc/nope/deeper"],
      ["POST", "/install.sh"],
      ["POST", "/healthz"],
      ["GET", "/downloads/"],
    ] as const) {
      const res = await get(path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text(), `${method} ${path}`).not.toContain("spa shell");
    }
    // `/` and client-side routes still get the shell.
    for (const path of ["/", "/sites/some-id"]) {
      const route = await get(path);
      expect(route.status, path).toBe(200);
      expect(await route.text(), path).toContain("spa shell");
    }
  });
});

describe("/downloads without a mirror", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  afterAll(() => client.close());

  it("is 404 for everything", async () => {
    const res = await app.request(`${ctx.env.EDGEWEIR_PUBLIC_URL}/downloads/edgeweir-node/latest`);
    expect(res.status).toBe(404);
  });
});
