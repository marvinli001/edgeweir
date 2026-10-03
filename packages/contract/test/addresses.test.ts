import { describe, expect, it } from "vitest";
import {
  cidr,
  consoleUrlWarnings,
  forbiddenOriginRange,
  formatIp,
  nodeChannelInput,
  nodeChannelOrigin,
  normalizeCidr,
  originAddress,
  originAllowListInput,
  parseIp,
  SPECIAL_PURPOSE_IPV4,
  SPECIAL_PURPOSE_IPV6,
  unicastAddress,
  urlHostScope,
} from "../src/index";

describe("IP literals", () => {
  it("parses dotted-quad IPv4 and IPv6 text forms", () => {
    expect(parseIp("10.0.0.1")).toEqual({ version: 4, bytes: new Uint8Array([10, 0, 0, 1]) });
    for (const text of [
      "::",
      "::1",
      "1::",
      "fe80::1",
      "2001:db8:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(parseIp(text)?.version, text).toBe(6);
    }
    expect(formatIp(parseIp("::ffff:127.0.0.1") ?? { version: 4, bytes: new Uint8Array() })).toBe(
      "::ffff:7f00:1",
    );
  });

  it("refuses ambiguous and decorated forms", () => {
    for (const text of [
      "127.1",
      "010.0.0.1",
      "1.2.3.256",
      "1.2.3.4.5",
      "0x7f.0.0.1",
      "[::1]",
      "fe80::1%eth0",
      "1::2::3",
      ":1",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
      "::1.2.3",
      "",
    ]) {
      expect(parseIp(text), text).toBeNull();
    }
  });
});

describe("CIDRs", () => {
  it("normalizes to the network address in canonical text", () => {
    expect(normalizeCidr("10.1.2.3/8")).toBe("10.0.0.0/8");
    expect(normalizeCidr(" 172.20.0.0/14 ")).toBe("172.20.0.0/14");
    expect(normalizeCidr("10.0.0.5")).toBe("10.0.0.5/32");
    expect(normalizeCidr("FC00::/7")).toBe("fc00::/7");
    expect(normalizeCidr("2001:DB8:0:0::1")).toBe("2001:db8::1/128");
    expect(normalizeCidr("1:0:0:1:0:0:0:1/128")).toBe("1:0:0:1::1/128");
    expect(normalizeCidr("1:0:1:1:1:1:1:1/128")).toBe("1:0:1:1:1:1:1:1/128");
    expect(normalizeCidr("::/0")).toBe("::/0");
    expect(normalizeCidr("0.0.0.0/0")).toBe("0.0.0.0/0");
    for (const bad of ["10.0.0.0/33", "::/129", "10.0.0.0/", "10.0.0.0/08", "10/8", "x", ""]) {
      expect(normalizeCidr(bad), bad).toBeNull();
    }
  });

  it("validates allow-list input", () => {
    expect(cidr.parse("192.168.1.10/16")).toBe("192.168.0.0/16");
    expect(cidr.safeParse("192.168.1.300/16").success).toBe(false);
    expect(originAllowListInput.parse({ cidrs: ["10.0.0.0/8", "FC00::/7"] })).toEqual({
      cidrs: ["10.0.0.0/8", "fc00::/7"],
    });
    expect(originAllowListInput.safeParse({ cidrs: Array(257).fill("10.0.0.0/8") }).success).toBe(
      false,
    );
  });
});

describe("special-purpose origin addresses", () => {
  it("refuses loopback, link-local, private and the other listed ranges", () => {
    expect(forbiddenOriginRange("127.0.0.1", [])).toBe("127.0.0.0/8");
    expect(forbiddenOriginRange("169.254.169.254", [])).toBe("169.254.0.0/16");
    expect(forbiddenOriginRange("10.1.2.3", [])).toBe("10.0.0.0/8");
    expect(forbiddenOriginRange("::1", [])).toBe("::1/128");
    expect(forbiddenOriginRange("::", [])).toBe("::/128");
    expect(forbiddenOriginRange("fd12:3456::1", [])).toBe("fc00::/7");
    // The network address of every listed range.
    for (const range of [...SPECIAL_PURPOSE_IPV4, ...SPECIAL_PURPOSE_IPV6]) {
      const network = range.slice(0, range.indexOf("/"));
      expect(forbiddenOriginRange(network, []), range).toBe(range);
    }
    for (const [address, range] of [
      ["100.127.255.255", "100.64.0.0/10"],
      ["172.31.255.255", "172.16.0.0/12"],
      ["198.19.255.255", "198.18.0.0/15"],
      ["239.255.255.255", "224.0.0.0/4"],
      ["255.255.255.255", "240.0.0.0/4"],
      ["100::ffff:ffff:ffff:ffff", "100::/64"],
      ["febf:ffff::1", "fe80::/10"],
      ["ff02::1", "ff00::/8"],
    ] as const) {
      expect(forbiddenOriginRange(address, []), address).toBe(range);
    }
  });

  it("judges IPv4-mapped and NAT64 addresses by the IPv4 address they embed", () => {
    expect(forbiddenOriginRange("::ffff:127.0.0.1", [])).toBe("127.0.0.0/8");
    expect(forbiddenOriginRange("::ffff:a9fe:a9fe", [])).toBe("169.254.0.0/16");
    expect(forbiddenOriginRange("64:ff9b::10.0.0.1", [])).toBe("10.0.0.0/8");
    expect(forbiddenOriginRange("::ffff:8.8.8.8", [])).toBeNull();
    expect(forbiddenOriginRange("64:ff9b::8.8.8.8", [])).toBeNull();
    expect(forbiddenOriginRange("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBeNull();
  });

  it("accepts public addresses, the edges of the ranges and host names", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "100.63.255.255",
      "100.128.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.255",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
      "2606:4700:4700::1111",
      "2001:db9::1",
      "fec0::1",
      "::2",
      "origin.example.com",
      "whoami",
    ]) {
      expect(forbiddenOriginRange(address, []), address).toBeNull();
    }
  });

  it("refuses localhost names whatever the allow list says", () => {
    for (const name of ["localhost", "LOCALHOST", "api.localhost", "a.b.localhost"]) {
      expect(forbiddenOriginRange(name, ["127.0.0.0/8", "::1/128"]), name).toBe("localhost");
    }
    expect(forbiddenOriginRange("localhost.example.com", [])).toBeNull();
  });

  it("allows addresses inside the platform allow list only", () => {
    expect(forbiddenOriginRange("10.1.2.3", ["10.0.0.0/8"])).toBeNull();
    expect(forbiddenOriginRange("10.1.2.3", ["10.1.0.0/16"])).toBeNull();
    expect(forbiddenOriginRange("10.1.2.3", ["10.2.0.0/16"])).toBe("10.0.0.0/8");
    expect(forbiddenOriginRange("172.18.0.5", ["172.18.0.0/16"])).toBeNull();
    expect(forbiddenOriginRange("fd00::5", ["fd00::/8"])).toBeNull();
    expect(forbiddenOriginRange("::1", ["127.0.0.0/8"])).toBe("::1/128");
    // Unparsable entries never widen the list.
    expect(forbiddenOriginRange("10.1.2.3", ["garbage", "10.0.0.0/99"])).toBe("10.0.0.0/8");
  });
});

