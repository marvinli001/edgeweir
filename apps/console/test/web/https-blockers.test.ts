import { describe, expect, it } from "vitest";
import { httpsBlockerText } from "../../src/web/lib/https-blockers";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

describe("one-click HTTPS blockers", () => {
  it("words every blocker in one line", () => {
    overwriteGetLocale(() => "en");
    const ca = "Let's Encrypt";
    expect(httpsBlockerText({ code: "nodes_offline", cluster: "default" }, ca)).toBe(
      "Cluster default has no online node",
    );
    expect(
      httpsBlockerText(
        { code: "nodes_lack_http01", nodes: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] },
        ca,
      ),
    ).toBe("These nodes need an upgrade to answer HTTP-01: e1, e2, e3, e4, e5 +2");
    expect(
      httpsBlockerText({ code: "dns_not_pointing", name: "a.test", pointing: "unresolved" }, ca),
    ).toBe("a.test has no DNS record yet");
    expect(
      httpsBlockerText({ code: "dns_not_pointing", name: "a.test", pointing: "elsewhere" }, ca),
    ).toBe("a.test does not point to the nodes");
    expect(
      httpsBlockerText({ code: "dns_credential_missing", names: ["*.a.test", "a.test"] }, ca),
    ).toBe("Wildcards need a DNS credential whose zone covers *.a.test, a.test");
    expect(
      httpsBlockerText(
        { code: "dns_credential_failed", credential: "CF", error: "DNS_PROVIDER_AUTH_FAILED" },
        ca,
      ),
    ).toMatch(/^DNS credential CF: /);
    expect(httpsBlockerText({ code: "caa_forbidden", name: "a.test" }, ca)).toBe(
      "CAA records of a.test do not allow Let's Encrypt",
    );
  });

  it("lists names the Chinese way in Chinese", () => {
    overwriteGetLocale(() => "zh-CN");
    expect(httpsBlockerText({ code: "nodes_lack_http01", nodes: ["e1", "e2"] }, "ZeroSSL")).toBe(
      "以下节点需要升级才能应答 HTTP-01：e1、e2",
    );
    overwriteGetLocale(() => "en");
    expect(httpsBlockerText({ code: "no_certificate_names" }, ca)).toBe(
      "The site has only pattern domains: no name to issue for",
    );
  });
});
