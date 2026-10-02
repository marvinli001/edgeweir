import type { AddressInfo } from "node:net";
import { schema } from "@edgeweir/db";
import { serve } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { createAuth } from "../../src/server/lib/auth";
import { resolveAuthSecret } from "../../src/server/lib/auth-secret";
import {
  CLIENT_IP_HEADER,
  resolveClientIp,
  TrustedProxies,
  withClientIp,
} from "../../src/server/lib/client-ip";
import { loadEnv } from "../../src/server/lib/env";
import { createTestContext, PASSWORD, setupPlatform } from "./helpers";

/** Hono's node-server bindings as `app.request` receives them: the TCP peer. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

describe("client IP resolution", () => {
  const trusted = new TrustedProxies("10.0.0.0/8, 192.0.2.10, 2001:db8::/32");
  const headers = (init: Record<string, string>) => new Headers(init);

  it("ignores forwarding headers from an untrusted peer", () => {
    const spoofed = headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    expect(resolveClientIp("203.0.113.5", spoofed, trusted)).toBe("203.0.113.5");
    expect(resolveClientIp("::ffff:203.0.113.5", spoofed, trusted)).toBe("203.0.113.5");
    // Nothing is trusted by default.
    expect(resolveClientIp("10.0.0.1", spoofed, new TrustedProxies(""))).toBe("10.0.0.1");
  });

  it("walks X-Forwarded-For from a trusted peer to the first untrusted hop", () => {
    expect(
      resolveClientIp("10.1.2.3", headers({ "x-forwarded-for": "198.51.100.7" }), trusted),
    ).toBe("198.51.100.7");
    // A client-supplied leftmost entry does not win over the real client.
    expect(
      resolveClientIp(
        "192.0.2.10",
        headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.9.9.9" }),
        trusted,
      ),
    ).toBe("198.51.100.7");
    expect(
      resolveClientIp(
        "2001:db8::1",
        headers({ "x-forwarded-for": "2001:db8::2, 2a00::7" }),
        trusted,
      ),
    ).toBe("2a00::7");
    // Garbage ends the chain at the last address that can be believed.
    expect(
      resolveClientIp("10.0.0.1", headers({ "x-forwarded-for": "junk, 10.0.0.5" }), trusted),
    ).toBe("10.0.0.5");
  });

  it("uses X-Real-IP from a trusted peer when there is no X-Forwarded-For", () => {
    expect(resolveClientIp("10.0.0.1", headers({ "x-real-ip": "198.51.100.8" }), trusted)).toBe(
      "198.51.100.8",
    );
    expect(resolveClientIp("10.0.0.1", headers({}), trusted)).toBe("10.0.0.1");
  });

  it("hands better-auth only the resolved address", () => {
    const out = withClientIp(
      headers({
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        [CLIENT_IP_HEADER]: "1.2.3.4",
      }),
      "203.0.113.5",
    );
    expect(out.get(CLIENT_IP_HEADER)).toBe("203.0.113.5");
    expect(out.has("x-forwarded-for")).toBe(false);
    expect(out.has("x-real-ip")).toBe(false);
  });

  it("rejects malformed EDGEWEIR_TRUSTED_PROXIES entries at startup", () => {
    const base = {
      DATABASE_URL: "postgres://x",
      EDGEWEIR_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      BETTER_AUTH_SECRET: "x".repeat(40),
    };
    expect(loadEnv({ ...base, EDGEWEIR_TRUSTED_PROXIES: "" }).trustedProxies.size).toBe(0);
    expect(
      loadEnv({ ...base, EDGEWEIR_TRUSTED_PROXIES: "172.16.0.0/12,::1" }).trustedProxies.entries,
    ).toEqual(["172.16.0.0/12", "::1"]);
    for (const bad of ["10.0.0.0/33", "proxy.internal", "10.0.0.1/8/1", "::1/129"]) {
      expect(() => loadEnv({ ...base, EDGEWEIR_TRUSTED_PROXIES: bad }), bad).toThrow(
        /EDGEWEIR_TRUSTED_PROXIES/,
      );
    }
  });
});

describe("client IP on audit entries and sessions", async () => {
  const { ctx, client } = await createTestContext({ EDGEWEIR_TRUSTED_PROXIES: "10.0.0.0/8" });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  beforeAll(() => setupPlatform(ctx));
  afterAll(() => client.close());

  const signIn = async (from: string, forwardedFor: string) => {
    const res = await app.request(
      `${origin}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
      },
      peer(from),
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const [session] = await ctx.db
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, token));
    return { cookie, sessionIp: session?.ipAddress };
  };

  const createCluster = async (
    cookie: string,
    from: string,
    forwardedFor: string,
    name: string,
  ) => {
    const res = await app.request(
      `${origin}/rpc/clusters/create`,
      {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/json",
          "x-csrf-token": "orpc",
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({ json: { name } }),
      },
      peer(from),
    );
    expect(res.status).toBe(200);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, "cluster.create"), eq(schema.auditLog.targetName, name)),
      );
    return entry?.ip;
  };

  it("ignores X-Forwarded-For from an untrusted peer", async () => {
    const { cookie, sessionIp } = await signIn("203.0.113.5", "1.2.3.4");
    expect(sessionIp).toBe("203.0.113.5");
    expect(await createCluster(cookie, "203.0.113.5", "1.2.3.4", "edge-untrusted")).toBe(
      "203.0.113.5",
    );
  });

  it("uses the socket address of a real HTTP connection", async () => {
    // Through @hono/node-server, as in production: a streamed POST body is
    // forwarded to better-auth, and the peer comes from the socket.
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": "6.6.6.6" },
        body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      const [session] = await ctx.db
        .select()
        .from(schema.session)
        .where(eq(schema.session.token, token));
      expect(session?.ipAddress).toBe("127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("honors X-Forwarded-For from a trusted proxy", async () => {
    const { cookie, sessionIp } = await signIn("10.0.0.2", "198.51.100.7");
    expect(sessionIp).toBe("198.51.100.7");
    expect(await createCluster(cookie, "10.0.0.2", "198.51.100.7", "edge-trusted")).toBe(
      "198.51.100.7",
    );
  });
});

describe("better-auth rate limiting", async () => {
  const { ctx, client } = await createTestContext(
    { EDGEWEIR_TRUSTED_PROXIES: "10.0.0.0/8" },
    { rateLimit: true },
  );
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  beforeAll(() => setupPlatform(ctx));
  afterAll(() => client.close());

  const attempt = (app: ReturnType<typeof createApp>, from: string, forwardedFor?: string) =>
    app.request(
      `${origin}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        },
        body: JSON.stringify({ email: "admin@example.com", password: "not the password" }),
      },
      peer(from),
    );
  const counter = async (key: string) =>
    (await ctx.db.select().from(schema.rateLimit).where(eq(schema.rateLimit.key, key)))[0];

  it("keeps the counters in the database, shared across instances and restarts", async () => {
    const app = createApp(ctx);
    // better-auth allows three sign-in attempts per 10 s and address.
    for (let i = 0; i < 3; i++) expect((await attempt(app, "203.0.113.20")).status).toBe(401);
    expect((await attempt(app, "203.0.113.20")).status).toBe(429);
    expect(await counter("203.0.113.20|/sign-in/email")).toMatchObject({ count: 3 });

    // A second instance (or the same console after a restart) sees the same count.
    const restarted = createApp({
      ...ctx,
      auth: createAuth({
        db: ctx.db,
        secret: resolveAuthSecret(ctx.env).value,
        publicUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        rateLimit: true,
      }),
    });
    expect((await attempt(restarted, "203.0.113.20")).status).toBe(429);
    // A forged X-Forwarded-For from an untrusted peer does not open a new bucket.
    expect((await attempt(restarted, "203.0.113.20", "192.0.2.99")).status).toBe(429);
    expect(await counter("192.0.2.99|/sign-in/email")).toBeUndefined();
    // Another client is not affected.
    expect((await attempt(restarted, "203.0.113.21")).status).toBe(401);
  });

  it("keys requests through a trusted proxy by the forwarded client", async () => {
    const app = createApp(ctx);
    expect((await attempt(app, "10.0.0.2", "198.51.100.30")).status).toBe(401);
    expect(await counter("198.51.100.30|/sign-in/email")).toMatchObject({ count: 1 });
    expect(await counter("10.0.0.2|/sign-in/email")).toBeUndefined();
  });
});
