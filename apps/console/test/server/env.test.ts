import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ENV_VARIABLES,
  FILE_VARIABLES,
  loadEnv,
  parseOutboundAllowCidrs,
} from "../../src/server/lib/env";

const base = {
  DATABASE_URL: "postgres://example.invalid/test",
  EDGEWEIR_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  BETTER_AUTH_SECRET: "x".repeat(32),
  EDGEWEIR_PUBLIC_URL: "https://console.example.com",
};

describe("documented node channel defaults", () => {
  it.each([undefined, ""])("derives the node URL when optional value is %j", (value) => {
    expect(loadEnv({ ...base, EDGEWEIR_NODE_API_URL: value }).nodeApiUrl).toBe(
      "https://console.example.com:8443",
    );
  });
  it("still rejects a malformed nonempty override", () => {
    expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_URL: "not-a-url" })).toThrow(
      "invalid configuration",
    );
  });
});

describe("console and node channel URLs", () => {
  const node = "https://cdn-admin.example.com:8443";

  it.each([
    "localhost:3000",
    "cdn-admin.example.com:8080",
    "https://cdn-admin.example.com/console",
    "https://cdn-admin.example.com/?next=1",
    "https://cdn-admin.example.com/#top",
    "https://admin:secret@cdn-admin.example.com",
    "ftp://cdn-admin.example.com",
    "https://",
  ])("refuses EDGEWEIR_PUBLIC_URL %j at startup, also with a node channel URL", (value) => {
    for (const nodeUrl of [undefined, node]) {
      expect(() =>
        loadEnv({ ...base, EDGEWEIR_PUBLIC_URL: value, EDGEWEIR_NODE_API_URL: nodeUrl }),
      ).toThrow(
        /^invalid configuration:\n {2}EDGEWEIR_PUBLIC_URL: expected http:\/\/ or https:\/\//,
      );
    }
  });

  it.each([
    "cdn-admin.example.com:8443",
    "http://cdn-admin.example.com:8443",
    "https://cdn-admin.example.com:8443/node",
    "wss://cdn-admin.example.com/node-channel",
  ])("refuses EDGEWEIR_NODE_API_URL %j", (value) => {
    expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_URL: value })).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_NODE_API_URL: expected https:\/\/, wss:\/\/ or ws:\/\/host/,
    );
  });

  it.each([["https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}"], ["https://:"]])(
    "names the rejected value %j, as a platform left it",
    (value) => {
      expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_URL: value })).toThrow(
        `e.g. https://cdn-admin.example.com; got ${JSON.stringify(value)}`,
      );
    },
  );

  it("masks a password in the rejected value", () => {
    const load = () =>
      loadEnv({ ...base, EDGEWEIR_PUBLIC_URL: "https://admin:secret@cdn-admin.example.com" });
    expect(load).toThrow('got "https://admin:***@cdn-admin.example.com"');
    expect(load).not.toThrow(/secret/);
  });

  it("takes the WebSocket entry's wss:// and ws:// URLs", () => {
    const env = loadEnv({ ...base, EDGEWEIR_NODE_API_URL: "wss://Nodes.example.com/" });
    expect(env.nodeApiUrl).toBe("wss://nodes.example.com");
    expect(env.nodeApiHostnames).toContain("nodes.example.com");
    expect(loadEnv({ ...base, EDGEWEIR_NODE_API_URL: "ws://192.0.2.7:3000" }).nodeApiUrl).toBe(
      "ws://192.0.2.7:3000",
    );
  });

  it("keeps the origin: a trailing slash and the default port are dropped", () => {
    const env = loadEnv({
      ...base,
      EDGEWEIR_PUBLIC_URL: "HTTPS://CDN-Admin.example.com:443/",
      EDGEWEIR_NODE_API_URL: "https://[2001:db8::1]:8443/",
    });
    expect(env.EDGEWEIR_PUBLIC_URL).toBe("https://cdn-admin.example.com");
    expect(env.nodeApiUrl).toBe("https://[2001:db8::1]:8443");
    expect(env.nodeApiHostnames).toContain("2001:db8::1");
    expect(loadEnv({ ...base, EDGEWEIR_PUBLIC_URL: "http://192.0.2.7:3000" }).nodeApiUrl).toBe(
      "https://192.0.2.7:8443",
    );
  });
});