describe("unicastAddress", () => {
  it("keeps single unicast addresses in canonical form, private ones included", () => {
    expect(unicastAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(unicastAddress(" 10.0.0.5 ")).toBe("10.0.0.5");
    expect(unicastAddress("2001:DB8:0:0::10")).toBe("2001:db8::10");
    expect(unicastAddress("fd00::5")).toBe("fd00::5");
  });

  it("refuses ranges, names and addresses that are not one host", () => {
    for (const text of [
      "0.0.0.0/0",
      "::/0",
      "203.0.113.0/24",
      "203.0.113.7/32",
      "edge.example.com",
      "",
      "0.0.0.0",
      "::",
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "169.254.1.1",
      "fe80::1",
      "224.0.0.1",
      "ff02::1",
      "255.255.255.255",
    ])
      expect(unicastAddress(text), text).toBeNull();
  });
});

describe("console URLs nodes use", () => {
  it("tells loopback and private hosts from the ones other networks reach", () => {
    for (const url of [
      "http://localhost:3000",
      "https://console.localhost:8443",
      "http://127.0.0.1:3000",
      "https://[::1]:8443",
      "http://0.0.0.0:3000",
      "https://[::ffff:127.0.0.1]:8443",
    ])
      expect(urlHostScope(url), url).toBe("local");
    for (const url of [
      "https://10.0.0.5:8443",
      "https://192.168.1.2:8443",
      "https://172.16.0.1:8443",
      "https://100.64.0.1:8443",
      "https://[fd00::1]:8443",
      "https://[fe80::1]:8443",
    ])
      expect(urlHostScope(url), url).toBe("private");
    for (const url of [
      "https://cdn-admin.example.com",
      "https://console:8443",
      "https://203.0.114.1:8443",
      "https://[2606:4700::1]:8443",
      "not a url",
    ])
      expect(urlHostScope(url), url).toBeNull();
  });

  it("warns per URL, never for public ones", () => {
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://localhost:3000",
        nodeApiUrl: "https://localhost:8443",
      }),
    ).toEqual(["console_url_local", "node_api_url_local"]);
    expect(
      consoleUrlWarnings({
        consoleUrl: "https://cdn-admin.example.com",
        nodeApiUrl: "https://10.1.2.3:8443",
      }),
    ).toEqual(["node_api_url_private"]);
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://192.168.0.10:3000",
        nodeApiUrl: "https://cdn-admin.example.com:8443",
      }),
    ).toEqual(["console_url_private"]);
    // The e2e stack: a console on localhost, nodes reaching the channel by its service name.
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://localhost:3000",
        nodeApiUrl: "https://console:8443",
      }),
    ).toEqual(["console_url_local"]);
    expect(
      consoleUrlWarnings({
        consoleUrl: "https://cdn-admin.example.com",
        nodeApiUrl: "https://cdn-admin.example.com:8443",
      }),
    ).toEqual([]);
  });

  it("warns when a public console URL is plain HTTP", () => {
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://cdn-admin.example.com",
        nodeApiUrl: "https://cdn-admin.example.com:8443",
      }),
    ).toEqual(["console_url_http"]);
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://203.0.114.1:3000",
        nodeApiUrl: "https://203.0.114.1:8443",
      }),
    ).toEqual(["console_url_http"]);
    // Local and private URLs keep their own warning only.
    expect(
      consoleUrlWarnings({
        consoleUrl: "http://10.0.0.5:3000",
        nodeApiUrl: "https://cdn-admin.example.com:8443",
      }),
    ).toEqual(["console_url_private"]);
    expect(
      consoleUrlWarnings({ consoleUrl: "not a url", nodeApiUrl: "https://edge.example.com:8443" }),
    ).toEqual([]);
  });
});

