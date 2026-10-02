import { describe, expect, it } from "vitest";
import { domainInput, domainList, originInput } from "../../src/web/lib/address-input";

describe("address input", () => {
  it("reads the host of a pasted domain", () => {
    expect(domainInput(" https://Shop.test/path?x#y ")).toBe("shop.test");
    expect(domainInput("http://shop.test:8080")).toBe("shop.test");
    expect(domainInput("shop.test.")).toBe("shop.test");
    expect(domainInput("*.shop.test")).toBe("*.shop.test");
    expect(domainList("https://a.test/, b.test\nA.test")).toEqual(["a.test", "b.test"]);
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
