import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { createClusterTx } from "../../src/server/services/clusters";
import { createTestContext, rpcClient } from "./helpers";

describe("HTTP API", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, { type: "system", id: "" }),
    );
  });
  afterAll(() => client.close());

  it("serves health and an install script bound to this console", async () => {
    expect(await (await call("/healthz")).json()).toMatchObject({ status: "ok" });
    const res = await call("/install.sh");
    expect(res.headers.get("content-type")).toContain("shellscript");
    const script = await res.text();
    expect(script).toContain(`CONSOLE_URL="${origin}"`);
    expect(script).not.toContain("__EDGEWEIR_CONSOLE_URL__");
    // Verification happens before anything is executed (the step order of
    // `main` is checked in install-script.test.ts).
    const main = script.slice(script.indexOf("main() {"));
    const verify = main.indexOf("\n  verify_signature\n");
    const sha = main.indexOf("\n  verify_checksum\n");
    const exec = main.indexOf("\n  enroll\n");
    expect(verify).toBeGreaterThan(0);
    expect(sha).toBeGreaterThan(verify);
    expect(exec).toBeGreaterThan(sha);
    expect(script).toContain("verify-blob");
    expect(script).toContain("sha256sum -c");
    execFileSync("bash", ["-n"], { input: script });
  });

  it("publishes an OpenAPI document generated from the contract", async () => {
    const spec = (await (await call("/api/v1/openapi.json")).json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/sites", "/nodes", "/clusters", "/enrollment-tokens"]),
    );
    expect(spec.paths["/sites"]).toHaveProperty("post");
  });

  it("requires authentication for every procedure but the public ones", async () => {
    expect((await call("/api/v1/system/status")).status).toBe(200);
    expect(await (await call("/api/v1/system/status")).json()).toMatchObject({
      initialized: false,
    });
    expect((await call("/api/v1/sites")).status).toBe(401);
    expect((await call("/api/v1/nodes")).status).toBe(401);
    expect(
      (
        await call("/rpc/sites/list", {
          method: "POST",
          headers: { "x-csrf-token": "orpc" },
          body: JSON.stringify({ json: {} }),
        })
      ).status,
    ).toBe(401);
    expect((await call("/api/v1/sites", { headers: { "x-api-key": "ewk_bogus" } })).status).toBe(
      401,
    );
  });

  it("signs in, issues an API key and creates a site through /api/v1", async () => {
    await ctx.auth.api.createUser({
      body: {
        email: "admin@example.com",
        password: "correct horse battery",
        name: "Admin",
        role: "admin",
      },
    });

    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
    });
    expect(signIn.status).toBe(200);
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");

    const { key } = await rpcClient(app, origin, cookie).accessKeys.create({
      name: "ci",
      scope: "write",
    });
    expect(key.startsWith("ewk_")).toBe(true);

    const res = await call("/api/v1/sites", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({
        name: "demo",
        domains: ["demo.test"],
        origins: [{ address: "whoami", port: 80 }],
        cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 60 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      site: { domains: string[] };
      revision: { revision: number };
    };
    expect(body.site.domains).toEqual(["demo.test"]);
    expect(body.revision.revision).toBe(2);

    const dup = await call("/api/v1/sites", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({
        name: "dup",
        domains: ["demo.test"],
        origins: [{ address: "whoami" }],
      }),
    });
    expect(dup.status).toBe(409);

    const list = await call("/api/v1/sites", { headers: { "x-api-key": key } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[]; total: number }).total).toBe(1);

    // Each surface accepts only its own credential.
    expect((await call("/api/v1/sites", { headers: { cookie } })).status).toBe(401);
    const rpcWithKey = await call("/rpc/sites/list", {
      method: "POST",
      headers: { "x-api-key": key, "x-csrf-token": "orpc" },
      body: JSON.stringify({ json: {} }),
    });
    expect(rpcWithKey.status).toBe(401);
    const rpcWithCookie = await call("/rpc/sites/list", {
      method: "POST",
      headers: { cookie, "x-csrf-token": "orpc" },
      body: JSON.stringify({ json: {} }),
    });
    expect(rpcWithCookie.status).toBe(200);
    // Without the CSRF header the UI surface refuses the request.
    const rpcNoCsrf = await call("/rpc/sites/list", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(rpcNoCsrf.status).toBe(403);

    const invalid = await call("/api/v1/sites", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ name: "x", domains: ["not a domain"], origins: [{ address: "a" }] }),
    });
    expect(invalid.status).toBe(400);

    const audit = await call("/api/v1/audit-logs?action=site.create", {
      headers: { "x-api-key": key },
    });
    const entries = (await audit.json()) as {
      items: { action: string; actorType: string; actorName: string; targetName: string }[];
    };
    expect(entries.items).toHaveLength(1);
    expect(entries.items[0]).toMatchObject({
      actorType: "api_key",
      actorName: "Admin",
      targetName: "demo",
    });

    // The operator's key reaches the system settings as well.
    expect((await call("/api/v1/settings", { headers: { "x-api-key": key } })).status).toBe(200);
  });
});