describe("originAddress", () => {
  it("accepts host names and IP literals, including IPv4-mapped IPv6", () => {
    for (const value of ["whoami", "origin.example.com", "10.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(originAddress.safeParse(value).success, value).toBe(true);
    }
  });

  it("refuses names that resolvers read as numbers", () => {
    for (const value of ["127.1", "2130706433", "0x7f000001", "0x7f.1", "1.2.3.04", "host.123"]) {
      expect(originAddress.safeParse(value).success, value).toBe(false);
    }
    expect(originAddress.safeParse("host-123.example").success).toBe(true);
    expect(originAddress.safeParse("123host.example").success).toBe(true);
  });
});

describe("node channel URLs", () => {
  it("takes https://host[:port] and normalizes it to its origin", () => {
    expect(nodeChannelOrigin("https://Nodes.Example.com:8443/")).toBe(
      "https://nodes.example.com:8443",
    );
    expect(nodeChannelOrigin("https://203.0.113.5:8443")).toBe("https://203.0.113.5:8443");
    expect(nodeChannelOrigin("https://[2001:DB8::1]:8443")).toBe("https://[2001:db8::1]:8443");
    // The default port is the URL's own: nodes connect to 443.
    expect(nodeChannelOrigin("https://nodes.example.com:443")).toBe("https://nodes.example.com");
  });

  it("refuses other schemes, paths, queries, fragments and credentials", () => {
    for (const url of [
      "http://nodes.example.com:8443",
      "https://nodes.example.com:8443/rpc",
      "https://nodes.example.com:8443/?a=1",
      "https://nodes.example.com:8443/#a",
      "https://user@nodes.example.com:8443",
      "nodes.example.com:8443",
      "",
    ])
      expect(nodeChannelOrigin(url), url).toBeUndefined();
  });

  it("lets an empty input clear the saved URL", () => {
    expect(nodeChannelInput.safeParse({ url: "" }).success).toBe(true);
    expect(nodeChannelInput.safeParse({ url: "https://nodes.example.com:8443" }).success).toBe(
      true,
    );
    expect(nodeChannelInput.safeParse({ url: "http://nodes.example.com" }).success).toBe(false);
  });
});
