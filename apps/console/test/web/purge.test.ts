import { describe, expect, it } from "vitest";
import { expandPurgeTargets, purgeLines, requestUrl } from "../../src/web/lib/purge";

describe("purge targets", () => {
  const domains = ["www.shop.test", "*.cdn.shop.test", "shop.test"];

  it("expands paths to the site's domains that are not wildcards", () => {
    expect(expandPurgeTargets(["/app.js?v=2", "/"], domains)).toEqual({
      urls: [
        "https://www.shop.test/app.js?v=2",
        "https://shop.test/app.js?v=2",
        "https://www.shop.test/",
        "https://shop.test/",
      ],
      invalid: [],
    });
  });

  it("keeps URLs, drops duplicates and reports the rest", () => {
    expect(
      expandPurgeTargets(
        [
          "https://img.shop.test/a.png",
          "/a.png",
          "HTTP://shop.test/a.png",
          "https://img.shop.test/a.png",
          "https://shop.test/a.png",
          "a.png",
          "//shop.test/a.png",
          "ftp://shop.test/a.png",
          "https://",
        ],
        domains,
      ),
    ).toEqual({
      urls: [
        "https://img.shop.test/a.png",
        "https://www.shop.test/a.png",
        "https://shop.test/a.png",
        "HTTP://shop.test/a.png",
      ],
      invalid: ["a.png", "//shop.test/a.png", "ftp://shop.test/a.png", "https://"],
    });
  });

  it("expands a path to nothing on a site with wildcard domains only", () => {
    expect(expandPurgeTargets(["/a"], ["*.shop.test"])).toEqual({ urls: [], invalid: [] });
  });

  it("reads one entry per line and builds the URL of a logged request", () => {
    expect(purgeLines(" /a \r\n\n  https://shop.test/b\n ")).toEqual(["/a", "https://shop.test/b"]);
    expect(requestUrl("shop.test", "/a b")).toBe("https://shop.test/a b");
  });
});
