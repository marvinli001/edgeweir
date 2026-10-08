import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { unicodeDomainHolds, unicodeSearchTerm } from "../../src/server/lib/site-domains";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("site search terms", () => {
  it("maps a term like a host name, or keeps it when the mapping refuses it", () => {
    expect(unicodeSearchTerm("ui.g10")).toBe("ui.g10");
    expect(unicodeSearchTerm("ÜCHER.G10")).toBe("ücher.g10");
    // Full width, the ideographic full stop and decoded Punycode.
    expect(unicodeSearchTerm("ｂüｃｈ")).toBe("büch");
    expect(unicodeSearchTerm("国。g10")).toBe("国.g10");
    expect(unicodeSearchTerm("XN--BCHER-KVA")).toBe("bücher");
    // A combining mark first: UTS #46 refuses it as a label.
    expect(unicodeSearchTerm("िन्दी")).toBe("िन्दी");
    expect(unicodeSearchTerm("ัย。th")).toBe("ัย.th");
    // Final sigma and sigma are one letter.
    expect(unicodeSearchTerm("ΟΔΟΣ")).toBe("οδοσ");
    expect(unicodeSearchTerm("οδος")).toBe("οδοσ");
  });

  it("looks in the formatted Unicode form of a stored domain", () => {
    const exact = { kind: "exact" as const, name: "xn--bcher-ui-65a.g10.test" };
    expect(unicodeDomainHolds(exact, "ui.g10")).toBe(true);
    expect(unicodeDomainHolds(exact, "cher-ui.g10")).toBe(true);
    expect(unicodeDomainHolds(exact, "bücher-ui")).toBe(true);
    expect(unicodeDomainHolds(exact, "*.bü")).toBe(false);
    expect(unicodeDomainHolds(exact, "")).toBe(false);
    const wildcard = { kind: "wildcard" as const, name: "xn--bcher-kva.example" };
    expect(unicodeDomainHolds(wildcard, "*.bü")).toBe(true);
    expect(unicodeDomainHolds(wildcard, ".bü")).toBe(true);
    const suffix = { kind: "suffix" as const, name: "xn--fiqs8s.g10.test" };
    expect(unicodeDomainHolds(suffix, ".中")).toBe(true);
    expect(unicodeDomainHolds(suffix, "*.中")).toBe(false);
    // Patterns are not host names: never decoded.
    const regex = { kind: "regex" as const, name: "xn--fiqs8s\\.test" };
    expect(unicodeDomainHolds(regex, "~xn--fiqs")).toBe(true);
    expect(unicodeDomainHolds(regex, "中国")).toBe(false);
    expect(unicodeDomainHolds({ kind: "exact", name: "xn--pxavbm.gr" }, "οδοσ")).toBe(true);
  });
});

describe("site list search with Unicode domains", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const origins = [{ address: "origin.example.com" }];
  let admin: ApiClient;
  const names = async (search: string) =>
    (await admin.sites.list({ search })).items.map((s) => s.name).sort();

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const create = (name: string, domains: string[]) =>
      admin.sites.create({ name, domains, origins });
    await create("books", ["bücher-ui.g10.test", "*.bücher.example"]);
    await create("hindi", ["हिन्दी.test"]);
    await create("china", ["中国.g10.test"]);
    await create("greek", ["οδος.gr"]);
    await create("plain", ["plain.g10.test"]);
  });
  afterAll(() => pglite.close());

  it("finds ASCII terms that run past the end of a Unicode label", async () => {
    expect(await names("ui.g10")).toEqual(["books"]);
    expect(await names("cher-ui.g10")).toEqual(["books"]);
    expect(await names("r-ui.g10.te")).toEqual(["books"]);
    // Plain ASCII terms still match stored names.
    expect(await names("g10.test")).toEqual(["books", "china", "plain"]);
    expect(await names("xn--bcher")).toEqual(["books"]);
  });

  it("finds parts of Unicode labels the host mapping refuses or maps", async () => {
    expect(await names("िन्दी")).toEqual(["hindi"]);
    expect(await names("ｂüｃｈ")).toEqual(["books"]);
    expect(await names("国。g10")).toEqual(["china"]);
    expect(await names("ΟΔΟΣ")).toEqual(["greek"]);
  });

  it("matches the `*.` form of a Unicode domain", async () => {
    expect(await names("*.bü")).toEqual(["books"]);
    expect(await names("*.bücher.ex")).toEqual(["books"]);
    expect(await names("*.ui")).toEqual([]);
  });
});
