import { describe, expect, it } from "vitest";
import { displayDomainList, domainsDetail } from "../../src/web/lib/domain-list";

describe("domain lists", () => {
  it("shows stored names in Unicode, patterns and look-alikes as they are", () => {
    expect(displayDomainList("xn--bcher-kva.example, .xn--fiqs8s.example, ~xn--a{1,2}")).toBe(
      "bücher.example, .中国.example, ~xn--a{1,2}",
    );
    expect(displayDomainList("xn--pple-43d.com")).toBe("xn--pple-43d.com");
    expect(displayDomainList("")).toBe("");
  });

  it("puts the Punycode forms on the hover's second line when they differ", () => {
    expect(domainsDetail(["xn--bcher-kva.example", "*.a.test"])).toEqual({
      detail: "bücher.example, *.a.test",
      title: "bücher.example, *.a.test\nxn--bcher-kva.example, *.a.test",
    });
    expect(domainsDetail(["a.test", "*.a.test"])).toEqual({
      detail: "a.test, *.a.test",
      title: "a.test, *.a.test",
    });
    expect(domainsDetail([])).toEqual({ detail: "", title: "" });
  });
});
