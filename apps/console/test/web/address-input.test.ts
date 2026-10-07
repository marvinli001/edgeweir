import { describe, expect, it } from "vitest";
import {
  domainInput,
  domainList,
  fillOrigin,
  originInput,
  replacesField,
} from "../../src/web/lib/address-input";
import { coversDomain, curlCheck } from "../../src/web/lib/launch";

describe("address input", () => {
  it("reads the host of a pasted domain", () => {
    expect(domainInput(" https://Shop.test/path?x#y ")).toBe("shop.test");
    expect(domainInput("http://shop.test:8080")).toBe("shop.test");
    expect(domainInput("shop.test.")).toBe("shop.test");
    expect(domainInput("*.shop.test")).toBe("*.shop.test");
    expect(domainList("https://a.test/, b.test\nA.test")).toEqual(["a.test", "b.test"]);
  });

  it("keeps suffixes, patterns and Unicode hosts", () => {
    expect(domainInput(".Shop.test")).toBe(".shop.test");
    expect(domainInput(" ~(Www|m)\\.shop\\.test/x?y ")).toBe("~(Www|m)\\.shop\\.test/x?y");
    expect(domainInput("Bücher.test")).toBe("bücher.test");
    expect(domainList("~a{1,3}\\.test, .b.test,c.test ~x")).toEqual([
      "~a{1,3}\\.test",
      ".b.test",
      "c.test",
      "~x",
    ]);
  });

  it("splits an origin into address, port and scheme", () => {
    expect(originInput("https://origin.test:8443/app")).toEqual({
      address: "origin.test",
      port: 8443,
      scheme: "https",
    });
    expect(originInput("origin.test:8080")).toEqual({ address: "origin.test", port: 8080 });
    expect(originInput("http://origin.test")).toEqual({ address: "origin.test", scheme: "http" });
    expect(originInput("[2001:db8::1]:8080")).toEqual({ address: "2001:db8::1", port: 8080 });
    expect(originInput("2001:db8::1")).toEqual({ address: "2001:db8::1" });
    expect(originInput("10.0.0.1")).toEqual({ address: "10.0.0.1" });
    expect(originInput("ftp://origin.test")).toEqual({ address: "origin.test" });
  });
});

describe("origin fields", () => {
  const port = (scheme: "http" | "https") => (scheme === "https" ? "443" : "80");
  const http = { scheme: "http" as const, port: "80" };

  it("moves a URL's scheme and port into their fields", () => {
    expect(fillOrigin("https://origin.test:8443/app", http, port)).toEqual({
      address: "origin.test",
      scheme: "https",
      port: "8443",
    });
    // A scheme without a port sets that scheme's default port.
    expect(fillOrigin("https://origin.test/", http, port)).toEqual({
      address: "origin.test",
      scheme: "https",
      port: "443",
    });
    expect(fillOrigin("https://origin.test", http, () => "")).toMatchObject({ port: "" });
    expect(fillOrigin("origin.test:8080", { scheme: "https", port: "443" }, port)).toEqual({
      address: "origin.test",
      scheme: "https",
      port: "8080",
    });
  });

  it("keeps the scheme and port for a plain host", () => {
    expect(fillOrigin(" origin.test ", { scheme: "https", port: "8443" }, port)).toEqual({
      address: "origin.test",
      scheme: "https",
      port: "8443",
    });
    expect(fillOrigin("2001:db8::1", http, port)).toEqual({ ...http, address: "2001:db8::1" });
  });

  it("reads a paste as a whole origin only when it replaces the field", () => {
    expect(replacesField({ value: "", selectionStart: 0, selectionEnd: 0 })).toBe(true);
    expect(replacesField({ value: "abc", selectionStart: 0, selectionEnd: 3 })).toBe(true);
    expect(replacesField({ value: "abc", selectionStart: 3, selectionEnd: 3 })).toBe(false);
  });
});

describe("launch check", () => {
  it("builds a request that bypasses DNS, IPv6 in brackets", () => {
    expect(curlCheck("shop.test", "45.76.1.10", false)).toBe(
      "curl -sI --resolve shop.test:80:45.76.1.10 http://shop.test/",
    );
    expect(curlCheck("shop.test", "2001:db8::1", true)).toBe(
      "curl -sI --resolve shop.test:443:[2001:db8::1] https://shop.test/",
    );
  });

  it("checks HTTPS only for domains the certificate covers", () => {
    const certificate = {
      state: "uncovered" as const,
      id: null,
      name: "",
      uncovered: ["www.shop.test"],
      error: "",
    };
    expect(coversDomain(certificate, "shop.test")).toBe(true);
    expect(coversDomain(certificate, "www.shop.test")).toBe(false);
    expect(coversDomain({ ...certificate, state: "none", uncovered: [] }, "shop.test")).toBe(false);
  });
});
