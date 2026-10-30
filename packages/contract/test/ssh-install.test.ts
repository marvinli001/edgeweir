import { describe, expect, it } from "vitest";
import {
  carriesSshCredentials,
  isSshHost,
  normalizeFingerprint,
  parseSshHostList,
  SSH_INSTALL_LIMITS,
  sshCredential,
  startSshInstallInput,
} from "../src/ssh-install";

const FP = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";

describe("parseSshHostList", () => {
  it("reads host[:port] [user] [name], bracketed and bare IPv6, comments and blank lines", () => {
    const { hosts, errors } = parseSshHostList(
      [
        "# edge nodes",
        "edge1.example.com",
        "  203.0.113.7:2222 ubuntu edge-sh-01 ",
        "",
        "[2001:db8::1]:22 root",
        "2001:db8::2",
        "Edge3.Example.com:22",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(hosts).toEqual([
      { host: "edge1.example.com", port: 22 },
      { host: "203.0.113.7", port: 2222, username: "ubuntu", nodeName: "edge-sh-01" },
      { host: "2001:db8::1", port: 22, username: "root" },
      { host: "2001:db8::2", port: 22 },
      { host: "edge3.example.com", port: 22 },
    ]);
  });

  it("reads CSV with or without a header, empty fields take the defaults", () => {
    const { hosts, errors } = parseSshHostList(
      'host,port,user,name\r\n10.0.0.1,,,\r\n"10.0.0.2",2200,admin,edge-2\r\n[2001:db8::3],22,,\n',
    );
    expect(errors).toEqual([]);
    expect(hosts).toEqual([
      { host: "10.0.0.1", port: 22 },
      { host: "10.0.0.2", port: 2200, username: "admin", nodeName: "edge-2" },
      { host: "2001:db8::3", port: 22 },
    ]);
  });

  it("names the lines it cannot read", () => {
    const { hosts, errors } = parseSshHostList(
      [
        "ok.example.com",
        "bad_host.example.com",
        "host:99999",
        "host:22 bad;user",
        "a b c d",
        "1.2.3",
        "10.0.0.1,22,root,name,extra",
        "-leading.example.com",
      ].join("\n"),
    );
    expect(hosts).toEqual([{ host: "ok.example.com", port: 22 }]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("host and fingerprint validation", () => {
  it("accepts host names, IPv4 and IPv6, nothing that could become a shell word", () => {
    for (const ok of ["a", "edge-1.example.com", "192.0.2.1", "::1", "2001:db8::1"]) {
      expect(isSshHost(ok), ok).toBe(true);
    }
    for (const bad of ["", "a b", "a;b", "$(id)", "256.1.1.1", "1.2.3", "-x", "x_y.com", "[::1]"]) {
      expect(isSshHost(bad), bad).toBe(false);
    }
  });

  it("normalizes OpenSSH SHA256 fingerprints and refuses anything else", () => {
    expect(normalizeFingerprint(FP)).toBe(FP);
    expect(normalizeFingerprint(` ${FP.slice(7)}= `)).toBe(FP);
    expect(normalizeFingerprint(`sha256:${FP.slice(7)}`)).toBe(FP);
    expect(normalizeFingerprint("MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48")).toBeNull();
    expect(normalizeFingerprint("SHA256:short")).toBeNull();
  });
});

describe("sshCredential", () => {
  it("needs a password or a private key, root by default", () => {
    expect(sshCredential.safeParse({}).success).toBe(false);
    expect(sshCredential.parse({ password: "pw" }).username).toBe("root");
    expect(sshCredential.safeParse({ privateKey: "k", username: "ubuntu" }).success).toBe(true);
  });

  it("refuses line breaks in passwords (sudo -S reads one line)", () => {
    expect(sshCredential.safeParse({ password: "a\nb" }).success).toBe(false);
    expect(sshCredential.safeParse({ password: "x", sudoPassword: "a\rb" }).success).toBe(false);
  });

  it("refuses a validation error that quotes the secret", () => {
    const result = sshCredential.safeParse({ password: "hunter2\nsecret" });
    expect(JSON.stringify(result.error?.issues)).not.toContain("hunter2");
  });
});

describe("startSshInstallInput", () => {
  const base = {
    clusterId: "00000000-0000-4000-8000-000000000001",
    credential: { password: "pw" },
    hosts: [{ host: "edge1.example.com", hostKeyFingerprint: FP }],
  };

  it("fills the defaults and the limits", () => {
    const input = startSshInstallInput.parse(base);
    expect(input).toMatchObject({
      concurrency: SSH_INSTALL_LIMITS.defaultConcurrency,
      timeoutMinutes: SSH_INSTALL_LIMITS.defaultTimeoutMinutes,
      options: { version: "", format: "auto", mirror: "", modsecurity: true, noStart: false },
      hosts: [{ host: "edge1.example.com", port: 22, nodeName: "", hostKeyFingerprint: FP }],
    });
    expect(startSshInstallInput.safeParse({ ...base, concurrency: 21 }).success).toBe(false);
    expect(startSshInstallInput.safeParse({ ...base, timeoutMinutes: 61 }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      host: `h${i}.example.com`,
      hostKeyFingerprint: FP,
    }));
    expect(startSshInstallInput.safeParse({ ...base, hosts: many }).success).toBe(false);
  });

  it("requires a host key fingerprint per host and valid install options", () => {
    expect(
      startSshInstallInput.safeParse({ ...base, hosts: [{ host: "edge1.example.com" }] }).success,
    ).toBe(false);
    for (const options of [
      { version: "v1.2.3" },
      { mirror: "ftp://x" },
      { mirror: "https://a b" },
    ]) {
      expect(
        startSshInstallInput.safeParse({ ...base, options }).success,
        JSON.stringify(options),
      ).toBe(false);
    }
  });
});

describe("carriesSshCredentials", () => {
  it("matches start and retry on /api/v1 only", () => {
    expect(carriesSshCredentials("POST", "/api/v1/ssh-installs")).toBe(true);
    expect(carriesSshCredentials("POST", "/api/v1/ssh-installs/abc/retry")).toBe(true);
    expect(carriesSshCredentials("POST", "/api/v1/ssh-installs/host-keys")).toBe(false);
    expect(carriesSshCredentials("POST", "/api/v1/ssh-installs/abc/cancel")).toBe(false);
    expect(carriesSshCredentials("GET", "/api/v1/ssh-installs/abc")).toBe(false);
  });
});
