import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("hidden cards", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
  });
  afterAll(() => pglite.close());

  it("shows every card until the user hides one", async () => {
    expect(await admin.hiddenCards.get()).toEqual({ overview: [], site: [] });
  });

  it("replaces one page's cards and keeps the other's, in display order without repeats", async () => {
    expect(
      await admin.hiddenCards.update({ overview: ["top-ips", "live-nodes", "top-ips"] }),
    ).toEqual({ overview: ["live-nodes", "top-ips"], site: [] });
    expect(await admin.hiddenCards.update({ site: ["protocols", "requests"] })).toEqual({
      overview: ["live-nodes", "top-ips"],
      site: ["requests", "protocols"],
    });
    expect(await admin.hiddenCards.update({ overview: [] })).toEqual({
      overview: [],
      site: ["requests", "protocols"],
    });
    expect(await admin.hiddenCards.get()).toEqual({
      overview: [],
      site: ["requests", "protocols"],
    });
  });

  it("refuses cards a page does not have and an empty change", async () => {
    // The edge network and the top sites are the console home's; a site has neither.
    for (const site of [["edge-network"], ["top-sites"], ["nope"]])
      expect((await rpcError(admin.hiddenCards.update({ site } as never))).code).toBe(
        "BAD_REQUEST",
      );
    expect((await rpcError(admin.hiddenCards.update({ overview: ["asns"] } as never))).code).toBe(
      "BAD_REQUEST",
    );
    expect((await rpcError(admin.hiddenCards.update({}))).code).toBe("BAD_REQUEST");
  });

  it("ignores stored ids that are no longer cards", async () => {
    const [user] = await ctx.db.select({ id: schema.user.id }).from(schema.user);
    await ctx.db
      .update(schema.hiddenCards)
      .set({ overview: ["retired-card", "sites"], site: ["countries", "gone"] })
      .where(eq(schema.hiddenCards.userId, user?.id ?? ""));
    expect(await admin.hiddenCards.get()).toEqual({ overview: ["sites"], site: ["countries"] });
  });

  it("needs a session", async () => {
    expect((await rpcError(rpcClient(app, origin).hiddenCards.get())).code).toBe("UNAUTHORIZED");
  });
});
