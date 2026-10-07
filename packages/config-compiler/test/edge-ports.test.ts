import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { ListenerProtocol, NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  canonicalize,
  compileNodeConfig,
  compileSitePorts,
  contentHash,
  diffNodeConfig,
  type EdgeModel,
  edgeOf,
  refreshDerived,
} from "../src/index";
import { certificate, site, tls, v0230Models } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0230.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vectorV0230 = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0230.json"), "utf8"),
) as Vector;

describe("listener ports and site ports (edge-ports-v1)", () => {
  it("keeps clusters without extra ports and sites on the defaults as before", () => {
    const plain = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: [{ ...certificate } as never],
        sites: [site("a", { certificateId: "cert", tls: tls() }), site("b")],
      },
      1n,
    );
    expect(
      plain.listeners.map((l) => [l.port, l.protocol, l.http2, l.http3, l.proxyProtocol]),
    ).toEqual([
      [80, ListenerProtocol.HTTP, false, false, false],
      [443, ListenerProtocol.HTTPS, true, false, false],
    ]);
    expect(plain.sites.every((s) => s.ports.length === 0)).toBe(true);
    expect(plain.sites[0]?.tls?.redirectStatus).toBe(0);
    expect(plain.sites[0]?.tls?.redirectPort).toBe(0);
    expect(plain.clientAddress).toBeUndefined();
    expect(plain.requiredFeatures).not.toContain("edge-ports-v1");
    expect(plain.requiredFeatures).not.toContain("client-ip-v1");
  });

  it("lists every extra port, 443 only while a site with a certificate is served there", () => {
    const config = compileNodeConfig(v0230Models(), 1n);
    expect(config.listeners.map((l) => [l.port, l.protocol, l.http2, l.http3])).toEqual([
      [80, ListenerProtocol.HTTP, false, false],
      [443, ListenerProtocol.HTTPS, true, false],
      [8081, ListenerProtocol.HTTP, false, false],
      [9443, ListenerProtocol.HTTPS, true, true],
    ]);
    const input = v0230Models();
    input.sites = input.sites.filter((s) => s.id === "a");
    expect(compileNodeConfig(input, 1n).listeners.map((l) => l.port)).toEqual([80, 8081, 9443]);
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining(["edge-ports-v1", "client-ip-v1", "l4-v2", "l4-v1"]),
    );
  });

  it("compiles a site's ports: listener ports only, HTTPS with a certificate, sorted; empty for the defaults", () => {
    const edge: EdgeModel = { httpPorts: [8081, 8082], httpsPorts: [9443], clientIp: null };
    expect(
      compileSitePorts({ ports: { http: [8082, 80], https: [9443] }, certificateId: "c" }, edge),
    ).toEqual([80, 8082, 9443]);
    expect(compileSitePorts({ ports: { http: [80], https: [9443] } }, edge)).toEqual([80]);
    expect(compileSitePorts({ ports: { http: [80, 8090], https: [] } }, edge)).toEqual([80]);
    expect(compileSitePorts({}, edge)).toEqual([80]);
    expect(compileSitePorts({}, undefined)).toEqual([]);
    expect(compileSitePorts({ certificateId: "c" }, undefined)).toEqual([]);
    expect(
      compileSitePorts({ ports: { http: [], https: [443] }, certificateId: "c" }, undefined),
    ).toEqual([443]);
    expect(
      compileSitePorts({ ports: { http: [80], https: [] }, certificateId: "c" }, undefined),
    ).toEqual([80]);
  });

  it("marks every listener for the PROXY protocol in that mode; direct without dropping is unset", () => {
    const proxy = v0230Models();
    proxy.edge = {
      httpPorts: [],
      httpsPorts: [],
      clientIp: { mode: "proxy_protocol", trustedCidrs: [], header: "", dropForwardedFor: false },
    };
    const config = compileNodeConfig(proxy, 1n);
    expect(config.listeners.every((l) => l.proxyProtocol)).toBe(true);
    expect(config.clientAddress?.mode).toBe("proxy_protocol");
    expect(config.requiredFeatures).toContain("client-ip-v1");
    const direct = v0230Models();
    direct.edge = {
      httpPorts: [],
      httpsPorts: [],
      clientIp: { mode: "direct", trustedCidrs: [], header: "", dropForwardedFor: false },
    };
    expect(compileNodeConfig(direct, 1n).clientAddress).toBeUndefined();
    direct.edge.clientIp = {
      mode: "direct",
      trustedCidrs: ["10.0.0.0/8"],
      header: "x",
      dropForwardedFor: true,
    };
    const drop = compileNodeConfig(direct, 1n).clientAddress;
    expect([drop?.mode, drop?.dropForwardedFor, drop?.trustedCidrs, drop?.header]).toEqual([
      "direct",
      true,
      [],
      "",
    ]);
  });

  it("refreshDerived keeps the configuration's own ports and setting, or takes current ones", () => {
    const config = compileNodeConfig(v0230Models(), 1n);
    expect(edgeOf(config)).toEqual({
      httpPorts: [8081],
      httpsPorts: [9443],
      clientIp: {
        mode: "header",
        trustedCidrs: ["10.0.0.0/8", "192.0.2.0/24"],
        header: "x-forwarded-for",
        dropForwardedFor: false,
      },
    });
    expect(refreshDerived(config).contentHash).toBe(config.contentHash);
    const moved = refreshDerived(config, {
      httpPorts: [8081, 8082],
      httpsPorts: [9443],
      clientIp: null,
    });
    expect(moved.listeners.map((l) => l.port)).toEqual([80, 443, 8081, 8082, 9443]);
    expect(moved.clientAddress).toBeUndefined();
    // Layer-4 certificates are kept like the sites' certificates.
    expect(moved.certificates.map((c) => c.id)).toEqual(["cert"]);
  });

  it("sends the client address setting in full with every diff", () => {
    const base = compileNodeConfig({ ...v0230Models(), edge: undefined }, 1n);
    const target = compileNodeConfig(v0230Models(), 2n);
    const diff = diffNodeConfig(base, target);
    expect(diff.clientAddress?.trustedCidrs).toEqual(["10.0.0.0/8", "192.0.2.0/24"]);
    expect(applyNodeConfigDiff(base, diff).contentHash).toBe(target.contentHash);
  });
});