describe("EDGEWEIR_NODE_API_WEBSOCKET", () => {
  it.each([undefined, "", "false", "0"])("keeps the node channel port when %j", (value) => {
    const env = loadEnv({ ...base, EDGEWEIR_NODE_API_WEBSOCKET: value });
    expect(env.EDGEWEIR_NODE_API_WEBSOCKET).toBe(false);
    expect(env.nodeApiUrl).toBe("https://console.example.com:8443");
  });

  it("defaults to the WebSocket entry at the console's own address", () => {
    expect(loadEnv({ ...base, EDGEWEIR_NODE_API_WEBSOCKET: "true" }).nodeApiUrl).toBe(
      "wss://console.example.com",
    );
    expect(
      loadEnv({
        ...base,
        EDGEWEIR_PUBLIC_URL: "https://console.example.com:8080",
        EDGEWEIR_NODE_API_WEBSOCKET: "1",
      }).nodeApiUrl,
    ).toBe("wss://console.example.com:8080");
    expect(
      loadEnv({
        ...base,
        EDGEWEIR_PUBLIC_URL: "http://192.0.2.7:3000",
        EDGEWEIR_NODE_API_WEBSOCKET: "true",
      }).nodeApiUrl,
    ).toBe("ws://192.0.2.7:3000");
  });

  it("leaves an explicit EDGEWEIR_NODE_API_URL as it is", () => {
    expect(
      loadEnv({
        ...base,
        EDGEWEIR_NODE_API_WEBSOCKET: "true",
        EDGEWEIR_NODE_API_URL: "https://nodes.example.com:9443",
      }).nodeApiUrl,
    ).toBe("https://nodes.example.com:9443");
  });

  it("refuses a value that is not a boolean", () => {
    expect(() => loadEnv({ ...base, EDGEWEIR_NODE_API_WEBSOCKET: "maybe" })).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_NODE_API_WEBSOCKET:/,
    );
  });
});

describe("node channel listen address", () => {
  it.each([undefined, ""])("follows HOST when NODE_API_HOST is %j", (value) => {
    expect(loadEnv({ ...base, HOST: "127.0.0.1", NODE_API_HOST: value }).nodeApiHost).toBe(
      "127.0.0.1",
    );
  });
  it("binds the node channel apart from the web console", () => {
    const env = loadEnv({ ...base, HOST: "127.0.0.1", NODE_API_HOST: "0.0.0.0" });
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.nodeApiHost).toBe("0.0.0.0");
  });
});

describe("outbound allow list", () => {
  it.each(["intranet", "10.0.0.0/33", "10.0.0.0/8,192.168.1.0/24x"])(
    "refuses %j at startup",
    (value) => {
      expect(() => loadEnv({ ...base, EDGEWEIR_OUTBOUND_ALLOW_CIDRS: value })).toThrow(
        /^invalid configuration:\n {2}EDGEWEIR_OUTBOUND_ALLOW_CIDRS: not an IP address or CIDR range: /,
      );
    },
  );

  it("takes addresses and ranges separated by commas or whitespace", () => {
    const env = loadEnv({
      ...base,
      EDGEWEIR_OUTBOUND_ALLOW_CIDRS: "10.1.2.3/8, 192.168.1.5\nFD00::/8",
    });
    expect(parseOutboundAllowCidrs(env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS)).toEqual([
      "10.0.0.0/8",
      "192.168.1.5/32",
      "fd00::/8",
    ]);
  });
});

describe("previous master key", () => {
  const previous = Buffer.alloc(32, 6).toString("base64");

  it("is optional, and empty is unset", () => {
    expect(loadEnv(base).EDGEWEIR_MASTER_KEY_PREVIOUS).toBeUndefined();
    expect(
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY_PREVIOUS: "" }).EDGEWEIR_MASTER_KEY_PREVIOUS,
    ).toBe(undefined);
    expect(
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY_PREVIOUS: previous }).EDGEWEIR_MASTER_KEY_PREVIOUS,
    ).toBe(previous);
  });

  it("is checked like the master key and must differ from it", () => {
    expect(() =>
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY_PREVIOUS: previous.replace("B", " ") }),
    ).toThrow(/^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY_PREVIOUS: is not valid base64/);
    expect(() =>
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY_PREVIOUS: base.EDGEWEIR_MASTER_KEY }),
    ).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY_PREVIOUS: is the same key as EDGEWEIR_MASTER_KEY/,
    );
  });
});

