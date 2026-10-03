import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { createTestContext } from "./helpers";

// A CDN in front of the console stores responses without Cache-Control
// (bunny.net for a month) and serves them to the next caller of the URL.
describe("Cache-Control", async () => {
  const web = mkdtempSync(join(tmpdir(), "edgeweir-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>spa shell</title>");
  writeFileSync(join(web, "assets", "index-abc123.js"), "export {};");
  writeFileSync(join(web, "favicon.svg"), "<svg/>");

  const { ctx, client } = await createTestContext();
  const app = createApp(ctx, { webDist: web });
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  afterAll(async () => {
    await client.close();
    rmSync(web, { recursive: true, force: true });
  });

  it("keeps API, auth, health and SPA responses out of every cache", async () => {
    const responses = {
      healthz: await call("/healthz"),
      status: await call("/api/v1/system/status"),
      unauthorized: await call("/api/v1/sites", { headers: { "x-api-key": "ewk_bogus" } }),
      openapi: await call("/api/v1/openapi.json"),
      rpc: await call("/rpc/sites/list", {
        method: "POST",
        headers: { "x-csrf-token": "orpc" },
        body: JSON.stringify({ json: {} }),
      }),
      session: await call("/api/auth/get-session"),
      authNotFound: await call("/api/auth/list-sessions"),
      notFound: await call("/api/nope"),
      install: await call("/install.sh"),
      shell: await call("/sites"),
      root: await call("/"),
      favicon: await call("/favicon.svg"),
    };
    expect(responses.healthz.status).toBe(200);
    expect(responses.status.status).toBe(200);
    expect(responses.unauthorized.status).toBe(401);
    expect(responses.rpc.status).toBe(401);
    expect(responses.session.status).toBe(200);
    expect(responses.authNotFound.status).toBe(404);
    expect(responses.shell.status).toBe(200);
    expect(await responses.shell.text()).toContain("spa shell");
    expect(responses.favicon.status).toBe(200);
    for (const [name, res] of Object.entries(responses)) {
      expect([name, res.headers.get("cache-control")]).toEqual([name, "no-store"]);
    }
  });

  it("leaves content-hashed assets cacheable and answers 404 for missing ones", async () => {
    const res = await call("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export {};");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const missing = await call("/assets/index-old999.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});