describe("content hash matches the Go agent (v0.23.0)", () => {
  it("leaves out a redirect port and excluded domains nodes would refuse", () => {
    const input = v0230Models();
    const [a] = input.sites;
    if (!a?.tls) throw new Error("site a missing");
    // Its certificate removed: the HTTPS ports, and so the redirect port, are gone.
    input.sites = [{ ...a, certificateId: undefined, tls: { ...a.tls, forceHttps: false } }];
    let compiled = compileNodeConfig(input, 1n).sites[0];
    expect(compiled?.ports).toEqual([8081]);
    expect(compiled?.tls?.redirectPort).toBe(0);
    // An excluded domain the site no longer has.
    input.sites = [{ ...a, domains: a.domains.filter((d) => d.name !== "b.test") }];
    compiled = compileNodeConfig(input, 1n).sites[0];
    expect(compiled?.tls?.redirectPort).toBe(9443);
    expect(compiled?.tls?.redirectExcludedDomains).toEqual(["*.w.test"]);
  });

  it("encodes the v0.23.0 vector to the same canonical bytes and hash", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vectorV0230.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vectorV0230.canonical_hex,
    );
    expect(contentHash(config)).toBe(vectorV0230.content_hash);
    // The vector feeds unsorted sets into canonicalization.
    const parsed = fromJson(NodeConfigSchema, vectorV0230.config);
    expect(parsed.clientAddress?.trustedCidrs).toEqual([
      "192.0.2.0/24",
      "10.0.0.0/8",
      "10.0.0.0/8",
    ]);
    expect(config.clientAddress?.trustedCidrs).toEqual(["10.0.0.0/8", "192.0.2.0/24"]);
    const a = config.sites.find((s) => s.id === "a");
    expect(a?.ports).toEqual([8081, 9443]);
    expect(a?.tls?.redirectExcludedDomains).toEqual(["*.w.test", "b.test"]);
  });

  it("compiles the v0.23.0 console models into the same hash", () => {
    const config = compileNodeConfig(v0230Models(), 12n);
    expect(config.contentHash).toBe(vectorV0230.content_hash);
    expect(config.requiredFeatures).toEqual([
      "client-ip-v1",
      "edge-ports-v1",
      "http3-v1",
      "l4-v1",
      "l4-v2",
      "rules-v1",
      "tls-v1",
    ]);
    const range = config.l4Apps.find((app) => app.id === "range");
    expect([range?.portEnd, range?.origins[0]?.port, range?.certificateId]).toEqual([20099, 0, ""]);
    const tlsApp = config.l4Apps.find((app) => app.id === "tls");
    expect([tlsApp?.certificateId, tlsApp?.tlsMinimumVersion]).toEqual(["cert", "1.3"]);
  });
});