describe("secrets from files", () => {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-env-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 5).toString("base64");
  let files = 0;
  const file = (content: string) => {
    const path = join(dir, `secret-${files++}`);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  const fromFile = (content: string, extra: Record<string, string> = {}) =>
    loadEnv({
      ...base,
      EDGEWEIR_MASTER_KEY: "",
      EDGEWEIR_MASTER_KEY_FILE: file(content),
      ...extra,
    });

  it("reads EDGEWEIR_MASTER_KEY_FILE, without the file's last newline", () => {
    expect(fromFile(`${key}\n`).EDGEWEIR_MASTER_KEY).toBe(key);
    expect(fromFile(`${key}\r\n`).EDGEWEIR_MASTER_KEY).toBe(key);
    expect(fromFile(key).EDGEWEIR_MASTER_KEY).toBe(key);
  });

  it("checks the key it reads like the variable", () => {
    expect(() => fromFile(`"${key}"\n`)).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY: is not valid base64/,
    );
  });

  it("refuses both sources at once and a file it cannot read", () => {
    expect(() => fromFile(key, { EDGEWEIR_MASTER_KEY: key })).toThrow(
      /^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY_FILE: set either/,
    );
    expect(() =>
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY_FILE: join(dir, "missing"), EDGEWEIR_MASTER_KEY: "" }),
    ).toThrow(/^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY_FILE: cannot read .*ENOENT/);
  });

  it("reads the database URL, the session secret and the ClickHouse password the same way", () => {
    const url = "postgres://edgeweir:p%40ss@db.example.com:5432/edgeweir?sslmode=verify-full";
    const secret = "s".repeat(20) + "t".repeat(20);
    const env = loadEnv({
      ...base,
      DATABASE_URL: "",
      DATABASE_URL_FILE: file(`${url}\n`),
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_SECRET_FILE: file(`${secret}\n`),
      EDGEWEIR_CLICKHOUSE_PASSWORD_FILE: file("click house \n"),
    });
    expect(env.DATABASE_URL).toBe(url);
    expect(env.BETTER_AUTH_SECRET).toBe(secret);
    // Only the line break goes: other whitespace belongs to the password.
    expect(env.EDGEWEIR_CLICKHOUSE_PASSWORD).toBe("click house ");
    // The value read is checked like the variable.
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET_FILE: file("short\n") })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it.each(FILE_VARIABLES)("refuses %s together with its file, and an empty file", (name) => {
    const value = name === "EDGEWEIR_MASTER_KEY" ? key : "value-value-value-value-value-value";
    expect(() => loadEnv({ ...base, [name]: value, [`${name}_FILE`]: file(value) })).toThrow(
      `invalid configuration:\n  ${name}_FILE: set either ${name} or ${name}_FILE, not both`,
    );
    expect(() => loadEnv({ ...base, [name]: "", [`${name}_FILE`]: file("\n") })).toThrow(
      /^invalid configuration:\n {2}\S+_FILE: \S+ is empty$/,
    );
    // An empty file variable is unset, as the compose templates pass them.
    expect(() => loadEnv({ ...base, [`${name}_FILE`]: "" })).not.toThrow();
    expect(ENV_VARIABLES).toContain(`${name}_FILE`);
  });

  it("names every problem at once", () => {
    const error = (() => {
      try {
        loadEnv({
          ...base,
          DATABASE_URL_FILE: join(dir, "missing"),
          BETTER_AUTH_SECRET_FILE: file("x".repeat(40)),
        });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(error?.split("\n")).toEqual([
      "invalid configuration:",
      expect.stringMatching(/^ {2}DATABASE_URL_FILE: set either DATABASE_URL or/),
      expect.stringMatching(/^ {2}BETTER_AUTH_SECRET_FILE: set either BETTER_AUTH_SECRET or/),
    ]);
  });
});
